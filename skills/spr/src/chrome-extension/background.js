// speedrun Chrome 扩展：一个固定 ABI 的管道。没有业务逻辑；页面脚本（page/）只经 CDP 注入 speedrun 的标签页（cdp.js），不是内容脚本。
// daemon 端的协议见 src/browser/extension.ts。改 ABI 才需要加 ABI 版本并让用户刷新扩展。
//
// daemon → 扩展：{ id, name, args }，应答 { id, result | error }
//   call { tabId, fn, args }          在页面（MAIN world）里调用 window.__spr.exec[fn](...args)，等它的结果（可以是 Promise）
//   tabs {}                            http/https 标签页：{ tabId, windowId, groupId, speedrun（是 speedrun 管理的标签页）, active, url, title, status }
//   goto { tabId, url, wait, waitMs } 在这个标签页里打开网址；wait 为真时等文档可用（readyState 不再是 loading，不等子资源；最多 waitMs）
//   history { tabId, dir, waitMs }    后退（dir: back）或前进（forward），等文档可用
//   openTab { url? }                  在全局唯一黄色 speedrun 组里新开标签页，返回 { tabId }；不传 url 时停在已附着好 CDP 的 about:blank
//   closeTab { tabId }                关闭标签页（组空了由 Chrome 自动删除）
//   idleTab { tabId }                 标签页闲置：解除调试器附着（页面停止渲染、被冻结；下次操作自动重新附着）
//   screenshot { tabId, region?, scale? } 截图（CDP）：截视口，一个像素就是一个 CSS 像素（截图上的坐标就是页面坐标）；region [x0,y0,x1,y1] 只要这块（zoom，按设备像素放大），scale 再缩小；返回 { data(base64), mime, w, h（图的尺寸）, vw, vh（视口） }
//   input { tabId, action, x, y, … }   一次真实输入（CDP Input.*）：点击、悬停、拖拽、滚轮、按键、输入文字，见 cdp.js
//   evaluate { tabId, src, args }      在页面里执行函数（CDP Runtime.evaluate，不受 CSP 限制），返回 { v }
//   reload {}                          从磁盘重新加载扩展
// 页面脚本只经 CDP 进 speedrun 的标签页（cdp.js：附着时注册、补注入），用户的网页里没有 speedrun 的任何代码；页面脚本经 CDP binding 上报。
// 扩展 → daemon：{ type: "hello", abi, build, ... }（build 是 setup.js 写进 build.js 的版本，daemon 发现不是磁盘上的最新版就发 reload） | { type: "page", tab, frame, top, page, msg }（页面脚本的消息，或标签页的地址变化、新开和关闭）
//
// 全局唯一黄色收纳组：Chrome 标签栏里最多只有 1 个折叠的黄色 speedrun 分组，纯做 UI 收纳；归属和生命周期只认 tabId，由 daemon 管理。
// 不抢前台：speedrun 从不选中自己的标签页；新开标签页先开成 chrome://newtab/（Tab Activate 这类扩展会把新标签页切到前台，但跳过 newtab）；
// 页面自己要新开标签页时（target=_blank、window.open）页面脚本拦下来交给这里开（page/newtab.js），否则 Chrome 会选中新标签页、把窗口和 Chrome 拉到前台。

import { attach, cdp, detach, evaluate, input, onPageMessage, screenshot, setPageScript } from "./cdp.js";
import { BUILD } from "./build.js";

const ABI = 17;
const HOST = "com.speedrun.connect";
/** 和 daemon 断开后固定隔这么久重连（relay 自己会等 daemon 起来；alarm 兜底 service worker 被停掉的情况）。 */
const RETRY_MS = 1000;
const KEEPALIVE_MINUTES = 0.5;
const PAGE_FILES = ["page/common.js", "page/a11y.js", "page/recorder.js", "page/executor.js", "page/newtab.js", "page/dialogs.js"];
// 页面脚本：连成一段，附着 speedrun 的标签页时经 CDP 注册（cdp.js）
const pageScriptReady = Promise.all(PAGE_FILES.map((f) => fetch(chrome.runtime.getURL(f)).then((r) => r.text()))).then((parts) => setPageScript(parts.join("\n;\n")));
const GROUP_TITLE = "speedrun";
const GROUP_COLOR = "yellow";
/** speedrun 新开的标签页在这么久之内被选中，算别的扩展抢的，把选中还回去。 */
const STOLEN_MS = 3000;

let port = null;
let retryTimer = null;

function postToHost(message) {
  if (port) port.postMessage(message);
}

const isWeb = (url) => typeof url === "string" && /^https?:/i.test(url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 本次连接里存活的 speedrun 标签页（纯内存；SW 重启会断开 port、daemon 会 forgetAll，并在重连时清场）。 */
const agentTabs = new Set();
let speedrunGroupId = null;
let cleanupPromise = Promise.resolve();
let groupLock = Promise.resolve();

function withGroupLock(fn) {
  const next = groupLock.then(fn, fn);
  groupLock = next.catch(() => {});
  return next;
}

function mustBeAgent(tabId) {
  if (tabId == null || !agentTabs.has(tabId)) throw new Error("只能在 speedrun 自己的标签页里操作页面");
}
// 附着调试器才会渲染、不被冻结，页面脚本也是附着时放进去的（cdp.js）。DevTools 开着等附着不上时照常往下走，由真正要 CDP 的操作报错。
const ensureRendering = (tabId) => pageScriptReady.then(() => attach(tabId)).catch(() => {});

// ---- 不抢前台：记住每个窗口里用户上一个选中的标签页，speedrun 的标签页刚开出来就被选中时还回去 ----
const lastUserTab = new Map(); // windowId → tabId（不是 speedrun 的）
const freshTabs = new Map(); // speedrun 刚开的标签页 → 开出来的时间
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  void (async () => {
    const born = freshTabs.get(tabId);
    if (born !== undefined && Date.now() - born <= STOLEN_MS) {
      const back = lastUserTab.get(windowId);
      if (back !== undefined && back !== tabId) await chrome.tabs.update(back, { active: true }).catch(() => {});
      return;
    }
    if (!agentTabs.has(tabId)) {
      let tab;
      try { tab = await chrome.tabs.get(tabId); } catch { return; }
      if (!agentTabs.has(tabId) && !freshTabs.has(tabId) && tab.url !== "chrome://newtab/") lastUserTab.set(windowId, tabId);
    }
  })();
});

// 每个窗口里当前选中的用户标签页（service worker 刚启动时还没有选中事件）
async function seedUserTab(windowId) {
  if (lastUserTab.has(windowId)) return;
  const [act] = await chrome.tabs.query({ windowId, active: true }).catch(() => []);
  if (act?.id != null && !agentTabs.has(act.id) && !freshTabs.has(act.id)) lastUserTab.set(windowId, act.id);
}

// ---- 唯一黄色收纳组与开标签页 ----
async function userWindow() {
  try {
    const w = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
    if (w.id !== undefined && !w.incognito) return { windowId: w.id };
  } catch { /* 没有普通窗口 */ }
  const w = await chrome.windows.create({ url: "chrome://newtab/", focused: false, type: "normal" });
  return { windowId: w.id, tabId: w.tabs?.[0]?.id };
}

async function waitUrl(tabId, url, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { if ((await chrome.tabs.get(tabId)).url === url) return; } catch { return; }
    await sleep(30);
  }
}

async function findAliveGroup() {
  if (speedrunGroupId != null) {
    try { return await chrome.tabGroups.get(speedrunGroupId); } catch { speedrunGroupId = null; }
  }
  const existing = await chrome.tabGroups.query({ title: GROUP_TITLE }).catch(() => []);
  if (existing[0]) { speedrunGroupId = existing[0].id; return existing[0]; }
  return null;
}

async function putTabInGroup(tabId, windowId, existingGroup) {
  if (existingGroup) {
    try {
      await chrome.tabs.group({ tabIds: [tabId], groupId: existingGroup.id });
      return existingGroup.id;
    } catch {
      speedrunGroupId = null;
    }
  }
  const gid = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId } });
  speedrunGroupId = gid;
  await chrome.tabGroups.update(gid, { title: GROUP_TITLE, color: GROUP_COLOR, collapsed: true }).catch(() => {});
  return gid;
}

async function parkInGroup(tabId) {
  return withGroupLock(async () => {
    const g = await findAliveGroup();
    const tab = await chrome.tabs.get(tabId);
    return putTabInGroup(tabId, g?.windowId ?? tab.windowId, g);
  });
}

function cleanLegacyGroups() {
  return (cleanupPromise = withGroupLock(async () => {
    try {
      const groups = await chrome.tabGroups.query({ title: GROUP_TITLE }).catch(() => []);
      for (const g of groups) {
        const tabs = await chrome.tabs.query({ groupId: g.id }).catch(() => []);
        const ids = tabs.map((t) => t.id).filter((id) => id != null);
        for (const id of ids) await detach(id);
        if (ids.length) await chrome.tabs.remove(ids).catch(() => {});
      }
    } catch {}
    speedrunGroupId = null;
  }));
}

/** 在全局唯一黄色 speedrun 组里新开标签页：先开成 newtab，进组并设好颜色标题，附着调试器（停在 about:blank），有 url 再导航。 */
async function openTab({ url } = {}) {
  await cleanupPromise;
  const tabId = await withGroupLock(async () => {
    const g = await findAliveGroup();
    let windowId = g?.windowId;
    let id;
    if (windowId === undefined) ({ windowId, tabId: id } = await userWindow());
    await seedUserTab(windowId);
    if (id === undefined) id = (await chrome.tabs.create({ windowId, url: "chrome://newtab/", active: false })).id;
    freshTabs.set(id, Date.now());
    agentTabs.add(id);
    await putTabInGroup(id, windowId, g);
    return id;
  });
  await chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});
  await chrome.tabs.update(tabId, { url: "about:blank" });
  await waitUrl(tabId, "about:blank");
  await ensureRendering(tabId);
  if (url) await chrome.tabs.update(tabId, { url });
  setTimeout(() => freshTabs.delete(tabId), STOLEN_MS);
  return { tabId };
}

// 页面要新开标签页（page/newtab.js 拦下的）：先以空白页开好、上报 opener 建立归属，再导航过去
async function openForPage(openerId, url) {
  if (!isWeb(url) || !agentTabs.has(openerId)) return;
  const { tabId } = await openTab({});
  postToHost({ type: "page", tab: tabId, frame: 0, msg: { k: "tab", ev: "opened", t: Date.now(), url, opener: openerId } });
  await chrome.tabs.update(tabId, { url }).catch(() => {});
}

// 兜底：页面拦截漏掉、Chrome 自己开出来的标签页（opener 是 speedrun 的）：收进唯一组；被选中了就还给用户，记一条「漏了」
chrome.tabs.onCreated.addListener((tab) => {
  void (async () => {
    const url = tab.pendingUrl || tab.url || "";
    if (tab.openerTabId == null || /^(chrome|edge|brave|chrome-extension):/i.test(url) || freshTabs.has(tab.id)) return;
    if (!agentTabs.has(tab.openerTabId)) return;
    freshTabs.set(tab.id, Date.now());
    agentTabs.add(tab.id);
    await seedUserTab(tab.windowId);
    setTimeout(() => freshTabs.delete(tab.id), STOLEN_MS);
    await parkInGroup(tab.id).catch(() => {});
    if ((await chrome.tabs.get(tab.id).catch(() => tab)).active) {
      const back = lastUserTab.get(tab.windowId);
      if (back !== undefined && back !== tab.id) await chrome.tabs.update(back, { active: true }).catch(() => {});
    }
    void ensureRendering(tab.id);
    postToHost({ type: "page", tab: tab.id, frame: 0, msg: { k: "tab", ev: "leaked", t: Date.now(), url, opener: tab.openerTabId } });
  })();
});

chrome.tabGroups.onRemoved.addListener((group) => { if (group.id === speedrunGroupId) speedrunGroupId = null; });

// ---- 连接 daemon ----
async function connect() {
  if (port) return;
  try {
    port = chrome.runtime.connectNative(HOST);
  } catch {
    scheduleRetry();
    return;
  }
  const current = port;
  port.onMessage.addListener((msg) => { void handleHostMessage(msg); });
  port.onDisconnect.addListener(() => { port = null; agentTabs.clear(); speedrunGroupId = null; scheduleRetry(); });
  void cleanLegacyGroups();
  current.postMessage({ type: "hello", abi: ABI, build: BUILD, chromeVersion: navigator.userAgent, extensionVersion: chrome.runtime.getManifest().version });
}

function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void connect();
  }, RETRY_MS);
}

async function handleHostMessage(msg) {
  try {
    const result = await runOp(msg.name, msg.args ?? {});
    postToHost({ id: msg.id, result: result ?? {} });
  } catch (error) {
    postToHost({ id: msg.id, error: { message: error instanceof Error ? error.message : String(error) } });
  }
}

// 等页面“可用”而不是“加载完”：导航提交后文档不再是 loading（interactive 即可）。
// 不等 status:complete——它要等所有子资源，页面带被墙的统计脚本就一直不来。上限 ms 只是兜底。
async function waitReady(tabId, target, ms) {
  let loading = false;
  const onUpdated = (id, info) => { if (id === tabId && info.status === "loading") loading = true; };
  chrome.tabs.onUpdated.addListener(onUpdated); // 必须在导航发起之前注册
  const t0 = Date.now();
  try {
    while (Date.now() - t0 < ms) {
      await sleep(60);
      let tab;
      try { tab = await chrome.tabs.get(tabId); } catch { return false; }
      const committed = loading || tab.url === target || Date.now() - t0 > 800;
      if (!committed) continue;
      try {
        const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: () => document.readyState });
        if (r && (r.result === "interactive" || r.result === "complete")) return true;
      } catch { /* 正在导航，页面还不能执行脚本 */ }
    }
    return false;
  } finally { chrome.tabs.onUpdated.removeListener(onUpdated); }
}

const view = (tab) => ({ tabId: tab.id, windowId: tab.windowId, groupId: tab.groupId, ...(agentTabs.has(tab.id) ? { speedrun: true } : {}), active: tab.active, url: tab.url || tab.pendingUrl || "", title: tab.title || "", status: tab.status || "" });

async function runOp(name, args) {
  switch (name) {
    case "call": {
      mustBeAgent(args.tabId);
      await ensureRendering(args.tabId); // 冻结的页面里 executeScript 会一直挂着
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: args.tabId, frameIds: [args.frameId ?? 0] }, world: "MAIN",
        func: async (fn, fnArgs) => {
          const T = window.__spr;
          if (!T || !T.exec || typeof T.exec[fn] !== "function") return { __sprError: "页面里没有 speedrun 的脚本（刷新这个页面后再试）" };
          try { return { v: await T.exec[fn](...fnArgs) }; } catch (e) { return { __sprError: String((e && e.message) || e) }; }
        },
        args: [args.fn, args.args ?? []],
      });
      const out = res?.result;
      if (!out) throw new Error("页面没有返回结果：页面在跳转（navigating）");
      if (out.__sprError) throw new Error(out.__sprError);
      return { v: out.v ?? null };
    }
    case "tabs": {
      await cleanupPromise;
      const out = [];
      for (const tab of await chrome.tabs.query({})) if (tab.id != null && (isWeb(tab.url) || isWeb(tab.pendingUrl))) out.push(view(tab));
      return { tabs: out };
    }
    case "history": {
      // 后退、前进（navigate back / forward）
      // 用页面自己的 history（chrome.tabs.goBack 对 tabs.update 打开的页面会报「没有下一页」）；地址没变就是没有可退的
      mustBeAgent(args.tabId);
      await ensureRendering(args.tabId);
      const before = (await chrome.tabs.get(args.tabId)).url;
      const wait = waitReady(args.tabId, null, args.waitMs);
      await chrome.scripting.executeScript({ target: { tabId: args.tabId }, func: (dir) => (dir === "back" ? history.back() : history.forward()), args: [args.dir] });
      const loaded = await wait;
      const tab = await chrome.tabs.get(args.tabId);
      if (tab.url === before) throw new Error(`history：没有可以${args.dir === "back" ? "后退" : "前进"}的页面`);
      return { url: tab.url || "", title: tab.title || "", loaded };
    }
    case "goto": {
      mustBeAgent(args.tabId);
      await ensureRendering(args.tabId);
      const wait = args.wait ? waitReady(args.tabId, args.url, args.waitMs) : null;
      await chrome.tabs.update(args.tabId, { url: args.url });
      const loaded = wait ? await wait : undefined;
      const tab = await chrome.tabs.get(args.tabId);
      return { url: tab.url || "", title: tab.title || "", loaded };
    }
    case "openTab": return openTab(args);
    case "closeTab": {
      agentTabs.delete(args.tabId);
      await detach(args.tabId);
      await chrome.tabs.remove(args.tabId).catch(() => {});
      return {};
    }
    case "idleTab": {
      await detach(args.tabId);
      return {};
    }
    case "screenshot": mustBeAgent(args.tabId); return screenshot(args.tabId, args);
    case "input": mustBeAgent(args.tabId); return input(args.tabId, args);
    case "evaluate": mustBeAgent(args.tabId); return { v: await evaluate(args.tabId, args.src, args.args ?? []) };
    case "reload": {
      // 从磁盘重新加载扩展（daemon 发现扩展比安装目录里的旧时用；改了 manifest 也生效）
      setTimeout(() => chrome.runtime.reload(), 100);
      return {};
    }
    default:
      throw new Error(`未知操作 ${name}`);
  }
}

// 页面脚本经 CDP binding 上报的消息（cdp.js）：只有附着了的 speedrun 标签页里才有页面脚本；仍只转 agentTabs 里的，补上 tab、frame。
onPageMessage((tabId, frame, payload) => {
  if (!agentTabs.has(tabId)) return;
  let m;
  try { m = JSON.parse(payload); } catch { return; }
  const msg = m && typeof m.msg === "object" && m.msg ? m.msg : {};
  if (msg.k === "newtab") { void openForPage(tabId, String(msg.url ?? "")).catch(() => {}); return; }
  postToHost({ type: "page", tab: tabId, frame, top: m.top === true, page: typeof m.page === "string" ? m.page : undefined, msg });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  freshTabs.delete(tabId);
  for (const [w, t] of lastUserTab) if (t === tabId) lastUserTab.delete(w);
  // 只告诉 daemon speedrun 的标签页关了；用户的标签页关了不发
  if (agentTabs.delete(tabId)) postToHost({ type: "page", tab: tabId, frame: 0, msg: { k: "tab", ev: "closed", t: Date.now(), url: "" } });
});

// service worker 每次启动都尝试连接；onStartup / onInstalled 显式触发，alarm 兜底。
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "spr-keepalive" && !port) void connect();
});
// 点击工具栏图标：唤醒 service worker 并立即尝试连接（need-extension 的提示让用户点一下它）。
chrome.action.onClicked.addListener(connect);
chrome.alarms.create("spr-keepalive", { periodInMinutes: KEEPALIVE_MINUTES });
void connect();
