import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionLink } from "../browser/extension.ts";
import type { Ingestor } from "../journal/ingest.ts";
import type { RawEntry, RawStore } from "../journal/raw.ts";
import type { AuthSnapshot } from "../journal/auth.ts";
import { VOLATILE } from "../journal/replay.ts";
import { endpointKey, endpointOf } from "../journal/digest.ts";
import { replayHeaders } from "../journal/replay-core.ts";
import { STEP_TIMEOUT_MS } from "../utils/constants.ts";
import { siteOfUrl } from "../utils/url.ts";
import type { AgentWindows } from "./window.ts";

/** 一次运行（或一次探索）用到的页面：绑定到 tabbot agent 窗口里的一个标签页，站点（origin）变了就换一个。 */
export class Session {
  tab: number | undefined;
  origin: string | undefined;
  lastUsed = Date.now();
  /** 所在的 agent 窗口：学习窗口的句柄，或 run 窗口的名字。 */
  readonly key: string;
  /** 组合实现（run --compose，或 @compose 的 action）：只许调用 action，任何页面操作都拒绝。 */
  composeOnly = false;
  /** 试运行：非 GET 的 request 不真发，只记下将发送的内容。 */
  dry = false;
  readonly dryLog: string[] = [];
  /** 这次 run 里真跑成功的草稿（action 文件路径），run 结束后由命令层判断晋升。嵌套调用并进父 session。 */
  readonly draftsOk: string[] = [];
  /** 已经为取请求头自动打开过首页的站点（每个站点只打开一次）。 */
  readonly warmed = new Set<string>();
  constructor(key: string) { this.key = key; }
}

/** request 的请求头从哪来（不含值）：inheritedFrom 是继承的那个原始请求；auth 是声明了来源的头；signatureMismatch 见 RunHost.sourceOf。 */
export type RequestSource = { inheritedFrom?: { method: string; endpoint: string; url: string }; auth: Record<string, string>; signatureMismatch?: { headers: string[]; changed: string[] } };

/** run 失败时的页面现场。 */
export type FailurePage = { url: string; title: string; screenshot?: string };

export type HostDeps = { link: Pick<ExtensionLink, "request">; win: AgentWindows; ingest: Ingestor; raw: RawStore };

/** 请求头里带身份信息的那些：继承页面自己的请求头时优先挑带这些的请求。 */
const CREDENTIAL = /auth|csrf|xsrf|token|^x-/i;
const NAVIGATED = /frame.*(removed|detached)|context.*(destroyed|invalidated)|navigat|Cannot access contents|No tab with id/i;
const originOf = (url: string): string => new URL(url).origin;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} 超过 ${Math.round(ms / 1000)} 秒`)), ms); })]).finally(() => clearTimeout(timer));
}

/**
 * action 与探索命令共用的页面操作。每个操作都在 tabbot agent 窗口的标签页里执行，并且都记进日志（来源 agent 的 cmd 行）：
 * 做过的事就是知识——写 action 从这些记录来。
 */
export class RunHost {
  private readonly d: HostDeps;
  private readonly byTab = new Map<number, Session>();
  constructor(deps: HostDeps) { this.d = deps; }

  /** 把 session 绑到 origin 的标签页：已经是就复用，否则还回去再拿一个（池里有同站点空闲的就直接用）。 */
  async bind(s: Session, origin: string): Promise<number> {
    s.lastUsed = Date.now();
    // 不再每次列标签页确认还在：标签页被关了，callTab 会发现并重新拿
    if (s.tab !== undefined && s.origin === origin) return s.tab;
    if (s.tab !== undefined) this.d.win.release(s.tab);
    s.tab = await this.d.win.acquire(origin, s.key);
    s.origin = origin;
    this.byTab.set(s.tab, s);
    return s.tab;
  }

  /** run 失败时留一张现场：当前页面的 URL、标题和截图（存成 file，扩展名按图片类型）。没有页面、或任何一步失败就返回 undefined，不影响原来的错误。 */
  async failureShot(s: Session, file: string): Promise<FailurePage | undefined> {
    if (s.tab === undefined) return undefined;
    const tab = s.tab;
    try {
      const info = ((await this.d.link.request("tabs")) as { tabs: { tabId: number; url: string; title: string }[] }).tabs.find((t) => t.tabId === tab);
      let shot: string | undefined;
      try {
        await this.d.win.activate(tab);
        const r = (await withTimeout(this.d.link.request("screenshot", { tabId: tab }), STEP_TIMEOUT_MS, "截图")) as { data: string; mime: string };
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        shot = `${file}.${r.mime.includes("png") ? "png" : "jpg"}`;
        fs.writeFileSync(shot, Buffer.from(r.data, "base64"), { mode: 0o600 });
      } catch { /* 截不了也给 URL */ }
      if (!info && !shot) return undefined;
      return { url: info?.url ?? "", title: info?.title ?? "", ...(shot ? { screenshot: shot } : {}) };
    } catch { return undefined; }
  }

  async end(s: Session): Promise<void> {
    if (s.tab !== undefined) this.d.win.release(s.tab);
    s.tab = undefined;
    s.origin = undefined;
  }

  private page(s: Session): number {
    if (s.tab === undefined) throw new Error("还没有打开页面：先 goto（学习窗口里 tabbot learn <句柄> open <网址>）");
    s.lastUsed = Date.now();
    return s.tab;
  }

  async callTab(tab: number, fn: string, args: unknown[]): Promise<any> {
    try {
      await this.d.win.activate(tab);
      const res = (await this.d.link.request("call", { tabId: tab, fn, args })) as { v: unknown };
      return res.v;
    } catch (e) {
      // 标签页被关了（用户关了窗口、被回收）：在同一个站点重新拿一个再试一次
      const s = this.byTab.get(tab);
      if (!/No tab with id/.test(e instanceof Error ? e.message : String(e)) || !s || !s.origin || s.tab !== tab) throw e;
      s.tab = undefined;
      const fresh = await this.bind(s, s.origin);
      await this.d.win.activate(fresh);
      const res = (await this.d.link.request("call", { tabId: fresh, fn, args })) as { v: unknown };
      return res.v;
    }
  }

  private log<T>(tab: number, verb: string, target: string, detail: Record<string, unknown>, run: () => Promise<T>, after?: (r: T) => Record<string, unknown>, site?: string): Promise<T> {
    // 命令记在它所在页面的站点里：goto 时标签页还没报上来，由调用方给；其余用标签页绑定的站点
    const ref = this.d.ingest.beginCmd(tab, Date.now(), verb, target, detail, site ?? (siteOfUrl(this.byTab.get(tab)?.origin) || undefined));
    return run().then(
      (r) => { this.d.ingest.endCmd(ref, { detail: { ...detail, ...(after?.(r) ?? {}), ok: true } }); return r; },
      (e: unknown) => { this.d.ingest.endCmd(ref, { detail: { ...detail, ok: false, error: e instanceof Error ? e.message : String(e) } }); throw e; },
    );
  }

  async op(s: Session, name: string, a: any): Promise<unknown> {
    if (s.composeOnly) throw new Error(`组合代码里只能调用 action（action("名字", 参数)），不能操作页面：缺的 action 先 tabbot learn 学会`);
    switch (name) {
      case "goto": return this.goto(s, a);
      case "request": return this.request(s, a);
      case "act": return this.act(s, a);
      case "pointer": return this.act(s, a, "pointer");
      case "screenshot": return this.screenshot(s);
      case "waitFor": return this.waitFor(s, a);
      case "text": { const tab = this.page(s); return this.callTab(tab, "text", [a.max ?? 20_000]); }
      case "query": { const tab = this.page(s); return this.callTab(tab, "query", [a]); }
      case "eval": { const tab = this.page(s); return this.log(tab, "eval", String(a.src).slice(0, 60), { src: String(a.src).slice(0, 2000) }, () => this.callTab(tab, "eval", [a])); }
      default: throw new Error(`未知操作 ${name}`);
    }
  }

  private async goto(s: Session, a: { url: string; timeout?: number; description?: string }): Promise<{ url: string; title: string }> {
    let url: URL;
    try { url = new URL(a.url.includes("://") ? a.url : `https://${a.url}`); if (!/^https?:$/.test(url.protocol)) throw new Error("协议"); } catch { throw new Error(`不是有效的网址：${a.url}`); }
    const tab = await this.bind(s, url.origin);
    await this.d.win.activate(tab);
    const safe = this.d.ingest.sanitizer.url(url.href);
    return this.log(tab, "goto", safe.bareUrl, { bareUrl: safe.bareUrl, query: safe.query, ...(a.description ? { description: a.description } : {}) }, async () => {
      let res = (await withTimeout(this.d.link.request("goto", { tabId: tab, url: url.href, wait: true }), a.timeout ?? STEP_TIMEOUT_MS, "打开页面")) as { url: string; title: string; loaded?: boolean };
      // 新开的标签页还在加载占位的 robots.txt 时，这次跳转会被它盖掉：停在占位页上就再跳一次
      if (/\/robots\.txt$/.test(res.url) && !/\/robots\.txt$/.test(url.pathname)) res = (await withTimeout(this.d.link.request("goto", { tabId: tab, url: url.href, wait: true }), a.timeout ?? STEP_TIMEOUT_MS, "打开页面")) as typeof res;
      this.d.win.moved(tab, originOf(res.url || url.href));
      s.origin = originOf(res.url || url.href);
      return { url: res.url, title: res.title };
    }, undefined, siteOfUrl(url.href) || undefined);
  }

  private async request(s: Session, a: { url: string; method?: string; headers?: Record<string, string>; json?: unknown; body?: string; inherit?: boolean; inheritFrom?: string; auth?: Record<string, string>; pageOrigin?: string; timeout?: number }): Promise<unknown> {
    const method = (a.method ?? (a.json !== undefined || a.body !== undefined ? "POST" : "GET")).toUpperCase();
    let target: URL;
    try { target = new URL(a.url); } catch { throw new Error(`request 需要完整的网址：${a.url}`); }
    const origin = a.pageOrigin ? originOf(a.pageOrigin) : target.origin;
    const tab = await this.bind(s, origin);
    const headers: Record<string, string> = {};
    let fromEntry: RawEntry | undefined;
    if (a.inheritFrom) {
      // 签名和接口绑定的站点（如知乎 x-zse-96）：只从这个接口最近一次的原始请求继承，别的接口的签名会被拒
      const from = this.newestOf(target.origin, a.inheritFrom);
      if (!from) throw new Error(`没有 ${a.inheritFrom} 的请求可以继承请求头：先 goto 会自己发这个请求的页面（等它发出），再 request`);
      fromEntry = from;
      Object.assign(headers, replayHeaders(from.headers));
    } else if (a.inherit !== false) {
      const sameOrigin = (e: { url: string }): boolean => { try { return originOf(e.url) === target.origin; } catch { return false; } };
      // 优先取带身份信息的（authorization、csrf、x-* 之类）最近一次，没有再取任何带头的
      const find = () => this.d.raw.newest((e) => sameOrigin(e) && Object.keys(replayHeaders(e.headers)).some((k) => CREDENTIAL.test(k)))
        ?? this.d.raw.newest((e) => sameOrigin(e) && Object.keys(replayHeaders(e.headers)).length > 0);
      let seen = find();
      // 内存里没有（holder 重启过，或页面还没发过请求）：打开该站点的首页，让页面自己发请求，每个站点只试一次
      if (!seen && !s.warmed.has(target.origin)) {
        s.warmed.add(target.origin);
        await this.goto(s, { url: `${target.origin}/` }).catch(() => {});
        await new Promise((r) => setTimeout(r, 300)); // 页面消息经扩展到 holder 要一小会儿
        this.d.ingest.flush();
        seen = find();
      }
      if (seen) { fromEntry = seen; Object.assign(headers, replayHeaders(seen.headers)); }
      else if (a.inherit === true) throw new Error(`没有可继承的请求头：已经打开过 ${target.origin} 的首页，页面也没有发出带身份头的请求；这个站点的接口可能不需要，去掉 inherit，或手写 headers`);
    }
    // 声明了来源的头：发送时现读（cookie、存储、meta 在页面里读，from: 按接口从原始请求取），取不到就报错，不静默发出去
    const auth = Object.fromEntries(Object.entries(a.auth ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const pageSpecs: Record<string, string> = {};
    for (const [h, spec] of Object.entries(auth)) {
      if (!spec.startsWith("from:")) { pageSpecs[h] = spec; continue; }
      const from = this.newestOf(target.origin, spec.slice(5));
      const v = from ? Object.entries(from.headers).find(([k]) => k.toLowerCase() === h)?.[1] : undefined;
      if (v === undefined) throw new Error(`取不到请求头 ${h}（${spec}）：没有这个接口的请求，或它没带这个头；先 goto 会发这个请求的页面`);
      headers[h] = v;
    }
    if (Object.keys(pageSpecs).length) {
      const vals = (await this.callTab(tab, "authRead", [pageSpecs])) as Record<string, string | null>;
      for (const [h, spec] of Object.entries(pageSpecs)) {
        if (vals?.[h] == null) throw new Error(`取不到请求头 ${h}（${spec}）：页面里没有这个值（没登录、换了存储位置，或页面不对）`);
        headers[h] = vals[h]!;
      }
    }
    for (const [k, v] of Object.entries(a.headers ?? {})) headers[k.toLowerCase()] = v;
    let body: string | null = null;
    if (a.json !== undefined) { body = JSON.stringify(a.json); headers["content-type"] ??= "application/json"; }
    else if (a.body !== undefined) body = a.body;
    const source = this.sourceOf(fromEntry, auth, a.headers ?? {}, target.href, body);
    const safe = this.d.ingest.sanitizer.url(target.href);
    const shown = safe.bareUrl;
    const ep = endpointOf(target.href, a.json ?? body ?? undefined);
    const endpoint = endpointKey(method, ep.name);
    const detail = { method, endpoint, bareUrl: safe.bareUrl, query: safe.query, ...(a.json !== undefined ? { reqBody: JSON.stringify(this.d.ingest.sanitizer.body(a.json)).slice(0, 4000) } : {}), inherit: a.inheritFrom ?? a.inherit !== false };
    if (s.dry && method !== "GET" && method !== "HEAD") {
      // 打印给 agent 看的是脱敏后的（和日志一样）
      const shownBody = body === null ? "" : (() => { let parsed: unknown = body; try { parsed = JSON.parse(body); } catch { /* 表单或文字 */ } const v = this.d.ingest.sanitizer.body(parsed, true); return typeof v === "string" ? v : JSON.stringify(v); })();
      const shownUrl = Object.keys(safe.query).length ? `${safe.bareUrl}?${new URLSearchParams(safe.query as Record<string, string>)}` : safe.bareUrl;
      s.dryLog.push(`${method} ${shownUrl}${shownBody ? ` ${shownBody.slice(0, 500)}` : ""}`);
      return this.log(tab, "request", `${method} ${shown}`, { ...detail, dry: true }, async () => ({ ok: true, status: 200, ct: "", size: 0, ms: 0, text: "", finalUrl: target.href, dry: true, source }));
    }
    return this.log(tab, "request", `${method} ${shown}`, detail, async () => {
      const res = await withTimeout(this.callTab(tab, "replay", [{ method, url: target.href, headers, body, timeout: a.timeout ?? STEP_TIMEOUT_MS }]), (a.timeout ?? STEP_TIMEOUT_MS) + 3000, "请求");
      if (res.ok === false) throw new Error(`请求失败：${res.error}`);
      return { ...res, source };
    }, (r: any) => ({ status: r.status, size: r.size, ms: r.ms, ...(source.inheritedFrom ? { inheritedFrom: source.inheritedFrom.endpoint } : {}) }));
  }

  /** 这个 origin 上、路径匹配（:id 匹配一段）的最近一次原始请求。 */
  private newestOf(origin: string, path: string): RawEntry | undefined {
    const pattern = new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:id/g, "[^/]+")}$`);
    return this.d.raw.newest((e) => { try { const u = new URL(e.url); return u.origin === origin && pattern.test(u.pathname); } catch { return false; } });
  }

  /**
   * 这次请求的请求头从哪来（给 replay 输出，不含值）：继承自哪个请求、声明了来源的头；
   * 继承来的签名类的头（没被 auth 或显式 headers 盖掉）配上了和它原来不一样的参数，就是 signatureMismatch。
   */
  private sourceOf(from: RawEntry | undefined, auth: Record<string, string>, explicit: Record<string, string>, url: string, body: string | null): RequestSource {
    if (!from) return { auth };
    const safe = this.d.ingest.sanitizer.url(from.url);
    const method = from.method.toUpperCase();
    let fromBody: unknown = from.body ?? undefined;
    try { fromBody = from.body ? JSON.parse(from.body) : undefined; } catch { /* 表单或文字 */ }
    const inheritedFrom = { method, endpoint: endpointKey(method, endpointOf(from.url, fromBody).name), url: safe.bareUrl };
    const own = new Set([...Object.keys(auth), ...Object.keys(explicit).map((k) => k.toLowerCase())]);
    const signed = Object.keys(replayHeaders(from.headers)).filter((k) => VOLATILE.test(k) && !own.has(k));
    const changed: string[] = [];
    try {
      const a = new URL(from.url).searchParams, b = new URL(url).searchParams;
      for (const k of new Set([...a.keys(), ...b.keys()])) if (a.get(k) !== b.get(k)) changed.push(k);
      if (new URL(from.url).pathname !== new URL(url).pathname) changed.splice(0, changed.length, `路径（是另一个接口 ${new URL(from.url).pathname}）`);
    } catch { /* 地址不合法 */ }
    if ((from.body ?? null) !== body) changed.push("请求体");
    return { inheritedFrom, auth, ...(signed.length && changed.length ? { signatureMismatch: { headers: signed, changed } } : {}) };
  }

  /** 页面此刻的 cookie、localStorage、sessionStorage、meta（判断身份头来源用，只在 holder 内存里）。 */
  async authSnapshot(tab: number): Promise<AuthSnapshot | undefined> {
    try { return (await this.callTab(tab, "authSnapshot", [])) as AuthSnapshot; } catch { return undefined; }
  }

  /** 截图（探索用）：返回 { data(base64), mime, w, h }；图上坐标就是页面视口的 CSS 像素。图片本身不进日志。 */
  private async screenshot(s: Session): Promise<{ data: string; mime: string; w: number; h: number }> {
    const tab = this.page(s);
    await this.d.win.activate(tab);
    return this.log(tab, "screenshot", "", {}, async () => (await withTimeout(this.d.link.request("screenshot", { tabId: tab }), STEP_TIMEOUT_MS, "截图")) as { data: string; mime: string; w: number; h: number }, (r) => ({ w: r.w, h: r.h }));
  }

  /** fn 是页面里的执行函数：act 按定位（action 用），pointer 按屏幕坐标（截图探索用）。 */
  private async act(s: Session, a: any, fn: "act" | "pointer" = "act"): Promise<unknown> {
    const tab = this.page(s);
    const cmd = { ...a };
    const at = a.x !== undefined && a.y !== undefined ? `(${a.x},${a.y})` : "";
    const target = a.loc !== undefined ? JSON.stringify(a.loc).slice(0, 60) : at || (a.key ?? a.to ?? "");
    const base = { kind: a.kind, ...(a.loc !== undefined ? { loc: a.loc } : {}), ...(at ? { x: a.x, y: a.y } : {}), ...(a.key ? { key: a.key } : {}), ...(a.dy !== undefined ? { dy: a.dy } : {}), ...(a.to ? { to: a.to } : {}), ...(a.checked !== undefined ? { checked: a.checked } : {}), ...(a.description ? { description: a.description } : {}) };
    return this.log(tab, a.kind, target, base, async () => {
      let res: any;
      try { res = await withTimeout(this.callTab(tab, fn, [cmd]), (a.timeout ?? 10_000) + 5_000, "页面操作"); }
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
    }, (r: any) => ({ loc: r.loc, ...((a.kind === "fill" || a.kind === "type") && r.target?.type !== "password" ? { text: String(a.text ?? "").slice(0, 200) } : {}), ...(a.kind === "select" ? { text: String(a.text ?? "") } : {}), url: r.url }));
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
