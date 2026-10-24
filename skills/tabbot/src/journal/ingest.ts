import { createHash } from "node:crypto";
import type { FiltersEngine } from "@ghostery/adblocker";
import { isSameSite, parseUrl } from "../utils/url.ts";
import { noiseReason, shouldStoreBody } from "./filter.ts";
import type { RawStore } from "./raw.ts";
import { UNREPLAYABLE_BODY } from "./replay-core.ts";
import { Sanitizer } from "./sanitize.ts";
import type { JournalStore } from "./store.ts";
import type { Kind, NewEvent, Src } from "./types.ts";

/** 扩展转来的一条页面消息：页面脚本产出，扩展补上 tab / frame / top / page。 */
export type PageMsg = { k: string; t: number; tab: number; frame?: number; top?: boolean; page?: string } & Record<string, unknown>;

/** 同一个请求（方法 + 地址 + 响应内容都相同）在这段时间内再次出现，只给上一行计数。 */
const DEDUPE_MS = 5 * 60_000;
/** 人的事件或 agent 的命令之后这段时间内发出的请求，记为它引发的。 */
const CAUSE_MS = 2_000;
const DETAIL_BODY_MAX = 8 * 1024;
const FLUSH_MS = 100;
const REQ_OMITTED = "[请求体已省略：太大，或不是完整的 JSON]";

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
/** 脱敏后的地址：别名 ⟨secret_a3f9c1e2d4b7:jwt⟩ 保持原样好读，其它参数照常编码（编码会把别名也编码掉）。 */
function readableUrl(sanitized: { bareUrl: string; query: Record<string, string> }): string {
  const parts = Object.entries(sanitized.query).map(([k, v]) => `${encodeURIComponent(k)}=${/^⟨secret_[0-9a-f]+:\w+⟩$/.test(v) ? v : encodeURIComponent(v)}`);
  return parts.length ? `${sanitized.bareUrl}?${parts.join("&")}` : sanitized.bareUrl;
}
const hash = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

function targetText(t: unknown): string {
  if (!t || typeof t !== "object") return "";
  const o = t as { tag?: string; role?: string; text?: string; sel?: string };
  const name = (o.role || o.tag || "").trim();
  const text = (o.text ?? "").trim();
  return text ? `${name}[${text.slice(0, 30)}]` : `${name}${o.sel ? `(${o.sel.split(">").pop()})` : ""}`;
}

/** 把响应体变成可 grep 的文本：JSON 就缩进展开（脱敏之后），其它原样。 */
function bodyText(sanitizer: Sanitizer, raw: string, ct: string | undefined): string {
  const jsonish = /json/i.test(ct ?? "") || /^\s*[[{]/.test(raw);
  if (jsonish) {
    try { return JSON.stringify(sanitizer.body(JSON.parse(raw)), null, 1); } catch { /* 不是合法 JSON：按文本处理 */ }
  }
  return raw;
}

export type IngestOptions = { engine?: () => FiltersEngine | undefined; aliasKey?: string; raw?: RawStore };
type Ref = { seq: number; seg: number };
type Base = Pick<NewEvent, "ts" | "tab" | "frame" | "page">;

export class Ingestor {
  readonly sanitizer: Sanitizer;
  private readonly store: JournalStore;
  private readonly engine: () => FiltersEngine | undefined;
  private readonly raw: RawStore | undefined;
  private readonly seen = new Map<string, Ref & { ts: number }>();
  private readonly lastAction = new Map<number, { seq: number; ts: number }>();
  private queue: PageMsg[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(store: JournalStore, options: IngestOptions = {}) {
    this.store = store;
    this.sanitizer = new Sanitizer(options.aliasKey ?? "");
    this.engine = options.engine ?? (() => undefined);
    this.raw = options.raw;
  }

  /** 收一条页面消息：攒一小会儿，一批放进一个事务。 */
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

  /** 一批消息放进一个事务。单条出错不影响其它。 */
  handleBatch(msgs: PageMsg[]): void {
    this.store.batch(() => {
      for (const msg of msgs) {
        try { this.handle(msg); } catch { /* 坏消息丢掉，不让它挡住整批 */ }
      }
    });
  }

  /** agent 的命令开始：先写一行命令记录（命令引发的请求会指向它）。 */
  beginCmd(tab: number, ts: number, verb: string, target: string, detail?: Record<string, unknown>): Ref {
    const ref = this.store.batch(() => this.insert({ ts, tab, frame: 0, src: "agent", kind: "cmd", verb, target, detail: detail ? JSON.stringify(detail) : undefined }));
    this.lastAction.set(tab, { seq: ref.seq, ts });
    return ref;
  }

  /** 命令做完：补上元素描述和结果。 */
  endCmd(ref: Ref, fields: { target?: string; size?: number; detail?: Record<string, unknown> }): void {
    this.store.batch(() => this.store.update(ref, { target: fields.target, size: fields.size, detail: fields.detail ? JSON.stringify(fields.detail) : undefined }));
  }

  /**
   * 记一次重放：agent 的一行（来源 agent，类型 net，动作 replay），响应体存成文件；返回给 CLI 看的预览。
   * `rawUrl` 是实际发出的地址（含查询参数里的秘密），这里脱敏成别名再写日志。--set 的值可能是秘密，所以只记名字不记值。
   */
  recordReplay(tab: number, ts: number, info: { method: string; rawUrl: string; replayOf: number; setKeys: string[]; status?: number; ct?: string; size?: number; text?: string; ms?: number; error?: string }): { seq: number; bodyFile?: string; preview: string } {
    const url = readableUrl(this.sanitizer.url(info.rawUrl));
    return this.store.batch(() => {
      let bodyFile: string | undefined;
      let preview = "";
      if (info.text) {
        preview = bodyText(this.sanitizer, info.text, info.ct);
        bodyFile = this.store.putFile("bodies", `${hash(preview)}.${/json/i.test(info.ct ?? "") ? "json" : "txt"}`, preview);
      }
      const { seq } = this.insert({
        ts, tab, frame: 0, src: "agent", kind: "net", verb: "replay", method: info.method, url, status: info.status, size: info.size, body: bodyFile,
        detail: JSON.stringify({ replayOf: info.replayOf, set: info.setKeys, ms: info.ms, error: info.error, ct: info.ct }),
      });
      return { seq, bodyFile, preview };
    });
  }

  /** 租约变化：人撤销记为 human，其余记为 agent。 */
  recordLease(msg: { tab: number; state: string; t: number; reason?: string; by?: string }): void {
    const src: Src = msg.state === "revoked" ? "human" : "agent";
    this.store.batch(() => this.insert({ ts: msg.t, tab: msg.tab, frame: 0, src, kind: "lease", verb: msg.state, target: msg.by ?? msg.reason, detail: JSON.stringify({ reason: msg.reason, by: msg.by }) }));
  }

  private handle(msg: PageMsg): void {
    const base: Base = { ts: msg.t, tab: msg.tab, frame: msg.frame ?? 0, page: msg.page ? this.bare(msg.page) : undefined };
    switch (msg.k) {
      case "net": return this.net(msg, base);
      case "ev": return this.input(msg, base);
      case "nav": return void this.insert({ ...base, src: "page", kind: "nav", verb: str(msg.via) ?? "nav", target: str(msg.via), url: this.bare(str(msg.url) ?? "") });
      case "snap": return this.snap(msg, base);
      case "doc": return this.doc(msg, base);
      case "bg": return void this.insert({ ...base, src: "page", kind: "bg", verb: "requests", size: num(msg.n) });
      case "tab": return void this.insert({ ...base, src: "page", kind: "tab", verb: str(msg.ev) ?? "tab", url: this.bare(str(msg.url) ?? "") });
    }
  }

  private bare(url: string): string { return parseUrl(url).bareUrl; }

  private insert(ev: NewEvent): Ref { return this.store.insert(ev); }

  private net(msg: PageMsg, base: Base): void {
    const rawUrl = str(msg.url) ?? "";
    const page = str(msg.page) ?? "";
    const method = str(msg.method) ?? "GET";
    const via = str(msg.via) ?? "fetch";
    const status = num(msg.status);
    const sanitizedUrl = readableUrl(this.sanitizer.url(rawUrl));
    const reason = noiseReason({ url: rawUrl, method, status, via, page }, this.engine());
    const noise = reason !== null;
    const rawBody = str(msg.body);
    const text = rawBody !== undefined && shouldStoreBody({ noise, url: rawUrl, page, status, body: rawBody }) ? bodyText(this.sanitizer, rawBody, str(msg.ct)) : undefined;
    const name = text === undefined ? undefined : `${hash(text)}.${/json/i.test(str(msg.ct) ?? "") ? "json" : "txt"}`;

    // 重复请求只计数：key 里带上响应内容的哈希，同一个接口返回了新内容就不算重复。
    const key = `${base.tab}|${method}|${this.bare(rawUrl)}|${name ?? status ?? ""}`;
    const prior = this.seen.get(key);
    if (prior && base.ts - prior.ts < DEDUPE_MS) { this.store.bump(prior, base.ts); return; }

    const last = this.lastAction.get(base.tab);
    const detail: Record<string, unknown> = { via };
    const rid = str(msg.rid);
    if (rid) detail.rid = rid; // 原始内容在 holder 的内存里，重放靠它找回来
    if (reason) detail.noise = reason;
    // 原始请求（含 token 真值）只放内存，重放用；只存同站的、非噪声的
    if (rid && this.raw && !noise && !msg.err && isSameSite(parseUrl(rawUrl), parseUrl(page))) {
      this.raw.put(base.tab, rid, { method, url: rawUrl, headers: (msg.reqHeaders as Record<string, string> | null) ?? {}, body: str(msg.reqBody) ?? null, page, t: base.ts });
    }
    if (msg.reqHeaders && typeof msg.reqHeaders === "object") {
      // 页面脚本把 cookie 抹成了 [redacted]：原样保留，不要再给它起别名
      const kept: Record<string, string> = {}, erased: string[] = [];
      for (const [k, v] of Object.entries(msg.reqHeaders as Record<string, string>)) (v === "[redacted]" ? erased.push(k) : (kept[k] = v));
      detail.reqHeaders = { ...this.sanitizer.headers(kept), ...Object.fromEntries(erased.map((k) => [k, "[redacted]"])) };
    }
    const reqBody = str(msg.reqBody);
    if (reqBody && !noise) {
      // JSON 先解析再脱敏；太大或不完整的 JSON 不存内容
      if (UNREPLAYABLE_BODY.test(reqBody)) detail.reqBody = reqBody.slice(0, 40); // 页面脚本放的占位文字（文件、二进制、没读到），原样保留
      else if (reqBody.length > DETAIL_BODY_MAX) { detail.reqBody = REQ_OMITTED; detail.reqBodyTruncated = true; }
      else if (/^\s*[[{]/.test(reqBody)) {
        try { detail.reqBody = JSON.stringify(this.sanitizer.body(JSON.parse(reqBody))); } catch { detail.reqBody = REQ_OMITTED; detail.reqBodyTruncated = true; }
      } else detail.reqBody = this.sanitizer.body(reqBody, /x-www-form-urlencoded/i.test(String((msg.reqHeaders as Record<string, string> | undefined)?.["content-type"] ?? "")));
    }
    if (str(msg.err)) detail.err = str(msg.err);
    if (str(msg.ct)) detail.ct = str(msg.ct);
    if (msg.truncated) detail.truncated = true;
    if (str(msg.finalUrl) && str(msg.finalUrl) !== rawUrl) detail.finalUrl = readableUrl(this.sanitizer.url(str(msg.finalUrl)!));

    const bodyRef = name !== undefined && text !== undefined ? this.store.putFile("bodies", name, text) : undefined;
    const ref = this.insert({
      ...base, src: "page", kind: "net", verb: via, url: sanitizedUrl, method, status, size: num(msg.size) ?? (rawBody?.length), body: bodyRef, noise: noise ? 1 : 0,
      cause: last && base.ts - last.ts <= CAUSE_MS ? last.seq : undefined, detail: JSON.stringify(detail),
    });
    this.seen.set(key, { ...ref, ts: base.ts });
    if (this.seen.size > 5000) for (const [k, v] of this.seen) if (base.ts - v.ts > DEDUPE_MS) this.seen.delete(k);
  }

  private input(msg: PageMsg, base: Base): void {
    const type = str(msg.type) ?? "";
    // 来源只看 isTrusted：真的是人，假的是页面里的脚本（包括 agent 的 DOM 事件，观察端分不出也不去分）
    const src: Src = msg.trusted === true ? "human" : "page";
    const sel = (msg.target as { sel?: string } | undefined)?.sel;
    const { seq } = this.insert({
      ...base, src, kind: "input" as Kind, verb: type, target: type === "key" ? `${str(msg.key) ?? ""} ${targetText(msg.target)}`.trim() : targetText(msg.target),
      size: num(msg.n) ?? num(msg.dy),
      detail: JSON.stringify({ sel, key: str(msg.key), inputType: str(msg.inputType) }),
    });
    if (src === "human" && type !== "scroll") this.lastAction.set(base.tab, { seq, ts: base.ts });
  }

  private snap(msg: PageMsg, base: Base): void {
    const text = JSON.stringify(msg.snap ?? {}, null, 1);
    const ref = this.store.putFile("snapshots", `${hash(text)}.json`, text);
    const s = (msg.snap ?? {}) as { title?: string; interactiveVisible?: number; interactiveTotal?: number; why?: string };
    this.insert({ ...base, src: "page", kind: "snap", verb: str(s.why) ?? "snap", target: `"${String(s.title ?? "").slice(0, 40)}" ${s.interactiveVisible ?? 0}/${s.interactiveTotal ?? 0}`, body: ref, size: text.length });
  }

  /** 主文档渲染后的 HTML，原样存。 */
  private doc(msg: PageMsg, base: Base): void {
    const html = str(msg.html);
    if (!html) return;
    const ref = this.store.putFile("bodies", `${hash(html)}.html`, html);
    this.insert({ ...base, src: "page", kind: "doc", verb: "html", url: readableUrl(this.sanitizer.url(str(msg.url) ?? "")), body: ref, size: html.length });
  }
}
