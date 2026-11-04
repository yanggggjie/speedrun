import * as fs from "node:fs";
import * as path from "node:path";
import { HABIT_HOME } from "../utils/constants.ts";
import { FiltersEngine, Request as FilterRequest } from "@ghostery/adblocker";
import { isSameSite, parseUrl } from "../utils/url.ts";

export const ADBLOCK_CACHE = path.join(HABIT_HOME, "adblock-engine.bin");
const ADBLOCK_MAX_AGE_MS = 7 * 24 * 3600_000;

const fromCache = (file: string): FiltersEngine | undefined => {
  try { return FiltersEngine.deserialize(new Uint8Array(fs.readFileSync(file))); } catch { return undefined; } // 没有缓存，或库升级后格式不认
};

/**
 * adblock 规则：缓存在 ~/.habit/adblock-engine.bin，7 天内直接用缓存，过期才联网下载（daemon 空闲 10 分钟就退出，不能每次启动都下载）。
 * 下载失败（离线）就用过期的缓存；都没有时只用启发式识别噪声。
 */
export async function loadAdblockEngine(file = ADBLOCK_CACHE): Promise<FiltersEngine> {
  let fresh = false;
  try { fresh = Date.now() - fs.statSync(file).mtimeMs < ADBLOCK_MAX_AGE_MS; } catch { /* 没有缓存 */ }
  const cached = fresh ? fromCache(file) : undefined;
  if (cached) return cached;
  try {
    const engine = await FiltersEngine.fromPrebuiltAdsAndTracking(fetch);
    try { fs.writeFileSync(file, engine.serialize()); } catch { /* 写不了缓存不影响使用 */ }
    return engine;
  } catch (error) {
    const stale = fromCache(file);
    if (stale) return stale;
    throw error;
  }
}

function adblockMatches(url: string, via: string, sourceUrl: string, engine: FiltersEngine | undefined): boolean {
  if (!engine) return false;
  try {
    return engine.match(FilterRequest.fromRawDetails({ url, type: via === "xhr" ? "xmlhttprequest" : "fetch", sourceUrl })).match;
  } catch {
    return false;
  }
}

/**
 * 第一方埋点：adblock 规则抓不住同站的上报（知乎的 zhihu-web-analytics、datahub、apm 都是同站）。
 * 只对非 GET 生效：GET /api/stats 这类可能是人要看的数据，不能当噪声。
 */
export const TELEMETRY_HOST = /(analytics|telemetry|apm|datahub|track|metrics|sentry|beacon|collector)/i;
export const TELEMETRY_PATH = /(^|[/._-])(collect|collector|track|tracking|beacon|analytics|telemetry|metrics|pixel|apm|sentry|logs?|stats?|events?|monitor|heartbeat|profiler|za)([/._?-]|$)/i;

export type NoiseInput = { url: string; method: string; status?: number; via: string; page: string };

/** 返回噪声原因，不是噪声返回 null。adblock 引擎没加载好（离线）时只用启发式。 */
export function noiseReason(input: NoiseInput, engine?: FiltersEngine): string | null {
  if (adblockMatches(input.url, input.via, input.page, engine)) return "adblock";
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
