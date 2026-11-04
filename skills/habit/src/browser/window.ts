import type { ExtensionLink } from "./extension.ts";
import { AGENT_TAB_IDLE_MS, GROUP_IDLE_MS } from "../utils/constants.ts";
import { sleep } from "../utils/async.ts";

type Tab = { tabId: number; groupId?: number; habit?: boolean };
type Owned = { origin: string; busy: boolean; idleSince: number; key: string };
/** 组的标题和颜色（Chrome 标签组的颜色名）。 */
export type GroupLabel = { title: string; color: string };

/**
 * habit 窗口：agent 干活的地方。不是单独的 Chrome 窗口，而是用户窗口里 habit 的一个**标签组**（始终折叠），不开窗口、不抢前台。两种，key 就是窗口的名字：
 * learn 窗口（key 是句柄，如 zhihu.com-20261101-130245）一直保留，agent 显式关；run 窗口（key 是 run 的名字）一次 run 一个，跑完就关（dispose）。
 * 组里的标签页按站点（origin）池化，只在这个组内复用。归属看组：扩展只认 habit 的组；组属于哪个 key 只记在这里（内存），
 * 页面自己开出来的标签页（扩展替它开在同一个组里）按扩展报来的组号归到 key。
 * 后台标签页靠调试器渲染（扩展附着时开 focus emulation）；一个组 GROUP_IDLE_MS 没有操作就解除附着（不吃 CPU，没有附着时「正在调试此浏览器」的横幅也会消失），下次操作扩展自动重新附着。
 * daemon 重启（或扩展链路重连）一切归零：第一次用时关掉所有 habit 组；开着的 learn 窗口随之算关掉（句柄只剩日志）。run 窗口的组被用户关了，下次用到时重建。
 */
export class AgentWindows {
  private readonly link: Pick<ExtensionLink, "request">;
  private readonly label: (key: string) => GroupLabel;
  private readonly groups = new Map<string, number>();
  private readonly keyOfGroup = new Map<number, string>();
  private readonly owned = new Map<number, Owned>();
  /** 页面自己开出来的标签页（扩展替它开在同一个组里）：不进池，但属于那个窗口，照常录。 */
  private readonly adopted = new Map<number, string>();
  /** 每个 key 进行中的操作数和最后一次操作的时间：闲置判断用。 */
  private readonly activity = new Map<string, { busy: number; last: number; idle: boolean }>();
  private reaper: ReturnType<typeof setInterval> | undefined;
  private idler: ReturnType<typeof setInterval> | undefined;
  /** 本次链路上已经关过上一个 daemon 留下的组。 */
  private cleaned = false;
  private readonly idleMs: number;
  private readonly groupIdleMs: number;

  constructor(link: Pick<ExtensionLink, "request">, opts: { label?: (key: string) => GroupLabel; idleMs?: number; groupIdleMs?: number } = {}) {
    this.link = link;
    this.label = opts.label ?? ((key) => ({ title: `habit·${key}`, color: "blue" }));
    this.idleMs = opts.idleMs ?? AGENT_TAB_IDLE_MS;
    this.groupIdleMs = opts.groupIdleMs ?? GROUP_IDLE_MS;
  }

  isAgentTab(tab: number): boolean { return this.owned.has(tab) || this.adopted.has(tab); }

  /** 标签页所在的窗口（learn 窗口的句柄、run 窗口的名字）；不在 habit 组里的就是用户自己的 user。 */
  winOf(tab: number): string { return this.owned.get(tab)?.key ?? this.adopted.get(tab) ?? "user"; }

  /** key 对应的组号（还没开就是 undefined）。 */
  groupOf(key: string): number | undefined { return this.groups.get(key); }

  /** 扩展报来的页面消息带着标签页所在的组：是 habit 的组、标签页又不是 habit 开的（页面自己开的、用户拖进组的），就记为属于那个窗口。 */
  adopt(tab: number, group: number | undefined): void {
    if (group === undefined || this.owned.has(tab)) return;
    const key = this.keyOfGroup.get(group);
    if (key === undefined) return;
    this.adopted.set(tab, key);
    if (this.adopted.size > 2_000) this.adopted.delete(this.adopted.keys().next().value!);
  }

  private async list(): Promise<Tab[]> { return ((await this.link.request("tabs")) as { tabs: Tab[] }).tabs; }

  /** 这个 key 的组还在（里面还有标签页）。 */
  async isOpen(key: string): Promise<boolean> {
    const g = this.groups.get(key);
    return g !== undefined && (await this.list()).some((t) => t.groupId === g);
  }

  /** 第一次用：关掉上一个 daemon 留下的 habit 组。 */
  private async clean(): Promise<void> {
    if (this.cleaned) return;
    this.cleaned = true;
    await this.link.request("closeAllGroups").catch(() => {});
  }

  private setGroup(key: string, group: number): void {
    const old = this.groups.get(key);
    if (old === group) return;
    if (old !== undefined) this.keyOfGroup.delete(old);
    this.groups.set(key, group);
    this.keyOfGroup.set(group, key);
  }

  /** 拿一个能在 origin 上发请求、操作页面的标签页（暖页面是 origin/robots.txt，很轻）。 */
  async acquire(origin: string, key: string): Promise<number> {
    this.touch(key);
    // 快速路径：池里有同站点空闲标签页——不查标签页列表（要枚举用户全部标签页）。
    // 标签页要是已经被关了，由 RunHost.callTab 发现“No tab with id”后重新拿。
    if (this.cleaned) {
      for (const [id, entry] of this.owned) if (!entry.busy && entry.origin === origin && entry.key === key) { entry.busy = true; return id; }
    }
    await this.clean();
    const live = new Set((await this.list()).map((t) => t.tabId));
    for (const [id, entry] of this.owned) {
      if (!live.has(id)) { this.owned.delete(id); continue; }
      if (!entry.busy && entry.origin === origin && entry.key === key) { entry.busy = true; return id; }
    }
    const res = (await this.link.request("openTab", { groupId: this.groups.get(key), ...this.label(key), url: `${origin}/robots.txt` })) as { tabId: number; groupId: number };
    this.setGroup(key, res.groupId);
    this.owned.set(res.tabId, { origin, busy: true, idleSince: Date.now(), key });
    this.arm();
    await this.waitScript(res.tabId);
    return res.tabId;
  }

  /** 暖页面只要页面脚本就位就行（几十毫秒），不等页面加载完。 */
  private async waitScript(tab: number, ms = 5000): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      try { await this.link.request("call", { tabId: tab, fn: "ping", args: [] }); return; } catch { await sleep(60); }
    }
  }

  /** 标签页导航到别的站点之后，池里记的 origin 要跟着改。 */
  moved(tab: number, origin: string): void { const e = this.owned.get(tab); if (e) e.origin = origin; }

  release(tab: number): void {
    const e = this.owned.get(tab);
    if (e) { e.busy = false; e.idleSince = Date.now(); this.arm(); }
  }

  private touch(key: string): { busy: number; last: number; idle: boolean } {
    let a = this.activity.get(key);
    if (!a) { a = { busy: 0, last: 0, idle: false }; this.activity.set(key, a); }
    a.last = Date.now();
    a.idle = false;
    return a;
  }

  /** 在这个标签页上做一次操作（页面操作、等请求、learn 的 wait）：期间它的组不算闲置。返回结束时调用的函数。 */
  busy(tab: number): () => void {
    const key = this.winOf(tab);
    if (key === "user") return () => {};
    const a = this.touch(key);
    a.busy++;
    this.arm();
    let done = false;
    return () => { if (done) return; done = true; a.busy--; a.last = Date.now(); };
  }

  /** 闲置的组解除调试器附着（扩展在下次操作时自动重新附着）。 */
  async idle(now = Date.now()): Promise<number> {
    let n = 0;
    for (const [key, a] of this.activity) {
      const g = this.groups.get(key);
      if (g === undefined || a.idle || a.busy > 0 || now - a.last < this.groupIdleMs) continue;
      a.idle = true;
      await this.link.request("idleGroup", { groupId: g }).catch(() => {});
      n++;
    }
    return n;
  }

  async close(tab: number): Promise<void> {
    this.owned.delete(tab);
    await this.link.request("closeTab", { tabId: tab }).catch(() => {});
  }

  /** 关掉一个 key 的整个组（run 跑完、learn 窗口 close 或空闲太久）。 */
  async dispose(key: string): Promise<void> {
    const group = this.groups.get(key);
    this.groups.delete(key);
    this.activity.delete(key);
    if (group !== undefined) this.keyOfGroup.delete(group);
    for (const [id, e] of this.owned) if (e.key === key) this.owned.delete(id);
    for (const [id, k] of this.adopted) if (k === key) this.adopted.delete(id);
    if (group !== undefined) await this.link.request("closeGroup", { groupId: group }).catch(() => {});
  }

  /** 关掉空闲太久的标签页。 */
  async reap(now = Date.now()): Promise<number> {
    let n = 0;
    for (const [id, e] of [...this.owned]) if (!e.busy && now - e.idleSince >= this.idleMs) { await this.close(id); n++; }
    return n;
  }

  private arm(): void {
    if (!this.reaper) {
      this.reaper = setInterval(() => {
        void this.reap().catch(() => {});
        if (this.owned.size === 0 && this.reaper) { clearInterval(this.reaper); this.reaper = undefined; }
      }, 30_000);
      this.reaper.unref();
    }
    if (!this.idler) {
      this.idler = setInterval(() => { void this.idle().catch(() => {}); }, 5_000);
      this.idler.unref();
    }
  }

  /** 链路断开或 daemon 退出时调用。 */
  forget(): void { this.owned.clear(); this.adopted.clear(); this.groups.clear(); this.keyOfGroup.clear(); this.activity.clear(); this.cleaned = false; }
}
