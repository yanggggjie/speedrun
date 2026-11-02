// 重放用的纯函数：把 agent 的 --set 应用到原始请求上，并整理出可以交给 fetch 的请求头。

/** 浏览器自己管的请求头：页面脚本设不了（或不该设），重放时丢掉。 */
export const BROWSER_HEADERS = /^(host|content-length|cookie|origin|referer|user-agent|accept-encoding|accept-language|connection|keep-alive|transfer-encoding|upgrade|sec-.*|proxy-.*)$/i;
/** 录制时对请求体放的占位文字：说明请求体是文件、二进制或没读到，没法重放。 */
export const UNREPLAYABLE_BODY = /^\[(FormData|Blob|Binary|Request body not read|object)/;

export function isSafeMethod(method: string): boolean {
  return method === "GET" || method === "HEAD";
}

export type RawRequest = { method: string; url: string; headers: Record<string, string>; body?: string | null };

const isIndex = (k: string): boolean => /^\d+$/.test(k);

/** 按已有值的类型转换：数字字段给 "2" 就是数字 2，布尔字段给 "true" 就是 true，null、对象、数组按 JSON。 */
function coerce(existing: unknown, value: string): unknown {
  if (typeof existing === "number" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  if (typeof existing === "boolean" && (value === "true" || value === "false")) return value === "true";
  if (existing === null || typeof existing === "object") { try { return JSON.parse(value); } catch { /* 当字符串 */ } }
  return value;
}

function setPath(root: Record<string, unknown>, keys: string[], value: string): { error?: string } {
  let cur: Record<string, unknown> = root;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]!;
    let next = cur[k];
    if (next === undefined || next === null) { next = isIndex(keys[i + 1]!) ? [] : {}; cur[k] = next; }
    if (typeof next !== "object") return { error: `请求体里 ${keys.slice(0, i + 1).join(".")} 不是对象，没法再往下设置` };
    cur = next as Record<string, unknown>;
  }
  const last = keys[keys.length - 1]!;
  cur[last] = coerce(cur[last], value);
  return {};
}

const isForm = (r: RawRequest): boolean => /x-www-form-urlencoded/i.test(r.headers["content-type"] ?? "");

/** 请求体里有没有这个字段：JSON 按路径走到底，表单按整个名字。 */
function bodyHas(r: RawRequest, keys: string[]): boolean {
  if (r.body === undefined || r.body === null) return false;
  if (isForm(r)) return new URLSearchParams(r.body).has(keys.join("."));
  let cur: unknown;
  try { cur = JSON.parse(r.body); } catch { return false; }
  for (const k of keys) {
    if (typeof cur !== "object" || cur === null || !(k in cur)) return false;
    cur = (cur as Record<string, unknown>)[k];
  }
  return true;
}

function setBody(out: RawRequest, keys: string[], value: string, key: string): { error?: string } {
  if (out.body === undefined || out.body === null) return { error: `这个请求没有请求体，没法设置 ${key}` };
  if (isForm(out)) {
    const params = new URLSearchParams(out.body);
    params.set(keys.join("."), value);
    out.body = params.toString();
    return {};
  }
  let doc: unknown;
  try { doc = JSON.parse(out.body); } catch { return { error: `请求体不是 JSON，没法设置 ${key}；整个换掉用 body=内容` }; }
  if (typeof doc !== "object" || doc === null) return { error: `请求体不是对象或数组，没法设置 ${key}` };
  const r = setPath(doc as Record<string, unknown>, keys, value);
  if (r.error) return r;
  out.body = JSON.stringify(doc);
  return {};
}

/**
 * 改请求再重放。--set 的写法：
 *   名字=值            改地址里的查询参数；地址里没有、请求体里有这个字段（JSON 按点分路径找，表单按名字）就改请求体；都没有就加成查询参数
 *   名字.路径=值       查询参数的值是 JSON 时改里面的字段，如 variables.cursor=xxx、variables.count=40（GraphQL 的 GET 请求）
 *   header.名字=值     改请求头（值为空就删掉）
 *   body.路径=值       改 JSON 请求体或表单请求体里的字段，路径用点分隔，数组用下标，如 body.filter.page=2、body.items.0.id=7
 *   body=内容          整个请求体换成这段文字
 */
export function applySets(template: RawRequest, sets: string[]): { template: RawRequest } | { error: string } {
  const out: RawRequest = { ...template, headers: { ...template.headers } };
  for (const set of sets) {
    const eq = set.indexOf("=");
    if (eq <= 0) return { error: `--set 要写成 名字=值，收到：${set}` };
    const key = set.slice(0, eq), value = set.slice(eq + 1);
    if (key.startsWith("header.")) {
      const name = key.slice(7).toLowerCase();
      if (!name) return { error: "header. 后面要写请求头的名字" };
      if (value === "") delete out.headers[name]; else out.headers[name] = value;
    } else if (key === "body") {
      out.body = value;
    } else if (key.startsWith("body.")) {
      const r = setBody(out, key.slice(5).split("."), value, key);
      if (r.error) return { error: r.error };
    } else {
      let u: URL;
      try { u = new URL(out.url); } catch { return { error: `地址不是有效的网址：${out.url}` }; }
      // 名字里带点、且点前面是一个值为 JSON 的查询参数（GraphQL 的 variables=...）：改 JSON 里的字段，如 variables.cursor=xxx
      const dot = key.indexOf(".");
      const head = dot > 0 ? key.slice(0, dot) : "";
      if (!u.searchParams.has(key) && !(head && u.searchParams.has(head)) && bodyHas(out, key.split("."))) {
        // 地址里没有、请求体里有：改请求体（POST 的 JSON 字段写成 size=200 也能改对，不会被悄悄加成查询参数）
        const r = setBody(out, key.split("."), value, key);
        if (r.error) return { error: r.error };
        continue;
      }
      if (head && !u.searchParams.has(key) && u.searchParams.has(head)) {
        let doc: unknown;
        try { doc = JSON.parse(u.searchParams.get(head)!); } catch { return { error: `查询参数 ${head} 的值不是 JSON，没法设置 ${key}` }; }
        if (typeof doc !== "object" || doc === null) return { error: `查询参数 ${head} 的值不是对象或数组，没法设置 ${key}` };
        const r = setPath(doc as Record<string, unknown>, key.slice(dot + 1).split("."), value);
        if (r.error) return { error: r.error };
        u.searchParams.set(head, JSON.stringify(doc));
      } else {
        u.searchParams.set(key, value);
      }
      out.url = u.href;
    }
  }
  return { template: out };
}

/** 从原始请求头里去掉浏览器自己管的，变成可以交给 fetch 的头。 */
export function replayHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) if (!BROWSER_HEADERS.test(k)) out[k.toLowerCase()] = v;
  return out;
}
