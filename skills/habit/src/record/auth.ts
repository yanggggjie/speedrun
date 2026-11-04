/**
 * 请求头的信号：每个要关心的头，值怎么变（headers.ts 的 headerKinds），以及能不能在页面固定位置找到同一个值（cookie、localStorage、sessionStorage、meta）。
 * 拿请求头的真值（daemon 内存里的原始请求）和页面此刻的存储比对，结果只写来源（"cookie:_xsrf"）和类别，不写值。
 * 给 agent 的信号：页面这次没发带这个头的请求时，照来源写进 request 的 auth；前序响应这一类由 explore.ts 的 dependencies 判断。
 */
import { HEADER_KIND_TEXT, notableHeaders, type HeaderKind } from "./headers.ts";

/** 页面里读到的存储快照（page/executor.js 的 authSnapshot）。 */
export type AuthSnapshot = { cookie: Record<string, string>; local: Record<string, string>; session: Record<string, string>; meta: Record<string, string> };
/** source 是 SDK 里 request 的 auth 写法（"cookie:_xsrf"、"Bearer local:token.access"），只有能在页面里现读的四种来源才有。 */
export type HeaderSignal = { kind: HeaderKind; source?: string };

const MIN_LEN = 6;

/** JSON 里等于 value 的叶子的路径（只取第一个）。 */
function findPath(json: unknown, value: string, depth = 0): string | undefined {
  if (depth > 8 || json === null || typeof json !== "object") return undefined;
  for (const [k, v] of Object.entries(json as Record<string, unknown>)) {
    if ((typeof v === "string" || typeof v === "number") && String(v) === value) return k;
    const sub = findPath(v, value, depth + 1);
    if (sub) return `${k}.${sub}`;
  }
  return undefined;
}

function inStore(store: Record<string, string>, value: string): string | undefined {
  for (const [k, v] of Object.entries(store)) {
    if (v === value) return k;
    if (/^\s*[[{]/.test(v)) { try { const p = findPath(JSON.parse(v), value); if (p) return `${k}.${p}`; } catch { /* 不是 JSON */ } }
  }
  return undefined;
}

/** 这个值在页面存储里的位置，写成 request 的 auth 来源；找不到是 undefined。 */
function sourceOf(value: string, snap: AuthSnapshot): string | undefined {
  const bare = value.replace(/^Bearer\s+/i, "");
  if (bare.length < MIN_LEN) return undefined;
  const prefix = bare === value ? "" : "Bearer ";
  const c = Object.entries(snap.cookie).find(([, v]) => v === bare)?.[0];
  if (c !== undefined) return `${prefix}cookie:${c}`;
  const l = inStore(snap.local, bare);
  if (l !== undefined) return `${prefix}local:${l}`;
  const se = inStore(snap.session, bare);
  if (se !== undefined) return `${prefix}session:${se}`;
  const m = Object.entries(snap.meta).find(([, v]) => v === bare)?.[0];
  return m !== undefined ? `${prefix}meta:${m}` : undefined;
}

/** headers：这次请求的原始请求头（真值）；snap：页面存储快照（没有就只给类别）；kinds：这个窗口里同站请求的统计。 */
export function headerSignals(headers: Record<string, string>, snap: AuthSnapshot | undefined, kinds: ReadonlyMap<string, HeaderKind>): Record<string, HeaderSignal> {
  const out: Record<string, HeaderSignal> = {};
  for (const [name, value] of Object.entries(notableHeaders(headers))) {
    const source = snap ? sourceOf(value, snap) : undefined;
    out[name] = { kind: kinds.get(name) ?? "few", ...(source ? { source } : {}) };
  }
  return out;
}

/** 一行给 agent 看的信号（不含值）：x-xsrftoken 页面级不变 ← cookie _xsrf；x-zse-96 每次都变。 */
export function describeHeaders(signals: Record<string, HeaderSignal>): string {
  const where = (spec: string): string => spec.replace(/^(Bearer )?(\w+):/, (_w, b, k) => `${b ?? ""}${{ cookie: "cookie ", local: "localStorage ", session: "sessionStorage ", meta: "meta " }[k as string]}`);
  return Object.entries(signals).map(([h, s]) => `${h} ${HEADER_KIND_TEXT[s.kind]}${s.source ? ` ← ${where(s.source)}` : ""}`).join("；");
}
