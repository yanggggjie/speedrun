// 重放用的纯函数（不依赖 chrome.* 和页面），background.js 用，自检也直接 import。
// 原始请求（含请求头里的 token 真值）只存在浏览器里，重放也在浏览器里发；这里负责把 agent 的 --set 应用到原始请求上。

/** 浏览器自己管的请求头：页面脚本设不了（或不该设），重放时丢掉。 */
export const BROWSER_HEADERS = /^(host|content-length|cookie|origin|referer|user-agent|accept-encoding|accept-language|connection|keep-alive|transfer-encoding|upgrade|sec-.*|proxy-.*)$/i;
/** hook 记请求体时放的占位文字：说明请求体是文件、二进制或没读到，没法重放。 */
export const UNREPLAYABLE_BODY = /^\[(FormData|Blob|Binary|Request body not read|object)/;

export function isSafeMethod(method) {
  return method === "GET" || method === "HEAD";
}

const isIndex = (k) => /^\d+$/.test(k);

/** 按已有值的类型转换：数字字段给 "2" 就是数字 2，布尔字段给 "true" 就是 true，null、对象、数组按 JSON。 */
function coerce(existing, value) {
  if (typeof existing === "number" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  if (typeof existing === "boolean" && (value === "true" || value === "false")) return value === "true";
  if (existing === null || typeof existing === "object") { try { return JSON.parse(value); } catch { /* 当字符串 */ } }
  return value;
}

function setPath(root, keys, value) {
  let cur = root;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    let next = cur[k];
    if (next === undefined || next === null) { next = isIndex(keys[i + 1]) ? [] : {}; cur[k] = next; }
    if (typeof next !== "object") return { error: `请求体里 ${keys.slice(0, i + 1).join(".")} 不是对象，没法再往下设置` };
    cur = next;
  }
  const last = keys[keys.length - 1];
  cur[last] = coerce(cur[last], value);
  return {};
}

/**
 * 改请求再重放。--set 的写法：
 *   名字=值            改地址里的查询参数（没有就加上）
 *   header.名字=值     改请求头（值为空就删掉）
 *   body.路径=值       改 JSON 请求体或表单请求体里的字段，路径用点分隔，数组用下标，如 body.filter.page=2、body.items.0.id=7
 *   body=内容          整个请求体换成这段文字
 * 返回 { template } 或 { error }。
 */
export function applySets(template, sets) {
  const out = { ...template, headers: { ...template.headers } };
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
      const keys = key.slice(5).split(".");
      if (out.body === undefined || out.body === null) return { error: `这个请求没有请求体，没法设置 ${key}` };
      if (/x-www-form-urlencoded/i.test(out.headers["content-type"] ?? "")) {
        const params = new URLSearchParams(out.body);
        params.set(keys.join("."), value);
        out.body = params.toString();
        continue;
      }
      let doc;
      try { doc = JSON.parse(out.body); } catch { return { error: `请求体不是 JSON，没法设置 ${key}；整个换掉用 body=内容` }; }
      if (typeof doc !== "object" || doc === null) return { error: `请求体不是对象或数组，没法设置 ${key}` };
      const r = setPath(doc, keys, value);
      if (r.error) return r;
      out.body = JSON.stringify(doc);
    } else {
      let u;
      try { u = new URL(out.url); } catch { return { error: `地址不是有效的网址：${out.url}` }; }
      u.searchParams.set(key, value);
      out.url = u.href;
    }
  }
  return { template: out };
}

/** 从原始请求头里去掉浏览器自己管的，变成可以交给 fetch 的头。 */
export function replayHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers ?? {})) if (!BROWSER_HEADERS.test(k)) out[k.toLowerCase()] = v;
  return out;
}

/** 请求头里名字像秘密的，转给 daemon 之前抹掉真值（原始值只留在浏览器里）。 */
const SECRET_HEADER = /auth|token|csrf|xsrf|session|secret|key|sign|cookie|password|passwd|bearer|jwt|ticket|nonce|verify/i;
export function redactHeadersForDaemon(headers) {
  if (!headers || typeof headers !== "object") return headers;
  const out = {};
  for (const [k, v] of Object.entries(headers)) out[k] = SECRET_HEADER.test(k) ? "[redacted]" : v;
  return out;
}
