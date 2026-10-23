import { createHash } from "node:crypto";
import type { FiltersEngine } from "@ghostery/adblocker";
import { RecordSanitizer } from "../record/pipeline.ts";
import { parseUrl } from "../utils/url.ts";
import { noiseReason, shouldStoreBody } from "./filter.ts";
import { bodiesDir, dayOf, snapshotsDir, type JournalStore } from "./store.ts";
import type { Kind, NewEvent, Src } from "./types.ts";

/** 扩展转来的一条页面消息：hook.js 产出，扩展补上 tab / frame / top / page。 */
export type HookMsg = { k: string; t: number; tab: number; frame?: number; top?: boolean; page?: string } & Record<string, unknown>;

const WATERMARK = 0.123;
/** 同一个请求（方法 + 地址 + 响应内容都相同）在这段时间内再次出现，只给上一行计数。 */
const DEDUPE_MS = 5 * 60_000;
/** 人或 agent 的动作之后这段时间内发出的请求，记为这个动作引发的。 */
const CAUSE_MS = 2_000;
const DETAIL_BODY_MAX = 8 * 1024;

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
/** 脱敏后的地址：别名 ⟨secret_001:jwt⟩ 保持原样好读，其它参数照常编码（serializeUrl 会把别名也编码掉）。 */
function readableUrl(sanitized: { bareUrl: string; query: Record<string, string> }): string {
  const parts = Object.entries(sanitized.query).map(([k, v]) => `${encodeURIComponent(k)}=${/^⟨secret_\d+:\w+⟩$/.test(v) ? v : encodeURIComponent(v)}`);
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
function bodyText(sanitizer: RecordSanitizer, raw: string, ct: string | undefined): string {
  const jsonish = /json/i.test(ct ?? "") || /^\s*[[{]/.test(raw);
  if (jsonish) {
    try { return JSON.stringify(sanitizer.sanitizeBody(JSON.parse(raw), "response-body").value, null, 1); } catch { /* 不是合法 JSON：按文本处理 */ }
  }
  return String(sanitizer.sanitizeBody(raw, "response-body").value);
}

export type IngestOptions = { engine?: () => FiltersEngine | undefined };

export class Ingestor {
  private readonly store: JournalStore;
  private readonly sanitizer = new RecordSanitizer();
  private readonly engine: () => FiltersEngine | undefined;
  private readonly seen = new Map<string, { seq: number; day: string; ts: number }>();
  private readonly lastAction = new Map<number, { seq: number; ts: number }>();

  constructor(store: JournalStore, options: IngestOptions = {}) {
    this.store = store;
    this.engine = options.engine ?? (() => undefined);
  }

  /** 一批消息放进事务；跨午夜的批按天拆开，一天的事件一个事务（一天一个库文件）。单条出错不影响其它。 */
  handleBatch(msgs: HookMsg[]): void {
    let start = 0;
    for (let i = 1; i <= msgs.length; i++) {
      if (i < msgs.length && dayOf(msgs[i]!.t) === dayOf(msgs[start]!.t)) continue;
      const chunk = msgs.slice(start, i);
      start = i;
      if (chunk.length === 0) continue;
      this.store.batch(chunk[0]!.t, () => {
        for (const msg of chunk) {
          try { this.handle(msg); } catch { /* 坏消息丢掉，不让它挡住整批 */ }
        }
      });
    }
  }

  private handle(msg: HookMsg): void {
    const base = { ts: msg.t, tab: msg.tab, frame: msg.frame ?? 0, page: msg.page ? this.bare(msg.page) : undefined };
    switch (msg.k) {
      case "net": return this.net(msg, base);
      case "ev": return this.input(msg, base);
      case "nav": return void this.push({ ...base, src: "page", kind: "nav", verb: str(msg.via) ?? "nav", target: str(msg.via), url: this.bare(str(msg.url) ?? "") });
      case "snap": return this.snap(msg, base);
      case "ws": return void this.push({ ...base, src: "page", kind: "ws", verb: str(msg.ev) ?? "ws", target: str(msg.url), detail: msg.data === undefined ? undefined : JSON.stringify({ data: String(msg.data).slice(0, 500) }) });
      case "bg": return void this.push({ ...base, src: "page", kind: "bg", verb: "requests", size: num(msg.n) });
      case "tab": return void this.push({ ...base, src: "page", kind: "tab", verb: str(msg.ev) ?? "tab", url: this.bare(str(msg.url) ?? "") });
    }
  }

  private bare(url: string): string { return parseUrl(url).bareUrl; }

  private push(ev: NewEvent): number {
    return this.store.insert(ev);
  }

  private net(msg: HookMsg, base: Pick<NewEvent, "ts" | "tab" | "frame" | "page">): void {
    const rawUrl = str(msg.url) ?? "";
    const page = str(msg.page) ?? "";
    const method = str(msg.method) ?? "GET";
    const via = str(msg.via) ?? "fetch";
    const status = num(msg.status);
    const sanitizedUrl = readableUrl(this.sanitizer.sanitizeUrl(rawUrl).value);
    const reason = noiseReason({ url: rawUrl, method, status, via, page }, this.engine());
    const noise = reason !== null;
    const rawBody = str(msg.body);
    const text = rawBody !== undefined && shouldStoreBody({ noise, url: rawUrl, page, status, body: rawBody }) ? bodyText(this.sanitizer, rawBody, str(msg.ct)) : undefined;
    const name = text === undefined ? undefined : `${hash(text)}.${/json/i.test(str(msg.ct) ?? "") ? "json" : "txt"}`;

    // 重复请求只计数：key 里带上响应内容的哈希，同一个接口返回了新内容就不算重复。
    const key = `${base.tab}|${method}|${this.bare(rawUrl)}|${name ?? status ?? ""}`;
    const prior = this.seen.get(key);
    if (prior && base.ts - prior.ts < DEDUPE_MS) { this.store.bump(prior.day, prior.seq, base.ts); return; }

    const last = this.lastAction.get(base.tab);
    const detail: Record<string, unknown> = { via };
    if (reason) detail.noise = reason;
    if (msg.reqHeaders && typeof msg.reqHeaders === "object") detail.reqHeaders = this.sanitizer.sanitizeHeaders(msg.reqHeaders as Record<string, string>).value;
    const reqBody = str(msg.reqBody);
    if (reqBody && !noise) detail.reqBody = this.sanitizer.sanitizeBody(reqBody.slice(0, DETAIL_BODY_MAX), "request-body", /x-www-form-urlencoded/i.test(String((msg.reqHeaders as Record<string, string> | undefined)?.["content-type"] ?? ""))).value;
    if (str(msg.err)) detail.err = str(msg.err);
    if (str(msg.ct)) detail.ct = str(msg.ct);
    if (msg.truncated) detail.truncated = true;
    if (str(msg.finalUrl) && str(msg.finalUrl) !== rawUrl) detail.finalUrl = readableUrl(this.sanitizer.sanitizeUrl(str(msg.finalUrl)!).value);

    if (name !== undefined && text !== undefined) this.store.writeFile(bodiesDir(dayOf(base.ts), this.store.dir), name, text);
    const seq = this.push({
      ...base, src: "page", kind: "net", verb: via, url: sanitizedUrl, method, status, size: num(msg.size) ?? (rawBody?.length), body: name, noise: noise ? 1 : 0,
      cause: last && base.ts - last.ts <= CAUSE_MS ? last.seq : undefined, detail: JSON.stringify(detail),
    });
    this.seen.set(key, { seq, day: dayOf(base.ts), ts: base.ts });
    if (this.seen.size > 5000) for (const [k, v] of this.seen) if (base.ts - v.ts > DEDUPE_MS) this.seen.delete(k);
  }

  private input(msg: HookMsg, base: Pick<NewEvent, "ts" | "tab" | "frame" | "page">): void {
    const type = str(msg.type) ?? "";
    const pressure = num(msg.pressure);
    // 来源：真人输入 isTrusted 为 true；agent 的鼠标点击带水印；脚本触发的事件 isTrusted 为 false，算页面自己的。
    let src: Src = msg.trusted === true ? "human" : "page";
    if (src === "human" && type === "click" && pressure !== undefined && Math.abs(pressure - WATERMARK) < 1e-3) src = "agent";
    const sel = (msg.target as { sel?: string } | undefined)?.sel;
    const seq = this.push({
      ...base, src, kind: "input" as Kind, verb: type, target: type === "key" ? `${str(msg.key) ?? ""} ${targetText(msg.target)}`.trim() : targetText(msg.target),
      size: num(msg.n) ?? num(msg.dy),
      detail: JSON.stringify({ sel, key: str(msg.key), inputType: str(msg.inputType) }),
    });
    if (src !== "page" && type !== "scroll") this.lastAction.set(base.tab, { seq, ts: base.ts });
  }

  private snap(msg: HookMsg, base: Pick<NewEvent, "ts" | "tab" | "frame" | "page">): void {
    const text = JSON.stringify(msg.snap ?? {}, null, 1);
    const name = `${hash(text)}.json`;
    this.store.writeFile(snapshotsDir(dayOf(base.ts), this.store.dir), name, text);
    const s = (msg.snap ?? {}) as { title?: string; interactiveVisible?: number; interactiveTotal?: number; why?: string };
    this.push({ ...base, src: "page", kind: "snap", verb: str(s.why) ?? "snap", target: `"${String(s.title ?? "").slice(0, 40)}" ${s.interactiveVisible ?? 0}/${s.interactiveTotal ?? 0}`, body: name, size: text.length });
  }
}
