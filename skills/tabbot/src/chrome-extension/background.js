// TabBot Chrome 扩展：一个固定 ABI 的管道。没有业务逻辑；页面脚本是扩展包里的静态内容脚本（page/）。
// holder 端的协议见 src/browser/extension.ts。改 ABI 才需要加 ABI 版本并让用户刷新扩展。
//
// holder → 扩展：{ id, name, args }，应答 { id, result | error }
//   call { tabId, fn, args }          在页面（MAIN world）里调用 window.__tcr.exec[fn](...args)，等它的结果（可以是 Promise）
//   tabs {}                            http/https 标签页，加上 anchor 页（标题 tabbot agent，extension 页，anchor: true）
//   goto { tabId, url, wait }          在这个标签页里打开网址；wait 为真时等文档可用（readyState 不再是 loading，不等子资源；最多 15 秒）
//   openWindow { url, anchor }         新开窗口（不抢焦点）；anchor 为真时打开 anchor 页
//   openTab { windowId, url, active }  在窗口里新开标签页
//   activateTab { tabId }              把标签页切到所在窗口的前台（后台标签页浏览器不渲染）
//   closeTab { tabId } | closeWindow { windowId }
//   screenshot { tabId }               截图：把标签页切到前台，截可见区域，缩到视口的 CSS 像素尺寸（截图上的坐标就是页面坐标），返回 { data(base64), mime, w, h }
// 扩展 → holder：{ type: "hello", abi, ... } | { type: "page", tab, frame, top, page, msg }（页面脚本的消息，或标签页的地址变化和关闭）

const ABI = 3;
const HOST = "com.tabbot.connect";
const RETRY_MAX_MS = 30_000;
const KEEPALIVE_MINUTES = 0.5;
const LOAD_WAIT_MS = 15_000;
const PAGE_FILES = ["page/common.js", "page/recorder.js", "page/executor.js"];
const ANCHOR_URL = chrome.runtime.getURL("anchor.html");

let port = null;
let retryCount = 0;
let retryTimer = null;

function postToHost(message) {
  if (port) port.postMessage(message);
}

const isWeb = (url) => typeof url === "string" && /^https?:/i.test(url);

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
  current.postMessage({ type: "hello", abi: ABI, chromeVersion: navigator.userAgent, extensionVersion: chrome.runtime.getManifest().version });
  void injectExisting();
}

// 内容脚本只在新加载的页面里生效；已经打开的页面补注入一次（脚本自己防重复）
async function injectExisting() {
  for (const tab of await chrome.tabs.query({})) {
    if (tab.id == null || !isWeb(tab.url)) continue;
    try {
      const [probe] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: () => !!window.__tcr });
      if (probe?.result) continue;
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, world: "MAIN", files: PAGE_FILES, injectImmediately: true });
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ["page/bridge.js"], injectImmediately: true });
    } catch { /* 受限页面（商店、PDF 查看器等）注入不了 */ }
  }
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const view = (tab) => ({ tabId: tab.id, windowId: tab.windowId, active: tab.active, url: tab.url || tab.pendingUrl || "", title: tab.title || "", status: tab.status || "" });

async function runOp(name, args) {
  switch (name) {
    case "call": {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: args.tabId, frameIds: [args.frameId ?? 0] }, world: "MAIN",
        func: async (fn, fnArgs) => {
          const T = window.__tcr;
          if (!T || !T.exec || typeof T.exec[fn] !== "function") return { __tcrError: "页面里没有 TabBot 的脚本（刷新这个页面后再试）" };
          try { return { v: await T.exec[fn](...fnArgs) }; } catch (e) { return { __tcrError: String((e && e.message) || e) }; }
        },
        args: [args.fn, args.args ?? []],
      });
      const out = res?.result;
      if (!out) throw new Error("页面没有返回结果");
      if (out.__tcrError) throw new Error(out.__tcrError);
      return { v: out.v ?? null };
    }
    case "tabs": {
      const out = [];
      for (const tab of await chrome.tabs.query({})) {
        if (tab.id == null) continue;
        if (tab.url === ANCHOR_URL) out.push({ ...view(tab), anchor: true });
        else if (isWeb(tab.url) || isWeb(tab.pendingUrl)) out.push(view(tab));
      }
      return { tabs: out };
    }
    case "goto": {
      const wait = args.wait ? waitReady(args.tabId, args.url, LOAD_WAIT_MS) : null;
      await chrome.tabs.update(args.tabId, { url: args.url });
      const loaded = wait ? await wait : undefined;
      const tab = await chrome.tabs.get(args.tabId);
      return { url: tab.url || "", title: tab.title || "", loaded };
    }
    case "openWindow": {
      const win = await chrome.windows.create({ url: args.anchor ? ANCHOR_URL : args.url, focused: false, type: "normal" });
      const tab = win.tabs?.[0];
      return { windowId: win.id, tabId: tab?.id };
    }
    case "openTab": {
      const tab = await chrome.tabs.create({ windowId: args.windowId, url: args.url, active: args.active !== false });
      return { tabId: tab.id, windowId: tab.windowId };
    }
    case "activateTab": {
      await chrome.tabs.update(args.tabId, { active: true });
      return {};
    }
    case "closeTab": {
      await chrome.tabs.remove(args.tabId);
      return {};
    }
    case "screenshot": {
      const tab = await chrome.tabs.get(args.tabId);
      if (!tab.active) await chrome.tabs.update(args.tabId, { active: true });
      const [vp] = await chrome.scripting.executeScript({ target: { tabId: args.tabId }, func: () => ({ w: window.innerWidth, h: window.innerHeight }) });
      const w = vp?.result?.w, h = vp?.result?.h;
      if (!w || !h) throw new Error("取不到页面视口大小（受限页面截不了图）");
      const shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 70 });
      const bitmap = await createImageBitmap(await (await fetch(shot)).blob());
      const canvas = new OffscreenCanvas(w, h);
      canvas.getContext("2d").drawImage(bitmap, 0, 0, w, h);
      const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.7 });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { data: btoa(bin), mime: "image/jpeg", w, h };
    }
    case "closeWindow": {
      await chrome.windows.remove(args.windowId);
      return {};
    }
    default:
      throw new Error(`未知操作 ${name}`);
  }
}

// 页面脚本经 bridge 发来的消息：补上 tab、frame，原样转给 holder。页面自己的脚本也能发，所以只当观察记录。
chrome.runtime.onMessage.addListener((m, sender) => {
  if (!m || m.__tcrl !== 1 || sender.id !== chrome.runtime.id || !sender.tab) return;
  postToHost({ type: "page", tab: sender.tab.id, frame: sender.frameId ?? 0, top: m.top, page: m.page, msg: m.msg ?? {} });
});

// 标签页的地址变化和关闭：holder 记进日志
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url == null || !isWeb(changeInfo.url)) return;
  postToHost({ type: "page", tab: tabId, frame: 0, msg: { k: "tab", ev: "url", t: Date.now(), url: changeInfo.url } });
});
chrome.tabs.onRemoved.addListener((tabId) => {
  postToHost({ type: "page", tab: tabId, frame: 0, msg: { k: "tab", ev: "closed", t: Date.now(), url: "" } });
});

// service worker 每次启动都尝试连接；onStartup / onInstalled 显式触发，alarm 兜底。
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "tabbot-keepalive" && !port) void connect();
});
// 点击工具栏图标：唤醒 service worker 并立即尝试连接（need-extension 的提示让用户点一下它）。
chrome.action.onClicked.addListener(connect);
chrome.alarms.create("tabbot-keepalive", { periodInMinutes: KEEPALIVE_MINUTES });
void connect();
