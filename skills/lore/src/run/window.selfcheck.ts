// agent 窗口的归属：页面自己在 agent 窗口里开的标签页（target=_blank、window.open）也算那个窗口的，照常录；用户窗口里的标签页永远是 user（不录）。
import assert from "node:assert/strict";
import { AgentWindows } from "./window.ts";

let nextTab = 100;
const link = {
  request: async (name: string) => {
    if (name === "tabs") return { tabs: [] };
    if (name === "openWindow") return { windowId: 7 };
    if (name === "openTab") return { tabId: nextTab++ };
    return {};
  },
};
const win = new AgentWindows(link as never);
const tab = await win.acquire("https://a.com", "a.com-20261101-120000");
assert.equal(win.winOf(tab), "a.com-20261101-120000");
win.adopt(555, 7); // learn 窗口里点链接新开的标签页
assert.equal(win.winOf(555), "a.com-20261101-120000"); assert.ok(win.isAgentTab(555));
win.adopt(556, 99); // 用户自己的窗口
assert.equal(win.winOf(556), "user");
win.adopt(557, undefined); // 旧扩展不带窗口号
assert.equal(win.winOf(557), "user");
await win.dispose("a.com-20261101-120000");
assert.equal(win.winOf(555), "user", "窗口收回后不再算");
console.log("window.selfcheck ok");
