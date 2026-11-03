// lore Chrome 扩展：一个固定 ABI 的管道。没有业务逻辑；页面脚本是扩展包里的静态内容脚本（page/）。
// daemon 端的协议见 src/browser/extension.ts。改 ABI 才需要加 ABI 版本并让用户刷新扩展。
//
// daemon → 扩展：{ id, name, args }，应答 { id, result | error }
//   call { tabId, fn, args }          在页面（MAIN world）里调用 window.__lore.exec[fn](...args)，等它的结果（可以是 Promise）
//   tabs {}                            http/https 标签页：{ tabId, windowId, groupId, lore（在 lore 的组里）, active, url, title, status }
//   goto { tabId, url, wait, waitMs } 在这个标签页里打开网址；wait 为真时等文档可用（readyState 不再是 loading，不等子资源；最多 waitMs）
//   history { tabId, dir, waitMs }    后退（dir: back）或前进（forward），等文档可用
//   openTab { groupId?, title, color, url }  在 lore 的组里新开标签页（组没了就在用户最近用的窗口里新建组），返回 { tabId, groupId }
//   closeTab { tabId } | closeGroup { groupId } | closeAllGroups {}
//   idleGroup { groupId }              组闲置：解除组里标签页的调试器附着（页面停止渲染、被冻结；下次操作自动重新附着）
//   screenshot { tabId, region?, scale? } 截图（CDP）：截视口，一个像素就是一个 CSS 像素（截图上的坐标就是页面坐标）；region [x0,y0,x1,y1] 只要这块（zoom，按设备像素放大），scale 再缩小；返回 { data(base64), mime, w, h（图的尺寸）, vw, vh（视口） }
//   input { tabId, action, x, y, … }   一次真实输入（CDP Input.*）：点击、悬停、拖拽、滚轮、按键、输入文字，见 cdp.js
//   evaluate { tabId, src, args }      在页面里执行函数（CDP Runtime.evaluate，不受 CSP 限制），返回 { v }
//   reload {}                          从磁盘重新加载扩展
// 扩展 → daemon：{ type: "hello", abi, build, ... }（build 是 setup.js 写进 build.js 的版本，daemon 发现不是磁盘上的最新版就发 reload） | { type: "page", tab, group, frame, top, page, msg }（页面脚本的消息，或标签页的地址变化、新开和关闭；group 是标签页所在的 lore 组）
//
// lore 的标签页都在用户窗口里 lore 自己的标签组中（一个 learn 句柄或一次 run 一个组，始终折叠）。归属只看组：标签页在 lore 的组里就是 lore 的，录、可以操作；
// 用户把标签页拖进组就是交给 lore，拖出去就收回。扩展只记哪些组是 lore 的（loreGroups），组属于哪个句柄由 daemon 记。
// 不抢前台：lore 从不选中自己的标签页；新开标签页先开成 chrome://newtab/（Tab Activate 这类扩展会把新标签页切到前台，但跳过 newtab）；
// 页面自己要新开标签页时（target=_blank、window.open）页面脚本拦下来交给这里开（page/newtab.js），否则 Chrome 会选中新标签页、把窗口和 Chrome 拉到前台。

import { attach, cdp, detach, evaluate, input, screenshot } from "./cdp.js";
import { BUILD } from "./build.js";

const ABI = 14;
const HOST = "com.lore.connect";
const RETRY_MAX_MS = 30_000;
const KEEPALIVE_MINUTES = 0.5;
const PAGE_FILES = ["page/common.js", "page/a11y.js", "page/recorder.js", "page/executor.js", "page/newtab.js"];
const GROUP_TITLE = /^lore[·▶]/;
/** lore 新开的标签页在这么久之内被选中，算别的扩展抢的，把选中还回去。 */
const STOLEN_MS = 3000;

let port = null;
let retryCount = 0;
let retryTimer = null;

function postToHost(message) {
  if (port) port.postMessage(message);
}

const isWeb = (url) => typeof url === "string" && /^https?:/i.test(url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// lore 的组：存进 storage.session，service worker 重启后读回（浏览器重启时清空，那时 daemon 也会把旧组当孤儿关掉）。
const loreGroups = new Set();
const loaded = chrome.storage.session.get("loreGroups").then((v) => { for (const id of v.loreGroups ?? []) loreGroups.add(id); }).catch(() => {});
const saveGroups = () => chrome.storage.session.set({ loreGroups: [...loreGroups] }).catch(() => {});
const isLoreGroup = (groupId) => groupId != null && groupId >= 0 && loreGroups.has(groupId);
async function isAgentTab(tabId) {
  if (tabId == null) return false;
  await loaded;
  try { return isLoreGroup((await chrome.tabs.get(tabId)).groupId); } catch { return false; }
}
async function mustBeAgent(tabId) {
  if (!(await isAgentTab(tabId))) throw new Error("只能在 lore 自己的标签页（lore 的标签组里）操作页面");
}
// 附着调试器才会渲染、不被冻结（cdp.js）。DevTools 开着等附着不上时照常往下走，由真正要 CDP 的操作报错。
const ensureRendering = (tabId) => attach(tabId).catch(() => {});

// ---- 不抢前台：记住每个窗口里用户上一个选中的标签页，lore 的标签页刚开出来就被选中时还回去 ----
const lastUserTab = new Map(); // windowId → tabId（不是 lore 的）
const freshTabs = new Map(); // lore 刚开的标签页 → 开出来的时间
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  void (async () => {
    await loaded;
    // lore 刚开的标签页（这时可能还没进组）一出来就被选中：别的扩展或 Chrome 抢的，还回去
    const born = freshTabs.get(tabId);
    if (born !== undefined && Date.now() - born <= STOLEN_MS) {
      const back = lastUserTab.get(windowId);
      if (back !== undefined && back !== tabId) await chrome.tabs.update(back, { active: true }).catch(() => {});
      return;
    }
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch { return; }
    if (!isLoreGroup(tab.groupId)) lastUserTab.set(windowId, tabId); // 用户自己点开组、选中 lore 的标签页不算
  })();
});

// 每个窗口里当前选中的用户标签页（service worker 刚启动时还没有选中事件）
async function seedUserTab(windowId) {
  if (lastUserTab.has(windowId)) return;
  const [act] = await chrome.tabs.query({ windowId, active: true }).catch(() => []);
  if (act?.id != null && !isLoreGroup(act.groupId) && !freshTabs.has(act.id)) lastUserTab.set(windowId, act.id);
}

// ---- 开标签页 ----
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

/** 在 lore 的组里新开标签页：先开成 newtab（躲开把新标签页切到前台的扩展），进组，附着调试器（要在普通页面上才附着得上，先到 about:blank），再打开 url。 */
async function openTab({ groupId, title, color, url }) {
  await loaded;
  let windowId;
  if (isLoreGroup(groupId)) {
    try { windowId = (await chrome.tabGroups.get(groupId)).windowId; } catch { groupId = undefined; }
  } else groupId = undefined;
  let tabId;
  if (windowId === undefined) ({ windowId, tabId } = await userWindow());
  await seedUserTab(windowId);
  if (tabId === undefined) tabId = (await chrome.tabs.create({ windowId, url: "chrome://newtab/", active: false })).id;
  freshTabs.set(tabId, Date.now());
  const fresh = groupId === undefined;
  groupId = await chrome.tabs.group({ tabIds: [tabId], ...(fresh ? { createProperties: { windowId } } : { groupId }) });
  if (fresh) {
    loreGroups.add(groupId); void saveGroups();
    await chrome.tabGroups.update(groupId, { title: String(title || "lore"), color: color || "blue", collapsed: true }).catch(() => {});
  }
  await chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});
  await chrome.tabs.update(tabId, { url: "about:blank" });
  await waitUrl(tabId, "about:blank");
  await ensureRendering(tabId);
  if (url) await chrome.tabs.update(tabId, { url });
  setTimeout(() => freshTabs.delete(tabId), STOLEN_MS);
  return { tabId, groupId, windowId };
}

async function closeGroup(groupId) {
  const tabs = await chrome.tabs.query({ groupId }).catch(() => []);
  const ids = tabs.map((t) => t.id).filter((id) => id != null);
  for (const id of ids) await detach(id);
  if (ids.length) await chrome.tabs.remove(ids).catch(() => {});
  loreGroups.delete(groupId); void saveGroups();
}

// 页面要新开标签页（page/newtab.js 拦下的）：在同一个组里开，告诉 daemon（时间线里记「页面打开了新标签页」）
async function openForPage(tab, url) {
  if (!isWeb(url) || !isLoreGroup(tab.groupId)) return;
  const r = await openTab({ groupId: tab.groupId, url });
  postToHost({ type: "page", tab: r.tabId, group: r.groupId, frame: 0, msg: { k: "tab", ev: "opened", t: Date.now(), url, opener: tab.id } });
}

// 兜底：页面拦截漏掉、Chrome 自己开出来的标签页（opener 是 lore 的）：收进 opener 的组；被选中了就还给用户，记一条「漏了」
chrome.tabs.onCreated.addListener((tab) => {
  void (async () => {
    await loaded;
    const url = tab.pendingUrl || tab.url || "";
    // lore 自己开的标签页都先是 newtab，这里排除掉（用户按 Cmd+T 开的也是）；Chrome 可能已经把它放进了 opener 的组，照样算漏掉的
    if (tab.openerTabId == null || /^(chrome|edge|brave|chrome-extension):/i.test(url) || freshTabs.has(tab.id)) return;
    let opener;
    try { opener = await chrome.tabs.get(tab.openerTabId); } catch { return; }
    if (!isLoreGroup(opener.groupId)) return;
    freshTabs.set(tab.id, Date.now());
    await seedUserTab(tab.windowId);
    setTimeout(() => freshTabs.delete(tab.id), STOLEN_MS);
    try {
      if (tab.windowId === opener.windowId) await chrome.tabs.group({ tabIds: [tab.id], groupId: opener.groupId });
    } catch { /* 弹出窗口里的标签页进不了组 */ }
    if ((await chrome.tabs.get(tab.id).catch(() => tab)).active) { const back = lastUserTab.get(tab.windowId); if (back !== undefined && back !== tab.id) await chrome.tabs.update(back, { active: true }).catch(() => {}); }
    void ensureRendering(tab.id);
    postToHost({ type: "page", tab: tab.id, group: opener.groupId, frame: 0, msg: { k: "tab", ev: "leaked", t: Date.now(), url, opener: opener.id } });
  })();
});

// 组被关掉（用户关了组或整个窗口）
chrome.tabGroups.onRemoved.addListener((group) => { if (loreGroups.delete(group.id)) void saveGroups(); });

// 用户把标签页拖进、拖出 lore 的组：告诉页面脚本开始或停止上报（拖进来的已经打开的页面要补注入）
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.groupId === undefined) return;
  void (async () => {
    await loaded;
    const on = isLoreGroup(changeInfo.groupId);
    if (on && isWeb(tab.url)) await inject(tabId);
    chrome.tabs.sendMessage(tabId, { __loreGate: 1, on }).catch(() => {});
  })();
});

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
  port.onDisconnect.addListener(() => { port = null; scheduleRetry(); });
  retryCount = 0;
  current.postMessage({ type: "hello", abi: ABI, build: BUILD, chromeVersion: navigator.userAgent, extensionVersion: chrome.runtime.getManifest().version });
  void injectExisting();
}

// 内容脚本只在新加载的页面里生效；已经打开的 lore 标签页补注入一次（脚本自己防重复）。用户的标签页不碰。
async function inject(tabId) {
  try {
    const [probe] = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: () => !!window.__lore });
    if (probe?.result) return;
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: "MAIN", files: PAGE_FILES, injectImmediately: true });
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["page/bridge.js"], injectImmediately: true });
  } catch { /* 受限页面（商店、PDF 查看器等）注入不了 */ }
}
async function injectExisting() {
  await loaded;
  for (const tab of await chrome.tabs.query({})) if (tab.id != null && isWeb(tab.url) && isLoreGroup(tab.groupId)) await inject(tab.id);
}

function scheduleRetry() {
  if (retryTimer) return;
  const delay = Math.min(1000 * 2 ** retryCount, RETRY_MAX_MS);
  retryCount++;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void connect();
  }, delay);
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

const view = (tab) => ({ tabId: tab.id, windowId: tab.windowId, groupId: tab.groupId, ...(isLoreGroup(tab.groupId) ? { lore: true } : {}), active: tab.active, url: tab.url || tab.pendingUrl || "", title: tab.title || "", status: tab.status || "" });

async function runOp(name, args) {
  switch (name) {
    case "call": {
      await mustBeAgent(args.tabId);
      await ensureRendering(args.tabId); // 冻结的页面里 executeScript 会一直挂着
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: args.tabId, frameIds: [args.frameId ?? 0] }, world: "MAIN",
        func: async (fn, fnArgs) => {
          const T = window.__lore;
          if (!T || !T.exec || typeof T.exec[fn] !== "function") return { __loreError: "页面里没有 lore 的脚本（刷新这个页面后再试）" };
          try { return { v: await T.exec[fn](...fnArgs) }; } catch (e) { return { __loreError: String((e && e.message) || e) }; }
        },
        args: [args.fn, args.args ?? []],
      });
      const out = res?.result;
      if (!out) throw new Error("页面没有返回结果：页面在跳转（navigating）");
      if (out.__loreError) throw new Error(out.__loreError);
      return { v: out.v ?? null };
    }
    case "tabs": {
      await loaded;
      const out = [];
      for (const tab of await chrome.tabs.query({})) if (tab.id != null && (isWeb(tab.url) || isWeb(tab.pendingUrl))) out.push(view(tab));
      return { tabs: out };
    }
    case "history": {
      // 后退、前进（navigate back / forward）
      // 用页面自己的 history（chrome.tabs.goBack 对 tabs.update 打开的页面会报「没有下一页」）；地址没变就是没有可退的
      await mustBeAgent(args.tabId);
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
      await mustBeAgent(args.tabId);
      await ensureRendering(args.tabId);
      const wait = args.wait ? waitReady(args.tabId, args.url, args.waitMs) : null;
      await chrome.tabs.update(args.tabId, { url: args.url });
      const loaded = wait ? await wait : undefined;
      const tab = await chrome.tabs.get(args.tabId);
      return { url: tab.url || "", title: tab.title || "", loaded };
    }
    case "openTab": return openTab(args);
    case "closeTab": {
      await detach(args.tabId);
      await chrome.tabs.remove(args.tabId);
      return {};
    }
    case "closeGroup": await closeGroup(args.groupId); return {};
    case "closeAllGroups": {
      // 上一个 daemon 留下的组；浏览器重启后恢复出来的 lore 组不在 loreGroups 里，按标题认
      await loaded;
      const ids = new Set(loreGroups);
      for (const g of await chrome.tabGroups.query({}).catch(() => [])) if (GROUP_TITLE.test(g.title ?? "")) ids.add(g.id);
      for (const id of ids) await closeGroup(id);
      return { closed: ids.size };
    }
    case "idleGroup": {
      for (const t of await chrome.tabs.query({ groupId: args.groupId }).catch(() => [])) if (t.id != null) await detach(t.id);
      return {};
    }
    case "screenshot": await mustBeAgent(args.tabId); return screenshot(args.tabId, args);
    case "input": await mustBeAgent(args.tabId); return input(args.tabId, args);
    case "evaluate": await mustBeAgent(args.tabId); return { v: await evaluate(args.tabId, args.src, args.args ?? []) };
    case "reload": {
      // 从磁盘重新加载扩展（daemon 发现扩展比安装目录里的旧时用；改了 manifest 也生效）
      setTimeout(() => chrome.runtime.reload(), 100);
      return {};
    }
    default:
      throw new Error(`未知操作 ${name}`);
  }
}

// bridge 问"这个标签页录不录"：只有 lore 组里的标签页录。
// 页面脚本经 bridge 发来的消息：只转 lore 标签页的，补上 tab、group、frame。页面自己的脚本也能发，所以只当观察记录；
// 只有「新开标签页」会让扩展做事（在同一个组里开一个标签页），而它本来就只是打开一个网址。
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (!m || sender.id !== chrome.runtime.id || !sender.tab) return;
  const tab = sender.tab;
  if (m.__loreMsg === 2) { void loaded.then(() => reply({ on: isLoreGroup(tab.groupId) })); return true; }
  if (m.__loreMsg !== 1) return;
  void loaded.then(() => {
    if (!isLoreGroup(tab.groupId)) return;
    const msg = m.msg ?? {};
    if (msg.k === "newtab") { void openForPage(tab, String(msg.url ?? "")).catch(() => {}); return; }
    postToHost({ type: "page", tab: tab.id, group: tab.groupId, frame: sender.frameId ?? 0, top: m.top, page: m.page, msg });
  });
});

// 标签页的地址变化和关闭：只转 lore 标签页的，daemon 记进日志
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url == null || !isWeb(changeInfo.url)) return;
  void loaded.then(() => { if (isLoreGroup(tab?.groupId)) postToHost({ type: "page", tab: tabId, group: tab.groupId, frame: 0, msg: { k: "tab", ev: "url", t: Date.now(), url: changeInfo.url } }); });
});
chrome.tabs.onRemoved.addListener((tabId) => {
  freshTabs.delete(tabId);
  for (const [w, t] of lastUserTab) if (t === tabId) lastUserTab.delete(w);
  postToHost({ type: "page", tab: tabId, frame: 0, msg: { k: "tab", ev: "closed", t: Date.now(), url: "" } });
});

// service worker 每次启动都尝试连接；onStartup / onInstalled 显式触发，alarm 兜底。
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "lore-keepalive" && !port) void connect();
});
// 点击工具栏图标：唤醒 service worker 并立即尝试连接（need-extension 的提示让用户点一下它）。
chrome.action.onClicked.addListener(connect);
chrome.alarms.create("lore-keepalive", { periodInMinutes: KEEPALIVE_MINUTES });
void connect();
