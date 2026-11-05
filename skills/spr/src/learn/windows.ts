import { siteDirName } from "../utils/url.ts";
import type { WindowLog } from "../record/windowlog.ts";
import { Session, type RunHost } from "../browser/host.ts";
import type { AgentWindows } from "../browser/window.ts";

/** 一个 learn 窗口最多这么多次页面操作（防止失控地翻页面）。 */
export const LEARN_MAX_OPS = 200;
/** learn 窗口这么久没有任何操作就关掉 speedrun 组（句柄和目录保留，再操作时从上次的 URL 重开）。 */
export const LEARN_IDLE_MS = 30 * 60_000;

/**
 * 一个 learn 窗口：一个窗口里可以学多个 action，不绑定 action。
 * id 是句柄（<站点>-<年月日>-<时分秒>）。窗口关掉（learn close、空闲太久、daemon 重启、标签组被关掉）之后，句柄就只剩日志可看：
 * 不能再操作，要接着学就 learn new 开一个新窗口，在新窗口里复现。日志和 meta.json 留在 learn-windows/<句柄>/。
 * url、title 是最近一次看到的页面；cursor 是观察的游标（这个编号之前的都观察过了）；open 是 speedrun 组已经开出来了。
 */
export type LearnWindow = { id: string; site: string; description: string; url: string; title: string; cursor: number; ops: number; open: boolean; createdAt: number; lastActive: number ; page?: PageSignals; apiUrl?: string; trace?: { until: number; paths: string[] } };

/** 页面函数快照给观察的信号：页面主体是不是 canvas、页面接口的线索；fresh 是这次观察还没说过。 */
export type PageSignals = { canvas: boolean; api: string[]; dir: string; fresh: boolean };

/** 句柄的样子：站点目录名加 8 位日期加 6 位时间（可能带 -2 这样的重名后缀）。 */
export const HANDLE = /^[A-Za-z0-9._-]+-\d{8}-\d{6}(?:-\d+)?$/;

export type LearnDeps = { log: WindowLog; host: Pick<RunHost, "op" | "end">; win: Pick<AgentWindows, "isOpen" | "dispose"> };

/**
 * learn 窗口的登记：只记开着的窗口（和它的页面 Session）。关掉的从这里删掉，只留目录里的日志和 meta.json。
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

  /** 开着的窗口；关掉的（包括 daemon 重启前的）是 undefined。 */
  get(id: string): LearnWindow | undefined { return this.map.get(id); }

  /** 句柄关掉之后给 agent 的说明：只能看日志，要接着学就开新窗口复现。不是 learn 窗口就是 undefined。 */
  closedNote(id: string): string | undefined {
    if (this.log.kindOf(id) !== "learn") return undefined;
    const m = this.log.readMeta(id) as Partial<LearnWindow> | undefined;
    const url = String(m?.url || "<要的页面>");
    return `learn 窗口 ${id} 已经关了（learn close、空闲 ${LEARN_IDLE_MS / 60_000} 分钟、daemon 重启、扩展重连，或标签组被关掉），只能看它的日志：${this.log.winDir(id)}。要接着学，用 spr learn new --url ${url} --description "…" 开一个新窗口，在新窗口里复现到要的页面状态`;
  }

  save(w: LearnWindow): void {
    const old = this.log.readMeta(w.id);
    this.log.writeMeta(w.id, { ...(old ?? {}), ...w, kind: "learn" });
  }

  /** 要操作的窗口：关掉了、不存在都是用法错误（换成 learn new）；counted 时操作次数用完也拒绝。不计数：操作成功后由调用方 w.ops++。 */
  forOp(id: string, counted = true): LearnWindow | { error: string; usage: boolean } {
    const w = this.get(id);
    if (!w) return { error: this.closedNote(id) ?? `没有 learn 窗口 ${id}：spr learn list 列出开着的，或 spr learn new --url <链接|tab 号> --description "…" 开一个`, usage: true };
    if (counted && w.ops >= LEARN_MAX_OPS) return { error: `learn 窗口 ${id} 已经操作了 ${LEARN_MAX_OPS} 次，多半在原地打转：先停下看清楚卡在哪。登录失效（观察里有 401/403、页面在登录页）就按观察里的提示登录；学不会的 action 在文件头写 @status blocked 和 @note，向用户说明卡在哪；确实还要接着学，用 spr learn new 开一个新窗口`, usage: false };
    return w;
  }

  /** 这个窗口当前的页面（speedrun 组没开就是 undefined）。 */
  session(id: string): Session | undefined { return this.sessions.get(id); }

  /**
   * learn 窗口当前的页面。刚创建的窗口在这里第一次开出 speedrun 组、打开起点（返回 opened）；
   * 开过的组没了（用户关了组）就当窗口关了：登记删掉，报错让 agent 开新窗口。
   */
  async page(w: LearnWindow): Promise<{ sess: Session; opened?: { url: string; title: string } }> {
    let sess = this.sessions.get(w.id);
    if (sess) {
      if (sess.tab !== undefined && await this.d.win.isOpen(w.id)) return { sess };
      await this.close(w);
      throw new Error(this.closedNote(w.id) ?? `learn 窗口 ${w.id} 已经关了`);
    }
    sess = new Session(w.id);
    this.sessions.set(w.id, sess);
    const res = (await this.d.host.op(sess, "navigate", { url: w.url || `https://${w.site}/` })) as { url: string; title: string };
    w.open = true;
    w.url = res.url;
    w.title = res.title;
    return { sess, opened: res };
  }

  /** 关掉 speedrun 组（agent 显式 close，或空闲太久）；句柄和目录保留。 */
  async close(w: LearnWindow): Promise<void> {
    const sess = this.sessions.get(w.id);
    this.sessions.delete(w.id);
    if (sess) await this.d.host.end(sess);
    await this.d.win.dispose(w.id);
    w.open = false;
    this.save(w);
    this.map.delete(w.id);
  }

  /** 这个 daemon 里 speedrun 组开着的。 */
  opened(): LearnWindow[] { return [...this.map.values()].filter((w) => w.open); }

  /** 开着但空闲太久的。 */
  idle(now = Date.now(), idleMs = LEARN_IDLE_MS): LearnWindow[] { return this.opened().filter((w) => now - w.lastActive >= idleMs); }

  /** 开着的 learn 窗口，新的在前。 */
  list(): LearnWindow[] { return [...this.map.values()].reverse(); }
}
