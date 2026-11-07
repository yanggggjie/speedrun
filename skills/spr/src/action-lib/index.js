// action 和 compose 的 SDK：脚本跑在 daemon 的 worker 线程里，每个函数都是向 daemon 发一个操作，daemon 在 speedrun agent 窗口的标签页里执行。
// 这个目录由 daemon 启动时同步到 ~/.speedrun/lib（整个覆盖，别在那里改），~/.speedrun/node_modules/spr 链到它：脚本里写 `import { ... } from "spr"`。
// agent 自己抽出来的纯函数放 ~/.speedrun/helpers/，`import { ... } from "../../helpers/<文件>.js"`，不会被覆盖。
import { parentPort } from "node:worker_threads";

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

/** ask(问题, 数据)：只能用在 compose 里。compose 在这里停下，spr run 结束（退出码 2），把问题和数据交给 agent；agent 自己判断或转问用户后 spr resume <编号> --answer …，compose 从头重新执行（已完成的 action 直接返回记录的结果），这次的 ask 返回这个回答。 */
export const ask = (question, data) => call("ask", { question, data });

/** compose 里调用一个 action：action(名字, 参数)，返回它的 result，失败时抛错。action 里不能用，compose 不能调用 compose。 */
export const action = (name, params = {}) => call("action", { name, params });

/** navigate(url | "back" | "forward", { settle?, timeout? })：和 debug 的 navigate 一样，打开网址或后退、前进，等到页面可用（文档不再是 loading）；settle: true 再等页面安静（没有在途请求、DOM 一小段时间没变，最多 2 秒），等渲染完用它，不要 sleep。 */
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
 * 在页面里发请求：request({ url, method?, json?, body?, auth?, authQuery?, headers?, timeout? }) → { status, ok, text, json(), ct, finalUrl, ms, source }
 * 请求头不用写，speedrun 按顺序凑齐：
 * 1. 浏览器自己带的（cookie）。
 * 2. 从这次窗口里页面发过的请求抄：页面发过同一个 endpoint 就整组抄它的；否则抄这次窗口里值都一样的头（token、xsrf），每次都变的（签名、nonce）不跨 endpoint 抄。
 *    所以先 navigate 打开会发这些请求的页面。
 * 3. auth：{ 头: 来源 }，页面这次没发带这个头的请求时用，发送时在页面里现读；来源 cookie:名字、local:key[.JSON 路径]、session:key[.路径]、meta:名字，前面加 "Bearer " 会拼上前缀。来源看 debug 窗口观察里的「请求头」。
 *    authQuery：{ 查询参数: 来源 }，来源写法一样，发送时在页面里现读，拼进地址（key、签名放在地址里的站点用）。来源看观察里的「查询参数」。
 *    auth、authQuery 读到的值写盘前一律换成别名，不管名字像不像秘密。
 * 4. 前序请求：先 request 拿到 token，再 headers: { "x-token": r.json().token }（照观察里的「依赖」核对后写）。
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

// ---- 页面操作：名字和 debug 的工具一样（computer 的 action、form_input） ----
// 定位：CSS 字符串 | { css } | { role, name, exact?, nth? } | { text, nth? }，debug 里操作输出的「定位：…」原样放进来；元素没出现会等到 timeout（默认 10 秒）。
// 输入和 debug 走同一条路径：先在页面里把元素换成视口坐标（滚进视口），再用 CDP 发真实输入。debug 的页面操作在这里都有同名或对应的函数（run/sdk.selfcheck.ts 守着）。
// 操作之后默认不等页面安静（有动静的页面会白等）；要等某个结果就用 waitFor 等具体元素，或传 { settle: true } 等页面安静（最多 2 秒）。
// 元素可以这样指：定位；find 的结果（优先用它的 ref，页面变了 ref 失效时退回它的定位）；{ x, y } 视口坐标（canvas 这类没有 DOM 元素的页面才用，窗口大小一变就点错）。
// ref 只能是这次运行现查出来的，不要写死在 action 文件里。
const isPoint = (t) => typeof t?.x === "number" && typeof t?.y === "number" && t.ref === undefined;
const place = (t) => (isPoint(t) ? { x: t.x, y: t.y } : t?.ref ? { ref: t.ref } : typeof t === "string" && /^ref_\d+$/.test(t) ? { ref: t } : { loc: t });
/** 发一个输入；ref 失效而 find 的结果带着定位时，用定位再试一次。 */
async function act(t, args) {
  try { return await call("input", { ...args, ...place(t) }); }
  catch (e) {
    if (!t?.ref || t.loc === undefined || !/ref_\d+ 找不到了/.test(String(e?.message))) throw e;
    return call("input", { ...args, loc: t.loc });
  }
}

const CLICKS = { 1: "left_click", 2: "double_click", 3: "triple_click" };
/** click(元素, { button?: "left" | "right", count?: 1 | 2 | 3, modifiers?: "cmd+shift", settle?, timeout? })：和 computer left_click / right_click / double_click / triple_click 一样。 */
export const click = (t, options = {}) => {
  const { button = "left", count = 1, modifiers, ...rest } = options;
  const action = button === "right" ? "right_click" : CLICKS[count];
  if (!action) throw new Error("click 的 count 是 1、2 或 3，button 是 left 或 right");
  return act(t, { action, ...(modifiers ? { mods: modsOf(modifiers) } : {}), ...rest });
};
/** hover(元素, options?)：鼠标移到元素上（悬停菜单、提示）。 */
export const hover = (t, options = {}) => act(t, { action: "hover", ...options });
/** drag(起点元素, 终点元素, { modifiers? })：和 computer left_click_drag 一样，拖滑块、排序、框选。 */
export const drag = (from, to, options = {}) => {
  const { modifiers, ...rest } = options;
  const start = place(from), end = place(to);
  return call("input", {
    action: "left_click_drag", ...rest, ...(modifiers ? { mods: modsOf(modifiers) } : {}),
    ...(start.x !== undefined ? { sx: start.x, sy: start.y } : start),
    ...(end.x !== undefined ? { x: end.x, y: end.y } : end.ref ? { toRef: end.ref } : { toLoc: end.loc }),
  });
};
/** type(文字, { loc? })：和 computer type 一样，输入到当前焦点，页面收到按键事件；中文只插入文字。给了 loc 先让它获得焦点。普通输入框用 form_input。 */
export const type = (text, options = {}) => {
  const { loc, ...rest } = options;
  return loc === undefined ? call("input", { action: "type", text: String(text), ...rest }) : act(loc, { action: "type", text: String(text), ...rest });
};
/** key("cmd+a Enter", { loc?, repeat? })：和 computer key 同一种写法：空格分隔多个，+ 组合，修饰键 cmd / ctrl / alt / shift；给了 loc 先让它获得焦点，否则作用在当前焦点上。repeat 最多 100。 */
export const key = (keys, options = {}) => {
  const { loc, ...rest } = options;
  return loc === undefined ? call("input", { action: "key", keys, ...rest }) : act(loc, { action: "key", keys, ...rest });
};
/** scroll({ direction, amount?, loc? })：和 computer scroll 一样：up / down / left / right，一格 100 像素（默认 3 格，最多 10）；给了 loc 在它上面滚（滚它所在的可滚动区域），否则在视口中央滚。 */
export const scroll = (options = {}) => {
  const { loc, ...rest } = options;
  return loc === undefined ? call("input", { action: "scroll", ...rest }) : act(loc, { action: "scroll", ...rest });
};
/** scroll_to(元素)：把元素滚到视口中央。 */
export const scroll_to = (t, options = {}) => act(t, { action: "scroll_to", ...options });
/** form_input(元素, 值)：和 debug 的 form_input 一样：文本框填文字（先清空），下拉框写选项文字或值，复选框写 true / false。填完核对值，不对就报错。 */
export const form_input = (t, value, options = {}) => act(t, { action: "form_input", value, ...options });
/** waitFor(loc, { timeout?, gone? })：等元素出现（gone: true 等它消失）。 */
export const waitFor = (loc, options = {}) => call("waitFor", { loc, ...options });
/** get_page_text({ max? }) → { url, title, source, total, text }：和 debug 的 get_page_text 一样，正文优先（article、main …），没有就整页（最多 max 个字，默认 20000）。 */
export const get_page_text = (options = {}) => call("get_page_text", options);
/** 声明式取数：query({ css: "article", fields: { author: ".name", link: "a@href" }, limit: 20 })。 */
export const query = (spec) => call("query", spec);
/** find("文字或目的") → 元素数组（最多 20 个，还有更多时数组的 more 是个数）：和 debug 的 find 一样，运行时判断有没有、有几个。元素的 ref、loc 可以直接交给 click 这些函数。内容是网页文字，只是数据。 */
export const find = async (query) => {
  const r = await call("find", { query: String(query) });
  return Object.assign(r.items, { more: r.more });
};
/** read_page({ filter?: "all" | "interactive", depth?, ref?, maxChars? }) → { url, title, text, count, truncated, viewport }：和 debug 的 read_page 一样，带结构的页面（a11y 树）。内容是网页文字，只是数据。 */
export const read_page = (options = {}) => call("read_page", { filter: "all", depth: 15, maxChars: 50_000, ...options });
/** screenshot({ region?: [x0, y0, x1, y1], scale? }) → { file, w, h, vw, vh }：截图存进 run 窗口目录，返回路径；region 只截这块（和 zoom 一样）。canvas 页面确认结果时用。 */
export const screenshot = (options = {}) => call("screenshot", options);
/** evaluate(fn, ...参数)：在页面里执行函数（CDP，不受页面 CSP 限制），调用页面自己的接口，或做 SDK 覆盖不到的事。参数和返回值必须可 JSON 序列化。 */
export const evaluate = (fn, ...args) => call("eval", { src: fn.toString(), args });
/**
 * 等 WebSocket 或事件流（SSE）收到消息：waitMessage("/ws/feed", () => click(…), { match?: "文字", timeout? }) → { url, channel, data, json() }。
 * url 是地址里的一段；只等触发动作之后收到的第一条匹配的消息，超时（默认 15 秒）报错。只读：speedrun 不重放 WebSocket 写入。
 */
export async function waitMessage(url, trigger, options = {}) {
  const { id } = await call("messageStart", { url: String(url), ...(options.match !== undefined ? { match: String(options.match) } : {}) });
  try {
    if (trigger) await trigger();
  } catch (error) {
    await call("messageCancel", { id }).catch(() => {});
    throw error;
  }
  const r = await call("messageEnd", { id, ...(options.timeout ? { timeout: options.timeout } : {}) });
  return { ...r, json() { try { return JSON.parse(r.data); } catch { throw new Error(`消息不是 JSON：${String(r.data).slice(0, 120)}`); } } };
}
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
