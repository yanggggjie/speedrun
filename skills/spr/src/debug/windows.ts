import type { WindowLog } from "../record/windowlog.ts";
import { Session, type RunHost } from "../browser/host.ts";

/** 一个 debug 窗口最多这么多次页面操作（防止失控地翻页面）。 */
export const DEBUG_MAX_OPS = 200;
/** debug 窗口这么久没有任何操作就关掉 speedrun 组（日志目录保留）。 */
export const DEBUG_IDLE_MS = 30 * 60_000;

export type ClosedReason = "cmd" | "idle" | "restart" | "tab-closed";

/**
 * 一个 debug 窗口：按窗口名（<名>）查找，无需预先存在 action 文件；id 是窗口和日志目录的 key（<名>-<年月日>-<时分秒>）。
 * close、空闲太久、daemon 重启、扩展重连、标签组被关掉时关闭并更新 meta.json（open: false, closedBy）。
 */
export type DebugWindow = {
  id: string;
  compose: string;
  site: string;
  url: string;
  title: string;
  cursor: number;
  ops: number;
  open: boolean;
  createdAt: number;
  lastActive: number;
  closedBy?: ClosedReason;
  closedAt?: number;
  page?: PageSignals;
  apiUrl?: string;
  trace?: { until: number; paths: string[] };
};

/** 页面函数快照给观察的信号：页面主体是不是 canvas、页面接口的线索；fresh 是这次观察还没说过。 */
export type PageSignals = { canvas: boolean; api: string[]; dir: string; fresh: boolean };

export type DebugDeps = { log: WindowLog; host: Pick<RunHost, "op" | "end">; win: { isOpen(key: string, tabId?: number): boolean | Promise<boolean>; dispose(key: string): Promise<void> } };

/** 窗口没开时给 agent 的说明。 */
export const notOpen = (name: string): string => `${name} 的 debug 窗口没开（没打开过，或者 close、空闲 ${DEBUG_IDLE_MS / 60_000} 分钟、daemon 重启、扩展重连、标签页被关掉）：spr debug ${name} navigate <网址|tab 号> 打开`;

/**
 * debug 窗口的登记：只记开着的窗口（和它的页面 Session）。关掉的从这里删掉，目录里的日志和 meta.json 保留。
 */
export class DebugWindows {
  private readonly d: DebugDeps;
  private readonly map = new Map<string, DebugWindow>();
  private readonly names = new Map<string, string>();
  private readonly sessions = new Map<string, Session>();
  /** 正在执行命令的窗口名：同一个窗口一次只跑一条命令。 */
  private readonly running = new Set<string>();

  constructor(deps: DebugDeps) { this.d = deps; }
  private get log(): WindowLog { return this.d.log; }

  /** daemon 启动时把上次异常退出或重启遗留的 open: true 窗口收尾标为 restart，避免 meta.json 永远停在 open: true。 */
  closeStaleMeta(now = Date.now()): void {
    for (const id of this.log.listWindows("debug")) {
      if (this.map.has(id)) continue;
      const meta = this.log.readMeta(id);
      if (meta && meta.open === true) {
        this.log.writeMeta(id, { ...meta, open: false, closedBy: "restart", closedAt: now });
      }
    }
  }

  /** 扩展断开重连时，旧组失效，内存里的窗口全部按 restart 收尾。 */
  forgetAll(reason: ClosedReason = "restart"): void {
    const now = Date.now();
    for (const w of [...this.map.values()]) {
      this.sessions.delete(w.id);
      w.open = false;
      w.closedBy = reason;
      w.closedAt = now;
      this.save(w);
    }
    this.map.clear();
    this.names.clear();
  }

  claim(name: string): boolean {
    if (this.running.has(name)) return false;
    this.running.add(name);
    return true;
  }

  release(name: string): void { this.running.delete(name); }

  /** 开一个新的 debug 窗口（登记、建目录、写 meta）。 */
  create(info: { compose: string; site: string; url: string }, now = Date.now()): DebugWindow {
    const id = this.log.freshName(info.compose, now);
    const w: DebugWindow = { id, ...info, title: "", cursor: this.log.lastSeq(), ops: 0, open: false, createdAt: now, lastActive: now };
    this.map.set(id, w);
    this.names.set(info.compose, id);
    this.log.openWindow(id, "debug", w);
    return w;
  }

  get(id: string): DebugWindow | undefined { return this.map.get(id); }

  of(name: string): DebugWindow | undefined {
    const id = this.names.get(name);
    return id === undefined ? undefined : this.map.get(id);
  }

  save(w: DebugWindow): void {
    const old = this.log.readMeta(w.id);
    this.log.writeMeta(w.id, { ...(old ?? {}), ...w, kind: "debug" });
  }

  forOp(name: string, counted = true): DebugWindow | { error: string; usage: boolean } {
    const w = this.of(name);
    if (!w) return { error: notOpen(name), usage: true };
    if (counted && w.ops >= DEBUG_MAX_OPS) {
      return { error: `${name} 的 debug 窗口已经操作了 ${DEBUG_MAX_OPS} 次，多半在原地打转：先停下看清楚卡在哪。登录失效就按观察里的提示请用户登录；确实还要接着做，spr debug ${name} close 后重新 navigate`, usage: false };
    }
    return w;
  }

  session(id: string): Session | undefined { return this.sessions.get(id); }

  async page(w: DebugWindow): Promise<{ sess: Session; opened?: { url: string; title: string } }> {
    let sess = this.sessions.get(w.id);
    if (sess) {
      if (sess.tab !== undefined && await this.d.win.isOpen(w.id, sess.tab)) return { sess };
      await this.close(w, "tab-closed");
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

  /** 扩展上报某标签页被关闭：若是当前 debug 窗口的主标签页，立即收尾 meta 与剩余子标签页。 */
  onTabClosed(key: string, tabId: number): void {
    const w = this.map.get(key);
    const sess = this.sessions.get(key);
    if (!w || !sess || sess.tab !== tabId) return;
    void this.close(w, "tab-closed").catch(() => {});
  }

  /** 关掉 speedrun 组，同步更新 meta.json（open: false, closedBy）；日志目录保留。 */
  async close(w: DebugWindow, reason: ClosedReason = "cmd"): Promise<void> {
    const sess = this.sessions.get(w.id);
    this.sessions.delete(w.id);
    if (sess) await this.d.host.end(sess);
    await this.d.win.dispose(w.id);
    w.open = false;
    w.closedBy = reason;
    w.closedAt = Date.now();
    this.save(w);
    this.map.delete(w.id);
    if (this.names.get(w.compose) === w.id) this.names.delete(w.compose);
  }

  opened(): DebugWindow[] { return [...this.map.values()].filter((w) => w.open); }

  idle(now = Date.now(), idleMs = DEBUG_IDLE_MS): DebugWindow[] { return this.opened().filter((w) => now - w.lastActive >= idleMs); }

  list(): DebugWindow[] { return [...this.map.values()].reverse(); }
}
