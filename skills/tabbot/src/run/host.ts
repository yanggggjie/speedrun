import type { ExtensionLink } from "../browser/extension.ts";
import type { Ingestor } from "../journal/ingest.ts";
import type { RawStore } from "../journal/raw.ts";
import { replayHeaders } from "../journal/replay-core.ts";
import { STEP_TIMEOUT_MS } from "../utils/constants.ts";
import type { RunWindow } from "./window.ts";

/** 一次运行（或一次探索）用到的页面：绑定到 tabbot run 窗口里的一个标签页，站点（origin）变了就换一个。 */
export class Session {
  tab: number | undefined;
  origin: string | undefined;
  lastUsed = Date.now();
}

export type HostDeps = { link: Pick<ExtensionLink, "request">; win: RunWindow; ingest: Ingestor; raw: RawStore };

/** 请求头里带身份信息的那些：继承页面自己的请求头时优先挑带这些的请求。 */
const CREDENTIAL = /auth|csrf|xsrf|token|^x-/i;
const NAVIGATED = /frame.*(removed|detached)|context.*(destroyed|invalidated)|navigat|Cannot access contents|No tab with id/i;
const originOf = (url: string): string => new URL(url).origin;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} 超过 ${Math.round(ms / 1000)} 秒`)), ms); })]).finally(() => clearTimeout(timer));
}

/**
 * task 与探索命令共用的页面操作。每个操作都在 tabbot run 窗口的标签页里执行，并且都记进日志（来源 agent 的 cmd 行）：
 * 做过的事就是知识——`tabbot task new` 从这些记录生成 task。
 */
export class RunHost {
  private readonly d: HostDeps;
  constructor(deps: HostDeps) { this.d = deps; }

  /** 把 session 绑到 origin 的标签页：已经是就复用，否则还回去再拿一个（池里有同站点空闲的就直接用）。 */
  async bind(s: Session, origin: string): Promise<number> {
    s.lastUsed = Date.now();
    if (s.tab !== undefined && s.origin === origin) {
      const tabs = ((await this.d.link.request("tabs")) as { tabs: { tabId: number }[] }).tabs;
      if (tabs.some((t) => t.tabId === s.tab)) return s.tab;
    }
    if (s.tab !== undefined) this.d.win.release(s.tab);
    s.tab = await this.d.win.acquire(origin);
    s.origin = origin;
    return s.tab;
  }

  async end(s: Session): Promise<void> {
    if (s.tab !== undefined) this.d.win.release(s.tab);
    s.tab = undefined;
    s.origin = undefined;
  }

  private page(s: Session): number {
    if (s.tab === undefined) throw new Error("还没有打开页面：先 goto（探索时 tabbot open <网址>）");
    s.lastUsed = Date.now();
    return s.tab;
  }

  async callTab(tab: number, fn: string, args: unknown[]): Promise<any> {
    await this.d.win.activate(tab);
    const res = (await this.d.link.request("call", { tabId: tab, fn, args })) as { v: unknown };
    return res.v;
  }

  private log<T>(tab: number, verb: string, target: string, detail: Record<string, unknown>, run: () => Promise<T>, after?: (r: T) => Record<string, unknown>): Promise<T> {
    const ref = this.d.ingest.beginCmd(tab, Date.now(), verb, target, detail);
    return run().then(
      (r) => { this.d.ingest.endCmd(ref, { detail: { ...detail, ...(after?.(r) ?? {}), ok: true } }); return r; },
      (e: unknown) => { this.d.ingest.endCmd(ref, { detail: { ...detail, ok: false, error: e instanceof Error ? e.message : String(e) } }); throw e; },
    );
  }

  async op(s: Session, name: string, a: any): Promise<unknown> {
    switch (name) {
      case "goto": return this.goto(s, a);
      case "request": return this.request(s, a);
      case "act": return this.act(s, a);
      case "waitFor": return this.waitFor(s, a);
      case "text": { const tab = this.page(s); return this.callTab(tab, "text", [a.max ?? 20_000]); }
      case "snapshot": { const tab = this.page(s); return this.callTab(tab, "snapshot", [a.full === true]); }
      case "query": { const tab = this.page(s); return this.callTab(tab, "query", [a]); }
      case "eval": { const tab = this.page(s); return this.log(tab, "eval", String(a.src).slice(0, 60), { src: String(a.src).slice(0, 2000) }, () => this.callTab(tab, "eval", [a])); }
      default: throw new Error(`未知操作 ${name}`);
    }
  }

  private async goto(s: Session, a: { url: string; timeout?: number }): Promise<{ url: string; title: string }> {
    let url: URL;
    try { url = new URL(a.url.includes("://") ? a.url : `https://${a.url}`); if (!/^https?:$/.test(url.protocol)) throw new Error("协议"); } catch { throw new Error(`不是有效的网址：${a.url}`); }
    const tab = await this.bind(s, url.origin);
    await this.d.win.activate(tab);
    const safe = this.d.ingest.sanitizer.url(url.href);
    return this.log(tab, "goto", safe.bareUrl, { bareUrl: safe.bareUrl, query: safe.query }, async () => {
      const res = (await withTimeout(this.d.link.request("goto", { tabId: tab, url: url.href, wait: true }), a.timeout ?? STEP_TIMEOUT_MS, "打开页面")) as { url: string; title: string; loaded?: boolean };
      this.d.win.moved(tab, originOf(res.url || url.href));
      s.origin = originOf(res.url || url.href);
      return { url: res.url, title: res.title };
    });
  }

  private async request(s: Session, a: { url: string; method?: string; headers?: Record<string, string>; json?: unknown; body?: string; inherit?: boolean; pageOrigin?: string; timeout?: number }): Promise<unknown> {
    const method = (a.method ?? (a.json !== undefined || a.body !== undefined ? "POST" : "GET")).toUpperCase();
    let target: URL;
    try { target = new URL(a.url); } catch { throw new Error(`request 需要完整的网址：${a.url}`); }
    const origin = a.pageOrigin ? originOf(a.pageOrigin) : target.origin;
    const tab = await this.bind(s, origin);
    const headers: Record<string, string> = {};
    if (a.inherit !== false) {
      const sameOrigin = (e: { url: string }): boolean => { try { return originOf(e.url) === target.origin; } catch { return false; } };
      // 优先取带身份信息的（authorization、csrf、x-* 之类）最近一次，没有再取任何带头的
      const seen = this.d.raw.newest((e) => sameOrigin(e) && Object.keys(replayHeaders(e.headers)).some((k) => CREDENTIAL.test(k)))
        ?? this.d.raw.newest((e) => sameOrigin(e) && Object.keys(replayHeaders(e.headers)).length > 0);
      if (seen) Object.assign(headers, replayHeaders(seen.headers));
      else if (a.inherit === true) throw new Error(`没有可继承的请求头：先让 ${target.origin} 的页面自己发过一次请求（goto 它的页面，或用户在 Chrome 里浏览过）`);
    }
    for (const [k, v] of Object.entries(a.headers ?? {})) headers[k.toLowerCase()] = v;
    let body: string | null = null;
    if (a.json !== undefined) { body = JSON.stringify(a.json); headers["content-type"] ??= "application/json"; }
    else if (a.body !== undefined) body = a.body;
    const safe = this.d.ingest.sanitizer.url(target.href);
    const shown = safe.bareUrl;
    const detail = { method, bareUrl: safe.bareUrl, query: safe.query, ...(a.json !== undefined ? { reqBody: JSON.stringify(this.d.ingest.sanitizer.body(a.json)).slice(0, 4000) } : {}), inherit: a.inherit !== false };
    return this.log(tab, "request", `${method} ${shown}`, detail, async () => {
      const res = await withTimeout(this.callTab(tab, "replay", [{ method, url: target.href, headers, body }]), a.timeout ?? STEP_TIMEOUT_MS, "请求");
      if (res.ok === false) throw new Error(`请求失败：${res.error}`);
      return res;
    }, (r: any) => ({ status: r.status, size: r.size, ms: r.ms }));
  }

  private async act(s: Session, a: any): Promise<unknown> {
    const tab = this.page(s);
    const cmd = { ...a };
    const target = a.loc !== undefined ? JSON.stringify(a.loc).slice(0, 60) : a.ref ?? a.key ?? a.to ?? "";
    const base = { kind: a.kind, ...(a.loc !== undefined ? { loc: a.loc } : {}), ...(a.ref ? { ref: a.ref } : {}), ...(a.key ? { key: a.key } : {}), ...(a.dy !== undefined ? { dy: a.dy } : {}), ...(a.to ? { to: a.to } : {}), ...(a.checked !== undefined ? { checked: a.checked } : {}) };
    return this.log(tab, a.kind, target, base, async () => {
      let res: any;
      try { res = await withTimeout(this.callTab(tab, "act", [cmd]), (a.timeout ?? 10_000) + 30_000, "页面操作"); }
      catch (e) {
        if (!NAVIGATED.test(e instanceof Error ? e.message : String(e))) throw e;
        res = { ok: true, navigated: true };
      }
      if (res.ok === false) throw new Error(res.error ?? "操作失败");
      if (res.navigated) {
        const loaded = (await this.d.link.request("tabs") as { tabs: { tabId: number; url: string; title: string }[] }).tabs.find((t) => t.tabId === tab);
        if (loaded) { res.url = loaded.url; res.title = loaded.title; s.origin = originOf(loaded.url); this.d.win.moved(tab, s.origin); }
      }
      return res;
    }, (r: any) => ({ loc: r.loc, ...(a.kind === "fill" && r.target?.type !== "password" ? { text: String(a.text ?? "").slice(0, 200) } : {}), ...(a.kind === "select" ? { text: String(a.text ?? "") } : {}), url: r.url }));
  }

  private async waitFor(s: Session, a: { loc: unknown; timeout?: number; gone?: boolean }): Promise<unknown> {
    const tab = this.page(s);
    return this.log(tab, "waitFor", JSON.stringify(a.loc).slice(0, 60), { loc: a.loc, gone: a.gone === true }, async () => {
      const res = await withTimeout(this.callTab(tab, "waitFor", [{ loc: a.loc, timeout: a.timeout ?? 10_000, gone: a.gone === true }]), (a.timeout ?? 10_000) + 5000, "等待元素");
      if (res.ok === false) throw new Error(res.error);
      return res;
    });
  }
}
