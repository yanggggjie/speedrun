// TabBot Chrome 扩展：一个固定 ABI 的管道。没有业务逻辑，也不放任何页面脚本——页面脚本由 holder 在连接时下发。
// holder 端的协议见 src/browser/extension.ts。改 ABI 才需要加 ABI 版本并让用户刷新扩展。
//
// holder → 扩展：{ id, name, args }，应答 { id, result | error }
//   register { scripts: [{ id, code, world }] }  用 chrome.userScripts 注册常驻脚本（所有 http/https 页面，document_start），并补注入已打开的页面
//   exec { tabId, code }                          在页面（MAIN world）里执行任意代码；结果由页面脚本自己经 bridge 发回
//   tabs {}                                       http/https 标签页列表
//   goto { tabId, url }                           在这个标签页里打开网址
// 扩展 → holder：{ type: "hello", abi, ... } | { type: "page", tab, frame, top, page, msg }（页面脚本的消息，或标签页的地址变化和关闭）

const ABI = 1;
const HOST = "com.tabbot.connect";
const MATCHES = ["http://*/*", "https://*/*"];
const RETRY_MAX_MS = 30_000;
const KEEPALIVE_MINUTES = 0.5;
const NO_USER_SCRIPTS = "chrome.userScripts 不可用：请在 chrome://extensions 的 TabBot 详情页打开『允许用户脚本』";

let port = null;
let retryCount = 0;
let retryTimer = null;

function postToHost(message) {
  if (port) port.postMessage(message);
}

const isWeb = (url) => typeof url === "string" && /^https?:/i.test(url);

async function userScriptsAvailable() {
  try { await chrome.userScripts.getScripts(); return true; } catch { return false; }
}

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
  const userScripts = await userScriptsAvailable();
  if (port !== current) return; // 等探测的时候连接已经断了
  current.postMessage({ type: "hello", abi: ABI, chromeVersion: navigator.userAgent, extensionVersion: chrome.runtime.getManifest().version, userScripts });
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

async function runOp(name, args) {
  switch (name) {
    case "register": {
      if (!(await userScriptsAvailable())) throw new Error(NO_USER_SCRIPTS);
      await chrome.userScripts.configureWorld({ messaging: true }); // USER_SCRIPT world 里的 bridge 才能给扩展发消息
      const old = await chrome.userScripts.getScripts();
      if (old.length) await chrome.userScripts.unregister({ ids: old.map((s) => s.id) });
      await chrome.userScripts.register(args.scripts.map((s) => ({ id: s.id, matches: MATCHES, js: [{ code: s.code }], runAt: "document_start", allFrames: true, world: s.world })));
      // 已经打开的页面不会重新加载，补注入一次（脚本自己防重复）
      for (const tab of await chrome.tabs.query({})) {
        if (tab.id == null || !isWeb(tab.url)) continue;
        for (const s of args.scripts) {
          chrome.userScripts.execute({ target: { tabId: tab.id, allFrames: true }, js: [{ code: s.code }], world: s.world, injectImmediately: true }).catch(() => {});
        }
      }
      return { scripts: args.scripts.length };
    }
    case "exec": {
      if (!(await userScriptsAvailable())) throw new Error(NO_USER_SCRIPTS);
      const results = await chrome.userScripts.execute({ target: { tabId: args.tabId }, js: [{ code: args.code }], world: "MAIN", injectImmediately: true });
      const failed = results.find((r) => r.error);
      if (failed) throw new Error(String(failed.error));
      return {};
    }
    case "tabs": {
      const out = [];
      for (const tab of await chrome.tabs.query({})) {
        if (tab.id == null || !isWeb(tab.url)) continue;
        out.push({ tabId: tab.id, windowId: tab.windowId, active: tab.active, url: tab.url, title: tab.title || "", status: tab.status || "" });
      }
      return { tabs: out };
    }
    case "goto": {
      await chrome.tabs.update(args.tabId, { url: args.url });
      return {};
    }
    default:
      throw new Error(`未知操作 ${name}`);
  }
}

// 页面脚本经 bridge 发来的消息：补上 tab、frame，原样转给 holder。页面自己的脚本也能发，所以只当观察记录。
chrome.runtime.onUserScriptMessage.addListener((m, sender) => {
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
