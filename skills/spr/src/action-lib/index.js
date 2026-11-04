// action 的 SDK：action 脚本跑在 daemon 的 worker 线程里，每个函数都是向 daemon 发一个操作，daemon 在 speedrun agent 窗口的标签页里执行。
// 这个目录由 daemon 启动时同步到 ~/.speedrun/lib（整个覆盖，别在那里改）。action 在 ~/.speedrun/sites/<站点>/actions/ 下，`import { ... } from "../../../lib/index.js"`；
// compose 在 ~/.speedrun/compose/ 下，`import { spr, action } from "../lib/index.js"`。
// agent 自己抽出来的纯函数放 ~/.speedrun/helpers/，`import { ... } from "../../../helpers/<文件>.js"`，不会被覆盖。
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
  if (!parentPort) throw new Error("这个 SDK 只能在 speedrun 的 action 里运行：spr run <名字>");
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
export const spr = {
  params: workerData?.params ?? {},
  /** 只能用在 spr run 直接跑的那个 compose 里：run 在这里停下，把 question 和 data 交给 agent；agent 用 spr resume <编号> --answer … 恢复时，返回它的回答。 */
  ask: (question, data) => call("ask", { question, data }),
};

/** compose 里调用一个 action（或别的 compose）：action(名字, 参数)，返回它的 result，失败时抛错。学出来的 action 里不能用。 */
export const action = (name, params = {}) => call("action", { name, params });

/** navigate(url | "back" | "forward", { settle?, timeout? })：和 learn 的 navigate 一样，打开网址或后退、前进，等到页面可用（文档不再是 loading）；settle: true 再等页面安静（没有在途请求、DOM 一小段时间没变，最多 2 秒），等渲染完用它，不要 sleep。 */
export const navigate = (url, options = {}) => call("navigate", { url, ...options });

const withJson = (res) => ({
  ...res,
  ok: res.status >= 200 && res.status < 300,
  json() {
    if (res.truncated) throw new Error(`响应有 ${res.size} 字节，超过上限被截断了，解析不了：缩小查询范围（分页、少要字段）`);
    try { return JSON.parse(res.text); } catch { throw new Error(`响应不是 JSON（${res.status}）：${String(res.text).slice(0, 120)}`); }
  },
});

/**
 * 在页面里发请求：request({ url, method?, json?, body?, auth?, headers?, timeout? }) → { status, ok, text, json(), ct, finalUrl, ms, source }
 * 请求头不用写，speedrun 按顺序凑齐：
 * 1. 浏览器自己带的（cookie）。
 * 2. 从这次窗口里页面发过的请求抄：页面发过同一个 endpoint 就整组抄它的；否则抄这次窗口里值都一样的头（token、xsrf），每次都变的（签名、nonce）不跨 endpoint 抄。
 *    所以先 navigate 打开会发这些请求的页面。
 * 3. auth：{ 头: 来源 }，页面这次没发带这个头的请求时用，发送时在页面里现读；来源 cookie:名字、local:key[.JSON 路径]、session:key[.路径]、meta:名字，前面加 "Bearer " 会拼上前缀。来源看 learn 窗口观察里的「请求头」。
 * 4. 前序请求：先 request 拿到 token，再 headers: { "x-token": r.json().token }（照观察里的「依赖」写）。
 * headers 显式写的最后覆盖。被 401/403 拒时，失败输出里会写抄了什么、没抄什么、下一步；每次都变的头被拒，改用 waitRequest 或 DOM。
 * 和当前页面同 origin，或者当前页面自己往那个 origin 发过请求（a.com 页面调 api.a.com）的，在当前页面上发；否则在请求自己的 origin 上开页面发（同一个公司域名下的不同产品互不放行跨域）。
 */
export async function request(options) {
  return withJson(await call("request", options));
}

/**
 * 等页面自己发出某个请求，拿它的响应：request 被拒（签名和参数绑定）、或请求体由页面拼出来时用；签名由页面自己算（介于 request() 和 DOM 之间）。
 * waitRequest(endpoint, () => navigate(url), { timeout? }) → { status, ok, text, json(), ct, url, requestBody }
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

// ---- 页面操作：名字和 learn 的工具一样（computer 的 action、form_input），区别只在指元素用持久定位而不是 ref / 坐标 ----
// 定位：CSS 字符串 | { css } | { role, name, exact?, nth? } | { text, nth? }，learn 里操作输出的「定位：…」原样放进来；元素没出现会等到 timeout（默认 10 秒）。
// 输入和 learn 走同一条路径：先在页面里把元素换成视口坐标（滚进视口），再用 CDP 发真实输入。
// 操作之后默认不等页面安静（有动静的页面会白等）；要等某个结果就用 waitFor 等具体元素，或传 { settle: true } 等页面安静（最多 2 秒）。
const CLICKS = { 1: "left_click", 2: "double_click", 3: "triple_click" };
/** click(loc, { button?: "left" | "right", count?: 1 | 2 | 3, modifiers?: "cmd+shift", settle?, timeout? })：和 computer left_click / right_click / double_click / triple_click 一样。 */
export const click = (loc, options = {}) => {
  const { button = "left", count = 1, modifiers, ...rest } = options;
  const action = button === "right" ? "right_click" : CLICKS[count];
  if (!action) throw new Error("click 的 count 是 1、2 或 3，button 是 left 或 right");
  return call("input", { action, loc, ...(modifiers ? { mods: modsOf(modifiers) } : {}), ...rest });
};
/** hover(loc, options?)：鼠标移到元素上（悬停菜单、提示）。 */
export const hover = (loc, options = {}) => call("input", { action: "hover", loc, ...options });
/** key("cmd+a Enter", { loc?, repeat? })：和 computer key 同一种写法：空格分隔多个，+ 组合，修饰键 cmd / ctrl / alt / shift；给了 loc 先让它获得焦点，否则作用在当前焦点上。repeat 最多 100。 */
export const key = (keys, options = {}) => call("input", { action: "key", keys, ...options });
/** scroll({ direction, amount?, loc? })：和 computer scroll 一样：up / down / left / right，一格 100 像素（默认 3 格，最多 10）；给了 loc 在它上面滚（滚它所在的可滚动区域），否则在视口中央滚。 */
export const scroll = (options = {}) => call("input", { action: "scroll", ...options });
/** scroll_to(loc)：把元素滚到视口中央。 */
export const scroll_to = (loc, options = {}) => call("input", { action: "scroll_to", loc, ...options });
/** form_input(loc, 值)：和 learn 的 form_input 一样：文本框填文字（先清空），下拉框写选项文字或值，复选框写 true / false。填完核对值，不对就报错。 */
export const form_input = (loc, value, options = {}) => call("input", { action: "form_input", loc, value, ...options });
/** waitFor(loc, { timeout?, gone? })：等元素出现（gone: true 等它消失）。 */
export const waitFor = (loc, options = {}) => call("waitFor", { loc, ...options });
/** get_page_text({ max? }) → { url, title, source, total, text }：和 learn 的 get_page_text 一样，正文优先（article、main …），没有就整页（最多 max 个字，默认 20000）。 */
export const get_page_text = (options = {}) => call("get_page_text", options);
/** 声明式取数：query({ css: "article", fields: { author: ".name", link: "a@href" }, limit: 20 })。 */
export const query = (spec) => call("query", spec);
/** 兜底：evaluate(fn, ...参数) 在页面里执行任意函数（CDP，不受页面 CSP 限制），参数和返回值必须可 JSON 序列化。 */
export const evaluate = (fn, ...args) => call("eval", { src: fn.toString(), args });
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function modsOf(spec) {
  const mods = {};
  for (const p of String(spec).split("+").filter(Boolean)) {
    const m = { cmd: "cmd", command: "cmd", meta: "cmd", ctrl: "ctrl", control: "ctrl", alt: "alt", option: "alt", shift: "shift" }[p.toLowerCase()];
    if (!m) throw new Error(`不认识的修饰键「${p}」：用 cmd、ctrl、alt、shift，用 + 连接`);
    mods[m] = true;
  }
  return mods;
}
