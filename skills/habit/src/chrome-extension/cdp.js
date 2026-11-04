// CDP（chrome.debugger）：habit 唯一的输入路径（learn 的 computer 和 action 回放都走这里），截图、执行 JS，以及把页面脚本放进 habit 的标签页。
// 只附着 agent 标签页；附着期间 Chrome 在窗口顶部显示「正在调试此浏览器」，用户点掉或开了 DevTools 会断开，下一次操作重新附着。
//
// 页面脚本只经这里进 habit 的标签页（用户的网页里没有 habit 的任何代码）：附着后注册
//   Page.addScriptToEvaluateOnNewDocument：之后每个新文档都在页面自己的脚本之前执行页面脚本（同站 iframe 也带上）；
//   Runtime.addBinding：页面脚本调用 window.__habitSend(字符串) 上报，这里收到 Runtime.bindingCalled；
//   Target.setAutoAttach（flatten）：跨站 iframe 作为子会话附着上来，同样注册后再放行。
// 当前已经打开的文档补注入一次（脚本自己防重复）。解除附着后注册跟着没了，下一个文档就没有脚本（当前文档里的还在，拖出组时先 stopPage）。
import { keySequence, modBits, typeSteps } from "./keys.js";

const CMD_TIMEOUT_MS = 20_000;
export const BINDING = "__habitSend";
const attached = new Set();
const attaching = new Map();
/** 页面脚本（page/*.js 连起来）：background 启动时读好交给 setPageScript。 */
let pageScript = null;
let scriptReady;
const scriptLoaded = new Promise((r) => { scriptReady = r; });
export function setPageScript(src) { pageScript = src; scriptReady(); }
/** 页面脚本上报的消息：(tabId, 子会话编号（0 是标签页本身，跨站 iframe 从 1 起）, 字符串)。 */
let onMessage = () => {};
export function onPageMessage(cb) { onMessage = cb; }
/** 每个标签页的跨站 iframe 子会话 → 编号（只用来在日志里区分 frame）。 */
const childNo = new Map();
const mac = /Mac/i.test(navigator.userAgent);

// 新代码跑在旧 manifest 上（还没有 debugger 权限）：从磁盘重新加载，拿到新的 manifest
if (!chrome.debugger) setTimeout(() => chrome.runtime.reload(), 500);
chrome.debugger?.onDetach.addListener((source) => { attached.delete(source.tabId); childNo.delete(source.tabId); });
chrome.tabs.onRemoved.addListener((tabId) => { attached.delete(tabId); childNo.delete(tabId); });
chrome.debugger?.onEvent.addListener((source, method, params) => {
  if (method === "Runtime.bindingCalled" && params.name === BINDING) {
    const no = source.sessionId ? childNo.get(source.tabId)?.get(source.sessionId) ?? 0 : 0;
    onMessage(source.tabId, no, params.payload);
    return;
  }
  // 子会话（跨站 iframe）附着上来时是暂停的：iframe 注册页面脚本后放行，其它类型直接放行。只处理标签页会话下的子会话
  if (method === "Target.attachedToTarget" && source.tabId !== undefined && attached.has(source.tabId)) {
    const child = { tabId: source.tabId, sessionId: params.sessionId };
    let m = childNo.get(source.tabId);
    if (!m) childNo.set(source.tabId, (m = new Map()));
    m.set(params.sessionId, m.size + 1);
    const prepare = params.targetInfo?.type === "iframe" ? register(child) : Promise.resolve();
    void prepare.catch(() => {}).then(() => chrome.debugger.sendCommand(child, "Runtime.runIfWaitingForDebugger").catch(() => {}));
  }
});

/** 让一个会话（标签页或跨站 iframe）以后的每个文档都带上页面脚本、能上报。 */
async function register(target) {
  await scriptLoaded;
  await chrome.debugger.sendCommand(target, "Page.enable");
  await chrome.debugger.sendCommand(target, "Runtime.enable");
  await chrome.debugger.sendCommand(target, "Runtime.addBinding", { name: BINDING });
  await chrome.debugger.sendCommand(target, "Page.addScriptToEvaluateOnNewDocument", { source: pageScript });
  await chrome.debugger.sendCommand(target, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
}

// 附着不是幂等的：两个调用同时附着同一个标签页，第二个会报「已经有调试器」。进行中的附着大家共用。
// 附着同时是 habit 后台标签页的「渲染开关」：没附着的后台标签页不渲染，在折叠的组里几秒后还会被 Chrome 冻结（冻结的页面连 chrome.scripting 都执行不了）；
// 附着并开 focus emulation 后页面以为自己可见、有焦点，照常渲染，冻结的也立刻解冻。
export async function attach(tabId) {
  if (attached.has(tabId)) return;
  if (attaching.has(tabId)) return attaching.get(tabId);
  const p = (async () => {
    try { await chrome.debugger.attach({ tabId }, "1.3"); }
    catch (e) {
      const msg = String((e && e.message) || e);
      if (!/already attached/i.test(msg)) throw new Error(`连不上这个标签页的调试接口：${msg}`);
      // 「已经有调试器」：service worker 重启过时，habit 自己之前的附着还在（注册也还在）。能发命令就是自己的：解除再重新附着，清掉旧注册
      const ours = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: "1" }).then(() => true, () => false);
      if (!ours) throw new Error("连不上这个标签页的调试接口：这个 agent 窗口开着 DevTools（或别的调试器），关掉后重试");
      await chrome.debugger.detach({ tabId }).catch(() => {});
      await chrome.debugger.attach({ tabId }, "1.3");
    }
    attached.add(tabId);
    try {
      await register({ tabId });
      // 当前已经打开的文档补注入（新文档由注册接管）；脚本自己防重复
      await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: pageScript });
    } catch (e) {
      attached.delete(tabId);
      await chrome.debugger.detach({ tabId }).catch(() => {});
      throw new Error(`没能把 habit 的页面脚本放进这个标签页：${String((e && e.message) || e)}`);
    }
    // 后台窗口（不在前台）的输入也要送到：让页面以为自己有焦点（和无头浏览器驱动未聚焦页面的做法一样）
    try { await chrome.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: true }); } catch {}
  })();
  attaching.set(tabId, p);
  try { await p; } finally { attaching.delete(tabId); }
}

/** 解除附着（habit 的组闲置时）：页面不再渲染，折叠组里的会被 Chrome 冻结，不吃 CPU；没有标签页附着时「正在调试此浏览器」的横幅也会消失。下次操作时 cdp() 自动重新附着。 */
export async function detach(tabId) {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  childNo.delete(tabId);
  try { await chrome.debugger.detach({ tabId }); } catch { /* 已经断开、标签页已关 */ }
}

/** 标签页不再是 habit 的（被拖出组）：先让当前文档里的页面脚本停止上报、不再拦新标签页，再解除附着（之后的文档就没有脚本了）。 */
export async function release(tabId) {
  if (attached.has(tabId)) await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: "window.__habit && window.__habit.stop && window.__habit.stop()" }).catch(() => {});
  await detach(tabId);
}

/** 发一条 CDP 命令；附着断了（用户点掉提示条）就重新附着再发一次。每条命令有超时，页面卡住时不会一直挂着。 */
export async function cdp(tabId, method, params = {}) {
  await attach(tabId);
  const send = () => {
    let timer;
    return Promise.race([
      chrome.debugger.sendCommand({ tabId }, method, params),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${method} 超过 ${CMD_TIMEOUT_MS / 1000} 秒没有响应`)), CMD_TIMEOUT_MS); }),
    ]).finally(() => clearTimeout(timer));
  };
  try { return await send(); }
  catch (e) {
    if (!/not attached|detached/i.test(String((e && e.message) || e))) throw e;
    attached.delete(tabId);
    await attach(tabId);
    return send();
  }
}

const mouse = (tabId, type, x, y, extra = {}) => cdp(tabId, "Input.dispatchMouseEvent", { type, x, y, ...extra });

/**
 * 一次输入。坐标是视口里的 CSS 像素。
 * { action: left_click | right_click | double_click | triple_click | hover | left_click_drag | scroll | key | type | insert, x, y, sx, sy, mods, keys, repeat, text, dx, dy }
 */
export async function input(tabId, a) {
  const modifiers = modBits(a.mods);
  switch (a.action) {
    case "left_click": case "right_click": case "double_click": case "triple_click": {
      const button = a.action === "right_click" ? "right" : "left";
      const buttons = button === "right" ? 2 : 1;
      const count = a.action === "double_click" ? 2 : a.action === "triple_click" ? 3 : 1;
      await mouse(tabId, "mouseMoved", a.x, a.y, { modifiers });
      for (let i = 1; i <= count; i++) {
        await mouse(tabId, "mousePressed", a.x, a.y, { button, buttons, clickCount: i, modifiers });
        await mouse(tabId, "mouseReleased", a.x, a.y, { button, buttons: 0, clickCount: i, modifiers });
      }
      return {};
    }
    case "hover": await mouse(tabId, "mouseMoved", a.x, a.y, { modifiers }); return {};
    case "left_click_drag": {
      await mouse(tabId, "mouseMoved", a.sx, a.sy, { modifiers });
      await mouse(tabId, "mousePressed", a.sx, a.sy, { button: "left", buttons: 1, clickCount: 1, modifiers });
      for (let i = 1; i <= 10; i++) await mouse(tabId, "mouseMoved", a.sx + ((a.x - a.sx) * i) / 10, a.sy + ((a.y - a.sy) * i) / 10, { button: "left", buttons: 1, modifiers });
      await mouse(tabId, "mouseReleased", a.x, a.y, { button: "left", buttons: 0, clickCount: 1, modifiers });
      return {};
    }
    case "scroll": await mouse(tabId, "mouseWheel", a.x, a.y, { deltaX: a.dx || 0, deltaY: a.dy || 0, modifiers }); return {};
    case "key": for (const p of keySequence(a.keys, a.repeat, mac)) await cdp(tabId, "Input.dispatchKeyEvent", p); return {};
    case "type": for (const s of typeSteps(a.text ?? "")) await cdp(tabId, s.method, s.params); return {};
    case "insert": await cdp(tabId, "Input.insertText", { text: String(a.text ?? "") }); return {}; // form_input：整段插入，不发按键
    default: throw new Error(`未知的输入 ${a.action}`);
  }
}

/**
 * 截图：图上一个像素就是一个 CSS 像素（截的是视口，按 1/devicePixelRatio 缩），坐标直接拿来点。
 * region [x0,y0,x1,y1] 只截这块（zoom）并按设备像素给出（放大看小字）；scale 再缩小。不需要把标签页切到前台。
 */
export async function screenshot(tabId, { region, scale } = {}) {
  const vp = await cdp(tabId, "Runtime.evaluate", { expression: "JSON.stringify([innerWidth, innerHeight, devicePixelRatio])", returnByValue: true });
  const [vw, vh, dpr0] = JSON.parse(vp.result.value);
  if (!vw || !vh) throw new Error("取不到页面视口大小（受限页面截不了图）");
  const dpr = dpr0 > 0 ? dpr0 : 1;
  const s = Number(scale) > 0 && Number(scale) <= 1 ? Number(scale) : 1;
  // 图的像素 = clip 的 CSS 尺寸 × clip.scale × dpr；factor 是图上一个 CSS 像素占几个像素
  let x = 0, y = 0, width = vw, height = vh, factor = s;
  if (Array.isArray(region)) {
    const [x0, y0, x1, y1] = region.map(Number);
    x = Math.max(0, x0); y = Math.max(0, y0);
    width = Math.max(1, Math.min(vw, x1) - x); height = Math.max(1, Math.min(vh, y1) - y);
    factor = Math.min(2, Math.max(1, dpr)) * s; // zoom 按设备像素给，放大看小字
  }
  const clip = { x, y, width, height, scale: factor / dpr };
  const shot = async (quality) => (await cdp(tabId, "Page.captureScreenshot", { format: "jpeg", quality, captureBeyondViewport: false, optimizeForSpeed: true, clip })).data;
  let data = await shot(70);
  if (data.length > 1_500_000) data = await shot(40);
  return { data, mime: "image/jpeg", w: Math.round(width * factor), h: Math.round(height * factor), vw, vh };
}

/** 在页面（MAIN world）里执行一个函数：不受页面 CSP 限制。src 是函数源码，args 必须能 JSON 序列化。 */
export async function evaluate(tabId, src, args = []) {
  const r = await cdp(tabId, "Runtime.evaluate", { expression: `(${src})(...${JSON.stringify(args)})`, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(`evaluate 出错：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result?.value ?? null;
}
