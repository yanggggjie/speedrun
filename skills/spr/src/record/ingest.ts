import type { FiltersEngine } from "@ghostery/adblocker";
import { isSameSite, parseUrl, siteOfUrl } from "../utils/url.ts";
import { createLogger } from "../utils/logger.ts";
import { endpointOf } from "./digest.ts";
import type { EndpointIndex } from "./endpoints.ts";
import { noiseReason, shouldStoreBody } from "./filter.ts";
import type { RawStore } from "./raw.ts";
import { docOf } from "./headers.ts";
import { bodyExt, hashText, pageSlug, requestBodyValue, requestStem, responseText, slug } from "./reqfile.ts";
import { Sanitizer } from "./sanitize.ts";
import type { WindowLog } from "./windowlog.ts";
import { USER_WIN, type ParsedUrl, type Phase, type RequestFile, type Row, type Src } from "./types.ts";

/** 扩展转来的一条页面消息：页面脚本产出，扩展补上 tab / frame / top / page。 */
export type PageMsg = { k: string; t: number; tab: number; frame?: number; top?: boolean; page?: string } & Record<string, unknown>;

/** 人的事件或 agent 的命令之后这段时间内开始的请求，记为它引发的。 */
const logger = createLogger("ingest");
const CAUSE_MS = 2_000;
/** 页面在 agent 窗口里新开的标签页（点了 target=_blank 的链接）：它的请求算这个窗口这么久之内最近一条命令引发的。 */
const NEW_TAB_MS = 10_000;
/** 页面（文档或单页应用路由）刚开始的这几秒里发出的请求，阶段记为 load。 */
const LOAD_MS = 4_000;
const FLUSH_MS = 100;
/** 站点判断不出来的行（chrome:// 页面的命令记录等）的 site。 */
export const OTHER_SITE = "_other";
const MAX_TAB_STATE = 2_000;
/** 一条连接的摘要行最快这么久写一次：心跳不把时间线写满。观察前 flushSockets 补齐。 */
const SOCKET_ROW_MS = 2_000;
/** 一条连接最多落盘这么多字节的消息内容，超了只计数。 */
const SOCKET_FILE_MAX = 5 * 1024 * 1024;

/** 一条 WebSocket 或事件流。 */
type SocketState = { win: string; tab: number; site: string; url: string; channel: string; file: string; sent: number; received: number; bytes: number; stored: number; dirty: boolean; lastRow: number; frame?: number };
/** 收到的一条消息（原文，只在内存里交给 waitMessage）。 */
export type SeenMessage = { win: string; url: string; channel: string; data: string };

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function trimMap<K, V>(map: Map<K, V>): void {
  if (map.size > MAX_TAB_STATE) map.delete(map.keys().next().value as K);
}

export type IngestOptions = {
  engine?: () => FiltersEngine | undefined;
  aliasKey?: string;
  raw?: RawStore;
  /** 标签页所在的窗口：debug 窗口的 id、run 窗口的名字；不是 agent 窗口的（user）一律不记。不给就当作都不是。 */
  winOf?: (tab: number) => string;
  /** endpoints.json：debug 窗口里每写一个请求就通知它（run 窗口的不进）。 */
  index?: EndpointIndex;
};

/** beginCmd 返回的句柄：编号已经预留，行在 endCmd 时才写。 */
export type CmdRef = { seq: number; site: string; win: string; tab: number; ts: number; verb: string; target: string; detail?: Record<string, unknown> };
type LastAction = { seq: number; ts: number; label: string; inherited?: boolean };

/** 页面发出、刚收录的一个请求（原始内容，只在内存里交给 waitRequest）。 */
export type SeenRequest = { seq: number; win: string; tab: number; method: string; url: string; endpoint: string; status?: number; body?: string; reqBody?: string; ct?: string; truncated?: boolean; error?: string; noise?: boolean };

export class Ingestor {
  readonly sanitizer: Sanitizer;
  private readonly log: WindowLog;
  private readonly engine: () => FiltersEngine | undefined;
  private readonly raw: RawStore | undefined;
  private readonly winOf: (tab: number) => string;
  private readonly index: EndpointIndex | undefined;
  private readonly tabSite = new Map<number, string>();
  private readonly lastAction = new Map<number, LastAction>();
  private readonly lastNav = new Map<number, number>();
  /** 每个窗口最近一条命令：新开的标签页还没有自己的命令时，用它当引发者。 */
  private readonly lastCmdOfWin = new Map<string, LastAction>();
  /** 收录了一个页面发出的请求：waitRequest 在这里拿原始响应（不经过日志文件、不脱敏，和 request() 返回的一样）。 */
  private readonly seenListeners = new Set<(r: SeenRequest) => void>();
  onRequest(fn: (r: SeenRequest) => void): () => void { this.seenListeners.add(fn); return () => this.seenListeners.delete(fn); }
  private readonly messageListeners = new Set<(m: SeenMessage) => void>();
  onMessage(fn: (m: SeenMessage) => void): () => void { this.messageListeners.add(fn); return () => this.messageListeners.delete(fn); }
  private readonly sockets = new Map<string, SocketState>();
  private readonly dialogListeners = new Set<(win: string, note: string) => void>();
  onDialog(fn: (win: string, note: string) => void): () => void { this.dialogListeners.add(fn); return () => this.dialogListeners.delete(fn); }
  private queue: PageMsg[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(log: WindowLog, options: IngestOptions = {}) {
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
    this.noteDelivered(msg);
    this.queue.push(msg);
    // 定时写盘出错（磁盘满、没权限）只记下来：抛到定时器外面会让 daemon 退出，内存里的原始请求、ask 恢复记录、debug 窗口的页面全丢
    this.timer ??= setTimeout(() => { try { this.flush(); } catch (error) { logger.warn("写日志失败", { err: error instanceof Error ? error.message : String(error) }); } }, FLUSH_MS);
  }

  // ---- 记录送达：页面每条消息带这次加载的编号 d 和递增序号 n（page/common.js） ----

  /** 每个标签页最近一次页面加载收到的最大序号。 */
  private readonly delivered = new Map<number, { d: string; n: number }>();
  private readonly deliveredWaits = new Set<{ tab: number; d: string; n: number; done: (ok: boolean) => void }>();

  private noteDelivered(msg: PageMsg): void {
    const d = str(msg.d), n = num(msg.n);
    if (!d || n === undefined) return;
    const cur = this.delivered.get(msg.tab);
    if (cur?.d === d && cur.n >= n) return;
    this.delivered.set(msg.tab, { d, n });
    trimMap(this.delivered);
    for (const w of this.deliveredWaits) if (w.tab === msg.tab && w.d === d && n >= w.n) w.done(true);
  }

  /** 等这个标签页这次加载（d）的第 n 条消息到 daemon，最多 ms；返回到没到。n 为 0（页面还没发过消息）直接算到了。 */
  waitDelivered(tab: number, d: string, n: number, ms: number): Promise<boolean> {
    const cur = this.delivered.get(tab);
    if (n <= 0 || (cur?.d === d && cur.n >= n)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const w = { tab, d, n, done: (ok: boolean) => { clearTimeout(timer); this.deliveredWaits.delete(w); resolve(ok); } };
      const timer = setTimeout(() => w.done(false), ms);
      this.deliveredWaits.add(w);
    });
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
    const act: LastAction = { seq, ts, label: `agent cmd ${verb} ${target}`.trim() };
    this.lastAction.set(tab, act);
    this.lastCmdOfWin.set(this.winOf(tab), act);
    trimMap(this.lastAction);
    return ref;
  }

  /** 命令做完：写这一行，带上元素描述和结果。 */
  endCmd(ref: CmdRef, fields: { target?: string; size?: number; detail?: Record<string, unknown> }): void {
    const { ok, error, ...rest } = { ...(fields.detail ?? ref.detail ?? {}) } as Record<string, unknown>;
    const row: Row = {
      seq: ref.seq, t: ref.ts, win: ref.win, site: ref.site, src: "agent", tab: ref.tab, type: "cmd", kind: ref.verb, target: fields.target ?? ref.target,
      ...(fields.size !== undefined ? { size: fields.size } : {}),
      ...(typeof ok === "boolean" ? { ok } : {}), ...(typeof error === "string" ? { error } : {}),
      ...(Object.keys(rest).length ? { detail: rest } : {}),
    };
    if (!this.log.kindOf(ref.win)) return;
    this.log.batch(() => this.log.append(row));
  }

  // ---- 页面消息 ----

  private handle(msg: PageMsg): void {
    // 只录 agent 自己的窗口：用户窗口里的一切不写日志、不进原始请求内存表、不进endpoints.json（扩展是旧版本、照常发来时也一样）
    const win = this.winOf(msg.tab);
    if (win === USER_WIN || !this.log.kindOf(win)) return;
    const page = msg.page ? parseUrl(msg.page).bareUrl : undefined;
    const pageSite = siteOfUrl(msg.page);
    if (pageSite) { this.tabSite.set(msg.tab, pageSite); trimMap(this.tabSite); }
    switch (msg.k) {
      case "net": return this.net(msg, page);
      case "socket": return this.socket(msg);
      case "dialog": {
        const kind = str(msg.kind) ?? "dialog", note = `${kind}${str(msg.message) ? `：${str(msg.message)}` : ""}`;
        for (const fn of this.dialogListeners) { try { fn(win, note); } catch { /* 订阅者的错不影响收录 */ } }
        return void this.emit(pageSite, msg, { type: "tab", src: "page", via: "dialog", target: note, ...(page ? { page } : {}) });
      }
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
      case "tab": {
        const site = siteOfUrl(str(msg.url)) || pageSite;
        return void this.emit(site, msg, { type: "tab", src: "page", via: str(msg.ev) ?? "tab", url: this.bare(str(msg.url) ?? "") });
      }
    }
  }

  private bare(url: string): string { return parseUrl(url).bareUrl; }

  /** WebSocket、事件流：连接只记摘要行；内容脱敏后写进 sockets/<编号>-<host>.jsonl，一条连接有总量上限。原文只在内存里交给 waitMessage。 */
  private socket(msg: PageMsg): void {
    const id = `${msg.tab}:${str(msg.id) ?? ""}`, rawUrl = str(msg.url) ?? "", ev = str(msg.ev);
    const win = this.winOf(msg.tab);
    let s = this.sockets.get(id);
    if (!s) {
      const seq = this.log.reserve();
      const safe = this.sanitizer.url(rawUrl);
      s = { win, tab: msg.tab, site: this.siteFor(siteOfUrl(str(msg.page)), msg.tab), url: safe.bareUrl, channel: str(msg.channel) ?? "ws", file: `sockets/${String(seq).padStart(6, "0")}-${slug(safe.bareUrl, 40)}.jsonl`, sent: 0, received: 0, bytes: 0, stored: 0, dirty: true, lastRow: 0, ...(msg.frame ? { frame: msg.frame } : {}) };
      this.sockets.set(id, s);
      trimMap(this.sockets);
    }
    if (ev === "frame") {
      const dir = str(msg.dir) === "sent" ? "sent" : "received", size = num(msg.size) ?? 0, data = str(msg.data);
      s[dir]++;
      s.bytes += size;
      s.dirty = true;
      if (s.stored < SOCKET_FILE_MAX) {
        const line = `${JSON.stringify({ t: msg.t, dir, size, ...(data !== undefined ? { data: responseText(this.sanitizer, data, /^\s*[[{]/.test(data) ? "application/json" : "text/plain") } : { binary: true }) })}\n`;
        s.stored += line.length;
        this.log.appendFile(s.win, s.file, line);
      }
      if (dir === "received" && data !== undefined) for (const fn of this.messageListeners) { try { fn({ win, url: rawUrl, channel: s.channel, data }); } catch { /* 订阅者的错不影响收录 */ } }
    }
    if (ev === "close" || msg.t - s.lastRow >= SOCKET_ROW_MS) this.socketRow(s, msg.t);
    if (ev === "close") this.sockets.delete(id);
  }

  private socketRow(s: SocketState, t: number): void {
    if (!s.dirty) return;
    s.dirty = false;
    s.lastRow = t;
    this.log.append({ seq: this.log.reserve(), t, win: s.win, site: s.site, src: "agent", tab: s.tab, ...(s.frame ? { frame: s.frame } : {}), type: "socket", channel: s.channel, url: s.url, sent: s.sent, received: s.received, bytes: s.bytes, file: s.file } as Row);
  }

  /** 观察前把攒着的连接摘要写出来。 */
  flushSockets(): void {
    this.log.batch(() => { for (const s of this.sockets.values()) this.socketRow(s, Date.now()); });
  }

  private siteFor(site: string | undefined, tab: number): string { return site || this.tabSite.get(tab) || OTHER_SITE; }

  /** 写一行：编号、窗口、来源在这里补上。只有 agent 窗口的行会走到这里，页面脚本触发的一切记为 agent 的。 */
  private emit(site: string | undefined, msg: PageMsg, row: Partial<Row> & Pick<Row, "type" | "src">): number {
    const win = this.winOf(msg.tab);
    const src: Src = row.src === "page" ? "agent" : row.src;
    const seq = this.log.reserve();
    const at = this.siteFor(site, msg.tab);
    this.log.append({ ...row, seq, t: msg.t, win, site: at, src, tab: msg.tab, ...(msg.frame ? { frame: msg.frame } : {}) } as Row);
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
    return act && reqStart - act.ts >= 0 && reqStart - act.ts <= CAUSE_MS ? "cmd" : "idle";
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
    const src: Src = "agent";
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
    const epName = endpointOf(rawUrl, bodyJson).name;
    const endpoint = `${method} ${epName}`;
    const stem = requestStem(seq, method, epName);

    // 因果与阶段
    const last = this.lastAction.get(msg.tab) ?? this.openedBy(msg.tab, win, reqStart);
    const causeDt = last ? reqStart - last.ts : undefined;
    const cause = last && causeDt !== undefined && causeDt >= 0 && causeDt <= (last.inherited ? NEW_TAB_MS : CAUSE_MS) ? last : undefined;
    const phase = this.phaseOf(msg.tab, reqStart, num(msg.at));

    // 原始请求（含 token 真值）只放内存，按窗口存：request() 从这次窗口里抄头、观察统计请求头怎么变用；只存同站的、非噪声的
    const rid = str(msg.rid);
    if (rid && this.raw && !noise && !msg.err && isSameSite(parseUrl(rawUrl), parseUrl(rawPage))) {
      this.raw.put(msg.tab, rid, { win, doc: docOf(rid), endpoint, method, url: rawUrl, headers: reqHeadersRaw ?? {}, body: rawReqBody ?? null, page: rawPage, t: msg.t });
    }

    // 响应体：只写同站的、非噪声的、有内容的；失败的请求只留小响应体（够看出错在哪）
    let responseBodyPath: string | undefined;
    let text: string | undefined;
    let bodyOmitted: string | undefined;
    if (rawBody === undefined) bodyOmitted = msg.err ? "error" : "no-body";
    else if (!shouldStoreBody({ noise, url: rawUrl, page: rawPage, status, body: rawBody })) bodyOmitted = noise ? "noise" : !isSameSite(parseUrl(rawUrl), parseUrl(rawPage)) ? "cross-site" : "large-error";
    else {
      text = responseText(this.sanitizer, rawBody, ct);
      responseBodyPath = this.log.putBody(win, `${stem}.response.${bodyExt(ct, text)}`, text, hashText(text));
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
    const rel = this.log.putFile(win, `${stem}.json`, JSON.stringify(file, null, 2));
    const row: Row = {
      seq, t: msg.t, win, site, src, tab: msg.tab, ...(msg.frame ? { frame: msg.frame } : {}), type: "request", requestType: via, method, url: url.bareUrl,
      ...(page ? { page } : {}), ...(status !== undefined ? { status } : {}), ...(num(msg.size) !== undefined || rawBody !== undefined ? { size: num(msg.size) ?? rawBody?.length } : {}),
      endpoint, ...(noise ? { noise: 1 as const } : {}), ...(cause ? { cause: cause.seq, causeDt } : {}), phase, file: rel,
    };
    this.log.append(row);
    if (this.seenListeners.size) {
      const seen: SeenRequest = { seq, win, tab: msg.tab, method, url: rawUrl, endpoint, ...(status !== undefined ? { status } : {}), ...(rawBody !== undefined ? { body: rawBody } : {}), ...(rawReqBody !== undefined ? { reqBody: rawReqBody } : {}), ...(ct ? { ct } : {}), ...(msg.truncated ? { truncated: true } : {}), ...(str(msg.err) ? { error: str(msg.err) } : {}), ...(noise ? { noise: true } : {}) };
      for (const fn of this.seenListeners) { try { fn(seen); } catch { /* 订阅者的错不影响收录 */ } }
    }
    // endpoints.json只由 debug 窗口累积；run 窗口的日志只给反查用
    if (!noise && this.log.kindOf(win) === "debug") this.index?.observe({ site, row, file, ref: this.log.ref(win, rel), ...(responseBodyPath ? { bodyRef: this.log.ref(win, responseBodyPath) } : {}), text, label: cause?.label });
  }

  /** 标签页还没有自己的命令（页面新开的）：窗口最近一条命令在 NEW_TAB_MS 之内，就当它是引发者，并记给这个标签页。 */
  private openedBy(tab: number, win: string, at: number): LastAction | undefined {
    const cmd = this.lastCmdOfWin.get(win);
    if (!cmd || at - cmd.ts < 0 || at - cmd.ts > NEW_TAB_MS) return undefined;
    const act = { ...cmd, inherited: true };
    this.lastAction.set(tab, act);
    trimMap(this.lastAction);
    return act;
  }

  private snap(msg: PageMsg, page: string | undefined): void {
    const text = JSON.stringify(msg.snap ?? {}, null, 1);
    const s = (msg.snap ?? {}) as { title?: string; interactiveVisible?: number; interactiveTotal?: number; why?: string };
    const site = this.siteFor(siteOfUrl(str(msg.page)), msg.tab);
    const seq = this.log.reserve();
    const win = this.winOf(msg.tab);
    const rel = this.log.putBody(win, `pages/${String(seq).padStart(6, "0")}-snap-${pageSlug(str(msg.page) ?? "")}.json`, text, hashText(text));
    this.log.append({ seq, t: msg.t, win, site, src: "agent", tab: msg.tab, type: "snap", kind: str(s.why) ?? "snap", target: `"${String(s.title ?? "").slice(0, 40)}" ${s.interactiveVisible ?? 0}/${s.interactiveTotal ?? 0}`, size: text.length, ...(page ? { page } : {}), file: rel });
  }

  /** 主文档渲染后的 HTML（输入框和 meta 里的秘密换成别名，sanitizer.html），内容相同的只存一份。 */
  private doc(msg: PageMsg, page: string | undefined): void {
    const rawHtml = str(msg.html);
    if (!rawHtml) return;
    const html = this.sanitizer.html(rawHtml);
    const url = str(msg.url) ?? "";
    const site = this.siteFor(siteOfUrl(url) || siteOfUrl(str(msg.page)), msg.tab);
    const seq = this.log.reserve();
    const win = this.winOf(msg.tab);
    const rel = this.log.putBody(win, `pages/${String(seq).padStart(6, "0")}-doc-${pageSlug(url)}.html`, html, hashText(html));
    this.log.append({ seq, t: msg.t, win, site, src: "agent", tab: msg.tab, type: "doc", url: this.sanitizer.url(url).bareUrl, size: html.length, ...(page ? { page } : {}), file: rel });
  }
}
