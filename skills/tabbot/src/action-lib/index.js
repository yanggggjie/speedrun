// action 的 SDK：action 脚本跑在 holder 的 worker 线程里，每个函数都是向 holder 发一个操作，holder 在 tabbot agent 窗口的标签页里执行。
// 这个目录由 holder 启动时同步到 ~/.tabbot/lib，action 里 `import { ... } from "../../../lib/index.js"`（action 在 ~/.tabbot/sites/<站点>/actions/ 下）。
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
  if (!parentPort) throw new Error("这个 SDK 只能在 tabbot 的 action 里运行：tabbot run <名字>");
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    parentPort.postMessage({ type: "call", id, op, args });
  });
}

// console 输出走 stderr 通道，不影响 stdout 的 JSON
const toLog = (...a) => parentPort?.postMessage({ type: "log", text: a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ") });
console.log = console.info = console.warn = console.error = toLog;

const PAGE = Object.freeze({ kind: "page" });

/** 命令行 `--名字 值` 传进来的参数，值都是字符串；没传的可选参数不存在。 */
export const tabbot = {
  params: workerData?.params ?? {},
  /** action 入口：fn({ page }) 的返回值就是 result。 */
  async run(fn) {
    try {
      const result = await fn({ page: PAGE });
      parentPort?.postMessage({ type: "done", result: result === undefined ? null : result });
    } catch (e) {
      parentPort?.postMessage({ type: "fail", error: String((e && e.stack) || e), message: String((e && e.message) || e) });
    }
  },
  /** 在这次运行里顺序调用另一个 action（共用同一个页面），返回它的 result；失败时抛错。 */
  action: (name, params = {}) => call("action", { name, params }),
  /** 只能用在最外层的组合代码里：run 在这里停下，把 question 和 data 交给 agent；agent 用 tabbot run --resume <编号> --answer … 恢复时，返回它的回答。 */
  ask: (question, data) => call("ask", { question, data }),
};

/** 打开网址并等加载完成。 */
export const goto = (_page, url, options = {}) => call("goto", { url, ...options });

/**
 * 在页面里发请求（带这个站点的登录态）。默认继承这个站点页面自己最近发出的请求头（authorization、csrf 之类，token 值只在 holder 内存里）。
 * request(page, { url, method?, headers?, json?, body?, inherit?, inheritFrom?, auth?, pageOrigin? }) → { status, ok, text, json(), ct, finalUrl, ms }
 * inheritFrom："/api/v4/search_v3" 这样的接口路径（:id 匹配一段），只从这个接口最近一次的请求继承请求头：签名和接口绑定的站点用它，先 goto 会发这个请求的页面。
 * auth：{ 头: 来源 }，发送时现读，不依赖内存里的原始请求（holder 重启也能用）。来源：cookie:名字、local:key[.JSON 路径]、session:key[.路径]、meta:名字、from:/接口路径（从那个接口的请求取这个头）；前面加 "Bearer " 会拼上前缀。
 *   取不到就报错。replay 的输出会给出判断好的 auth。
 */
export async function request(_page, options) {
  const res = await call("request", options);
  return {
    ...res,
    ok: res.status >= 200 && res.status < 300,
    json() { try { return JSON.parse(res.text); } catch { throw new Error(`响应不是 JSON（${res.status}）：${String(res.text).slice(0, 120)}`); } },
  };
}

// 定位：CSS 字符串 | { css } | { role, name, exact?, nth? } | { text, nth? }。元素没出现会等到 timeout（默认 10 秒）。
// 操作之后默认不等页面“稳定”（有动静的页面会白等）；要等某个结果就用 waitFor 等具体元素，或传 { settle: true } 等在途请求结束。
export const click = (_page, loc, options = {}) => call("act", { kind: "click", loc, ...options });
export const fill = (_page, loc, text, options = {}) => call("act", { kind: "fill", loc, text, ...options });
export const select = (_page, loc, text, options = {}) => call("act", { kind: "select", loc, text, ...options });
export const check = (_page, loc, checked = true, options = {}) => call("act", { kind: "check", loc, checked, ...options });
export const press = (_page, key, loc, options = {}) => call("act", { kind: "press", key, ...(loc !== undefined ? { loc } : {}), ...options });
/** scroll(page, { dy: 800 }) | scroll(page, { to: "bottom" }) | scroll(page, { dy: 800, loc }) */
export const scroll = (_page, options = {}) => call("act", { kind: "scroll", ...options });
export const waitFor = (_page, loc, options = {}) => call("waitFor", { loc, ...options });
export const text = (_page, options = {}) => call("text", options);
/** 声明式取数：query(page, { css: "article", fields: { author: ".name", link: "a@href" }, limit: 20 })。严格 CSP 的页面也能用。 */
export const query = (_page, spec) => call("query", spec);
/** 兜底：在页面里执行任意函数，参数必须可 JSON 序列化。严格 CSP 的页面会被浏览器拒绝，那时改用 query / request。 */
export const evaluate = (_page, fn, ...args) => call("eval", { src: fn.toString(), args });
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function serializeUrl({ bareUrl, query: q = {} }) {
  const u = new URL(bareUrl);
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
  return u.href;
}
