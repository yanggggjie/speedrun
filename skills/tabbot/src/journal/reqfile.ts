import { createHash } from "node:crypto";
import { UNREPLAYABLE_BODY } from "./replay-core.ts";
import type { Sanitizer } from "./sanitize.ts";
import type { ParsedUrl } from "./types.ts";

// 请求文件、响应体文件的命名与内容整理（秘密在这里换成别名）。

export const REQ_BODY_MAX = 64 * 1024;
export const REQ_OMITTED = "[请求体已省略：太大，或不是完整的 JSON]";
const ALIAS_ONLY = /^⟨secret_[0-9a-f]+:\w+⟩$/;

export const hashText = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** 文件名里用的一段：只留字母数字和 ._-，其余换成下划线，过长截断。 */
export function slug(text: string, max = 60): string {
  return text.replace(/^https?:\/\//, "").replace(/[^A-Za-z0-9.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, max) || "x";
}

/** 接口名变成文件名里的一段：/api/v4/answers/:id/voters → api-v4-answers-_id-voters。 */
export function endpointSlug(name: string): string {
  return name.replace(/^\/+/, "").replace(/\//g, "-").replace(/:/g, "_").replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[-_]+|[-_]+$/g, "").slice(0, 80) || "root";
}

/** 页面地址变成文件名里的一段：路径部分，首页是 index。 */
export function pageSlug(url: string): string {
  let p = "";
  try { p = new URL(url).pathname; } catch { p = url; }
  return endpointSlug(p) === "root" ? "index" : endpointSlug(p);
}

/** requests/001203-GET-api-v4-search_v3：请求文件和响应体共用的前半截（窗口内的相对路径），编号在最前面，glob 和排序都靠它，后面是方法和接口名。 */
export function requestStem(seq: number, method: string, endpointName: string): string {
  return `requests/${String(seq).padStart(6, "0")}-${method.toUpperCase()}-${endpointSlug(endpointName)}`;
}

export function bodyExt(ct: string | undefined | null, text: string): string {
  if (/json/i.test(ct ?? "") || /^\s*[[{]/.test(text)) return "json";
  if (/html/i.test(ct ?? "")) return "html";
  return "txt";
}

/** 脱敏后的地址：别名 ⟨secret_a3f9c1e2d4b7:jwt⟩ 保持原样好读，其它参数照常编码（编码会把别名也编码掉）。 */
export function readableUrl(parsed: ParsedUrl): string {
  const parts = Object.entries(parsed.query).map(([k, v]) => `${encodeURIComponent(k)}=${ALIAS_ONLY.test(v) ? v : encodeURIComponent(v)}`);
  return parts.length ? `${parsed.bareUrl}?${parts.join("&")}` : parsed.bareUrl;
}

/** 把响应体变成可 grep 的文本：JSON 就缩进展开（脱敏之后），其它原样。 */
export function responseText(sanitizer: Sanitizer, raw: string, ct: string | undefined | null): string {
  if (/json/i.test(ct ?? "") || /^\s*[[{]/.test(raw)) {
    try { return JSON.stringify(sanitizer.body(JSON.parse(raw)), null, 1); } catch { /* 不是合法 JSON：按文本处理 */ }
  }
  return raw;
}

/** 请求体整理成请求文件里的 requestBody：JSON 解析成对象，表单解析成对象，其它是脱敏后的文字；太大或不完整的 JSON 不存内容。 */
export function requestBodyValue(sanitizer: Sanitizer, body: string | undefined, headers: Record<string, string> | null | undefined): { value?: unknown; truncated?: boolean } {
  if (!body) return {};
  if (UNREPLAYABLE_BODY.test(body)) return { value: body.slice(0, 40) }; // 页面脚本放的占位文字（文件、二进制、没读到），原样保留
  if (body.length > REQ_BODY_MAX) return { value: REQ_OMITTED, truncated: true };
  if (/^\s*[[{]/.test(body)) {
    try { return { value: sanitizer.body(JSON.parse(body)) }; } catch { return { value: REQ_OMITTED, truncated: true }; }
  }
  const ct = String(headers?.["content-type"] ?? "");
  return { value: sanitizer.body(body, /x-www-form-urlencoded/i.test(ct)) };
}

/** 请求文件里的 requestBody 变回要发的文字（重放、req 展示用）。 */
export function bodyToText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" ? value : JSON.stringify(value);
}
