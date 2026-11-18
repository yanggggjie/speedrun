// speedrun 窗口：daemon 只围绕 WindowScope 与 tabId 管理归属与生命周期（组纯做扩展内 UI 收纳）。
// 守住：同一个 key 下同源空闲 tab 复用；空白页直跳不走 robots.txt；page 打开的 sub-tab 按 opener 继承作用域且跨窗口隔离；
// 单 tab 闲置解除附着（idleTab），操作进行中不解除；dispose 后在途 openTab 立即关闭且不写回内存表；onTabRemoved 实时清理。
import assert from "node:assert/strict";
import { AgentWindows } from "./window.ts";

let nextTab = 100;
const calls: Array<[string, Record<string, unknown>]> = [];
const open = new Map<number, string>(); // tabId → url
let delayOpenMs = 0;
const link = {
  request: async (name: string, args: Record<string, unknown> = {}) => {
    calls.push([name, args]);
    if (name === "openTab") {
      if (delayOpenMs > 0) await new Promise((r) => setTimeout(r, delayOpenMs));
      const tabId = nextTab++;
      open.set(tabId, String(args.url ?? "about:blank"));
      return { tabId };
    }
    if (name === "closeTab") open.delete(Number(args.tabId));
    return {};
  },
};
const win = new AgentWindows(link as never, { tabIdleMs: 20_000 });
const K = "a.com-20261101-120000";
const K2 = "b.com-20261101-120000";

// 空白页直开不带 url（navigate 路径），warm 页带 robots.txt（request 路径）
const tBlank = await win.acquire("https://a.com", K, { blank: true });
assert.equal(open.get(tBlank), "about:blank", "blank 模式只开空白页");
assert.equal(win.winOf(tBlank), K);
win.moved(tBlank, "https://a.com");
win.release(tBlank);
const reused = await win.acquire("https://a.com", K, { blank: true });
assert.equal(reused, tBlank, "归还后同源空闲 tab 自动复用");

const t2 = await win.acquire("https://b.com", K);
assert.equal(open.get(t2), "https://b.com/robots.txt", "裸 request 路径开 robots.txt 暖页");
assert.equal(win.winOf(t2), K);

// opener 归属与跨窗口隔离
win.adopt(555, tBlank);
assert.equal(win.winOf(555), K);
assert.ok(win.isAgentTab(555));
win.adopt(556, 999); // 非 speedrun tab
assert.equal(win.winOf(556), "user");
win.adopt(557, undefined);
assert.equal(win.winOf(557), "user");
const tK2 = await win.acquire("https://b.com", K2, { blank: true });
assert.equal(win.winOf(tK2), K2);
assert.notEqual(win.winOf(555), win.winOf(tK2), "不同窗口的 opener 互不串台");

// 单 tab 闲置解除附着：操作进行中该 tab 不解除，其它空闲 tab 正常解除且只发一次
const done = win.busy(tBlank);
await win.idle(Date.now() + 60_000);
assert.equal(calls.some(([n, a]) => n === "idleTab" && a.tabId === tBlank), false, "操作进行中的 tab 不解除附着");
assert.equal(calls.some(([n, a]) => n === "idleTab" && a.tabId === 555), true, "adopted 子 tab 闲置时也解除附着");
done();
await win.idle(Date.now() + 1_000);
assert.equal(calls.some(([n, a]) => n === "idleTab" && a.tabId === tBlank), false, "刚操作完不算闲置");
assert.equal(await win.idle(Date.now() + 60_000), 1, "只有刚释放的 tBlank 进入闲置");
assert.equal(calls.filter(([n, a]) => n === "idleTab" && a.tabId === tBlank).length, 1);
assert.equal(await win.idle(Date.now() + 120_000), 0, "已经闲置的不再发");
win.busy(t2)();
assert.equal(await win.idle(Date.now() + 60_000), 1, "再次操作 t2 后恢复活跃并能再次闲置");

// isOpen 按作用域与可选主 tab 判断；removeTab 实时清理
assert.equal(win.isOpen(K, tBlank), true);
open.delete(tBlank);
win.removeTab(tBlank);
assert.equal(win.isOpen(K, tBlank), false, "主 tab 被关后即使还有其它 tab 也返回 false");
assert.equal(win.isOpen(K), true, "窗口里仍有其它 tab");

// dispose 封口：在途 openTab 返回后立刻 closeTab，不泄漏、不写回内存
delayOpenMs = 80;
const pendingAcquire = win.acquire("https://c.com", K, { blank: true });
await new Promise((r) => setTimeout(r, 15));
await win.dispose(K);
await assert.rejects(pendingAcquire, /已关闭/);
await new Promise((r) => setTimeout(r, 100));
assert.equal(open.has(nextTab - 1), false, "在途 openTab 完成后立即被 closeTab，不留孤儿");
assert.equal(win.winOf(555), "user", "窗口收回后子 tab 归零");
assert.equal(win.isOpen(K), false);
await assert.rejects(win.acquire("https://c.com", K, { blank: true }), /已关闭/);

await win.dispose(K2);
assert.equal(open.size, 0, "全部 dispose 后无残留 tab");
console.log("window.selfcheck ok");
