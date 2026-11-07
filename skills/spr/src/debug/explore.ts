/**
 * debug 窗口里"观察"用的纯函数：游标之后发生的请求里哪些值得列出（含 GET，写明有没有响应体）、一行怎么写、
 * 请求之间的依赖（后一个用了前一个响应里的值）。
 */
import type { RequestFile, Row } from "../record/types.ts";

/** 静态资源不算“引发了请求”：脚本、样式、图片、字体。 */
const STATIC = /\.(?:m?js|css|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|map|mp4|webm)(?:$|\?)/i;

export type PeriodicStat = { count: number; idle: number; cmdTriggered: number };

/** 周期性 endpoint（轮询、心跳）：多数调用是 idle，落在动作后两秒内的只是碰巧（远少于 idle）。它们出现在动作之后也不算这一步引发的。 */
export function isPeriodic(stat: PeriodicStat | undefined): boolean {
  return !!stat && stat.idle >= 3 && stat.idle * 2 >= stat.count && stat.cmdTriggered * 4 <= stat.idle;
}

/** 值得列出的请求：非噪声、非疑似埋点、非静态资源、非周期性 endpoint（轮询、心跳）。返回列出的和折叠掉的个数。 */
export function shownRequests(rows: Row[], stats: ReadonlyMap<string, PeriodicStat>): { shown: Row[]; noise: number; telemetry: number; periodic: number; assets: number } {
  const out = { shown: [] as Row[], noise: 0, telemetry: 0, periodic: 0, assets: 0 };
  for (const r of rows) {
    if (r.type !== "request") continue;
    if (r.noise) out.noise++;
    else if (r.maybeTelemetry) out.telemetry++;
    else if (STATIC.test(r.url ?? "")) out.assets++;
    else if (isPeriodic(r.endpoint ? stats.get(r.endpoint) : undefined)) out.periodic++;
    else out.shown.push(r);
  }
  return out;
}

/**
 * 一个请求的一行：编号、`方法 路径`、状态、内容类型、有没有响应体（没有就写原因）、请求文件（窗口内的相对路径）；
 * other 是请求不在 debug 窗口起点的站点时写上站点。
 */
export function describeRequest(r: Row, file: RequestFile | undefined, opts: { other?: string }): { line: string; readable: boolean } {
  const ct = file?.responseHeaders?.["content-type"]?.split(";")[0]?.trim() || "未知类型";
  const readable = !!file?.responseBodyPath;
  const body = readable ? "有响应体" : `无响应体（${file?.bodyOmitted ?? file?.error ?? "没存"}）`;
  return { line: `#${r.seq} ${r.endpoint ?? `${r.method ?? "?"} ${r.url ?? ""}`}${opts.other ? `（${opts.other}）` : ""} → ${r.status ?? "?"} ${ct}，${body}，${r.file ?? "（没有请求文件）"}`, readable };
}

/** 路径里的这些词多半是配置和上报，不是业务接口。 */
const LOW_VALUE = /(?:^|[/_.-])(?:report|reports|log|logs|track|tracking|metric|metrics|stats?|gray|grayconfig|config|configs|version|ping|beacon|collect|telemetry|monitor)(?:$|[/_.?-])/i;

/** 内容能对上的证据：请求里出现了 agent 输入的值、响应里出现了页面上的文字。 */
export type RelevanceHints = { input?: boolean; pageText?: boolean };

/** 请求和这一步的相关程度：只用来排序，不用来丢请求；分数低的折叠成数量。 */
export function relevance(r: Row, file: RequestFile | undefined, hints: RelevanceHints = {}): number {
  let n = 0;
  if (hints.input) n += 4;
  if (hints.pageText) n += 4;
  if (r.phase === "cmd" || r.cause !== undefined) n += 3;
  if (r.phase === "idle") n -= 1;
  if (file?.responseBodyPath && /json/i.test(file.responseHeaders?.["content-type"] ?? "")) n += 1;
  if (LOW_VALUE.test(r.endpoint ?? r.url ?? "")) n -= 3;
  if ((r.status ?? 200) >= 400) n -= 2;
  return n;
}

export type Dependency = { from: number; to: number; field: string };

/** 把响应体里长度 ≥ 6 的字符串和数字值连同路径收集起来（只取第一次出现的位置）。 */
export function valuesOf(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let json: unknown;
  try { json = JSON.parse(text); } catch { return out; }
  const walk = (v: unknown, at: string, depth: number): void => {
    if (depth > 12 || out.size > 5000) return;
    if (typeof v === "string" || typeof v === "number") { const s = String(v); if (s.length >= 6 && !out.has(s)) out.set(s, at || "（整个响应）"); return; }
    if (Array.isArray(v)) { v.slice(0, 50).forEach((x, i) => walk(x, `${at}[${i}]`, depth + 1)); return; }
    if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, at ? `${at}.${k}` : k, depth + 1);
  };
  walk(json, "", 0);
  return out;
}

/** 一个请求带出去的值：查询参数和请求体（JSON 里的叶子值）里长度 ≥ 6 的；raw 是 daemon 内存里的原始请求，有就把原文也算上。 */
function sentValues(file: RequestFile, raw?: { url: string; body: string | null; headers?: Record<string, string> }): string[] {
  const out: string[] = [];
  const walk = (v: unknown, depth: number): void => {
    if (depth > 12 || out.length > 500) return;
    if (typeof v === "string" || typeof v === "number") { const s = String(v); if (s.length >= 6) out.push(s); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (v && typeof v === "object") for (const x of Object.values(v)) walk(x, depth + 1);
  };
  // 日志里的值：秘密是别名，同一个秘密永远是同一个别名，响应体里同样脱敏时能直接对上
  walk(file.url?.query ?? {}, 0);
  walk(file.requestBody, 0);
  walk(file.headers ?? {}, 0); // auth 头也算：上传凭证、nonce 这类来自前序响应的头
  // 再加上原文：响应体里没被脱敏的秘密（字段名不像 token）只能用原文对上
  if (raw) {
    try { walk(Object.fromEntries(new URL(raw.url).searchParams), 0); } catch { /* 地址不完整 */ }
    if (raw.body) { try { walk(JSON.parse(raw.body), 0); } catch { walk(Object.fromEntries(new URLSearchParams(raw.body)), 0); } }
    if (raw.headers) walk(Object.fromEntries(Object.entries(raw.headers).filter(([k]) => !/^(cookie|user-agent|accept|referer|origin)/i.test(k))), 0);
  }
  return out;
}

/**
 * 请求之间的依赖：后一个请求的查询参数或请求体里，有长度 ≥ 6 的值和前一个请求的响应体里某个值完全相等。
 * 例如 "#813 里有一个值与 #812 响应的 data.token 相同"（值相同可能是巧合）。agent 据此判断几个请求是一条依赖链（放进同一个 action，或拆开再用 compose 串起来），还是互不相干。只输出字段路径，不输出值。
 */
/**
 * 请求之间的依赖：后一个请求里的值等于前面某个响应里的值，就记下来源（最近的那个）。
 * onlyTo 给了就只找这些请求的来源（观察里只报这次列出的请求），来源可以是 rows 里更早的任何请求（之前几步的也算：页面加载时拿的 token、几步之后提交时用）。
 */
export function dependencies(rows: Row[], fileOf: (seq: number) => RequestFile | undefined, bodyOf: (file: RequestFile) => string | undefined, rawOf?: (file: RequestFile) => { url: string; body: string | null; headers?: Record<string, string> } | undefined, onlyTo?: ReadonlySet<number>): Dependency[] {
  const reqs = rows.filter((r) => r.type === "request").sort((a, b) => a.seq - b.seq);
  const responses = new Map<number, Map<string, string>>();
  const out: Dependency[] = [];
  for (let j = 1; j < reqs.length; j++) {
    if (onlyTo && !onlyTo.has(reqs[j]!.seq)) continue;
    const fb = fileOf(reqs[j]!.seq);
    if (!fb) continue;
    const sent = sentValues(fb, rawOf?.(fb));
    if (!sent.length) continue;
    for (let i = j - 1; i >= 0; i--) {
      const a = reqs[i]!.seq;
      if (!responses.has(a)) { const fa = fileOf(a); const text = fa ? bodyOf(fa) : undefined; responses.set(a, text ? valuesOf(text) : new Map()); }
      const hit = sent.find((v) => responses.get(a)!.has(v));
      if (hit) { out.push({ from: a, to: reqs[j]!.seq, field: responses.get(a)!.get(hit)! }); break; }
    }
  }
  return out;
}
