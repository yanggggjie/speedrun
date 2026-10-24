// 用桩对象模拟 chrome.* 运行 background.js：握手、固定的几个操作（register / exec / tabs / goto）、页面消息转发、标签页事件、重连。
import assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const posted = [];
const port = { message: null, disconnect: null };
const calls = [];
const handlers = {};
const onEvt = (name) => ({ addListener: (fn) => { (handlers[name] ??= []).push(fn); } });
const tabs = new Map([[1, { id: 1, windowId: 1, active: true, url: "https://a.com/x", title: "A", status: "complete" }], [2, { id: 2, windowId: 1, active: false, url: "chrome://extensions", title: "E", status: "complete" }]]);
let userScriptsOn = true;
let registered = [];

globalThis.chrome = {
  runtime: {
    id: "fake-id",
    connectNative: (name) => {
      calls.push(["connectNative", name]);
      return { postMessage: (m) => posted.push(m), onMessage: { addListener: (fn) => (port.message = fn) }, onDisconnect: { addListener: (fn) => (port.disconnect = fn) } };
    },
    getManifest: () => ({ version: "0.2.0" }),
    onStartup: onEvt("startup"),
    onInstalled: onEvt("installed"),
    onUserScriptMessage: onEvt("userScriptMessage"),
  },
  userScripts: new Proxy({
    getScripts: async () => { if (!userScriptsOn) throw new Error("User scripts are not enabled"); return registered; },
    configureWorld: async (o) => { calls.push(["configureWorld", o.messaging]); },
    unregister: async ({ ids }) => { registered = registered.filter((s) => !ids.includes(s.id)); },
    register: async (list) => { registered.push(...list); },
    execute: async ({ target, js, world }) => { calls.push(["execute", target.tabId, world, js[0].code]); return [{ frameId: 0 }]; },
  }, {}),
  tabs: {
    query: async () => [...tabs.values()],
    update: async (id, { url }) => { calls.push(["tabs.update", id, url]); },
    onUpdated: onEvt("tabUpdated"),
    onRemoved: onEvt("tabRemoved"),
  },
  action: { onClicked: onEvt("actionClicked") },
  alarms: { create: (n, o) => calls.push(["alarm", n, o.periodInMinutes]), onAlarm: onEvt("alarm") },
};

await import(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "background.js") + "?t=1");
await new Promise((r) => setTimeout(r, 10));
const host = async (msg) => { await port.message(msg); await new Promise((r) => setTimeout(r, 5)); };
const last = () => [...posted].reverse().find((m) => "id" in m);

// 1. 启动即连接，握手带 ABI 版本和用户脚本能力；ABI 必须和 holder 一侧一致
assert.deepEqual(calls.find((c) => c[0] === "connectNative"), ["connectNative", "com.tabbot.connect"]);
const { ABI } = await import(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../browser/extension.ts"));
assert.deepEqual(posted[0], { type: "hello", abi: ABI, chromeVersion: posted[0].chromeVersion, extensionVersion: "0.2.0", userScripts: true });
assert.deepEqual(calls.find((c) => c[0] === "alarm"), ["alarm", "tabbot-keepalive", 0.5]);

// 2. tabs：只列 http/https
await host({ id: 1, name: "tabs", args: {} });
assert.deepEqual(last().result.tabs.map((t) => t.tabId), [1]);
assert.equal(last().result.tabs[0].status, "complete");

// 3. register：开消息通道、注册常驻脚本（所有 http/https，document_start），已打开的页面补注入；旧的先清掉
const scripts = [{ id: "page", code: "/*page*/", world: "MAIN" }, { id: "bridge", code: "/*bridge*/", world: "USER_SCRIPT" }];
await host({ id: 2, name: "register", args: { scripts } });
assert.deepEqual(last().result, { scripts: 2 });
assert.ok(calls.some((c) => c[0] === "configureWorld" && c[1] === true));
assert.deepEqual(registered.map((s) => [s.id, s.world, s.runAt, s.allFrames]), [["page", "MAIN", "document_start", true], ["bridge", "USER_SCRIPT", "document_start", true]]);
assert.deepEqual(registered[0].matches, ["http://*/*", "https://*/*"]);
assert.equal(calls.filter((c) => c[0] === "execute" && c[1] === 1).length, 2, "已打开的 http 页面补注入两个脚本");
assert.ok(!calls.some((c) => c[0] === "execute" && c[1] === 2), "chrome:// 页面不注入");
await host({ id: 3, name: "register", args: { scripts: [scripts[0]] } });
assert.deepEqual(registered.map((s) => s.id), ["page"], "再次注册先清掉旧的");

// 4. exec：在 MAIN world 执行任意代码，不限制内容
await host({ id: 4, name: "exec", args: { tabId: 1, code: "anything()" } });
assert.deepEqual(calls.at(-1), ["execute", 1, "MAIN", "anything()"]);
assert.deepEqual(last().result, {});

// 5. goto
await host({ id: 5, name: "goto", args: { tabId: 1, url: "https://a.com/next" } });
assert.deepEqual(calls.at(-1), ["tabs.update", 1, "https://a.com/next"]);
await host({ id: 6, name: "nope", args: {} });
assert.match(last().error.message, /未知操作 nope/);

// 6. 开关没打开：register 和 exec 说清楚怎么办
userScriptsOn = false;
await host({ id: 7, name: "exec", args: { tabId: 1, code: "1" } });
assert.match(last().error.message, /允许用户脚本/);
await host({ id: 8, name: "register", args: { scripts } });
assert.match(last().error.message, /允许用户脚本/);
userScriptsOn = true;

// 7. 页面消息：只收自己的 bridge 发来的、带 tab 的；补上 tab / frame / top / page，原样转给 holder
const before = posted.length;
const forward = (m, sender) => handlers.userScriptMessage[0](m, sender);
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
