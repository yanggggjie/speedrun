// 从日志里的行和请求文件整理出的纯函数：站点、endpoint 名、变量、响应结构、动作标签。不做 I/O。
import { siteOfUrl } from "../utils/url.ts";
import type { RequestFile, Row } from "./types.ts";

/** 站点：页面的 host（去 www.，非默认端口带上）；不是网址返回空串。 */
export function siteOf(url: string | undefined): string {
  return siteOfUrl(url);
}

/** 把用户输入（域名或网址）变成站点。 */
export function normalizeSite(input: string): string {
  const text = input.trim().toLowerCase();
  if (!text) return "";
  return siteOfUrl(text.includes("://") ? text : `https://${text}`);
}

const ID_SEG = /^(\d{5,}|[0-9a-f]{16,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
/** 请求体顶层的这些字段（字符串值）决定了同一个路径上做的是哪件事：GraphQL 的 operationName、JSON-RPC 的 method、网关的 action / cmd。 */
const OPERATION_KEYS = ["operationName", "operation", "action", "Action", "method", "cmd", "command", "op", "apiName"];
const HTTP_VERB = /^(get|post|put|delete|patch|head|options)$/i;

function bodyObject(body: unknown): Record<string, unknown> | undefined {
  let value = body;
  if (typeof value === "string") { try { value = JSON.parse(value); } catch { return undefined; } }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function operationOf(body: unknown): string | undefined {
  const obj = bodyObject(body);
  if (!obj) return undefined;
  for (const key of OPERATION_KEYS) {
    const v = obj[key];
    if (typeof v === "string" && v.length > 0 && v.length <= 64 && /^[\w.:/-]+$/.test(v) && !HTTP_VERB.test(v)) return v;
  }
  return undefined;
}

/**
 * endpoint 名：GraphQL 取操作名（/graphql/<queryId>/<操作名>，queryId 会变），其它取路径并把长数字、哈希、uuid 换成 :id；
 * 同一路径上请求体里带 operationName / action / method 之类的字符串字段时拼在后面（/graphql#FavoriteTweet、/rpc#listUsers），
 * 否则 POST /graphql 和 POST /rpc 会把所有不同的操作并成一个 endpoint。
 */
export function endpointOf(url: string, body?: unknown): { host: string; name: string } {
  try {
    const u = new URL(url);
    const segs = u.pathname.split("/").filter(Boolean);
    const gi = segs.indexOf("graphql");
    if (gi >= 0 && segs.length > gi + 2) return { host: u.hostname, name: `graphql ${segs[gi + 2]}` };
    const path = "/" + segs.map((s) => (ID_SEG.test(s) ? ":id" : s)).join("/");
    const op = operationOf(body);
    return { host: u.hostname, name: op ? `${path}#${op}` : path };
  } catch {
    return { host: "", name: url.slice(0, 60) };
  }
}

/** action 文件头 @endpoint 的写法：`方法 路径`。 */
export const endpointKey = (method: string, name: string): string => `${method} ${name}`;

/** 一行的"谁做了什么"：`user click button[Like]`、`agent cmd goto https://…`。 */
export function causeLabel(row: Row): string {
  return `${row.src} ${row.type === "cmd" ? "cmd " : ""}${row.kind ?? row.type}${row.target ? ` ${row.target}` : ""}`.trim();
}

function jsonKeys(v: unknown): string[] {
  return v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v as object) : [];
}

/** 请求里能改的变量：请求体 JSON（有 variables 就取它里面的）或查询参数里 JSON 的 variables。 */
export function variablesOf(file: Pick<RequestFile, "requestBody" | "url">): string[] {
  const out: string[] = [];
  let body: unknown = file.requestBody;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = undefined; } }
  const vars = (body as { variables?: unknown } | undefined)?.variables;
  out.push(...(jsonKeys(vars).length ? jsonKeys(vars) : jsonKeys(body).filter((k) => k !== "queryId")));
  const query = file.url?.query ?? {};
  for (const [k, v] of Object.entries(query)) {
    if (k === "variables") {
      try { out.push(...jsonKeys(JSON.parse(v)).map((x) => `variables.${x}`)); } catch { /* 不是 JSON */ }
    } else if (!["features", "fieldToggles"].includes(k) && out.length < 12) out.push(k);
  }
  return [...new Set(out)].slice(0, 12);
}

/** JSON 的结构概要：沿着只有一个键的对象往下走，到第一个有多个键的地方列出键，如 data.home.home_timeline_urt.{instructions,metadata}。 */
export function shapeOf(value: unknown): string {
  const path: string[] = [];
  let cur = value;
  for (let depth = 0; depth < 8; depth++) {
    if (Array.isArray(cur)) return `${path.join(".")}[${cur.length}]${cur[0] && typeof cur[0] === "object" ? `{${Object.keys(cur[0] as object).slice(0, 8).join(",")}}` : ""}`;
    const keys = jsonKeys(cur);
    if (keys.length === 0) return path.join(".") || "（空）";
    if (keys.length > 1) return `${path.length ? `${path.join(".")}.` : ""}{${keys.slice(0, 8).join(",")}${keys.length > 8 ? ",…" : ""}}`;
    path.push(keys[0]!);
    cur = (cur as Record<string, unknown>)[keys[0]!];
  }
  return path.join(".");
}

/** 名字像只读操作的 RPC / GraphQL 操作：getUser、listOrders、SearchTimeline、DescribeInstances…… */
const READ_VERB = /^(get|list|query|search|fetch|find|count|describe|batchget|check|preview|load|read)(?=[A-Z_\-:.]|$)/i;

/**
 * 非 GET 的请求是不是其实只读：GraphQL 的 query（不是 mutation），或 endpoint 名、操作名以 get / list / search 之类开头。
 * 观察据此给写请求标 write。宁可当成写请求：判断不出来就算写。
 */
export function looksReadOnly(method: string | undefined, url: string, body?: unknown): boolean {
  if (!method || ["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) return true;
  let value = body;
  if (typeof value === "string") { try { value = JSON.parse(value); } catch { /* 不是 JSON */ } }
  const ops = Array.isArray(value) ? value : [value];
  const objs = ops.filter((o): o is Record<string, unknown> => !!o && typeof o === "object");
  if (objs.length && objs.every((o) => typeof o.query === "string")) return objs.every((o) => !/^\s*mutation\b/.test(String(o.query)));
  const op = objs.map((o) => o.operationName ?? o.action ?? o.Action).find((x) => typeof x === "string") as string | undefined;
  if (op) return READ_VERB.test(op);
  let last = "";
  try { last = new URL(url).pathname.split("/").filter(Boolean).at(-1) ?? ""; } catch { /* 地址不完整 */ }
  return READ_VERB.test(last);
}
