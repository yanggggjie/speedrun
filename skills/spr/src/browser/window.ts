import type { ExtensionLink } from "./extension.ts";
import { TAB_IDLE_MS } from "../utils/constants.ts";
import { sleep } from "../utils/async.ts";

type TabEntry = {
  scope: WindowScope;
  origin: string | undefined;
  poolable: boolean;
  leased: boolean;
  ops: number;
  lastActive: number;
  detached: boolean;
};

/** 单个 agent 窗口（一次 run 或一个 debug 窗口）的作用域：持有统一的关闭信号与状态。 */
export class WindowScope {
  readonly key: string;
  private readonly controller = new AbortController();
  closed = false;
  constructor(key: string) { this.key = key; }
  get signal(): AbortSignal { return this.controller.signal; }
  abort(): void {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort(new Error(`窗口 ${this.key} 已关闭`));
  }
}

function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : new Error("窗口已关闭"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("窗口已关闭"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => { signal.removeEventListener("abort", onAbort); resolve(v); },
      (e) => { signal.removeEventListener("abort", onAbort); reject(e); },
    );
  });
}

/**
 * speedrun 窗口：agent 干活的地方。所有 tab 都在 Chrome 顶部全局唯一的黄色折叠「speedrun」组里（组纯做 UI 收纳，由扩展自治）；
 * daemon 只围绕 WindowScope 与 tabId 管理归属与生命周期。两种窗口，key 就是窗口的名字：
 * debug 窗口（key 是窗口 id，如 zhihu-vote-20261101-130245）run 之后也保留，agent 显式关或空闲太久才关；run 窗口（key 是 run 的名字）一次 run 一个，跑完就关（dispose）。
 * 页面自己开出来的子标签页按 opener 继承所属的 WindowScope。
 * 后台标签页靠调试器渲染；单 tab 闲置 TAB_IDLE_MS 没有操作就发 idleTab 解除附着（不吃 CPU，没有附着时横幅也会消失），下次操作扩展自动重新附着。
 * daemon 重启（或扩展链路重连）一切归零：扩展在新建连接时自己清场遗留组。
 */
export class AgentWindows {
  private readonly link: Pick<ExtensionLink, "request">;
  private readonly scopes = new Map<string, WindowScope>();
  private readonly closedKeys = new Set<string>();
  private readonly tabs = new Map<number, TabEntry>();
  private idler: ReturnType<typeof setInterval> | undefined;
  private readonly tabIdleMs: number;

  constructor(link: Pick<ExtensionLink, "request">, opts: { tabIdleMs?: number } = {}) {
    this.link = link;
    this.tabIdleMs = opts.tabIdleMs ?? TAB_IDLE_MS;
  }

  private scopeOf(key: string): WindowScope {
    if (this.closedKeys.has(key)) throw new Error(`窗口 ${key} 已关闭`);
    let scope = this.scopes.get(key);
    if (!scope) {
      scope = new WindowScope(key);
      this.scopes.set(key, scope);
    }
    return scope;
  }

  /** 返回窗口对应的中止信号（用于中止在途页面操作）。 */
  signalOf(key: string): AbortSignal | undefined { return this.scopes.get(key)?.signal; }

  isAgentTab(tab: number): boolean { return this.tabs.has(tab); }

  /** 标签页所在的窗口（debug 窗口的 id、run 窗口的名字）；不在管理表里的就是用户自己的 user。 */
  winOf(tab: number): string {
    const e = this.tabs.get(tab);
    return e && !e.scope.closed ? e.scope.key : "user";
  }

  /** 页面自己开出来的子标签页：只要 opener 属于某个活跃窗口，就归入同一 WindowScope。 */
  adopt(tab: number, opener: number | undefined): void {
    if (opener === undefined || this.tabs.has(tab)) return;
    const parent = this.tabs.get(opener);
    if (!parent || parent.scope.closed) return;
    this.tabs.set(tab, {
      scope: parent.scope,
      origin: undefined,
      poolable: false,
      leased: false,
      ops: 0,
      lastActive: Date.now(),
      detached: false,
    });
    this.arm();
  }

  /** 扩展通知标签页已关闭：即时从内存表移除，避免继续操作已死 tabId。 */
  removeTab(tab: number): void {
    this.tabs.delete(tab);
    if (this.tabs.size === 0 && this.idler) { clearInterval(this.idler); this.idler = undefined; }
  }

  /** 窗口（以及可选的主标签页）是否仍活着。 */
  isOpen(key: string, tabId?: number): boolean {
    const scope = this.scopes.get(key);
    if (!scope || scope.closed) return false;
    if (tabId !== undefined) return this.tabs.get(tabId)?.scope === scope;
    for (const e of this.tabs.values()) if (e.scope === scope) return true;
    return false;
  }

  /** 拿一个标签页：有同源空闲池 tab 直接复用；否则新开空白页（blank: true）或 origin/robots.txt 暖页（blank: false）。 */
  async acquire(origin: string | undefined, key: string, opts: { blank?: boolean } = {}): Promise<number> {
    const scope = this.scopeOf(key);
    if (origin !== undefined) {
      for (const [id, e] of this.tabs) {
        if (e.scope === scope && e.poolable && !e.leased && e.origin === origin) {
          e.leased = true;
          e.lastActive = Date.now();
          e.detached = false;
          this.arm();
          return id;
        }
      }
    }
    const warm = origin !== undefined && !opts.blank;
    const openArgs = warm ? { url: `${origin}/robots.txt` } : {};
    const openP = this.link.request("openTab", openArgs) as Promise<{ tabId: number }>;
    // 即使调用方因 scope abort 提前返回，openTab 真落成时也要立刻关掉，不留孤儿 tab
    const guarded = openP.then((r) => {
      if (scope.closed || this.closedKeys.has(key)) void this.link.request("closeTab", { tabId: r.tabId }).catch(() => {});
      return r;
    });
    const res = await raceAbort(guarded, scope.signal);
    if (scope.closed || this.closedKeys.has(key)) {
      void this.link.request("closeTab", { tabId: res.tabId }).catch(() => {});
      throw new Error(`窗口 ${key} 已关闭`);
    }
    this.tabs.set(res.tabId, {
      scope,
      origin: warm ? origin : undefined,
      poolable: true,
      leased: true,
      ops: 0,
      lastActive: Date.now(),
      detached: false,
    });
    this.arm();
    if (warm) {
      await this.waitScript(res.tabId, 5000, scope.signal);
      if (scope.closed || this.closedKeys.has(key)) {
        this.tabs.delete(res.tabId);
        void this.link.request("closeTab", { tabId: res.tabId }).catch(() => {});
        throw new Error(`窗口 ${key} 已关闭`);
      }
    }
    return res.tabId;
  }

  /** 暖页面只要页面脚本就位就行（几十毫秒），不等页面加载完。 */
  private async waitScript(tab: number, ms = 5000, signal?: AbortSignal): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && !signal?.aborted) {
      try { await this.link.request("call", { tabId: tab, fn: "ping", args: [] }); return; } catch { await sleep(60); }
    }
  }

  /** 标签页导航到别的站点之后，池里记的 origin 要跟着改。 */
  moved(tab: number, origin: string): void { const e = this.tabs.get(tab); if (e) e.origin = origin; }

  release(tab: number): void {
    const e = this.tabs.get(tab);
    if (e) { e.leased = false; e.lastActive = Date.now(); this.arm(); }
  }

  /** 在这个标签页上做一次操作：期间该标签页不算闲置。返回结束时调用的函数。 */
  busy(tab: number): () => void {
    const e = this.tabs.get(tab);
    if (!e || e.scope.closed) return () => {};
    e.ops++;
    e.lastActive = Date.now();
    e.detached = false;
    this.arm();
    let done = false;
    return () => { if (done) return; done = true; e.ops = Math.max(0, e.ops - 1); e.lastActive = Date.now(); };
  }

  /** 单个标签页闲置超过 tabIdleMs 就解除调试器附着（扩展在下次操作时自动重新附着）。 */
  async idle(now = Date.now()): Promise<number> {
    let n = 0;
    for (const [tabId, e] of [...this.tabs]) {
      if (e.scope.closed || e.detached || e.ops > 0 || now - e.lastActive < this.tabIdleMs) continue;
      e.detached = true;
      await this.link.request("idleTab", { tabId }).catch(() => {});
      n++;
    }
    return n;
  }

  async close(tab: number): Promise<void> {
    this.removeTab(tab);
    await this.link.request("closeTab", { tabId: tab }).catch(() => {});
  }

  private readonly closedListeners = new Set<(key: string) => void>();
  /** 一个 key 的窗口关了（dispose，或 forget 忘掉全部）：同步通知，用来收尾挂在这个窗口下的状态。 */
  onClosed(fn: (key: string) => void): void { this.closedListeners.add(fn); }
  private closed(key: string): void { for (const fn of this.closedListeners) { try { fn(key); } catch { /* 收尾出错不影响关窗口 */ } } }

  /** 关掉一个 key 作用域下的全部标签页，并中止所有在途操作。 */
  async dispose(key: string): Promise<void> {
    this.closedKeys.add(key);
    if (this.closedKeys.size > 500) this.closedKeys.delete(this.closedKeys.values().next().value!);
    const scope = this.scopes.get(key);
    if (scope) {
      scope.abort();
      this.scopes.delete(key);
    }
    this.closed(key);
    const ids: number[] = [];
    for (const [id, e] of this.tabs) {
      if (e.scope.key === key) {
        ids.push(id);
        this.tabs.delete(id);
      }
    }
    if (this.tabs.size === 0 && this.idler) { clearInterval(this.idler); this.idler = undefined; }
    await Promise.all(ids.map((tabId) => this.link.request("closeTab", { tabId }).catch(() => {})));
  }

  private arm(): void {
    if (!this.idler && this.tabs.size > 0) {
      this.idler = setInterval(() => {
        void this.idle().catch(() => {});
        if (this.tabs.size === 0 && this.idler) { clearInterval(this.idler); this.idler = undefined; }
      }, 5_000);
      this.idler.unref();
    }
  }

  /** 链路断开或 daemon 退出时调用。 */
  forget(): void {
    const keys = new Set<string>([...this.scopes.keys(), ...[...this.tabs.values()].map((e) => e.scope.key)]);
    for (const scope of this.scopes.values()) scope.abort();
    for (const key of keys) this.closed(key);
    this.scopes.clear();
    this.tabs.clear();
    this.closedKeys.clear();
    if (this.idler) { clearInterval(this.idler); this.idler = undefined; }
  }
}
