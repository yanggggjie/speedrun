/**
 * 身份头的来源：拿请求头的真值（holder 内存里的原始请求）和页面此刻的 cookie、localStorage、sessionStorage、meta 比对，
 * 再看同一接口各次请求里这个头变不变，判断每个身份头从哪来。结果只写来源（"cookie:_xsrf"），不写值。
 * 前序响应这一类由 explore.ts 的 dependencies 判断（"#813 用了 #812 响应的 data.token"）。
 */
import { BROWSER_HEADERS } from "./replay-core.ts";
import { VOLATILE } from "./replay.ts";

/** 页面里读到的存储快照（page/executor.js 的 authSnapshot）。 */
export type AuthSnapshot = { cookie: Record<string, string>; local: Record<string, string>; session: Record<string, string>; meta: Record<string, string> };
/** spec 是 SDK 里 request 的 auth 写法（"cookie:_xsrf"、"Bearer local:token.access"），只有能在页面里现读的四种来源才有。 */
export type AuthSource = { kind: "cookie" | "local" | "session" | "meta" | "signed" | "static" | "unknown"; spec?: string };

/** 要判断来源的头：身份、csrf、token、x-* 自定义头，以及签名类的头。普通头（content-type、accept）不管。 */
const CREDENTIAL = /auth|csrf|xsrf|token|session|^x-/i;
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

/**
 * headers：这次请求的原始请求头（真值）；snap：页面存储快照（没有就只按变不变判断）；history：同一接口别的请求里同名头的值；
 * siteHistory：同站别的接口里同名头的值（x-api-version 这类各接口都一样的头，在这里认成不变的值）。
 * 返回每个要判断的头的来源。顺序：能在页面里现读的来源 > 签名（名字像签名，或各次请求都不同）> 不变的值 > 不明。
 */
export function classifyAuth(headers: Record<string, string>, snap: AuthSnapshot | undefined, history: Record<string, string[]> = {}, siteHistory: Record<string, string[]> = {}): Record<string, AuthSource> {
  const out: Record<string, AuthSource> = {};
  for (const [name0, value] of Object.entries(headers)) {
    const name = name0.toLowerCase();
    if (BROWSER_HEADERS.test(name) || !(CREDENTIAL.test(name) || VOLATILE.test(name)) || typeof value !== "string") continue;
    const bare = value.replace(/^Bearer\s+/i, "");
    const prefix = bare === value ? "" : "Bearer ";
    let found: AuthSource | undefined;
    if (snap && bare.length >= MIN_LEN) {
      const c = Object.entries(snap.cookie).find(([, v]) => v === bare)?.[0];
      const l = c === undefined ? inStore(snap.local, bare) : undefined;
      const se = c === undefined && l === undefined ? inStore(snap.session, bare) : undefined;
      const m = c === undefined && l === undefined && se === undefined ? Object.entries(snap.meta).find(([, v]) => v === bare)?.[0] : undefined;
      if (c !== undefined) found = { kind: "cookie", spec: `${prefix}cookie:${c}` };
      else if (l !== undefined) found = { kind: "local", spec: `${prefix}local:${l}` };
      else if (se !== undefined) found = { kind: "session", spec: `${prefix}session:${se}` };
      else if (m !== undefined) found = { kind: "meta", spec: `${prefix}meta:${m}` };
    }
    if (!found) {
      const others = history[name] ?? [];
      const site = siteHistory[name] ?? [];
      if (VOLATILE.test(name) || others.some((v) => v !== value)) found = { kind: "signed" };
      else if (others.length || (site.length && site.every((v) => v === value))) found = { kind: "static" };
      else found = { kind: "unknown" };
    }
    out[name] = found;
  }
  return out;
}

/** 一行给 agent 看的来源说明（不含值）。 */
export function describeAuth(sources: Record<string, AuthSource>): string {
  const text = (s: AuthSource): string => {
    switch (s.kind) {
      case "cookie": case "local": case "session": case "meta": return s.spec!.replace(/^(Bearer )?(\w+):/, (_w, b, k) => `${b ?? ""}${{ cookie: "cookie ", local: "localStorage ", session: "sessionStorage ", meta: "meta " }[k as string]}`);
      case "signed": return "签名（每次都变；换参数可能被拒，以 replay、run 的结果为准，被拒就用页面实现）";
      case "static": return "不变的值（照常继承）";
      default: return "来源不明（会从最近的请求继承）";
    }
  };
  return Object.entries(sources).map(([h, s]) => `${h} ← ${text(s)}`).join("；");
}

/** 能写进 SDK request 的 auth 声明的那部分。 */
export function authSpecs(sources: Record<string, AuthSource>): Record<string, string> {
  return Object.fromEntries(Object.entries(sources).filter(([, s]) => s.spec).map(([h, s]) => [h, s.spec!]));
}
