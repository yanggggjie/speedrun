// 用桩对象模拟 chrome.* 运行 background.js：握手、固定的几个操作（call / tabs / goto / 窗口与标签页）、页面消息转发、标签页事件、重连。
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const posted = [];
const port = { message: null, disconnect: null };
const calls = [];
const handlers = {};
const onEvt = (name) => ({ addListener: (fn) => { (handlers[name] ??= []).push(fn); }, removeListener: () => {} });
const ANCHOR = "chrome-extension://fake-id/anchor.html";
const tabs = new Map([
  [1, { id: 1, windowId: 1, active: true, url: "https://a.com/x", title: "A", status: "complete" }],
  [2, { id: 2, windowId: 1, active: false, url: "chrome://extensions", title: "E", status: "complete" }],
  [3, { id: 3, windowId: 9, active: true, url: ANCHOR, title: "tabbot kitchen", status: "complete" }],
]);
let nextTab = 10;
const navigated = new Map();
let scriptResult = { v: 42 };

globalThis.chrome = {
  runtime: {
    id: "fake-id",
    connectNative: (name) => {
      calls.push(["connectNative", name]);
      return { postMessage: (m) => posted.push(m), onMessage: { addListener: (fn) => (port.message = fn) }, onDisconnect: { addListener: (fn) => (port.disconnect = fn) } };
    },
    getManifest: () => ({ version: "0.3.0" }),
    getURL: (p) => `chrome-extension://fake-id/${p}`,
    onStartup: onEvt("startup"),
    onInstalled: onEvt("installed"),
    onMessage: onEvt("message"),
  },
  scripting: {
    executeScript: async (o) => {
      calls.push(["executeScript", o.target.tabId, o.world ?? "ISOLATED", o.files ?? "func", o.args]);
      if (o.func) return [{ result: o.args ? scriptResult : false }];
      return [{}];
    },
  },
  tabs: {
    query: async () => [...tabs.values()],
    get: async (id) => ({ ...(tabs.get(id) ?? { id }), ...(navigated.get(id) ?? {}) }),
    update: async (id, props) => { calls.push(["tabs.update", id, props]); if (props.url) navigated.set(id, { url: props.url, title: "next" });
      if (props.url) setTimeout(() => handlers.tabUpdated.forEach((h) => h(id, { status: "complete" })), 5); return {}; },
    create: async (props) => { calls.push(["tabs.create", props]); return { id: nextTab++, windowId: props.windowId }; },
    remove: async (id) => { calls.push(["tabs.remove", id]); },
    onUpdated: onEvt("tabUpdated"),
    onRemoved: onEvt("tabRemoved"),
  },
  windows: {
    create: async (props) => { calls.push(["windows.create", props]); return { id: 11, tabs: [{ id: nextTab++ }] }; },
    remove: async (id) => { calls.push(["windows.remove", id]); },
  },
  action: { onClicked: onEvt("actionClicked") },
  alarms: { create: (n, o) => calls.push(["alarm", n, o.periodInMinutes]), onAlarm: onEvt("alarm") },
};

await import(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "background.js") + "?t=1");
await new Promise((r) => setTimeout(r, 10));
const host = async (msg) => { await port.message(msg); await new Promise((r) => setTimeout(r, 30)); };
const last = () => [...posted].reverse().find((m) => "id" in m);

// 1. 启动即连接，握手带 ABI 版本；ABI 必须和 holder 一侧一致
assert.deepEqual(calls.find((c) => c[0] === "connectNative"), ["connectNative", "com.tabbot.connect"]);
const { ABI } = await import(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../browser/extension.ts"));
assert.deepEqual(posted[0], { type: "hello", abi: ABI, chromeVersion: posted[0].chromeVersion, extensionVersion: "0.3.0" });
assert.equal(ABI, 2);
assert.deepEqual(calls.find((c) => c[0] === "alarm"), ["alarm", "tabbot-keepalive", 0.5]);
// 已经打开的 http 页面补注入（chrome:// 不注入）：探测不到页面脚本时注入 MAIN 三个文件和隔离世界的 bridge
assert.ok(calls.some((c) => c[0] === "executeScript" && c[1] === 1 && Array.isArray(c[3]) && c[3].includes("page/recorder.js")));
assert.ok(calls.some((c) => c[0] === "executeScript" && c[1] === 1 && Array.isArray(c[3]) && c[3][0] === "page/bridge.js"));
assert.ok(!calls.some((c) => c[0] === "executeScript" && c[1] === 2), "chrome:// 页面不注入");

// 2. tabs：http/https 页面，加上 anchor 页（标 anchor）
await host({ id: 1, name: "tabs", args: {} });
assert.deepEqual(last().result.tabs.map((t) => [t.tabId, !!t.anchor]), [[1, false], [3, true]]);

// 3. call：在页面里调用 window.__tcr.exec[fn]，结果原样带回；页面脚本报的错变成错误
await host({ id: 2, name: "call", args: { tabId: 1, fn: "text", args: [100] } });
assert.deepEqual(last().result, { v: 42 });
assert.deepEqual(calls.at(-1).slice(0, 3), ["executeScript", 1, "MAIN"]);
assert.deepEqual(calls.at(-1)[4], ["text", [100]]);
scriptResult = { __tcrError: "元素已不在页面上" };
await host({ id: 3, name: "call", args: { tabId: 1, fn: "act", args: [{}] } });
assert.match(last().error.message, /元素已不在页面上/);

// 4. goto（等加载）、窗口与标签页
await host({ id: 4, name: "goto", args: { tabId: 1, url: "https://a.com/next", wait: true } });
assert.deepEqual(calls.filter((c) => c[0] === "tabs.update").at(-1), ["tabs.update", 1, { url: "https://a.com/next" }]);
assert.deepEqual(last().result, { url: "https://a.com/next", title: "next", loaded: true });
await host({ id: 5, name: "openWindow", args: { anchor: true } });
assert.deepEqual(calls.find((c) => c[0] === "windows.create")[1], { url: ANCHOR, focused: false, type: "normal" }, "新窗口不抢焦点");
assert.equal(last().result.windowId, 11);
await host({ id: 6, name: "openTab", args: { windowId: 11, url: "https://a.com/robots.txt" } });
assert.deepEqual(calls.find((c) => c[0] === "tabs.create")[1], { windowId: 11, url: "https://a.com/robots.txt", active: true });
await host({ id: 7, name: "activateTab", args: { tabId: 10 } });
assert.deepEqual(calls.filter((c) => c[0] === "tabs.update").at(-1), ["tabs.update", 10, { active: true }]);
await host({ id: 8, name: "closeTab", args: { tabId: 10 } });
await host({ id: 9, name: "closeWindow", args: { windowId: 11 } });
assert.ok(calls.some((c) => c[0] === "tabs.remove" && c[1] === 10) && calls.some((c) => c[0] === "windows.remove" && c[1] === 11));
await host({ id: 10, name: "nope", args: {} });
assert.match(last().error.message, /未知操作 nope/);

// 5. 页面消息：只收自己的 bridge 发来的、带 tab 的；补上 tab / frame / top / page，原样转给 holder
const before = posted.length;
const forward = (m, sender) => handlers.message[0](m, sender);
forward({ __tcrl: 1, top: true, page: "https://a.com/x", msg: { __tcrl: 1, k: "ev", t: 5, type: "click", trusted: true } }, { id: "fake-id", tab: { id: 1 }, frameId: 3 });
forward({ __tcrl: 1, msg: { k: "ev" } }, { id: "other", tab: { id: 1 } });
forward({ __tcrl: 1, msg: { k: "ev" } }, { id: "fake-id" });
assert.equal(posted.length, before + 1);
assert.deepEqual(posted.at(-1), { type: "page", tab: 1, frame: 3, top: true, page: "https://a.com/x", msg: { __tcrl: 1, k: "ev", t: 5, type: "click", trusted: true } }, "消息放在 msg 里，事件自己的 type 字段不会盖掉信封的 type");

// 8. 标签页事件：http/https 的地址变化、关闭
handlers.tabUpdated[0](1, { url: "https://a.com/y" });
handlers.tabUpdated[0](1, { url: "chrome://x" });
handlers.tabUpdated[0](1, { title: "没有 url 变化" });
handlers.tabRemoved[0](1);
const tabEvents = posted.filter((m) => m.msg?.k === "tab");
assert.deepEqual(tabEvents.map((m) => [m.msg.ev, m.tab, m.msg.url]), [["url", 1, "https://a.com/y"], ["closed", 1, ""]]);

// 9. 断开后退避重连；点击工具栏图标立即重连
port.disconnect();
await new Promise((r) => setTimeout(r, 1100));
assert.ok(calls.filter((c) => c[0] === "connectNative").length >= 2, "断开后应重连");
const connects = calls.filter((c) => c[0] === "connectNative").length;
port.disconnect();
handlers.actionClicked[0]();
await new Promise((r) => setTimeout(r, 5));
assert.equal(calls.filter((c) => c[0] === "connectNative").length, connects + 1, "点击图标应立即重连");

console.log("extension smoke ok");
