import type { WindowLog } from "../record/windowlog.ts";
import { Session, type RunHost } from "../browser/host.ts";
import type { AgentWindows } from "../browser/window.ts";

/** 一个 debug 窗口最多这么多次页面操作（防止失控地翻页面）。 */
export const DEBUG_MAX_OPS = 200;
/** debug 窗口这么久没有任何操作就关掉 speedrun 组（日志目录保留）。 */
export const DEBUG_IDLE_MS = 30 * 60_000;

/**
 * 一个 debug 窗口：属于一个 compose，可以写或修它缺的多个 action，也可以跨站点。
 * compose 是查找窗口用的名字；id 是窗口和日志目录的 key（<compose>-<年月日>-<时分秒>）。窗口重开时换一个 id。
 * run 成功或失败都不关 debug 窗口；close、空闲太久、daemon 重启、标签组被关掉才关，日志和 meta.json 留在 debug-windows/<id>/。
 * url、title 是最近一次看到的页面；cursor 是观察的游标（这个编号之前的都观察过了）；open 是 speedrun 组已经开出来了。
 */
export type DebugWindow = { id: string; compose: string; site: string; url: string; title: string; cursor: number; ops: number; open: boolean; createdAt: number; lastActive: number; page?: PageSignals; apiUrl?: string; trace?: { until: number; paths: string[] } };

/** 页面函数快照给观察的信号：页面主体是不是 canvas、页面接口的线索；fresh 是这次观察还没说过。 */
export type PageSignals = { canvas: boolean; api: string[]; dir: string; fresh: boolean };

export type DebugDeps = { log: WindowLog; host: Pick<RunHost, "op" | "end">; win: Pick<AgentWindows, "isOpen" | "dispose"> };

/** 窗口没开时给 agent 的说明。 */
export const notOpen = (compose: string): string => `${compose} 的 debug 窗口没开（没打开过，或者 close、空闲 ${DEBUG_IDLE_MS / 60_000} 分钟、daemon 重启、扩展重连、标签组被关掉）：spr debug ${compose} navigate <网址|tab 号> 打开，在窗口里复现到要的页面状态`;

/**
 * debug 窗口的登记：只记开着的窗口（和它的页面 Session）。关掉的从这里删掉，只留目录里的日志和 meta.json。
 * 内部按 id 登记（AgentWindows、Session、WindowLog、日志淘汰都用 id），names 是 compose 名到 id 的映射。
 */
export class DebugWindows {
  private readonly d: DebugDeps;
  private readonly map = new Map<string, DebugWindow>();
  private readonly names = new Map<string, string>();
  private readonly sessions = new Map<string, Session>();
  /** 正在执行命令的 compose：同一个 compose 一次只跑一条命令。 */
  private readonly running = new Set<string>();

  constructor(deps: DebugDeps) { this.d = deps; }
  private get log(): WindowLog { return this.d.log; }

  /** 占住这个 compose 跑一条命令；已经有一条在跑就返回 false。用完调 release。 */
  claim(compose: string): boolean {
    if (this.running.has(compose)) return false;
    this.running.add(compose);
    return true;
  }

  release(compose: string): void { this.running.delete(compose); }

  /** 开一个新的 debug 窗口（登记、建目录、写 meta）。 */
  create(info: { compose: string; site: string; url: string }, now = Date.now()): DebugWindow {
    const id = this.log.freshName(info.compose, now);
    const w: DebugWindow = { id, ...info, title: "", cursor: this.log.lastSeq(), ops: 0, open: false, createdAt: now, lastActive: now };
    this.map.set(id, w);
    this.names.set(info.compose, id);
    this.log.openWindow(id, "debug", w);
    return w;
  }

  /** 按窗口 id 查开着的窗口。 */
  get(id: string): DebugWindow | undefined { return this.map.get(id); }

  /** 这个 compose 开着的窗口。 */
  of(compose: string): DebugWindow | undefined {
    const id = this.names.get(compose);
    return id === undefined ? undefined : this.map.get(id);
  }

  save(w: DebugWindow): void {
    const old = this.log.readMeta(w.id);
    this.log.writeMeta(w.id, { ...(old ?? {}), ...w, kind: "debug" });
  }

  /** 要操作的窗口：没开是用法错误（要先 navigate）；counted 时操作次数用完也拒绝。不计数：操作成功后由调用方 w.ops++。 */
  forOp(compose: string, counted = true): DebugWindow | { error: string; usage: boolean } {
    const w = this.of(compose);
    if (!w) return { error: notOpen(compose), usage: true };
    if (counted && w.ops >= DEBUG_MAX_OPS) return { error: `${compose} 的 debug 窗口已经操作了 ${DEBUG_MAX_OPS} 次，多半在原地打转：先停下看清楚卡在哪。登录失效（观察里有 401/403、页面在登录页）就按观察里的提示登录；写不出来的 action 在文件头写 @status blocked 和 @note，向用户说明卡在哪；确实还要接着做，spr debug ${compose} close 后重新 navigate`, usage: false };
    return w;
  }

  /** 这个窗口当前的页面（speedrun 组没开就是 undefined）。 */
  session(id: string): Session | undefined { return this.sessions.get(id); }

  /**
   * debug 窗口当前的页面。刚创建的窗口在这里第一次开出 speedrun 组、打开起点（返回 opened）；
   * 开过的组没了（用户关了组）就当窗口关了：登记删掉，报错让 agent 重新 navigate。
   */
  async page(w: DebugWindow): Promise<{ sess: Session; opened?: { url: string; title: string } }> {
    let sess = this.sessions.get(w.id);
    if (sess) {
      if (sess.tab !== undefined && await this.d.win.isOpen(w.id)) return { sess };
      await this.close(w);
      throw new Error(notOpen(w.compose));
    }
    sess = new Session(w.id);
    this.sessions.set(w.id, sess);
    const res = (await this.d.host.op(sess, "navigate", { url: w.url || `https://${w.site}/` })) as { url: string; title: string };
    w.open = true;
    w.url = res.url;
    w.title = res.title;
    return { sess, opened: res };
  }

  /** 关掉 speedrun 组（agent 显式 close，或空闲太久）；目录保留。 */
  async close(w: DebugWindow): Promise<void> {
    const sess = this.sessions.get(w.id);
    this.sessions.delete(w.id);
    if (sess) await this.d.host.end(sess);
    await this.d.win.dispose(w.id);
    w.open = false;
    this.save(w);
    this.map.delete(w.id);
    if (this.names.get(w.compose) === w.id) this.names.delete(w.compose);
  }

  /** 这个 daemon 里 speedrun 组开着的。 */
  opened(): DebugWindow[] { return [...this.map.values()].filter((w) => w.open); }

  /** 开着但空闲太久的。 */
  idle(now = Date.now(), idleMs = DEBUG_IDLE_MS): DebugWindow[] { return this.opened().filter((w) => now - w.lastActive >= idleMs); }

  /** 开着的 debug 窗口，新的在前。 */
  list(): DebugWindow[] { return [...this.map.values()].reverse(); }
}
