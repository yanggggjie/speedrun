import { siteDirName } from "../utils/url.ts";
import type { WindowLog } from "../record/windowlog.ts";
import { Session, type RunHost } from "../browser/host.ts";
import type { AgentWindows } from "../browser/window.ts";

/** 一个 learn 窗口最多这么多次页面操作（防止失控地翻页面）。 */
export const LEARN_MAX_OPS = 200;
/** learn 窗口这么久没有任何操作就关掉 habit 组（句柄和目录保留，再操作时从上次的 URL 重开）。 */
export const LEARN_IDLE_MS = 30 * 60_000;

/**
 * 一个 learn 窗口：一个窗口里可以学多个 action，不绑定 action。
 * id 是句柄（<站点>-<年月日>-<时分秒>），持久：信息存在 learn-windows/<句柄>/meta.json，daemon 重启后照样能用。
 * url、title 是最近一次看到的页面（重开时回到这里）；cursor 是观察的游标（这个编号之前的都观察过了）；open 是这个 daemon 里 habit 组开着。
 */
export type LearnWindow = { id: string; site: string; description: string; url: string; title: string; cursor: number; ops: number; open: boolean; createdAt: number; lastActive: number };

/** 句柄的样子：站点目录名加 8 位日期加 6 位时间（可能带 -2 这样的重名后缀）。 */
export const HANDLE = /^[A-Za-z0-9._-]+-\d{8}-\d{6}(?:-\d+)?$/;

export type LearnDeps = { log: WindowLog; host: Pick<RunHost, "op" | "end">; win: Pick<AgentWindows, "isOpen" | "dispose"> };

/**
 * learn 窗口的登记：持久的部分（meta.json）和这个 daemon 里的页面（Session，daemon 重启后为空，下次操作时从上次的 URL 重开）都归这里管。
 */
export class LearnWindows {
  private readonly d: LearnDeps;
  private readonly map = new Map<string, LearnWindow>();
  private readonly sessions = new Map<string, Session>();
  /** 正在执行命令的句柄：同一个句柄一次只跑一条命令。 */
  private readonly running = new Set<string>();

  constructor(deps: LearnDeps) { this.d = deps; }
  private get log(): WindowLog { return this.d.log; }

  /** 占住这个句柄跑一条命令；已经有一条在跑就返回 false。用完调 release。 */
  claim(id: string): boolean {
    if (this.running.has(id)) return false;
    this.running.add(id);
    return true;
  }

  release(id: string): void { this.running.delete(id); }

  /** 开一个新的 learn 窗口（登记、建目录、写 meta）。 */
  create(info: { site: string; description: string; url: string }, now = Date.now()): LearnWindow {
    const id = this.log.freshName(siteDirName(info.site), now);
    const w: LearnWindow = { id, ...info, title: "", cursor: this.log.lastSeq(), ops: 0, open: false, createdAt: now, lastActive: now };
    this.map.set(id, w);
    this.log.openWindow(id, "learn", w);
    return w;
  }

  /** 按句柄找：内存里没有就从 meta.json 读回（daemon 重启过，habit 组当作已关）。 */
  get(id: string): LearnWindow | undefined {
    const known = this.map.get(id);
    if (known) return known;
    if (this.log.kindOf(id) !== "learn") return undefined;
    const m = this.log.readMeta(id) as Partial<LearnWindow> | undefined;
    if (!m) return undefined;
    const w: LearnWindow = { id, site: String(m.site ?? ""), description: String(m.description ?? ""), url: String(m.url ?? ""), title: String(m.title ?? ""), cursor: Number(m.cursor ?? 0), ops: Number(m.ops ?? 0), open: false, createdAt: Number(m.createdAt ?? 0), lastActive: Number(m.lastActive ?? 0) };
    this.map.set(id, w);
    return w;
  }

  save(w: LearnWindow): void {
    const old = this.log.readMeta(w.id);
    this.log.writeMeta(w.id, { ...(old ?? {}), ...w, kind: "learn" });
  }

  /** 要做页面操作的窗口：不存在、操作次数用完都拒绝。不计数：操作成功后由调用方 w.ops++。 */
  forOp(id: string): LearnWindow | { error: string } {
    const w = this.get(id);
    if (!w) return { error: `没有 learn 窗口 ${id}：habit learn list 列出有哪些，或 habit learn new --url <链接|tab 号> --description "…" 开一个` };
    if (w.ops >= LEARN_MAX_OPS) return { error: `learn 窗口 ${id} 已经操作了 ${LEARN_MAX_OPS} 次，多半在原地打转：先停下看清楚卡在哪。登录失效（观察里有 401/403、页面在登录页）就按观察里的提示登录；学不会的 action 在文件头写 @status blocked 和 @note，向用户说明卡在哪；确实还要接着学，用 habit learn new 开一个新窗口` };
    return w;
  }

  /** 这个窗口当前的页面（habit 组没开就是 undefined）。 */
  session(id: string): Session | undefined { return this.sessions.get(id); }

  /**
   * learn 窗口的 habit 组开着就直接用它当前的页面；没开（刚创建、close 过、空闲关了、daemon 重启过）就新建组，到上次的 URL。
   * 返回 opened 表示这次新打开了（页面状态没了）。
   */
  async page(w: LearnWindow): Promise<{ sess: Session; opened?: { url: string; title: string } }> {
    let sess = this.sessions.get(w.id);
    if (sess && w.open && sess.tab !== undefined && await this.d.win.isOpen(w.id)) return { sess };
    this.log.openWindow(w.id, "learn");
    sess = new Session(w.id);
    this.sessions.set(w.id, sess);
    const res = (await this.d.host.op(sess, "navigate", { url: w.url || `https://${w.site}/` })) as { url: string; title: string };
    w.open = true;
    w.url = res.url;
    w.title = res.title;
    return { sess, opened: res };
  }

  /** 关掉 habit 组（agent 显式 close，或空闲太久）；句柄和目录保留。 */
  async close(w: LearnWindow): Promise<void> {
    const sess = this.sessions.get(w.id);
    this.sessions.delete(w.id);
    if (sess) await this.d.host.end(sess);
    await this.d.win.dispose(w.id);
    w.open = false;
    this.save(w);
  }

  /** 这个 daemon 里 habit 组开着的。 */
  opened(): LearnWindow[] { return [...this.map.values()].filter((w) => w.open); }

  /** 开着但空闲太久的。 */
  idle(now = Date.now(), idleMs = LEARN_IDLE_MS): LearnWindow[] { return this.opened().filter((w) => now - w.lastActive >= idleMs); }

  /** 所有 learn 窗口（磁盘上的），新的在前。 */
  list(): LearnWindow[] {
    return this.log.listWindows("learn").reverse().map((id) => this.get(id)).filter((w): w is LearnWindow => !!w);
  }
}
