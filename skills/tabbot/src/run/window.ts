import type { ExtensionLink } from "../browser/extension.ts";
import { RUN_TAB_IDLE_MS } from "../utils/constants.ts";

type Tab = { tabId: number; windowId: number; url: string; anchor?: boolean };
type Owned = { origin: string; busy: boolean; idleSince: number };

/**
 * tabbot run 窗口：agent 自己干活的地方，和用户的窗口分开，不抢焦点。
 * 窗口里第一个标签页是扩展的 anchor 页（标题 tabbot run），用它认出这个窗口，holder 重启后也能接上。
 * 其余标签页按站点（origin）池化：task 结束只是还回去，下次同站点的 task 直接复用，省掉开页面的时间；空闲太久才关。
 */
export class RunWindow {
  private readonly link: Pick<ExtensionLink, "request">;
  private windowId: number | undefined;
  private readonly owned = new Map<number, Owned>();
  private activeTab: number | undefined;
  private reaper: ReturnType<typeof setInterval> | undefined;
  private opening: Promise<number> | undefined;
  private readonly idleMs: number;

  constructor(link: Pick<ExtensionLink, "request">, idleMs = RUN_TAB_IDLE_MS) {
    this.link = link;
    this.idleMs = idleMs;
  }

  isRunTab(tab: number): boolean { return this.owned.has(tab); }

  private async list(): Promise<Tab[]> { return ((await this.link.request("tabs")) as { tabs: Tab[] }).tabs; }

  /** 窗口还在就返回它；不在（用户关了，或第一次）就新开一个。 */
  ensureWindow(): Promise<number> {
    this.opening ??= this.doEnsure().finally(() => { this.opening = undefined; });
    return this.opening;
  }

  private async doEnsure(): Promise<number> {
    const tabs = await this.list();
    const anchor = tabs.find((t) => t.anchor);
    if (anchor) {
      if (this.windowId !== anchor.windowId) this.windowId = anchor.windowId;
      // 接管上一个 holder 留下的标签页：当作空闲的池子
      for (const t of tabs) {
        if (t.anchor || t.windowId !== anchor.windowId || this.owned.has(t.tabId)) continue;
        this.owned.set(t.tabId, { origin: originOf(t.url), busy: false, idleSince: Date.now() });
      }
    } else {
      const res = (await this.link.request("openWindow", { anchor: true })) as { windowId: number };
      this.windowId = res.windowId;
      this.owned.clear();
      this.activeTab = undefined;
    }
    // 用户手动关掉的标签页不再记着
    const alive = new Set(tabs.map((t) => t.tabId));
    for (const id of this.owned.keys()) if (!alive.has(id) && anchor) this.owned.delete(id);
    return this.windowId!;
  }

  /** 拿一个能在 origin 上发请求、操作页面的标签页（暖页面是 origin/robots.txt，很轻）。 */
  async acquire(origin: string): Promise<number> {
    const windowId = await this.ensureWindow();
    const live = new Set((await this.list()).map((t) => t.tabId));
    for (const [id, entry] of this.owned) {
      if (!live.has(id)) { this.owned.delete(id); continue; }
      if (!entry.busy && entry.origin === origin) { entry.busy = true; return id; }
    }
    const res = (await this.link.request("openTab", { windowId, url: `${origin}/robots.txt`, active: true })) as { tabId: number };
    this.owned.set(res.tabId, { origin, busy: true, idleSince: Date.now() });
    this.activeTab = res.tabId;
    this.armReaper();
    // 等暖页面加载完，页面脚本才就位
    await this.link.request("goto", { tabId: res.tabId, url: `${origin}/robots.txt`, wait: true }).catch(() => {});
    return res.tabId;
  }

  /** 标签页导航到别的站点之后，池里记的 origin 要跟着改。 */
  moved(tab: number, origin: string): void { const e = this.owned.get(tab); if (e) e.origin = origin; }

  release(tab: number): void {
    const e = this.owned.get(tab);
    if (e) { e.busy = false; e.idleSince = Date.now(); this.armReaper(); }
  }

  /** 后台标签页浏览器不渲染（滚动加载、懒加载都不动）：要操作页面前先切到前台。 */
  async activate(tab: number): Promise<void> {
    if (this.activeTab === tab) return;
    await this.link.request("activateTab", { tabId: tab });
    this.activeTab = tab;
  }

  async close(tab: number): Promise<void> {
    this.owned.delete(tab);
    if (this.activeTab === tab) this.activeTab = undefined;
    await this.link.request("closeTab", { tabId: tab }).catch(() => {});
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
  forget(): void { this.owned.clear(); this.windowId = undefined; this.activeTab = undefined; }
}

function originOf(url: string): string { try { return new URL(url).origin; } catch { return ""; } }
