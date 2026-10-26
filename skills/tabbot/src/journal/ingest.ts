import type { FiltersEngine } from "@ghostery/adblocker";
import { isSameSite, parseUrl, siteOfUrl } from "../utils/url.ts";
import { actionLabel, endpointOf } from "./digest.ts";
import type { EndpointIndex } from "./endpoints.ts";
import { noiseReason, shouldStoreBody } from "./filter.ts";
import type { RawStore } from "./raw.ts";
import { bodyExt, hashText, requestBodyValue, requestStem, responseText } from "./reqfile.ts";
import { Sanitizer } from "./sanitize.ts";
import type { SiteLog } from "./sitelog.ts";
import { USER_WIN, type ParsedUrl, type Phase, type RequestFile, type Row, type Src } from "./types.ts";

/** 扩展转来的一条页面消息：页面脚本产出，扩展补上 tab / frame / top / page。 */
export type PageMsg = { k: string; t: number; tab: number; frame?: number; top?: boolean; page?: string } & Record<string, unknown>;

/** 人的事件或 agent 的命令之后这段时间内开始的请求，记为它引发的。 */
const CAUSE_MS = 2_000;
/** 页面（文档或单页应用路由）刚开始的这几秒里发出的请求，阶段记为 load。 */
const LOAD_MS = 4_000;
const FLUSH_MS = 100;
/** 站点判断不出来的行（chrome:// 页面的命令记录等）放在这个目录里。 */
export const OTHER_SITE = "_other";
const MAX_TAB_STATE = 2_000;

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function targetText(t: unknown): string {
  if (!t || typeof t !== "object") return "";
  const o = t as { tag?: string; role?: string; text?: string; sel?: string };
  const name = (o.role || o.tag || "").trim();
  const text = (o.text ?? "").trim();
  return text ? `${name}[${text.slice(0, 30)}]` : `${name}${o.sel ? `(${o.sel.split(">").pop()})` : ""}`;
}

function trimMap<K, V>(map: Map<K, V>): void {
  if (map.size > MAX_TAB_STATE) map.delete(map.keys().next().value as K);
}

export type IngestOptions = {
  engine?: () => FiltersEngine | undefined;
  aliasKey?: string;
  raw?: RawStore;
  /** 标签页所在的窗口：user、run、debug-xxxx。agent 窗口里的页面事件记为 agent 的（不是用户做的）。 */
  winOf?: (tab: number) => string;
  /** 接口聚合：每写一个请求就通知它。 */
  index?: EndpointIndex;
};

/** beginCmd 返回的句柄：编号已经预留，行在 endCmd 时才写。 */
export type CmdRef = { seq: number; site: string; win: string; tab: number; ts: number; verb: string; target: string; detail?: Record<string, unknown> };
type LastAction = { seq: number; ts: number; label: string };

export class Ingestor {
  readonly sanitizer: Sanitizer;
  private readonly log: SiteLog;
  private readonly engine: () => FiltersEngine | undefined;
  private readonly raw: RawStore | undefined;
  private readonly winOf: (tab: number) => string;
  private readonly index: EndpointIndex | undefined;
  private readonly tabSite = new Map<number, string>();
  private readonly lastAction = new Map<number, LastAction>();
  private readonly lastNav = new Map<number, number>();
  private queue: PageMsg[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(log: SiteLog, options: IngestOptions = {}) {
    this.log = log;
    this.sanitizer = new Sanitizer(options.aliasKey ?? "");
    this.engine = options.engine ?? (() => undefined);
    this.raw = options.raw;
    this.winOf = options.winOf ?? (() => USER_WIN);
    this.index = options.index;
  }

  /** 这个标签页最近所在的站点（页面脚本报上来的）。 */
  siteOfTab(tab: number): string | undefined { return this.tabSite.get(tab); }

  /** 收一条页面消息：攒一小会儿，一批放进一次写入。 */
  push(msg: PageMsg): void {
    this.queue.push(msg);
    this.timer ??= setTimeout(() => this.flush(), FLUSH_MS);
  }

  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const msgs = this.queue;
    this.queue = [];
    if (msgs.length) this.handleBatch(msgs);
  }

  /** 一批消息放进一次写入。单条出错不影响其它。 */
  handleBatch(msgs: PageMsg[]): void {
    this.log.batch(() => {
      for (const msg of msgs) {
        try { this.handle(msg); } catch { /* 坏消息丢掉，不让它挡住整批 */ }
      }
    });
  }

  // ---- agent 的命令 ----

  /** agent 的命令开始：先预留编号（命令引发的请求会指向它），行在 endCmd 时写。site 是命令的站点（goto 时标签页还没报上来，由调用方给）。 */
  beginCmd(tab: number, ts: number, verb: string, target: string, detail?: Record<string, unknown>, site?: string): CmdRef {
    const seq = this.log.reserve();
    if (site) { this.tabSite.set(tab, site); trimMap(this.tabSite); }
    const ref: CmdRef = { seq, site: site ?? this.tabSite.get(tab) ?? OTHER_SITE, win: this.winOf(tab), tab, ts, verb, target, detail };
    this.lastAction.set(tab, { seq, ts, label: `agent cmd ${verb} ${target}`.trim() });
    trimMap(this.lastAction);
    return ref;
  }

  /** 命令做完：写这一行，带上元素描述和结果。 */
  endCmd(ref: CmdRef, fields: { target?: string; size?: number; detail?: Record<string, unknown> }): void {
    const { ok, error, ...rest } = { ...(fields.detail ?? ref.detail ?? {}) } as Record<string, unknown>;
    const row: Row = {
      seq: ref.seq, t: ref.ts, win: ref.win, src: "agent", tab: ref.tab, type: "cmd", actionType: ref.verb, target: fields.target ?? ref.target,
      ...(fields.size !== undefined ? { size: fields.size } : {}),
      ...(typeof ok === "boolean" ? { ok } : {}), ...(typeof error === "string" ? { error } : {}),
      ...(Object.keys(rest).length ? { detail: rest } : {}),
    };
    this.log.batch(() => this.log.append(ref.site, row));
  }

  /**
   * 记一次重放：agent 的一个请求（requestType 为 replay），响应体存成文件；返回给 CLI 看的预览。
   * `rawUrl` 是实际发出的地址（含查询参数里的秘密），这里脱敏成别名再写日志。--set 的值可能是秘密，所以只记名字不记值。
   */
  recordReplay(tab: number, ts: number, info: { site: string; page?: string; method: string; rawUrl: string; replayOf: number; setKeys: string[]; headers?: Record<string, string>; status?: number; ct?: string; size?: number; text?: string; ms?: number; error?: string; reqBody?: string }): { seq: number; bodyFile?: string; preview: string; endpoint: string } {
    return this.log.batch(() => {
      const seq = this.log.reserve();
      const win = this.winOf(tab);
      const url = this.sanitizer.url(info.rawUrl);
      const body = requestBodyValue(this.sanitizer, info.reqBody, info.headers);
      const endpoint = `${info.method} ${endpointOf(info.rawUrl, info.reqBody).name}`;
      const stem = requestStem(seq, info.method, url.bareUrl);
      let preview = "";
      let responseBodyPath: string | undefined;
      if (info.text) {
        preview = responseText(this.sanitizer, info.text, info.ct);
        responseBodyPath = this.log.putBody(info.site, `${stem}.response.${bodyExt(info.ct, preview)}`, preview, hashText(preview));
      }
      const file: RequestFile = {
        seq, win, endpoint, requestType: "replay", tab, replayOf: info.replayOf, set: info.setKeys,
        method: info.method, url, ...(info.page ? { frameUrl: this.sanitizer.url(info.page) } : {}), headers: {},
        ...(body.value !== undefined ? { requestBody: body.value } : {}), ...(body.truncated ? { requestBodyTruncated: true } : {}),
        ...(info.status !== undefined ? { status: info.status } : {}), ...(info.ct ? { responseHeaders: { "content-type": info.ct } } : {}),
        ...(responseBodyPath ? { responseBodyPath } : {}), ...(info.size !== undefined ? { responseSize: info.size } : {}),
        ...(info.error ? { error: info.error } : {}),
        startedAt: ts, endedAt: ts + (info.ms ?? 0),
      };
      const rel = this.log.putFile(info.site, `${stem}.json`, JSON.stringify(file, null, 2));
      this.log.append(info.site, { seq, t: ts, win, src: "agent", tab, type: "request", requestType: "replay", method: info.method, url: url.bareUrl, endpoint, ...(info.status !== undefined ? { status: info.status } : {}), ...(info.size !== undefined ? { size: info.size } : {}), replayOf: info.replayOf, file: rel });
      return { seq, bodyFile: responseBodyPath, preview, endpoint };
    });
  }

  // ---- 页面消息 ----

  private handle(msg: PageMsg): void {
    const page = msg.page ? parseUrl(msg.page).bareUrl : undefined;
    const pageSite = siteOfUrl(msg.page);
    if (pageSite) { this.tabSite.set(msg.tab, pageSite); trimMap(this.tabSite); }
    switch (msg.k) {
      case "net": return this.net(msg, page);
      case "ev": return this.input(msg, page);
      case "nav": {
        const url = this.bare(str(msg.url) ?? "");
        const site = siteOfUrl(str(msg.url)) || pageSite;
        if (site) this.tabSite.set(msg.tab, site);
        this.lastNav.set(msg.tab, msg.t);
        trimMap(this.lastNav);
        return void this.emit(site, msg, { type: "nav", src: "page", via: str(msg.via) ?? "nav", url, ...(page ? { page } : {}) });
      }
      case "snap": return this.snap(msg, page);
      case "doc": return this.doc(msg, page);
      case "bg": return void this.emit(pageSite, msg, { type: "bg", src: "page", count: num(msg.n), ...(page ? { page } : {}) });
      case "tab": {
        const site = siteOfUrl(str(msg.url)) || pageSite;
        return void this.emit(site, msg, { type: "tab", src: "page", via: str(msg.ev) ?? "tab", url: this.bare(str(msg.url) ?? "") });
      }
    }
  }

  private bare(url: string): string { return parseUrl(url).bareUrl; }

  private siteFor(site: string | undefined, tab: number): string { return site || this.tabSite.get(tab) || OTHER_SITE; }

  /** 写一行：编号、窗口、来源在这里补上。agent 窗口里页面脚本触发的一切记为 agent 的。 */
  private emit(site: string | undefined, msg: PageMsg, row: Partial<Row> & Pick<Row, "type" | "src">): number {
    const win = this.winOf(msg.tab);
    const src: Src = row.src === "page" && win !== USER_WIN ? "agent" : row.src;
    const seq = this.log.reserve();
    this.log.append(this.siteFor(site, msg.tab), { ...row, seq, t: msg.t, win, src, tab: msg.tab, ...(msg.frame ? { frame: msg.frame } : {}) } as Row);
    return seq;
  }

  /** 请求所处的阶段：文档（或单页应用路由）刚开始的几秒里、期间没有新动作，是 load；动作后 2 秒内是 action；其余是 idle。 */
  private phaseOf(tab: number, reqStart: number, at: number | undefined): Phase {
    const act = this.lastAction.get(tab);
    const starts: number[] = [];
    if (at !== undefined && at >= 0) starts.push(reqStart - at);
    const nav = this.lastNav.get(tab);
    if (nav !== undefined) starts.push(nav);
    const start = Math.max(-Infinity, ...starts.filter((s) => s <= reqStart));
    if (Number.isFinite(start) && reqStart - start <= LOAD_MS && (!act || act.ts <= start)) return "load";
    return act && reqStart - act.ts >= 0 && reqStart - act.ts <= CAUSE_MS ? "action" : "idle";
  }

  private net(msg: PageMsg, page: string | undefined): void {
    const rawUrl = str(msg.url) ?? "";
    const rawPage = str(msg.page) ?? "";
    const method = (str(msg.method) ?? "GET").toUpperCase();
    const via = str(msg.via) ?? "fetch";
    const status = num(msg.status);
    const ms = num(msg.ms) ?? 0;
    const reqStart = msg.t - ms;
    const site = this.siteFor(siteOfUrl(rawPage), msg.tab);
    const win = this.winOf(msg.tab);
    const src: Src = win !== USER_WIN ? "agent" : "page";
    const reason = noiseReason({ url: rawUrl, method, status, via, page: rawPage }, this.engine());
    const noise = reason !== null;
    const rawBody = str(msg.body);
    const ct = str(msg.ct);
    const reqHeadersRaw = (msg.reqHeaders && typeof msg.reqHeaders === "object" ? msg.reqHeaders : null) as Record<string, string> | null;
    const rawReqBody = str(msg.reqBody);

    const seq = this.log.reserve();
    const url: ParsedUrl = this.sanitizer.url(rawUrl);
    let bodyJson: unknown;
    if (rawReqBody && /^\s*[[{]/.test(rawReqBody)) { try { bodyJson = JSON.parse(rawReqBody); } catch { /* 不是 JSON */ } }
    const endpoint = `${method} ${endpointOf(rawUrl, bodyJson).name}`;
    const stem = requestStem(seq, method, url.bareUrl);

    // 因果与阶段
    const last = this.lastAction.get(msg.tab);
    const causeDt = last ? reqStart - last.ts : undefined;
    const cause = last && causeDt !== undefined && causeDt >= 0 && causeDt <= CAUSE_MS ? last : undefined;
    const phase = this.phaseOf(msg.tab, reqStart, num(msg.at));

    // 原始请求（含 token 真值）只放内存，重放用；只存同站的、非噪声的
    const rid = str(msg.rid);
    if (rid && this.raw && !noise && !msg.err && isSameSite(parseUrl(rawUrl), parseUrl(rawPage))) {
      this.raw.put(msg.tab, rid, { method, url: rawUrl, headers: reqHeadersRaw ?? {}, body: rawReqBody ?? null, page: rawPage, t: msg.t });
    }

    // 响应体：只写同站的、非噪声的、有内容的；失败的请求只留小响应体（够看出错在哪）
    let responseBodyPath: string | undefined;
    let text: string | undefined;
    let bodyOmitted: string | undefined;
    if (rawBody === undefined) bodyOmitted = msg.err ? "error" : "no-body";
    else if (!shouldStoreBody({ noise, url: rawUrl, page: rawPage, status, body: rawBody })) bodyOmitted = noise ? "noise" : !isSameSite(parseUrl(rawUrl), parseUrl(rawPage)) ? "cross-site" : "large-error";
    else {
      text = responseText(this.sanitizer, rawBody, ct);
      responseBodyPath = this.log.putBody(site, `${stem}.response.${bodyExt(ct, text)}`, text, hashText(text));
    }

    // 请求头：页面脚本把 cookie 抹成了 [redacted]，原样保留，不要再给它起别名
    const headers: Record<string, string> = {};
    if (reqHeadersRaw) {
      const kept: Record<string, string> = {}, erased: string[] = [];
      for (const [k, v] of Object.entries(reqHeadersRaw)) (v === "[redacted]" ? erased.push(k) : (kept[k] = v));
      Object.assign(headers, this.sanitizer.headers(kept), Object.fromEntries(erased.map((k) => [k, "[redacted]"])));
    }
    const body = noise ? {} : requestBodyValue(this.sanitizer, rawReqBody, reqHeadersRaw);
    const finalUrl = str(msg.finalUrl);
    const file: RequestFile = {
      seq, win, endpoint, requestType: via, tab: msg.tab, ...(rid ? { rid } : {}),
      ...(cause ? { cause: cause.seq, causeDt } : {}), phase,
      method, url, ...(rawPage ? { frameUrl: this.sanitizer.url(rawPage) } : {}), headers,
      ...(body.value !== undefined ? { requestBody: body.value } : {}), ...(body.truncated ? { requestBodyTruncated: true } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(ct ? { responseHeaders: { "content-type": ct, ...(finalUrl && finalUrl !== rawUrl ? { "x-final-url": this.sanitizer.url(finalUrl).bareUrl } : {}) } } : {}),
      ...(responseBodyPath ? { responseBodyPath } : {}), ...(num(msg.size) !== undefined || rawBody !== undefined ? { responseSize: num(msg.size) ?? rawBody?.length } : {}),
      ...(msg.truncated ? { truncated: true } : {}), ...(bodyOmitted ? { bodyOmitted } : {}), ...(str(msg.err) ? { error: str(msg.err) } : {}),
      startedAt: reqStart, endedAt: msg.t,
    };
    const rel = this.log.putFile(site, `${stem}.json`, JSON.stringify(file, null, 2));
    const row: Row = {
      seq, t: msg.t, win, src, tab: msg.tab, ...(msg.frame ? { frame: msg.frame } : {}), type: "request", requestType: via, method, url: url.bareUrl,
      ...(page ? { page } : {}), ...(status !== undefined ? { status } : {}), ...(num(msg.size) !== undefined || rawBody !== undefined ? { size: num(msg.size) ?? rawBody?.length } : {}),
      endpoint, ...(noise ? { noise: 1 as const } : {}), ...(cause ? { cause: cause.seq, causeDt } : {}), phase, file: rel,
    };
    this.log.append(site, row);
    if (!noise) this.index?.observe({ site, row, file, relFile: rel, text, label: cause?.label });
  }

  private input(msg: PageMsg, page: string | undefined): void {
    const type = str(msg.type) ?? "";
    // 来源只看 isTrusted：真的是人，假的是页面里的脚本（包括 agent 的 DOM 事件，观察端分不出也不去分）
    const src: Src = msg.trusted === true ? "user" : "page";
    const t = (msg.target ?? {}) as { tag?: string; role?: string; text?: string; sel?: string };
    const key = str(msg.key);
    const label = type === "key" ? `${key ?? ""} ${targetText(msg.target)}`.trim() : targetText(msg.target);
    const row: Partial<Row> & Pick<Row, "type" | "src"> = {
      type: "action", src, actionType: type, ...(label ? { target: label } : {}),
      ...((t.role || t.tag) ? { role: (t.role || t.tag)!.trim() } : {}), ...(t.text?.trim() ? { name: t.text.trim().slice(0, 80) } : {}), ...(t.sel ? { selector: t.sel } : {}),
      ...(key ? { key } : {}), ...(num(msg.dy) !== undefined ? { deltaY: num(msg.dy) } : {}), ...(num(msg.n) !== undefined ? { n: num(msg.n) } : {}),
      ...(page ? { page } : {}),
    };
    const seq = this.emit(siteOfUrl(str(msg.page)), msg, row);
    if (src === "user" && type !== "scroll") {
      this.lastAction.set(msg.tab, { seq, ts: msg.t, label: actionLabel({ ...row, seq, t: msg.t, win: USER_WIN, tab: msg.tab } as Row) });
      trimMap(this.lastAction);
    }
  }

  private snap(msg: PageMsg, page: string | undefined): void {
    const text = JSON.stringify(msg.snap ?? {}, null, 1);
    const s = (msg.snap ?? {}) as { title?: string; interactiveVisible?: number; interactiveTotal?: number; why?: string };
    const site = this.siteFor(siteOfUrl(str(msg.page)), msg.tab);
    const seq = this.log.reserve();
    const rel = this.log.putBody(site, `${String(seq).padStart(6, "0")}.snap.json`, text, hashText(text));
    const win = this.winOf(msg.tab);
    this.log.append(site, { seq, t: msg.t, win, src: win !== USER_WIN ? "agent" : "page", tab: msg.tab, type: "snap", actionType: str(s.why) ?? "snap", target: `"${String(s.title ?? "").slice(0, 40)}" ${s.interactiveVisible ?? 0}/${s.interactiveTotal ?? 0}`, size: text.length, ...(page ? { page } : {}), file: rel });
  }

  /** 主文档渲染后的 HTML，原样存（内容相同的只存一份）。 */
  private doc(msg: PageMsg, page: string | undefined): void {
    const html = str(msg.html);
    if (!html) return;
    const url = str(msg.url) ?? "";
    const site = this.siteFor(siteOfUrl(url) || siteOfUrl(str(msg.page)), msg.tab);
    const seq = this.log.reserve();
    const rel = this.log.putBody(site, `${String(seq).padStart(6, "0")}.doc.html`, html, hashText(html));
    const win = this.winOf(msg.tab);
    this.log.append(site, { seq, t: msg.t, win, src: win !== USER_WIN ? "agent" : "page", tab: msg.tab, type: "doc", url: this.sanitizer.url(url).bareUrl, size: html.length, ...(page ? { page } : {}), file: rel });
  }
}
