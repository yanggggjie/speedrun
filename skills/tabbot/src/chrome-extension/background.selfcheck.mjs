// 用桩对象模拟 chrome.* 运行 background.js，验证扩展侧的消息与所有权逻辑。由 npm test 调用。
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const posted = [];
let portListeners = { message: null, disconnect: null };
const storage = {};
const calls = [];
const listeners = {};
// 同一个事件可以有多个监听（所有权逻辑和常驻录制各有一个）：listeners[name] 依次调用全部
const handlers = {};
const onEvt = (name) => ({ addListener: (fn) => { (handlers[name] ??= []).push(fn); listeners[name] = (...args) => Promise.all(handlers[name].map((f) => f(...args))); } });
const registered = [];
let siteStore = {};
let nextWin = 1000;
let nextTab = 2000;
const tabs = new Map();

globalThis.chrome = {
  storage: {
    session: {
      get: async (keys) => Object.fromEntries(keys.map((k) => [k, storage[k]])),
      set: async (obj) => Object.assign(storage, obj),
    },
    local: { get: async () => ({ ...siteStore }), set: async (o) => Object.assign(siteStore, o) },
  },
  runtime: {
    connectNative: (name) => {
      calls.push(["connectNative", name]);
      return {
        postMessage: (m) => posted.push(m),
        onMessage: { addListener: (fn) => (portListeners.message = fn) },
        onDisconnect: { addListener: (fn) => (portListeners.disconnect = fn) },
      };
    },
    getManifest: () => ({ version: "0.1.0" }),
    getURL: (name) => `chrome-extension://fake/${name}`,
    onStartup: onEvt("startup"),
    onInstalled: onEvt("installed"),
    id: "fake-extension-id",
    onMessage: onEvt("runtimeMessage"),
  },
  scripting: {
    registerContentScripts: async (list) => { registered.push(...list); },
    unregisterContentScripts: async () => { registered.length = 0; },
    executeScript: async ({ target, func, args }) => { calls.push(["executeScript", target.tabId]); return [{ result: func ? func(...args) : null }]; },
  },
  action: { onClicked: onEvt("actionClicked") },
  alarms: { create: (n, o) => calls.push(["alarm", n, o.periodInMinutes]), onAlarm: onEvt("alarm") },
  debugger: {
    attach: async (t, v) => { calls.push(["attach", t.tabId, v]); },
    detach: async (t) => { calls.push(["detach", t.tabId]); },
    sendCommand: async (t, m, p) => { calls.push(["cdp", t.tabId, m]); return { echoed: m, params: p }; },
    onEvent: onEvt("debuggerEvent"),
    onDetach: onEvt("debuggerDetach"),
  },
  windows: {
    create: async ({ focused }) => {
      const id = nextWin++; const tab = { id: nextTab++, windowId: id, url: "about:blank" };
      tabs.set(tab.id, tab); calls.push(["windows.create", focused]);
      return { id, tabs: [tab], state: "normal" };
    },
    get: async (id) => ({ id, state: "normal" }),
    remove: async (id) => { calls.push(["windows.remove", id]); },
    onRemoved: onEvt("windowRemoved"),
  },
  tabs: {
    create: async ({ windowId, url, active }) => { const tab = { id: nextTab++, windowId, url }; tabs.set(tab.id, tab); calls.push(["tabs.create", windowId, active]); return tab; },
    get: async (id) => { const t = tabs.get(id); if (!t) throw new Error("no tab"); return t; },
    remove: async (id) => { tabs.delete(id); calls.push(["tabs.remove", id]); },
    query: async () => [...tabs.values()],
    onCreated: onEvt("tabCreated"),
    onUpdated: onEvt("tabUpdated"),
    onRemoved: onEvt("tabRemoved"),
  },
};

// 扩展用 fetch(chrome.runtime.getURL(...)) 读自己的文件算 buildId；这里用固定内容代替
const extensionFiles = { "background.js": Buffer.from("bg-bytes\n"), "manifest.json": Buffer.from("{}\n"), "hook.js": Buffer.from("hook\n"), "relay.js": Buffer.from("relay\n") };
globalThis.fetch = async (url) => {
  const name = String(url).split("/").pop();
  if (!(name in extensionFiles)) throw new Error("not found");
  const bytes = extensionFiles[name];
  return { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
};
await import(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "background.js") + "?t=1");
await new Promise((r) => setTimeout(r, 10));

// 1. 启动即连接，并先发 hello
assert.deepEqual(calls.find((c) => c[0] === "connectNative"), ["connectNative", "com.tabbot.connect"]);
assert.equal(posted[0].type, "hello");
assert.equal(posted[0].protocolVersion, 1);
// hello 带 buildId，算法和 store/version.ts 里的 extension 一致
const { createHash } = await import("node:crypto");
const expectedBuild = createHash("sha256").update(extensionFiles["background.js"]).update(extensionFiles["manifest.json"]).update(extensionFiles["hook.js"]).update(extensionFiles["relay.js"]).digest("hex").slice(0, 16);
assert.equal(posted[0].buildId, expectedBuild);
assert.deepEqual(calls.find((c) => c[0] === "alarm"), ["alarm", "tabbot-keepalive", 0.5]);

const host = (msg) => portListeners.message(msg);
const replies = () => posted.filter((m) => "id" in m);
const last = () => replies()[replies().length - 1];
const settle = () => new Promise((r) => setTimeout(r, 20));

// 2. 开窗：focused 原样传递；返回 windowId / tabId；记入 owned
await host({ id: 1, op: "tab", name: "openWindow", args: { focused: true } });
await settle();
assert.equal(last().id, 1);
const win = last().result;
assert.ok(win.windowId && win.tabId);
assert.ok(calls.some((c) => c[0] === "windows.create" && c[1] === true));

// 3. 未 attach 的 cdp 被拒绝；attach 后可发送
await host({ id: 2, op: "cdp", tabId: win.tabId, method: "Runtime.evaluate", params: { expression: "1" } });
await settle();
assert.match(last().error.message, /未 attach/);
await host({ id: 3, op: "tab", name: "attach", args: { tabId: win.tabId } });
await settle();
assert.ok(calls.some((c) => c[0] === "attach" && c[1] === win.tabId && c[2] === "1.3"));
await host({ id: 4, op: "cdp", tabId: win.tabId, method: "Runtime.evaluate", params: { expression: "1" } });
await settle();
assert.equal(last().result.echoed, "Runtime.evaluate");

// 4. 非 TabBot 的 tab 一律拒绝（用户自己的 tab）
await host({ id: 5, op: "tab", name: "attach", args: { tabId: 999999 } });
await settle();
assert.match(last().error.message, /不属于 tabbot/);
await host({ id: 6, op: "cdp", tabId: 999999, method: "Page.enable", params: {} });
await settle();
assert.match(last().error.message, /不属于 tabbot/);

// 5. 由 tabbot tab 打开的新 tab 自动纳入，并通知 holder
tabs.set(7001, { id: 7001, windowId: 7000, url: "https://a.com" });
await listeners.tabCreated({ id: 7001, windowId: 7000, openerTabId: win.tabId, pendingUrl: "https://a.com" });
await settle();
const created = posted.find((m) => m.type === "tab" && m.kind === "created");
assert.equal(created.tabId, 7001);
assert.equal(created.openerTabId, win.tabId);
// 无 opener 的用户 tab 不纳入
tabs.set(8001, { id: 8001, windowId: 8000, url: "https://user.com" });
await listeners.tabCreated({ id: 8001, windowId: 8000, openerTabId: undefined });
await settle();
assert.equal(posted.filter((m) => m.type === "tab" && m.kind === "created").length, 1);
await host({ id: 9, op: "tab", name: "listOwned", args: {} });
await settle();
const ids = last().result.tabs.map((t) => t.tabId);
assert.equal(typeof last().result.tabs[0].title, "string", "listOwned 带 title，holder 靠它识别 TabBot 的窗口");
assert.ok(ids.includes(win.tabId) && ids.includes(7001) && !ids.includes(8001));

// 6. 录制窗口（kind: record）里用户自己开的新 tab（没有 opener）也纳入；run 窗口不放宽
await host({ id: 20, op: "tab", name: "openWindow", args: { focused: false, kind: "record" } });
await settle();
const rec = last().result;
const createdCount = () => posted.filter((m) => m.type === "tab" && m.kind === "created").length;
const before = createdCount();
tabs.set(9001, { id: 9001, windowId: rec.windowId, url: "chrome://newtab" });
await listeners.tabCreated({ id: 9001, windowId: rec.windowId, openerTabId: undefined });
await settle();
assert.equal(createdCount(), before + 1, "录制窗口里没有 opener 的 tab 应被纳入并通知 holder");
assert.equal(posted.filter((m) => m.type === "tab" && m.kind === "created").at(-1).tabId, 9001);
tabs.set(9002, { id: 9002, windowId: win.windowId, url: "https://user.com" });
await listeners.tabCreated({ id: 9002, windowId: win.windowId, openerTabId: undefined });
await settle();
assert.equal(createdCount(), before + 1, "run 窗口里没有 opener 的 tab 不纳入");
// 录制窗口关闭后不再放宽
await host({ id: 21, op: "tab", name: "closeWindow", args: { windowId: rec.windowId } });
await settle();
tabs.set(9003, { id: 9003, windowId: rec.windowId, url: "https://late.com" });
await listeners.tabCreated({ id: 9003, windowId: rec.windowId, openerTabId: undefined });
await settle();
assert.equal(createdCount(), before + 1, "窗口关闭后不再纳入"); 

// 6. 调试器事件带 tabId 转发；分离通知
listeners.debuggerEvent({ tabId: win.tabId }, "Page.loadEventFired", { timestamp: 1 });
const ev = posted.find((m) => m.type === "event");
assert.equal(ev.tabId, win.tabId);
assert.equal(ev.method, "Page.loadEventFired");
listeners.debuggerDetach({ tabId: win.tabId }, "canceled_by_user");
const det = posted.find((m) => m.type === "tab" && m.kind === "detached");
assert.equal(det.reason, "canceled_by_user");

// 7. 关闭 tab：owned 移除并通知
listeners.tabRemoved(7001, { windowId: 7000 });
await settle();
assert.ok(posted.some((m) => m.type === "tab" && m.kind === "removed" && m.tabId === 7001));

// 8. 断开后退避重连
portListeners.disconnect();
await new Promise((r) => setTimeout(r, 1100));
assert.equal(calls.filter((c) => c[0] === "connectNative").length >= 2, true, "断开后应重连");

// 9. 点击工具栏图标：立即重连，不等退避（need-extension 的提示让用户点一下它）
const connectsBefore = calls.filter((c) => c[0] === "connectNative").length;
portListeners.disconnect();
listeners.actionClicked();
assert.equal(calls.filter((c) => c[0] === "connectNative").length, connectsBefore + 1, "点击图标应立即重连");


// 10. 常驻录制：setSites 动态注册内容脚本（manifest 不变），白名单站点之外的 tab 一律不开放，页面事件批量推给 daemon
tabs.set(8001, { id: 8001, windowId: 1, url: "https://www.zhihu.com/hot", title: "热榜", active: true });
tabs.set(8002, { id: 8002, windowId: 1, url: "https://mail.example.org/inbox", title: "邮箱", active: false });
await host({ id: 20, op: "tab", name: "setSites", args: { sites: ["zhihu.com"] } });
await settle();
assert.deepEqual(last().result, { mode: "only", sites: ["zhihu.com"], exclude: [] }); // 没带 mode 的旧格式按只录点名站点处理
assert.deepEqual(registered.map((r) => [r.id, r.world]), [["tc-hook", "MAIN"], ["tc-relay", "ISOLATED"]]);
assert.deepEqual(registered[0].matches, ["*://zhihu.com/*", "*://*.zhihu.com/*"]);
assert.equal(registered[0].runAt, "document_start");
assert.ok(calls.some((c) => c[0] === "executeScript" && c[1] === 8001), "已打开的白名单页面要补注入");
assert.ok(!calls.some((c) => c[0] === "executeScript" && c[1] === 8002), "白名单之外的页面不注入");
await host({ id: 21, op: "tab", name: "siteTabs", args: {} });
await settle();
assert.deepEqual(last().result.tabs.map((t) => t.tabId), [8001], "只列白名单站点的 tab，不泄露其它 tab");
await host({ id: 22, op: "tab", name: "snapshot", args: { tabId: 8002 } });
await settle();
assert.match(last().error.message, /不在录制范围内/);
globalThis.window = globalThis; // executeScript 的桩直接在本进程里运行 func
globalThis.__tcrSnap = (why) => ({ why, title: "热榜" });
await host({ id: 23, op: "tab", name: "snapshot", args: { tabId: 8001 } });
await settle();
assert.deepEqual(last().result.snap, { why: "live", title: "热榜" });
delete globalThis.__tcrSnap;
delete globalThis.window;
// 页面事件：只收自己扩展内容脚本发来的、带 tab 的消息；批量推送
const journalPosts = () => posted.filter((m) => m.type === "journal");
const postsBefore = journalPosts().length;
listeners.runtimeMessage({ __tcrl: 1, top: true, page: "https://www.zhihu.com/hot", msg: { __tcrl: 1, k: "ev", t: 1, type: "click" } }, { id: "fake-extension-id", tab: { id: 8001 }, frameId: 0 });
listeners.runtimeMessage({ __tcrl: 1, msg: { k: "ev", t: 2 } }, { id: "other-extension", tab: { id: 8001 }, frameId: 0 });
listeners.runtimeMessage({ __tcrl: 1, msg: { k: "ev", t: 3 } }, { id: "fake-extension-id", frameId: 0 });
await new Promise((r) => setTimeout(r, 350));
const batch = journalPosts().slice(postsBefore);
assert.equal(batch.length, 1);
assert.deepEqual(batch[0].events, [{ k: "ev", t: 1, type: "click", tab: 8001, frame: 0, top: true, page: "https://www.zhihu.com/hot" }]);
// 白名单 tab 的地址变化、关闭会记一条 tab 事件；离开白名单站点只记 left
await listeners.tabUpdated(8001, { url: "https://www.zhihu.com/explore" }, tabs.get(8001));
await listeners.tabRemoved(8001, { windowId: 1 });
await new Promise((r) => setTimeout(r, 350));
const tabEvents = journalPosts().flatMap((m) => m.events).filter((e) => e.k === "tab").map((e) => e.ev);
assert.deepEqual(tabEvents, ["url", "closed"]);

// 11. 默认录所有 http/https 站点、排除敏感站点：注册的是全部 http/https，用 excludeMatches 排除；被排除的站点和非网页不开放只读操作
await host({ id: 30, op: "tab", name: "setSites", args: { mode: "all", sites: [], exclude: ["mail.example.org", "bank.example.com"] } });
await settle();
assert.deepEqual(last().result, { mode: "all", sites: [], exclude: ["mail.example.org", "bank.example.com"] });
assert.deepEqual(registered[0].matches, ["http://*/*", "https://*/*"]);
assert.deepEqual(registered[0].excludeMatches, ["*://mail.example.org/*", "*://*.mail.example.org/*", "*://bank.example.com/*", "*://*.bank.example.com/*"]);
tabs.set(8003, { id: 8003, windowId: 1, url: "https://v2ex.com/?tab=tech", title: "V2EX", active: false });
tabs.set(8004, { id: 8004, windowId: 1, url: "chrome://extensions/", title: "扩展", active: false });
await host({ id: 31, op: "tab", name: "siteTabs", args: {} });
await settle();
const allIds = last().result.tabs.map((t) => t.tabId);
assert.ok(allIds.includes(8001) && allIds.includes(8003), "zhihu、v2ex 等没被排除的站点都在范围内");
assert.ok(!allIds.includes(8002), "被排除的 mail.example.org 不在范围内");
assert.ok(!allIds.includes(8004), "chrome:// 页面不算");
globalThis.window = globalThis;
globalThis.__tcrSnap = (why) => ({ why, title: "V2EX" });
await host({ id: 32, op: "tab", name: "snapshot", args: { tabId: 8003 } });
await settle();
assert.deepEqual(last().result.snap, { why: "live", title: "V2EX" });
await host({ id: 33, op: "tab", name: "snapshot", args: { tabId: 8002 } });
await settle();
assert.match(last().error.message, /不在录制范围内/, "被排除站点的页面不能取快照");
delete globalThis.__tcrSnap;
delete globalThis.window;
// 排除列表不为空以外的情况：没有排除时不带 excludeMatches；切回只录点名站点后恢复成按站点注册
await host({ id: 34, op: "tab", name: "setSites", args: { mode: "all", sites: [], exclude: [] } });
await settle();
assert.equal("excludeMatches" in registered[0], false);
await host({ id: 35, op: "tab", name: "setSites", args: { mode: "only", sites: ["ithome.com"], exclude: [] } });
await settle();
assert.deepEqual(registered[0].matches, ["*://ithome.com/*", "*://*.ithome.com/*"]);

console.log("extension smoke ok");
