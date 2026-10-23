import type { FiltersEngine } from "@ghostery/adblocker";
import { isSameSite, parseUrl } from "../utils/url.ts";
import { shouldSkipRecordUrl } from "../record/pipeline.ts";
import type { RequestKind } from "../record/types.ts";

/**
 * 第一方埋点：adblock 规则抓不住同站的上报（知乎的 zhihu-web-analytics、datahub、apm 都是同站）。
 * 只对非 GET 生效：GET /api/stats 这类可能是人要看的数据，不能当噪声。
 * hook.js 里有同一份正则（页面里没法 import），filter.selfcheck.ts 校验两边一致。
 */
export const TELEMETRY_HOST = /(analytics|telemetry|apm|datahub|track|metrics|sentry|beacon|collector)/i;
export const TELEMETRY_PATH = /(^|[/._-])(collect|collector|track|tracking|beacon|analytics|telemetry|metrics|pixel|apm|sentry|logs?|stats?|events?|monitor|heartbeat|profiler|za)([/._?-]|$)/i;

export type NoiseInput = { url: string; method: string; status?: number; via: string; page: string };

/** 返回噪声原因，不是噪声返回 null。adblock 引擎没加载好（离线）时只用启发式。 */
export function noiseReason(input: NoiseInput, engine?: FiltersEngine): string | null {
  const kind: RequestKind = input.via === "xhr" ? "xhr" : "fetch";
  if (input.via === "beacon") return "beacon";
  if (shouldSkipRecordUrl(input.url, kind, input.page, engine)) return "adblock";
  if (input.method === "GET") return null;
  let host = "";
  let pathname = "";
  try { const u = new URL(input.url); host = u.hostname; pathname = u.pathname; } catch { return null; }
  if (TELEMETRY_HOST.test(host)) return "telemetry-host";
  if (TELEMETRY_PATH.test(pathname)) return "telemetry-path";
  if (input.status === 204) return "no-content";
  return null;
}

/** 响应体写不写盘：只写同站、非噪声、有内容的；失败的请求只留小响应体（够看出错在哪）。 */
export function shouldStoreBody(input: { noise: boolean; url: string; page: string; status?: number; body?: string }): boolean {
  if (input.noise || !input.body) return false;
  if (!isSameSite(parseUrl(input.url), parseUrl(input.page))) return false;
  const ok = typeof input.status === "number" && input.status >= 200 && input.status < 300;
  return ok || input.body.length <= 4096;
}
