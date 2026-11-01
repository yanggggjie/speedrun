import type { ExtensionLink } from "../browser/extension.ts";
import { AGENT_TAB_IDLE_MS } from "../utils/constants.ts";
import { sleep } from "../utils/async.ts";

type Tab = { tabId: number; windowId: number; url: string; anchor?: boolean };
type Owned = { origin: string; busy: boolean; idleSince: number; key: string };

/**
 * tabbot agent 窗口：agent 干活的地方，和用户的窗口分开，不抢焦点。两种，key 就是窗口的名字：
 * 学习窗口（key 是句柄，如 zhihu.com-20261101-130245）一直保留，agent 显式关；run 窗口（key 是 run 的名字）一次 run 一个，跑完就关（dispose）。
 * 一个 key 一个浏览器窗口，各自的页面都在自己窗口的前台（浏览器不渲染后台标签页）。
 * 每个窗口的第一个标签页是扩展的 anchor 页（标题 tabbot agent）。窗口里其余标签页按站点（origin）池化，只在这个窗口内复用。
 * key 到窗口的映射只在内存里；holder 重启（或扩展链路重连）一切归零：留下的窗口都是孤儿，第一次用窗口时全部关掉（学习窗口之后按需从上次的 URL 重开）。
 * 窗口被用户关了，下次用到时自动重开。
 */
export class AgentWindows {
  private readonly link: Pick<ExtensionLink, "request">;
  private readonly windows = new Map<string, number>();
  private readonly owned = new Map<number, Owned>();
  private readonly activeTab = new Map<string, number>();
  /** 页面自己在 agent 窗口里开的标签页（target=_blank 链接、window.open）：不进池，但属于那个窗口，照常录。 */
  private readonly adopted = new Map<number, string>();
  private readonly opening = new Map<string, Promise<number>>();
  private reaper: ReturnType<typeof setInterval> | undefined;
  /** 本次链路上已经清理过孤儿窗口。 */
  private cleaned = false;
  private readonly idleMs: number;

  constructor(link: Pick<ExtensionLink, "request">, idleMs = AGENT_TAB_IDLE_MS) {
    this.link = link;
    this.idleMs = idleMs;
  }

  isAgentTab(tab: number): boolean { return this.owned.has(tab) || this.adopted.has(tab); }

  /** 标签页所在的窗口（学习窗口的句柄、run 窗口的名字）；不在任何 agent 窗口里的就是用户自己的 user。 */
  winOf(tab: number): string { return this.owned.get(tab)?.key ?? this.adopted.get(tab) ?? "user"; }

  /** key 对应的浏览器窗口号（还没开就是 undefined）。 */
  windowIdOf(key: string): number | undefined { return this.windows.get(key); }

  /** 扩展报来的页面消息带着标签页所在的浏览器窗口：是 agent 窗口、标签页又不是 TabBot 开的，就记为属于那个窗口。扩展只转 TabBot 开的、以及被它们打开的标签页（看 openerTabId），用户在 agent 窗口里自己开的不会报上来。 */
  adopt(tab: number, windowId: number | undefined): void {
    if (windowId === undefined || this.owned.has(tab) || this.adopted.has(tab)) return;
    for (const [key, id] of this.windows) if (id === windowId) { this.adopted.set(tab, key); if (this.adopted.size > 2_000) this.adopted.delete(this.adopted.keys().next().value!); return; }
  }

  private async list(): Promise<Tab[]> { return ((await this.link.request("tabs")) as { tabs: Tab[] }).tabs; }

  /** 这个 key 的浏览器窗口还开着（anchor 页还在）。 */
  async isOpen(key: string): Promise<boolean> {
    const id = this.windows.get(key);
    return id !== undefined && (await this.list()).some((t) => t.anchor && t.windowId === id);
  }

  ensureWindow(key: string, tabs?: Tab[]): Promise<number> {
    let p = this.opening.get(key);
    if (!p) { p = this.doEnsure(key, tabs).finally(() => this.opening.delete(key)); this.opening.set(key, p); }
    return p;
  }

  private async doEnsure(key: string, listed?: Tab[]): Promise<number> {
    const tabs = listed ?? await this.list();
    if (!this.cleaned) {
      this.cleaned = true;
      for (const t of tabs) if (t.anchor) await this.link.request("closeWindow", { windowId: t.windowId }).catch(() => {});
    }
    const known = this.windows.get(key);
    if (known !== undefined && tabs.some((t) => t.anchor && t.windowId === known)) return known;
    const res = (await this.link.request("openWindow", { anchor: true })) as { windowId: number };
    this.windows.set(key, res.windowId);
    for (const [id, e] of this.owned) if (e.key === key) this.owned.delete(id);
    this.activeTab.delete(key);
    return res.windowId;
  }

  /** 拿一个能在 origin 上发请求、操作页面的标签页（暖页面是 origin/robots.txt，很轻）。 */
  async acquire(origin: string, key: string): Promise<number> {
    // 快速路径：窗口已知、池里有同站点空闲标签页——不查标签页列表（要枚举用户全部标签页）。
    // 标签页要是已经被关了，由 RunHost.callTab 发现“No tab with id”后重新拿。
    if (this.cleaned && this.windows.has(key)) {
      for (const [id, entry] of this.owned) if (!entry.busy && entry.origin === origin && entry.key === key) { entry.busy = true; return id; }
    }
    const tabs = await this.list(); // 只列一次，ensureWindow 复用
    const windowId = await this.ensureWindow(key, tabs);
    const live = new Set(tabs.map((t) => t.tabId));
    for (const [id, entry] of this.owned) {
      if (!live.has(id)) { this.owned.delete(id); continue; }
      if (!entry.busy && entry.origin === origin && entry.key === key) { entry.busy = true; return id; }
    }
    const res = (await this.link.request("openTab", { windowId, url: `${origin}/robots.txt`, active: true })) as { tabId: number };
    this.owned.set(res.tabId, { origin, busy: true, idleSince: Date.now(), key });
    this.activeTab.set(key, res.tabId);
    this.armReaper();
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
    if (e) { e.busy = false; e.idleSince = Date.now(); this.armReaper(); }
  }

  /** 后台标签页浏览器不渲染（滚动加载、懒加载都不动）：要操作页面前先切到所在窗口的前台。 */
  async activate(tab: number): Promise<void> {
    const key = this.owned.get(tab)?.key ?? this.adopted.get(tab) ?? "";
    if (this.activeTab.get(key) === tab) return;
    await this.link.request("activateTab", { tabId: tab });
    this.activeTab.set(key, tab);
  }

  async close(tab: number): Promise<void> {
    const e = this.owned.get(tab);
    this.owned.delete(tab);
    if (e && this.activeTab.get(e.key) === tab) this.activeTab.delete(e.key);
    await this.link.request("closeTab", { tabId: tab }).catch(() => {});
  }

  /** 关掉一个 key 的整个浏览器窗口（run 跑完、学习窗口 close 或空闲太久）。 */
  async dispose(key: string): Promise<void> {
    const windowId = this.windows.get(key);
    this.windows.delete(key);
    this.activeTab.delete(key);
    for (const [id, e] of this.owned) if (e.key === key) this.owned.delete(id);
    for (const [id, k] of this.adopted) if (k === key) this.adopted.delete(id);
    if (windowId !== undefined) await this.link.request("closeWindow", { windowId }).catch(() => {});
  }

  /** 关掉空闲太久的标签页。 */
  async reap(now = Date.now()): Promise<number> {
    let n = 0;
    for (const [id, e] of [...this.owned]) if (!e.busy && now - e.idleSince >= this.idleMs) { await this.close(id); n++; }
    if (this.owned.size === 0 && this.reaper) { clearInterval(this.reaper); this.reaper = undefined; }
    return n;
  }

  private armReaper(): void {
    if (this.reaper) return;
    this.reaper = setInterval(() => { void this.reap().catch(() => {}); }, 30_000);
    this.reaper.unref();
  }

  /** 链路断开或 holder 退出时调用。 */
  forget(): void { this.owned.clear(); this.windows.clear(); this.activeTab.clear(); this.cleaned = false; }
}
