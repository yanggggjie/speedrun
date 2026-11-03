// action 的 SDK：action 脚本跑在 daemon 的 worker 线程里，每个函数都是向 daemon 发一个操作，daemon 在 lore agent 窗口的标签页里执行。
// 这个目录由 daemon 启动时同步到 ~/.lore/lib（整个覆盖，别在那里改），action 里 `import { ... } from "../../../lib/index.js"`（action 在 ~/.lore/sites/<站点>/actions/ 下）。
// agent 自己抽出来的纯函数放 ~/.lore/helpers/，`import { ... } from "../../../helpers/<文件>.js"`，不会被覆盖。
import { parentPort, workerData } from "node:worker_threads";

let nextId = 1;
const pending = new Map();

parentPort?.on("message", (m) => {
  if (m?.type !== "reply") return;
  const entry = pending.get(m.id);
  if (!entry) return;
  pending.delete(m.id);
  if (m.error) entry.reject(new Error(m.error));
  else entry.resolve(m.result);
});

function call(op, args = {}) {
  if (!parentPort) throw new Error("这个 SDK 只能在 lore 的 action 里运行：lore run --action <名字>");
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    parentPort.postMessage({ type: "call", id, op, args });
  });
}

// console 输出走 stderr 通道，不影响 stdout 的 JSON
const toLog = (...a) => parentPort?.postMessage({ type: "log", text: a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") });
console.log = console.info = console.warn = console.error = toLog;

/** 命令行 `--名字 值` 传进来的参数：按文件头 `@param 名字:类型` 转好（number、boolean、json），不写类型是字符串；没传的可选参数不存在。 */
export const lore = {
  params: workerData?.params ?? {},
  /** compose 代码里的 action(名字, 参数) 就是它：顺序调用一个 action，返回它的 result，失败时抛错。学出来的 action 里不能用。 */
  action: (name, params = {}) => call("action", { name, params }),
  /** 只能用在最外层的 compose 代码里：run 在这里停下，把 question 和 data 交给 agent；agent 用 lore run --resume <编号> --answer … 恢复时，返回它的回答。 */
  ask: (question, data) => call("ask", { question, data }),
};

/** goto(url, options?)：打开网址并等加载完成。 */
export const goto = (url, options = {}) => call("goto", { url, ...options });

const withJson = (res) => ({
  ...res,
  ok: res.status >= 200 && res.status < 300,
  json() { try { return JSON.parse(res.text); } catch { throw new Error(`响应不是 JSON（${res.status}）：${String(res.text).slice(0, 120)}`); } },
});

/**
 * 在页面里发请求（带这个站点的登录态，Cookie 由浏览器自动带上）。
 * request({ url, method?, headers?, json?, body?, inherit?, inheritFrom?, auth?, pageOrigin? }) → { status, ok, text, json(), ct, finalUrl, ms }
 * 请求头里的认证按这个顺序选，前一种不行再用后一种：
 * - 默认继承：什么都不写，复制这个站点页面最近一次带身份信息的请求的请求头（token 值只在 daemon 内存里）；内存里没有就先打开站点首页让页面自己发一次。inherit: false 不继承（公开接口）。
 * - auth：{ 头: 来源 }，发送时现读，daemon 重启也能用。来源：cookie:名字、local:key[.JSON 路径]、session:key[.路径]、meta:名字、from:/endpoint 路径（从那个 endpoint 的请求取这个头）；前面加 "Bearer " 会拼上前缀。取不到就报错。观察里的「草稿」会给出判断好的 auth。
 * - inheritFrom："/api/v4/search_v3" 这样的 endpoint 路径（:id 匹配一段），只从这个 endpoint 最近一次的请求继承整组请求头：签名和 endpoint 绑定的站点用它，先 goto 会发这个请求的页面。
 * - pageOrigin："https://a.com"，接口在另一个域名（api.a.com）时从站点页面发出；不写就在接口自己的域名上开页面发。
 * - 签名还和完整 URL 绑定（换参数就被拒），或请求体由页面拼出来：用 waitRequest；页面也不发请求的，用 DOM。
 */
export async function request(options) {
  return withJson(await call("request", options));
}

// 定位：CSS 字符串 | { css } | { role, name, exact?, nth? } | { text, nth? }。元素没出现会等到 timeout（默认 10 秒）。
// 操作之后默认不等页面“稳定”（有动静的页面会白等）；要等某个结果就用 waitFor 等具体元素，或传 { settle: true } 等在途请求结束。
/**
 * 等页面自己发出某个请求，拿它的响应：请求体由页面拼、签名复现不了时用（介于 request() 和纯页面操作之间）。
 * waitRequest(endpoint, () => goto(url), { timeout? }) → { status, ok, text, json(), ct, url, requestBody }
 * endpoint 写法和 @endpoint 一样（:id 匹配一段）；只等触发动作之后、这个窗口里发出的第一个匹配请求，超时（默认 15 秒）报错并列出实际发出的请求。
 */
export async function waitRequest(endpoint, trigger, options = {}) {
  const { id } = await call("waitStart", { endpoint });
  try {
    if (trigger) await trigger();
  } catch (error) {
    await call("waitCancel", { id }).catch(() => {});
    throw error;
  }
  return withJson(await call("waitEnd", { id, ...(options.timeout ? { timeout: options.timeout } : {}) }));
}

/** click(loc, options?) */
export const click = (loc, options = {}) => call("act", { kind: "click", loc, ...options });
/** fill(loc, text, options?) */
export const fill = (loc, text, options = {}) => call("act", { kind: "fill", loc, text, ...options });
/** select(loc, text, options?) */
export const select = (loc, text, options = {}) => call("act", { kind: "select", loc, text, ...options });
/** check(loc, checked = true, options?) */
export const check = (loc, checked = true, options = {}) => call("act", { kind: "check", loc, checked, ...options });
/** press(key, loc?, options?) */
export const press = (key, loc, options = {}) => call("act", { kind: "press", key, ...(loc !== undefined ? { loc } : {}), ...options });
/** scroll({ dy: 800 }) | scroll({ to: "bottom" }) | scroll({ dy: 800, loc }) */
export const scroll = (options = {}) => call("act", { kind: "scroll", ...options });
/** waitFor(loc, options?) */
export const waitFor = (loc, options = {}) => call("waitFor", { loc, ...options });
/** text(options?)：页面的可见文字。 */
export const text = (options = {}) => call("text", options);
/** 声明式取数：query({ css: "article", fields: { author: ".name", link: "a@href" }, limit: 20 })。严格 CSP 的页面也能用。 */
export const query = (spec) => call("query", spec);
/** 兜底：evaluate(fn, ...参数) 在页面里执行任意函数，参数必须可 JSON 序列化。严格 CSP 的页面会被浏览器拒绝，那时改用 query / request。 */
export const evaluate = (fn, ...args) => call("eval", { src: fn.toString(), args });
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function serializeUrl({ bareUrl, query: q = {} }) {
  const u = new URL(bareUrl);
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  return u.href;
}
