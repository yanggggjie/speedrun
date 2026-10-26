import { bodyToText, readableUrl } from "./reqfile.ts";
import { BROWSER_HEADERS, isSafeMethod, UNREPLAYABLE_BODY } from "./replay-core.ts";
import type { RequestFile } from "./types.ts";

export { isSafeMethod };

/** 日志里一个请求的样子（给人和 agent 看的）：地址、请求头、请求体里的秘密都是别名。真正重放用的原始内容在 holder 内存里，不在这里。 */
export type ReplayTemplate = { method: string; url: string; headers: Record<string, string>; body?: string };

/** 签名、时间戳、一次性随机数这类每次请求都会变的头或参数：原样重放通常会被拒。 */
const VOLATILE = /(^|[-_])(sign|signature|nonce|bogus|timestamp|zse|ts|t)([-_]|$)|^x-s(-common)?$|^msToken$|^a_bogus$/i;

/** 从请求文件还原请求。不能重放（是埋点、请求体没存全、是二进制、本身就是重放）时说明原因。 */
export function templateFromRequestFile(file: RequestFile, noise = false): { template: ReplayTemplate; warnings: string[] } | { error: string } {
  if (file.requestType === "replay") return { error: `#${file.seq} 本身就是一次重放，请用被重放的那个请求（#${file.replayOf ?? "?"}）` };
  if (noise) return { error: `#${file.seq} 是埋点或广告请求，不重放` };
  const body = bodyToText(file.requestBody);
  if (body !== undefined && UNREPLAYABLE_BODY.test(body)) return { error: `#${file.seq} 的请求体是文件、二进制或表单数据，日志里没有内容，没法重放` };
  if (file.requestBodyTruncated) return { error: `#${file.seq} 的请求体太大，日志里没存全，没法重放` };
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(file.headers ?? {})) if (!BROWSER_HEADERS.test(k)) headers[k.toLowerCase()] = v;
  const warnings: string[] = [];
  const volatile = [...Object.keys(headers).filter((k) => VOLATILE.test(k)), ...Object.keys(file.url.query).filter((k) => VOLATILE.test(k))];
  if (volatile.length) warnings.push(`带有签名或时间戳类的参数（${[...new Set(volatile)].join(", ")}），重放可能被服务器拒绝；被拒就改用 act`);
  if (!isSafeMethod(file.method)) warnings.push(`${file.method} 请求可能有副作用（下单、提交、删除），重放要加 --yes，并先问过用户`);
  return { template: { method: file.method, url: readableUrl(file.url), headers, ...(body !== undefined ? { body } : {}) }, warnings };
}

/** 响应的一行摘要：JSON 给顶层结构，其它给长度。 */
export function summarizeBody(text: string, ct: string): string {
  if (!text) return "（空）";
  if (/json/i.test(ct) || /^\s*[[{]/.test(text)) {
    try {
      const v = JSON.parse(text) as unknown;
      if (Array.isArray(v)) return `JSON 数组，${v.length} 项${v[0] && typeof v[0] === "object" ? `，每项的字段：${Object.keys(v[0] as object).slice(0, 12).join(", ")}` : ""}`;
      if (v && typeof v === "object") return `JSON 对象，字段：${Object.keys(v as object).slice(0, 16).join(", ")}`;
    } catch { /* 不是合法 JSON */ }
  }
  return `${/html/i.test(ct) ? "HTML" : "文本"}，${text.length} 字符`;
}
