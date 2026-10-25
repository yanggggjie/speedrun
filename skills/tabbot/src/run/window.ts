import type { ExtensionLink } from "../browser/extension.ts";
import { AGENT_TAB_IDLE_MS } from "../utils/constants.ts";
import { sleep } from "../utils/async.ts";

type Tab = { tabId: number; windowId: number; url: string; anchor?: boolean };
type Owned = { origin: string; busy: boolean; idleSince: number; key: string };

export const MAIN_KEY = "main";

/**
 * tabbot agent 窗口：subagent 干活的地方，和用户的窗口分开，不抢焦点。一个 key（票据，或 主 agent 自己的 main）一个窗口，
 * 这样几个 subagent 并行时各自的页面都在自己窗口的前台（浏览器不渲染后台标签页）。
 * 每个窗口的第一个标签页是扩展的 anchor 页（标题 tabbot agent）。窗口里其余标签页按站点（origin）池化：
 * task 结束只是还回去，下次同站点的直接复用，空闲太久才关。
 * key 到窗口的映射只在内存里；holder 重启后留下的窗口是孤儿：第一个当 main 接管，其余关掉。
 */
export class AgentWindows {
  private readonly link: Pick<ExtensionLink, "request">;
  private readonly windows = new Map<string, number>();
  private readonly owned = new Map<number, Owned>();
  private readonly activeTab = new Map<string, number>();
  private readonly opening = new Map<string, Promise<number>>();
  private reaper: ReturnType<typeof setInterval> | undefined;
  private adopted = false;
  private readonly idleMs: number;

  constructor(link: Pick<ExtensionLink, "request">, idleMs = AGENT_TAB_IDLE_MS) {
    this.link = link;
    this.idleMs = idleMs;
  }

  isAgentTab(tab: number): boolean { return this.owned.has(tab); }

  private async list(): Promise<Tab[]> { return ((await this.link.request("tabs")) as { tabs: Tab[] }).tabs; }

  ensureWindow(key = MAIN_KEY, tabs?: Tab[]): Promise<number> {
    let p = this.opening.get(key);
    if (!p) { p = this.doEnsure(key, tabs).finally(() => this.opening.delete(key)); this.opening.set(key, p); }
    return p;
  }

  private async doEnsure(key: string, listed?: Tab[]): Promise<number> {
    const tabs = listed ?? await this.list();
    if (!this.adopted) {
      this.adopted = true;
      const anchors = tabs.filter((t) => t.anchor);
      const [first, ...orphans] = anchors;
      if (first) {
        this.windows.set(MAIN_KEY, first.windowId);
        for (const t of tabs) if (!t.anchor && t.windowId === first.windowId) this.owned.set(t.tabId, { origin: originOf(t.url), busy: false, idleSince: Date.now(), key: MAIN_KEY });
      }
      for (const o of orphans) await this.link.request("closeWindow", { windowId: o.windowId }).catch(() => {});
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
  async acquire(origin: string, key = MAIN_KEY): Promise<number> {
    // 快速路径：窗口已知、池里有同站点空闲标签页——不查标签页列表（要枚举用户全部标签页）。
    // 标签页要是已经被关了，由 RunHost.callTab 发现“No tab with id”后重新拿。
    if (this.adopted && this.windows.has(key)) {
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
    const e = this.owned.get(tab);
    const key = e?.key ?? MAIN_KEY;
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

  /** 一个 key 用完了（票据结束）：关掉它的整个窗口。main 不关。 */
  async dispose(key: string): Promise<void> {
    if (key === MAIN_KEY) return;
    const windowId = this.windows.get(key);
    this.windows.delete(key);
    this.activeTab.delete(key);
    for (const [id, e] of this.owned) if (e.key === key) this.owned.delete(id);
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
  forget(): void { this.owned.clear(); this.windows.clear(); this.activeTab.clear(); this.adopted = false; }
}

function originOf(url: string): string { try { return new URL(url).origin; } catch { return ""; } }
