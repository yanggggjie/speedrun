import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionLink } from "./extension.ts";
import type { Ingestor, SeenMessage, SeenRequest } from "../record/ingest.ts";
import type { RawEntry, RawStore } from "../record/raw.ts";
import type { AuthSnapshot } from "../record/auth.ts";
import { endpointKey, endpointOf } from "../record/digest.ts";
import { fetchableHeaders, headerKinds, notableHeaders } from "../record/headers.ts";
import { GOTO_WAIT_MS, QUIET_MAX_MS, STEP_TIMEOUT_MS, WAIT_REQUEST_MS } from "../utils/constants.ts";
import { isSameSite, parseUrl, siteOfUrl } from "../utils/url.ts";
import type { AgentWindows } from "./window.ts";

/** 一次运行（或一次 debug）用到的页面：绑定到 speedrun agent 窗口里的一个标签页，站点（origin）变了就换一个。 */
export class Session {
  tab: number | undefined;
  origin: string | undefined;
  lastUsed = Date.now();
  /** 所在的 agent 窗口：debug 窗口的 id，或 run 窗口的名字。 */
  readonly key: string;
  /** compose（~/.speedrun/compose/ 下的文件）：只许调用 action，任何页面操作都拒绝。 */
  composeOnly = false;
  /** 刚 goto 过、还没等过页面安静：request 抄头时这个窗口里还没有同站请求，就先等一次安静。 */
  fresh = false;
  /** 这次 run 里真跑成功的 draft（action 文件路径），run 结束后由命令层判断变成 verified。嵌套调用并进父 session。 */
  readonly draftsOk: string[] = [];
  constructor(key: string) { this.key = key; }
}

/** request 的请求头从哪来（只有名字）：from 抄自这次窗口里的哪些 endpoint，copied 抄了哪些头，skipped 因为每次都变没抄的，auth 现读的。 */
export type RequestSource = { from: string[]; copied: string[]; skipped: string[]; auth: string[] };


/** 请求头的族：去掉最后一段（x-zse-93、x-zse-96 → x-zse）；只有一段的就是它自己。 */
const familyOf = (name: string): string => (name.split("-").length >= 3 ? name.replace(/-[^-]*$/, "") : name);

/** 被 401/403 拒时给 agent 的说明：抄了什么、没抄什么、下一步。 */
function rejectHint(endpoint: string, status: number, src: RequestSource): string {
  const copied = src.copied.length ? `抄了 ${src.from.join("、")} 的 ${src.copied.join("、")}` : "这次窗口里没有可抄的请求头（只带了 cookie）";
  const skipped = src.skipped.length ? `；没抄 ${src.skipped.join("、")}（这次窗口里每次都变、按 endpoint 变，或和它们同一族）` : "";
  return `${endpoint} 被拒（${status}）：${copied}${skipped}。像是登录失效就请用户登录后重跑；页面这次没发带某个头的请求的，看 debug 窗口观察里「请求头」给的来源写进 request 的 auth；每次都变的头被拒的，改用 waitRequest（goto 带参数的页面或点一下，收页面自己发的请求）或 DOM`;
}

/** run 失败时的页面现场。 */
export type FailurePage = { url: string; title: string; screenshot?: string };

type Wait = { key: string; method: string; path: string; pattern: RegExp; others: string[]; hit?: SeenRequest; resolve?: (r: SeenRequest | undefined) => void };
type MessageWait = { key: string; url: string; match?: string; hit?: SeenMessage; resolve?: (m: SeenMessage | undefined) => void };
/** 不算进「已发出的非 GET 请求」的方法。 */
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const pathOf = (url: string): string => { try { return new URL(url).pathname; } catch { return url.split("?")[0]!; } };

export type HostDeps = { link: Pick<ExtensionLink, "request">; win: AgentWindows; ingest: Ingestor; raw: RawStore };

const NAVIGATED = /frame.*(removed|detached)|context.*(destroyed|invalidated)|navigat|Cannot access contents|No tab with id/i;
const originOf = (url: string): string => new URL(url).origin;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} 超过 ${Math.round(ms / 1000)} 秒`)), ms); })]).finally(() => clearTimeout(timer));
}

/**
 * action 与 debug 命令共用的页面操作。每个操作都在 speedrun agent 窗口的标签页里执行，并且都记进日志（来源 agent 的 cmd 行）：
 * 做过的事都记下来——写 action 从这些记录来。
 */
export class RunHost {
  private readonly d: HostDeps;
  private readonly byTab = new Map<number, Session>();
  /** waitRequest 登记的等待：只收登记之后、这个 agent 窗口里发出的请求。 */
  private readonly waits = new Map<number, Wait>();
  private nextWait = 1;
  /** 这个窗口里被拦下的系统弹窗（离开确认、alert、confirm、prompt）：run 结束时列给 agent。 */
  private readonly dialogs = new Map<string, string[]>();
  /** waitMessage 登记的等待：只收登记之后、这个窗口收到的 WebSocket 和事件流消息。 */
  private readonly messageWaits = new Map<number, MessageWait>();
  /** 正在统计非 GET 请求的窗口（run 窗口的名字）：endpoint → 次数。 */
  private readonly sent = new Map<string, Map<string, number>>();
  /** 每个窗口最近一次被 401/403 拒的说明。 */
  private readonly rejected = new Map<string, string>();
  constructor(deps: HostDeps) {
    this.d = deps;
    deps.ingest.onRequest?.((r) => this.seen(r));
    deps.ingest.onMessage?.((m) => this.heard(m));
    deps.ingest.onDialog?.((win, note) => { const l = this.dialogs.get(win) ?? []; if (l.length < 20) l.push(note); this.dialogs.set(win, l); });
  }

  /**
   * 从现在起统计这个窗口发出的非 GET 请求（request() 发的，和页面自己发的）。只看方法、不判断有没有副作用：
   * 那是 agent 的判断，speedrun 只列出实际发了什么，让 agent 核对有没有意料之外的、并告诉用户。
   */
  watchSent(key: string): void { this.sent.set(key, new Map()); }
  /** 停止统计，返回 `POST /api/x ×2` 这样的几行；没有就是空。 */
  takeSent(key: string): string[] {
    if (this.sent.has(key)) this.d.ingest.flush(); // 页面自己发的请求可能还在收录队列里
    const m = this.sent.get(key);
    this.sent.delete(key);
    return m ? [...m].map(([ep, n]) => `${ep} ×${n}`) : [];
  }
  private noteSent(key: string, method: string, endpoint: string): void {
    const m = this.sent.get(key);
    if (!m || READ_METHODS.has(method.toUpperCase())) return;
    m.set(endpoint, (m.get(endpoint) ?? 0) + 1);
  }

  private seen(r: SeenRequest): void {
    if (!r.noise) this.noteSent(r.win, r.method, r.endpoint);
    for (const w of this.waits.values()) {
      if (w.key !== r.win) continue;
      if (!r.noise) w.others.push(r.endpoint); // 超时时列给 agent 看的，埋点广告不列
      if (w.hit || r.method !== w.method || !(r.endpoint === `${w.method} ${w.path}` || w.pattern.test(pathOf(r.url)))) continue;
      w.hit = r;
      w.resolve?.(r);
    }
  }

  /** 取走这个窗口被拦下的系统弹窗。 */
  takeDialogs(key: string): string[] {
    this.d.ingest.flush();
    const l = this.dialogs.get(key) ?? [];
    this.dialogs.delete(key);
    return l;
  }

  private heard(m: SeenMessage): void {
    for (const w of this.messageWaits.values()) {
      if (w.hit || w.key !== m.win || !m.url.includes(w.url) || (w.match !== undefined && !m.data.includes(w.match))) continue;
      w.hit = m;
      w.resolve?.(m);
    }
  }

  private async messageEnd(a: { id: number; timeout?: number }): Promise<{ url: string; channel: string; data: string }> {
    const w = this.messageWaits.get(Number(a.id));
    if (!w) throw new Error("waitMessage 的等待已经结束");
    const ms = a.timeout ?? WAIT_REQUEST_MS;
    try {
      const m = w.hit ?? await new Promise<SeenMessage | undefined>((resolve) => { w.resolve = resolve; setTimeout(() => resolve(undefined), ms); });
      if (!m) throw new Error(`等了 ${Math.round(ms / 1000)} 秒没等到 ${w.url} 的消息${w.match !== undefined ? `（要含「${w.match}」）` : ""}`);
      return { url: this.d.ingest.sanitizer.url(m.url).bareUrl, channel: m.channel, data: m.data };
    } finally { this.messageWaits.delete(Number(a.id)); }
  }

  /**
   * 在页面里执行一个函数，不记时间线、不算命令：debug 的页面函数快照和 trace 用，它们不是 agent 的操作，不能抢走请求的因果。
   * fn 只能用自己的参数；没有页面时返回 undefined。
   */
  async peek<T>(s: Session, fn: (...args: never[]) => T, args: unknown[] = []): Promise<T | undefined> {
    if (s.tab === undefined) return undefined;
    const done = this.d.win.busy(s.tab);
    try { return ((await withTimeout(this.d.link.request("evaluate", { tabId: s.tab, src: fn.toString(), args }), STEP_TIMEOUT_MS, "evaluate")) as { v: T }).v; }
    finally { done(); }
  }

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
    for (const [id, w] of this.waits) if (w.key === s.key) this.waits.delete(id); // action 中途失败没等完的
    for (const [id, w] of this.messageWaits) if (w.key === s.key) this.messageWaits.delete(id);
    if (s.tab !== undefined) this.d.win.release(s.tab);
    s.tab = undefined;
    s.origin = undefined;
    // 窗口关掉（run 结束、debug close）：这个窗口的原始请求一起清掉
    this.d.raw.dropWindow(s.key);
    this.rejected.delete(s.key);
  }

  private page(s: Session): number {
    if (s.tab === undefined) throw new Error("还没有打开页面：action 第一步先 navigate(url)；debug 窗口里用 spr debug <compose> navigate <网址>");
    s.lastUsed = Date.now();
    return s.tab;
  }

  async callTab(tab: number, fn: string, args: unknown[]): Promise<any> {
    const done = this.d.win.busy(tab);
    try {
      const res = (await this.d.link.request("call", { tabId: tab, fn, args })) as { v: unknown };
      return res.v;
    } catch (e) {
      // 标签页被关了（用户关了窗口、被回收）：在同一个站点重新拿一个再试一次
      const s = this.byTab.get(tab);
      if (!/No tab with id/.test(e instanceof Error ? e.message : String(e)) || !s || !s.origin || s.tab !== tab) throw e;
      s.tab = undefined;
      const fresh = await this.bind(s, s.origin);
      const res = (await this.d.link.request("call", { tabId: fresh, fn, args })) as { v: unknown };
      return res.v;
    } finally {
      done();
    }
  }

  private log<T>(tab: number, verb: string, target: string, detail: Record<string, unknown>, run: () => Promise<T>, after?: (r: T) => Record<string, unknown>, site?: string): Promise<T> {
    // 命令记在它所在页面的站点里：goto 时标签页还没报上来，由调用方给；其余用标签页绑定的站点
    const ref = this.d.ingest.beginCmd(tab, Date.now(), verb, target, detail, site ?? (siteOfUrl(this.byTab.get(tab)?.origin) || undefined));
    const done = this.d.win.busy(tab); // 操作期间组不算闲置（不会被解除附着）
    return run().then(
      (r) => { this.d.ingest.endCmd(ref, { detail: { ...detail, ...(after?.(r) ?? {}), ok: true } }); return r; },
      (e: unknown) => { this.d.ingest.endCmd(ref, { detail: { ...detail, ok: false, error: e instanceof Error ? e.message : String(e) } }); throw e; },
    ).finally(done);
  }

  async op(s: Session, name: string, a: any): Promise<unknown> {
    if (s.composeOnly) throw new Error(`compose 代码里只能调用 action（action("名字", 参数)），不能操作页面：缺的 action 用 spr debug 写好`);
    switch (name) {
      case "navigate": return this.navigate(s, a);
      case "request": return this.request(s, a);
      case "input": return this.input(s, a);
      case "screenshot": return this.screenshot(s, a);
      case "waitFor": return this.waitFor(s, a);
      case "read_page": { const tab = this.page(s); return this.callTab(tab, "readPage", [a]); }
      case "find": { const tab = this.page(s); return this.callTab(tab, "findElements", [a]); }
      case "get_page_text": { const tab = this.page(s); return this.callTab(tab, "pageText", [{ max: a.max ?? 20_000 }]); }
      case "query": { const tab = this.page(s); return this.callTab(tab, "query", [a]); }
      case "waitStart": return this.waitStart(s, a);
      case "waitEnd": return this.waitEnd(s, a);
      case "waitCancel": { this.waits.delete(Number(a.id)); return {}; }
      case "messageStart": { const id = this.nextWait++; this.messageWaits.set(id, { key: s.key, url: String(a.url), ...(a.match !== undefined ? { match: String(a.match) } : {}) }); return { id }; }
      case "messageEnd": return this.messageEnd(a);
      case "messageCancel": { this.messageWaits.delete(Number(a.id)); return {}; }
      case "eval": {
        const tab = this.page(s);
        return this.log(tab, "eval", String(a.src).slice(0, 60), { src: String(a.src).slice(0, 2000) }, async () => {
          return ((await withTimeout(this.d.link.request("evaluate", { tabId: tab, src: a.src, args: a.args ?? [] }), STEP_TIMEOUT_MS, "evaluate")) as { v: unknown }).v;
        });
      }
      default: throw new Error(`未知操作 ${name}`);
    }
  }

  /** 登记要等的请求（"POST /api/list"，:id 匹配一段），返回编号；之后的触发动作引发的请求才算。 */
  private waitStart(s: Session, a: { endpoint: string }): { id: number } {
    const m = /^\s*([A-Za-z]+)\s+(\S+)\s*$/.exec(String(a.endpoint ?? ""));
    if (!m) throw new Error(`waitRequest 的 endpoint 要写成「方法 路径」，如 "POST /api/list"，收到：${a.endpoint}`);
    const method = m[1]!.toUpperCase(), path = m[2]!.split("?")[0]!;
    const pattern = new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/:id/g, "[^/]+")}$`);
    const id = this.nextWait++;
    this.waits.set(id, { key: s.key, method, path, pattern, others: [] });
    return { id };
  }

  /** 等登记的请求出现，返回它的原始响应；超时报错并列出这段时间发出了哪些请求。 */
  private async waitEnd(s: Session, a: { id: number; timeout?: number }): Promise<unknown> {
    const w = this.waits.get(Number(a.id));
    if (!w || w.key !== s.key) throw new Error("waitRequest 的等待已经失效");
    const ms = a.timeout ?? WAIT_REQUEST_MS;
    const done = s.tab !== undefined ? this.d.win.busy(s.tab) : () => {}; // 等请求期间页面要一直在渲染
    try {
      const r = w.hit ?? await new Promise<SeenRequest | undefined>((resolve) => { w.resolve = resolve; setTimeout(() => resolve(undefined), ms); });
      if (!r) {
        const seen = [...new Set(w.others)].slice(0, 15);
        throw new Error(`等了 ${Math.round(ms / 1000)} 秒没等到 ${w.method} ${w.path}：触发动作之后页面${seen.length ? `发出了 ${seen.join("、")}` : "没有发出请求"}`);
      }
      if (r.error) throw new Error(`${r.endpoint} 请求失败：${r.error}`);
      if (r.truncated) throw new Error(`${r.endpoint} 的响应太大，录制时被截断了，拿不到完整内容：换成 request()，或缩小查询范围`);
      return { status: r.status ?? 0, text: r.body ?? "", ct: r.ct ?? "", url: r.url, requestBody: r.reqBody ?? null, seq: r.seq };
    } finally {
      done();
      this.waits.delete(Number(a.id));
    }
  }

  /** 打开网址，或 back / forward 后退前进（和 navigate 工具一样）；settle 为真再等页面安静。 */
  private async navigate(s: Session, a: { url: string; timeout?: number; settle?: boolean }): Promise<{ url: string; title: string }> {
    if (a.url === "back" || a.url === "forward") return this.history(s, a.url, a);
    let url: URL;
    try { url = new URL(a.url.includes("://") ? a.url : `https://${a.url}`); if (!/^https?:$/.test(url.protocol)) throw new Error("协议"); } catch { throw new Error(`不是有效的网址：${a.url}`); }
    const tab = await this.bind(s, url.origin);
    const safe = this.d.ingest.sanitizer.url(url.href);
    return this.log(tab, "navigate", safe.bareUrl, { bareUrl: safe.bareUrl, query: safe.query }, async () => {
      let res = (await withTimeout(this.d.link.request("goto", { tabId: tab, url: url.href, wait: true, waitMs: GOTO_WAIT_MS }), a.timeout ?? STEP_TIMEOUT_MS, "打开页面")) as { url: string; title: string; loaded?: boolean };
      // 新开的标签页还在加载占位的 robots.txt 时，这次跳转会被它盖掉：停在占位页上就再跳一次
      if (/\/robots\.txt$/.test(res.url) && !/\/robots\.txt$/.test(url.pathname)) res = (await withTimeout(this.d.link.request("goto", { tabId: tab, url: url.href, wait: true, waitMs: GOTO_WAIT_MS }), a.timeout ?? STEP_TIMEOUT_MS, "打开页面")) as typeof res;
      this.d.win.moved(tab, originOf(res.url || url.href));
      s.origin = originOf(res.url || url.href);
      s.fresh = true;
      if (a.settle) await this.quiet(s);
      return { url: res.url, title: res.title };
    }, undefined, siteOfUrl(url.href) || undefined);
  }

  private async history(s: Session, dir: "back" | "forward", a: { timeout?: number; settle?: boolean }): Promise<{ url: string; title: string }> {
    const tab = this.page(s);
    return this.log(tab, "navigate", dir, { dir }, async () => {
      let res: { url: string; title: string };
      try { res = (await withTimeout(this.d.link.request("history", { tabId: tab, dir, waitMs: GOTO_WAIT_MS }), a.timeout ?? STEP_TIMEOUT_MS, dir === "back" ? "后退" : "前进")) as typeof res; }
      catch (e) { if (/history/i.test(e instanceof Error ? e.message : String(e))) throw new Error(`没有可以${dir === "back" ? "后退" : "前进"}的页面（这个标签页的历史里没有）：用 navigate <网址> 直接打开`); throw e; }
      if (res.url) { s.origin = originOf(res.url); this.d.win.moved(tab, s.origin); }
      s.fresh = true;
      if (a.settle) await this.quiet(s);
      return { url: res.url, title: res.title };
    });
  }

  /**
   * 在页面里发请求。请求头按顺序凑齐：浏览器自己带的（cookie）→ 从这次窗口里页面发过的请求抄 → auth 声明的页面固定位置（发送时现读）→ headers 显式写的。
   * 从页面请求抄：页面发过同一个 endpoint 就整组抄它最近一次的；否则按头名看这次窗口里的同站请求，值都一样的（页面级不变）抄，各不相同的（签名、nonce）不跨 endpoint 抄。
   * 只用这次窗口里的原始请求，不用以前或别的窗口的。
   */
  private async request(s: Session, a: { url: string; method?: string; headers?: Record<string, string>; json?: unknown; body?: string; auth?: Record<string, string>; timeout?: number }): Promise<unknown> {
    const method = (a.method ?? (a.json !== undefined || a.body !== undefined ? "POST" : "GET")).toUpperCase();
    let target: URL;
    try { target = new URL(a.url); } catch { throw new Error(`request 需要完整的网址：${a.url}`); }
    // 在当前页面上发：和它同 origin，或者这个页面在这次窗口里自己往这个 origin 发过请求（跨域是页面本来就在做的，CORS 放行）。
    // 只看注册域名不够：同一个公司域名下的不同产品（a.example.com 和 b.example.com）互不放行跨域，从别的页面发会被 403。其余在请求自己的 origin 上开页面发
    const tab = s.tab !== undefined && s.origin && (s.origin === target.origin || this.pageCalled(s, target.origin)) ? this.page(s) : await this.bind(s, target.origin);
    let body: string | null = null;
    if (a.json !== undefined) body = JSON.stringify(a.json);
    else if (a.body !== undefined) body = a.body;
    const endpoint = endpointKey(method, endpointOf(target.href, a.json ?? body ?? undefined).name);
    const copy = await this.copyHeaders(s, target, endpoint);
    const headers: Record<string, string> = { ...copy.headers };
    // 声明了来源的头：发送时在页面里现读，取不到就报错，不静默发出去
    const auth = Object.fromEntries(Object.entries(a.auth ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    if (Object.keys(auth).length) {
      const vals = (await this.callTab(tab, "authRead", [auth])) as Record<string, string | null>;
      for (const [h, spec] of Object.entries(auth)) {
        if (vals?.[h] == null) throw new Error(`取不到请求头 ${h}（${spec}）：页面里没有这个值（没登录、换了存储位置，或页面不对）`);
        headers[h] = vals[h]!;
      }
    }
    for (const [k, v] of Object.entries(a.headers ?? {})) headers[k.toLowerCase()] = v;
    if (a.json !== undefined) headers["content-type"] ??= "application/json";
    const source = { from: copy.from, copied: Object.keys(copy.headers), skipped: copy.skipped, auth: Object.keys(auth) };
    const safe = this.d.ingest.sanitizer.url(target.href);
    const detail = { method, endpoint, bareUrl: safe.bareUrl, query: safe.query, ...(a.json !== undefined ? { reqBody: JSON.stringify(this.d.ingest.sanitizer.body(a.json)).slice(0, 4000) } : {}), headersFrom: source.from, copied: source.copied, ...(source.skipped.length ? { skipped: source.skipped } : {}) };
    this.noteSent(s.key, method, endpoint);
    const res = await this.log(tab, "request", `${method} ${safe.bareUrl}`, detail, async () => {
      const r = await withTimeout(this.callTab(tab, "fetch", [{ method, url: target.href, headers, body, timeout: a.timeout ?? STEP_TIMEOUT_MS }]), (a.timeout ?? STEP_TIMEOUT_MS) + 3000, "请求");
      if (r.ok === false) throw new Error(`请求失败：${r.error}`);
      return { ...r, source };
    }, (r: any) => ({ status: r.status, size: r.size, ms: r.ms })) as { status?: number };
    if (res.status === 401 || res.status === 403) this.rejected.set(s.key, rejectHint(endpoint, res.status, source));
    return res;
  }

  /** 当前页面（session 的 origin）在这次窗口里是不是自己往 origin 发过请求。 */
  private pageCalled(s: Session, origin: string): boolean {
    return this.d.raw.inWindow(s.key).some((e) => { try { return new URL(e.url).origin === origin && new URL(e.page).origin === s.origin; } catch { return false; } });
  }

  /** 从这次窗口里页面发过的同站请求抄头（刚 goto 的页面可能还没发请求：先等一次页面安静；没打开过页面的不等，只靠 cookie 的站点不被拖慢）。 */
  private async copyHeaders(s: Session, target: URL, endpoint: string): Promise<{ headers: Record<string, string>; from: string[]; skipped: string[] }> {
    const win = s.key;
    const same = (e: RawEntry): boolean => isSameSite(parseUrl(e.url), parseUrl(target.href));
    let entries = this.d.raw.inWindow(win).filter(same);
    if (!entries.length && s.fresh) {
      await this.quiet(s);
      entries = this.d.raw.inWindow(win).filter(same);
    }
    const newest = [...entries].reverse();
    const own = newest.find((e) => e.endpoint === endpoint);
    if (own) return { headers: fetchableHeaders(own.headers), from: [own.endpoint], skipped: [] };
    const headers: Record<string, string> = {}, from = new Set<string>(), skipped: string[] = [];
    const kinds = headerKinds(entries);
    // 和不抄的头同一族（x-zse-93 和 x-zse-96）的也不抄：只带签名族的一半，比都不带更容易被拒（知乎实测 403）
    const off = new Set([...kinds].filter(([, k]) => k === "varies" || k === "endpoint").map(([n]) => familyOf(n)));
    for (const [name, kind] of kinds) {
      if (kind === "varies" || kind === "endpoint" || off.has(familyOf(name))) { skipped.push(name); continue; }
      const e = newest.find((x) => notableHeaders(x.headers)[name] !== undefined)!;
      headers[name] = notableHeaders(e.headers)[name]!;
      from.add(e.endpoint);
    }
    return { headers, from: [...from], skipped };
  }

  /**
   * 等页面安静、记录送达：页面没有在途请求、DOM 一小段时间没变（页面自己判断），并且页面在这之前发出的记录 daemon 都收到了；
   * 合起来不超过 maxMs。页面在这期间跳转了（执行上下文没了）就再试一次新页面。debug 每步之后、request 抄头前、goto / 操作带 settle 时用。
   */
  async quiet(s: Session, maxMs = QUIET_MAX_MS): Promise<{ settled: boolean; waitedMs: number }> {
    s.fresh = false;
    if (s.tab === undefined) return { settled: false, waitedMs: 0 };
    const tab = s.tab, t0 = Date.now();
    for (let attempt = 0; attempt < 2; attempt++) {
      const left = maxMs - (Date.now() - t0);
      if (left <= 0) break;
      let r: { settled: boolean; d: string; n: number };
      try { r = await withTimeout(this.callTab(tab, "quiet", [left]), left + 3000, "等页面安静"); }
      catch (e) {
        // 页面在跳转：调用要么报执行上下文没了，要么一直等到超时（回车提交表单这类由输入引发的跳转）
        const msg = e instanceof Error ? e.message : String(e);
        if (!NAVIGATED.test(msg) && !/等页面安静 超过/.test(msg)) throw e;
        await new Promise((res) => setTimeout(res, 200)); // 页面在跳转：新页面的脚本就位要一小会儿
        continue;
      }
      const arrived = await this.d.ingest.waitDelivered(tab, r.d, r.n, Math.max(0, maxMs - (Date.now() - t0)));
      this.d.ingest.flush();
      return { settled: r.settled && arrived, waitedMs: Date.now() - t0 };
    }
    this.d.ingest.flush();
    return { settled: false, waitedMs: Date.now() - t0 };
  }

  /** 这个窗口最近一次被 401/403 拒的说明（run 失败时接在 hint 里），取过就清掉。 */
  takeRejected(win: string): string | undefined {
    const v = this.rejected.get(win);
    this.rejected.delete(win);
    return v;
  }

  /** 页面此刻的 cookie、localStorage、sessionStorage、meta（判断 auth 来源用，只在 daemon 内存里）。 */
  async authSnapshot(tab: number): Promise<AuthSnapshot | undefined> {
    try { return (await this.callTab(tab, "authSnapshot", [])) as AuthSnapshot; } catch { return undefined; }
  }

  /** 截图（debug 的 computer screenshot / zoom）：region 只要这块，scale 缩小；返回图和视口尺寸。图片本身不进日志。 */
  private async screenshot(s: Session, a: { region?: number[]; scale?: number } = {}): Promise<{ data: string; mime: string; w: number; h: number; vw: number; vh: number }> {
    const tab = this.page(s);
    const args = { tabId: tab, ...(a.region ? { region: a.region } : {}), ...(a.scale ? { scale: a.scale } : {}) };
    return this.log(tab, a.region ? "zoom" : "screenshot", a.region ? a.region.join(",") : "", {}, async () => (await withTimeout(this.d.link.request("screenshot", args), STEP_TIMEOUT_MS, "截图")) as { data: string; mime: string; w: number; h: number; vw: number; vh: number }, (r) => ({ w: r.w, h: r.h }));
  }

  /**
   * 一次输入（debug 的 computer / form_input，和 action 的 click / hover / key / scroll / scroll_to / form_input 共用）：
   * 目标（ref | loc | 坐标）先在页面里换成视口坐标（a11y.js 的 point：滚进视口、查遮挡、给出持久定位），再由扩展用 CDP 发真实输入（cdp.js）。
   * a.action：left_click | right_click | double_click | triple_click | hover | left_click_drag | scroll | scroll_to | key | type | form_input。
   */
  private async input(s: Session, a: any): Promise<unknown> {
    const tab = this.page(s);
    const action = String(a.action);
    const where = a.ref ?? (a.loc !== undefined ? JSON.stringify(a.loc).slice(0, 60) : a.x !== undefined ? `(${a.x},${a.y})` : "");
    const target = action === "key" ? `${a.keys}${where ? ` @${where}` : ""}` : where || (a.direction ?? "");
    const detail = {
      ...(a.ref ? { ref: a.ref } : {}), ...(a.loc !== undefined ? { loc: a.loc } : {}), ...(a.x !== undefined ? { x: a.x, y: a.y } : {}), ...(a.sx !== undefined ? { sx: a.sx, sy: a.sy } : {}),
      ...(a.toRef ? { toRef: a.toRef } : {}), ...(a.toLoc !== undefined ? { toLoc: a.toLoc } : {}), ...(a.keys ? { keys: a.keys } : {}), ...(a.repeat ? { repeat: a.repeat } : {}),
      ...(a.direction ? { direction: a.direction, amount: a.amount } : {}), ...(a.mods ? { mods: a.mods } : {}),
    };
    const to = (t: { ref?: string; loc?: unknown; x?: number; y?: number }) => (t.ref ? { ref: t.ref } : t.loc !== undefined ? { loc: t.loc, timeout: a.timeout } : { x: t.x, y: t.y });
    const send = (args: Record<string, unknown>) => withTimeout(this.d.link.request("input", { tabId: tab, ...args }), STEP_TIMEOUT_MS, "输入");
    const urlNow = async (): Promise<{ url: string; title: string } | undefined> => (await this.d.link.request("tabs") as { tabs: { tabId: number; url: string; title: string }[] }).tabs.find((t) => t.tabId === tab);
    const mayNavigate = ["left_click", "right_click", "double_click", "triple_click", "key", "form_input", "type"].includes(action);
    return this.log(tab, action, String(target), detail, async () => {
      const before = mayNavigate ? (await urlNow())?.url : undefined;
      const res: any = {};
      const pointAt = async (t: Record<string, unknown>) => (await withTimeout(this.callTab(tab, "point", [t]), (a.timeout ?? 10_000) + 5_000, "找元素")) as { x: number; y: number; target?: unknown; loc?: unknown; warning?: string; covered?: string; scrolled?: boolean };
      const keep = (p: { target?: unknown; loc?: unknown; warning?: string; covered?: string; scrolled?: boolean }) => Object.assign(res, { target: p.target, loc: p.loc, ...(p.warning ? { warning: p.warning } : {}), ...(p.covered ? { covered: p.covered } : {}), ...(p.scrolled ? { scrolled: true } : {}) });
      try {
        switch (action) {
          case "left_click": case "right_click": case "double_click": case "triple_click": case "hover": {
            const p = await pointAt(to(a));
            keep(p);
            await send({ action, x: p.x, y: p.y, mods: a.mods });
            break;
          }
          case "left_click_drag": {
            const p = await pointAt(a.ref || a.loc !== undefined ? to(a) : { x: a.sx, y: a.sy });
            keep(p);
            const q = await pointAt(a.toRef ? { ref: a.toRef } : a.toLoc !== undefined ? { loc: a.toLoc } : { x: a.x, y: a.y });
            res.dropTarget = q.target;
            await send({ action, sx: p.x, sy: p.y, x: q.x, y: q.y, mods: a.mods });
            break;
          }
          case "scroll": {
            const n = Math.min(Math.max(1, Number(a.amount) || 3), 10) * 100;
            const [dx, dy] = a.direction === "up" ? [0, -n] : a.direction === "down" ? [0, n] : a.direction === "left" ? [-n, 0] : a.direction === "right" ? [n, 0] : [NaN, NaN];
            if (Number.isNaN(dx)) throw new Error(`scroll 的方向要是 up、down、left、right，收到：${a.direction}`);
            const p = a.ref || a.loc !== undefined || a.x !== undefined ? await pointAt({ ...to(a), scroll: false }) : await pointAt({ center: true });
            res.target = p.target;
            await send({ action, x: p.x, y: p.y, dx, dy, mods: a.mods });
            break;
          }
          case "scroll_to": Object.assign(res, await this.callTab(tab, "scrollTo", [to(a)])); break;
          case "key": {
            if (a.ref || a.loc !== undefined) Object.assign(res, await this.callTab(tab, "focus", [to(a)]));
            await send({ action, keys: a.keys, repeat: a.repeat });
            break;
          }
          case "type": {
            if (a.ref || a.loc !== undefined) Object.assign(res, await this.callTab(tab, "focus", [to(a)]));
            // 焦点在敏感输入框（密码、卡号、验证码）里：照样打字，但日志里不记内容，只记字数
            const f = (await this.callTab(tab, "focusedSensitive", []).catch(() => ({ sensitive: false }))) as { sensitive: boolean };
            if (f.sensitive) res.password = true;
            await send({ action, text: String(a.text ?? "") });
            res.chars = String(a.text ?? "").length;
            break;
          }
          case "form_input": Object.assign(res, await this.formInput(tab, a, to(a), send)); break;
          default: throw new Error(`未知的输入 ${action}`);
        }
      } catch (e) {
        if (!NAVIGATED.test(e instanceof Error ? e.message : String(e))) throw e;
        res.navigated = true;
      }
      if (mayNavigate || res.navigated) {
        // 这一步让页面跳转了（地址变了，同站也算；只改了 #hash 的不算）
        const now = await urlNow();
        if (now) {
          res.url = now.url; res.title = now.title;
          if (before !== undefined && now.url.split("#")[0] !== before.split("#")[0]) res.navigated = true;
          if (/^https?:/.test(now.url) && originOf(now.url) !== s.origin) { s.origin = originOf(now.url); this.d.win.moved(tab, s.origin); res.navigated = true; }
        }
      }
      // 滚轮滚动是异步的：等滚动位置稳定下来再读（最多 600ms）
      if (action === "scroll") {
        try {
          let last = NaN;
          for (let i = 0; i < 6; i++) {
            await new Promise((r) => setTimeout(r, 100));
            const y = ((await this.callTab(tab, "viewport", [])) as { scrollY: number }).scrollY;
            if (y === last) break;
            last = y;
          }
          res.scrollY = last;
        } catch { /* 页面在跳转 */ }
      }
      if (a.settle === true) res.settle = await this.quiet(s);
      return res;
    }, (r: any) => ({ loc: r.loc, ...(action === "type" || action === "form_input" ? (r.password ? { chars: String(a.text ?? a.value ?? "").length, sensitive: true } : { text: String(a.text ?? a.value ?? "").slice(0, 200) }) : {}), url: r.url }));
  }

  /** form_input：文本框点一下、全选、删掉、插入；复选框状态不对就点一下；下拉框在页面里直接设值（原生下拉的选项 CDP 点不到）。最后核对值。 */
  private async formInput(tab: number, a: any, t: Record<string, unknown>, send: (args: Record<string, unknown>) => Promise<unknown>): Promise<Record<string, unknown>> {
    const value = a.value;
    const f = (await this.callTab(tab, "formTarget", [{ ...t, value }])) as { kind: string; x?: number; y?: number; checked?: boolean; target?: unknown; loc?: unknown; value?: string };
    const out: Record<string, unknown> = { target: f.target, loc: f.loc };
    if (f.kind === "select") return { ...out, value: f.value };
    if (f.kind === "check") {
      const want = value === true || value === "true";
      if (f.checked !== want) await send({ action: "left_click", x: f.x, y: f.y });
      const now = (await this.callTab(tab, "checked", [t])) as { checked: boolean };
      if (now.checked !== want) throw new Error(`点了之后复选框还是 ${now.checked ? "勾上" : "没勾"} 的：可能被页面拦住了，用 computer left_click 试`);
      return { ...out, checked: now.checked };
    }
    await send({ action: "left_click", x: f.x, y: f.y });
    await send({ action: "key", keys: process.platform === "darwin" ? "cmd+a" : "ctrl+a" });
    await send({ action: "key", keys: "Backspace" });
    const text = String(value ?? "");
    if (text) await send({ action: "insert", text });
    const now = (await this.callTab(tab, "valueOf", [t])) as { value: string | null; password?: boolean };
    if (now.password) return { ...out, password: true };
    if (now.value !== null && now.value !== text) throw new Error(`填完之后输入框里是「${String(now.value).slice(0, 60)}」，不是要的「${text.slice(0, 60)}」：页面可能改写了输入（自动补全、格式化），截图看一下`);
    return { ...out, value: text };
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
