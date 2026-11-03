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

/** goto(url, { settle?, timeout? })：打开网址，等到页面可用（文档不再是 loading）；settle: true 再等页面安静（没有在途请求、DOM 一小段时间没变，最多 2 秒），等渲染完用它，不要 sleep。 */
export const goto = (url, options = {}) => call("goto", { url, ...options });

const withJson = (res) => ({
  ...res,
  ok: res.status >= 200 && res.status < 300,
  json() { try { return JSON.parse(res.text); } catch { throw new Error(`响应不是 JSON（${res.status}）：${String(res.text).slice(0, 120)}`); } },
});

/**
 * 在页面里发请求：request({ url, method?, json?, body?, auth?, headers?, timeout? }) → { status, ok, text, json(), ct, finalUrl, ms, source }
 * 请求头不用写，lore 按顺序凑齐：
 * 1. 浏览器自己带的（cookie）。
 * 2. 从这次窗口里页面发过的请求抄：页面发过同一个 endpoint 就整组抄它的；否则抄这次窗口里值都一样的头（token、xsrf），每次都变的（签名、nonce）不跨 endpoint 抄。
 *    所以先 goto（或写 @start）打开会发这些请求的页面。
 * 3. auth：{ 头: 来源 }，页面这次没发带这个头的请求时用，发送时在页面里现读；来源 cookie:名字、local:key[.JSON 路径]、session:key[.路径]、meta:名字，前面加 "Bearer " 会拼上前缀。来源看 learn 窗口观察里的「请求头」。
 * 4. 前序请求：先 request 拿到 token，再 headers: { "x-token": r.json().token }（照观察里的「依赖」写）。
 * headers 显式写的最后覆盖。被 401/403 拒时，失败输出里会写抄了什么、没抄什么、下一步；每次都变的头被拒，改用 waitRequest 或 DOM。
 * 和当前页面同一注册域名（api.a.com 和 a.com）的请求在当前页面上发，否则在请求自己的域名上开页面发。
 */
export async function request(options) {
  return withJson(await call("request", options));
}

// 定位：CSS 字符串 | { css } | { role, name, exact?, nth? } | { text, nth? }。元素没出现会等到 timeout（默认 10 秒）。
// 操作之后默认不等页面安静（有动静的页面会白等）；要等某个结果就用 waitFor 等具体元素，或传 { settle: true } 等页面安静（最多 2 秒）。
/**
 * 等页面自己发出某个请求，拿它的响应：request 被拒（签名和参数绑定）、或请求体由页面拼出来时用；签名由页面自己算（介于 request() 和 DOM 之间）。
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
