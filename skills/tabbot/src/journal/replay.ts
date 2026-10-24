import { isSameSite, parseUrl } from "../utils/url.ts";
import { BROWSER_HEADERS, isSafeMethod, UNREPLAYABLE_BODY } from "./replay-core.ts";
import type { EventRow } from "./types.ts";

export { isSafeMethod };

/** 日志里一个请求的样子（给人和 agent 看的）：地址、请求头、请求体里的秘密都是别名。真正重放用的原始内容在浏览器里，不在这里。 */
export type ReplayTemplate = { method: string; url: string; headers: Record<string, string>; body?: string };

/** 签名、时间戳、一次性随机数这类每次请求都会变的头或参数：原样重放通常会被拒。 */
const VOLATILE = /(^|[-_])(sign|signature|nonce|bogus|timestamp|zse|ts|t)([-_]|$)|^x-s(-common)?$|^msToken$|^a_bogus$/i;


/** 从日志里的一行还原请求。不能重放（不是请求、是埋点、请求体没存全、是二进制）时说明原因。 */
export function templateFromRow(row: EventRow): { template: ReplayTemplate; warnings: string[] } | { error: string } {
  if (row.kind !== "net" || !row.url || !row.method) return { error: `#${row.seq} 不是一个请求（${row.kind} ${row.verb}）` };
  if (row.verb === "replay") return { error: `#${row.seq} 本身就是一次重放，请用被重放的那个请求` };
  if (row.noise) return { error: `#${row.seq} 是埋点或广告请求，不重放` };
  let detail: { reqHeaders?: Record<string, string>; reqBody?: unknown; reqBodyTruncated?: boolean } = {};
  try { detail = row.detail ? JSON.parse(row.detail) : {}; } catch { /* 没有细节 */ }
  const body = typeof detail.reqBody === "string" ? detail.reqBody : detail.reqBody === undefined ? undefined : JSON.stringify(detail.reqBody);
  if (body !== undefined && UNREPLAYABLE_BODY.test(body)) return { error: `#${row.seq} 的请求体是文件、二进制或表单数据，日志里没有内容，没法重放` };
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(detail.reqHeaders ?? {})) if (!BROWSER_HEADERS.test(k)) headers[k.toLowerCase()] = v;
  const warnings: string[] = [];
  const volatile = [...Object.keys(headers).filter((k) => VOLATILE.test(k)), ...[...new URL(row.url.replace(/⟨[^⟩]*⟩/g, "x")).searchParams.keys()].filter((k) => VOLATILE.test(k))];
  if (volatile.length) warnings.push(`带有签名或时间戳类的参数（${[...new Set(volatile)].join(", ")}），重放可能被服务器拒绝；被拒就改用 act`);
  if (!isSafeMethod(row.method)) warnings.push(`${row.method} 请求可能有副作用（下单、提交、删除），重放要加 --yes，并先问过用户`);
  return { template: { method: row.method, url: row.url, headers, ...(body !== undefined ? { body } : {}) }, warnings };
}

export function sameOrigin(a: string, b: string): boolean {
  try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
}

/**
 * 在候选标签页里挑一个能重放的：请求与标签页同站，且标签页的 origin 等于这个请求原来发出时的页面 origin
 * （`www.xxx.com` 的页面调用 `api.xxx.com` 的请求，换个同样 origin 的标签页发，CORS 和登录态都和原来一样）。前台的优先。
 */
export function pickReplayTab(tabs: { tabId: number; active: boolean; url: string }[], requestUrl: string, originalPage: string): number | undefined {
  const ok = tabs.filter((t) => sameOrigin(t.url, originalPage) && isSameSite(parseUrl(requestUrl), parseUrl(t.url)));
  return (ok.find((t) => t.active) ?? ok[0])?.tabId;
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
