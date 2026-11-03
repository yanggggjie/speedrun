/**
 * learn 窗口里"观察"用的纯函数：游标之后发生的请求里哪些值得列出（含 GET，写明有没有响应体）、一行怎么写、
 * 请求之间的依赖（后一个用了前一个响应里的值），以及可贴进 action 的一行。没有请求时这一行就是 DOM 步骤的 draft。
 */
import type { RequestFile, Row } from "./types.ts";

/** 静态资源不算“引发了请求”：脚本、样式、图片、字体。 */
const STATIC = /\.(?:m?js|css|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|map|mp4|webm)(?:$|\?)/i;

export type PeriodicStat = { count: number; idle: number; cmdTriggered: number };

/** 周期性 endpoint（轮询、心跳）：多数调用是 idle，落在动作后两秒内的只是碰巧（远少于 idle）。它们出现在动作之后也不算这一步引发的。 */
export function isPeriodic(stat: PeriodicStat | undefined): boolean {
  return !!stat && stat.idle >= 3 && stat.idle * 2 >= stat.count && stat.cmdTriggered * 4 <= stat.idle;
}

/** 值得列出的请求：非噪声、非静态资源、非周期性 endpoint（轮询、心跳）。返回列出的和折叠掉的个数。 */
export function shownRequests(rows: Row[], stats: ReadonlyMap<string, PeriodicStat>): { shown: Row[]; noise: number; periodic: number; assets: number } {
  const out = { shown: [] as Row[], noise: 0, periodic: 0, assets: 0 };
  for (const r of rows) {
    if (r.type !== "request") continue;
    if (r.noise) out.noise++;
    else if (STATIC.test(r.url ?? "")) out.assets++;
    else if (isPeriodic(r.endpoint ? stats.get(r.endpoint) : undefined)) out.periodic++;
    else out.shown.push(r);
  }
  return out;
}

/**
 * 一个请求的一行：write（写请求）、编号、`方法 路径`、状态、内容类型、有没有响应体（没有就写原因）、请求文件（窗口内的相对路径）；
 * other 是请求不在 learn 窗口起点的站点时写上站点；known 是这个 endpoint 以前记下的 description（description）。
 */
export function describeRequest(r: Row, file: RequestFile | undefined, opts: { write: boolean; other?: string; known?: string }): { line: string; readable: boolean } {
  const ct = file?.responseHeaders?.["content-type"]?.split(";")[0]?.trim() || "未知类型";
  const readable = !!file?.responseBodyPath;
  const body = readable ? "有响应体" : `无响应体（${file?.bodyOmitted ?? file?.error ?? "没存"}）`;
  return { line: `${opts.write ? "write" : "     "} #${r.seq} ${r.endpoint ?? `${r.method ?? "?"} ${r.url ?? ""}`}${opts.other ? `（${opts.other}）` : ""} → ${r.status ?? "?"} ${ct}，${body}，${r.file ?? "（没有请求文件）"}${opts.known ? `（以前：${opts.known}）` : ""}`, readable };
}

type StepCmd = { kind: string; text?: string; key?: string; dx?: number; dy?: number; to?: string };

/** 可贴进 action draft 的一行（SDK 见 src/action-lib/index.js）。 */
export function stepLine(cmd: StepCmd, loc: unknown): string {
  const where = loc ? JSON.stringify(loc) : undefined;
  switch (cmd.kind) {
    case "click": return where ? `await click(${where});` : "// 这一步点击没有拿到持久定位：换个更具体的位置再点";
    case "type": return where ? `await fill(${where}, ${JSON.stringify(cmd.text ?? "")});` : `// 输入 ${JSON.stringify(cmd.text ?? "")}：先 click 输入框拿到定位，再写 await fill(<定位>, …);`;
    case "key": return `await press(${JSON.stringify(cmd.key ?? "")});`;
    case "scroll": {
      const opts = cmd.to ? { to: cmd.to } : { dy: cmd.dy };
      return `await scroll(${JSON.stringify(where ? { loc, ...opts } : opts)});`;
    }
    default: return "";
  }
}

export type Dependency = { from: number; to: number; field: string };

/** 把响应体里长度 ≥ 6 的字符串和数字值连同路径收集起来（只取第一次出现的位置）。 */
function valuesOf(text: string): Map<string, string> {
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
 * 例如 "#813 用了 #812 响应的 data.token"。agent 据此判断几个请求是一条依赖链（放进同一个 action，或拆开再用 compose 串起来），还是互不相干。只输出字段路径，不输出值。
 */
export function dependencies(rows: Row[], fileOf: (seq: number) => RequestFile | undefined, bodyOf: (file: RequestFile) => string | undefined, rawOf?: (file: RequestFile) => { url: string; body: string | null; headers?: Record<string, string> } | undefined): Dependency[] {
  const reqs = rows.filter((r) => r.type === "request").sort((a, b) => a.seq - b.seq);
  const responses = new Map<number, Map<string, string>>();
  const out: Dependency[] = [];
  for (let j = 1; j < reqs.length; j++) {
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

/** 多行 @endpoint 是不是按顺序都出现在这次运行发出的请求里（可以夹着别的请求）；返回缺的那一行。 */
export function missingInSequence(expected: string[], sent: string[]): string | undefined {
  let i = 0;
  for (const e of sent) if (i < expected.length && e === expected[i]) i++;
  return i < expected.length ? expected[i] : undefined;
}
