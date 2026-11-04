// speedrun 窗口 = 用户窗口里 speedrun 的一个标签组。守住：同一个 key 的标签页进同一个组；页面自己开出来的标签页按组号归到那个窗口（录进对的日志），
// 用户的标签页永远是 user（不录）；组被用户关了（扩展回来新组号）映射跟着换；第一次用时关掉上一个 daemon 留下的组；
// 闲置的组解除附着、操作进行中的不解除（否则页面在等请求时停止渲染、被冻结）。
import assert from "node:assert/strict";
import { AgentWindows } from "./window.ts";

let nextTab = 100;
let nextGroup = 50;
const calls: Array<[string, Record<string, unknown>]> = [];
const groupsAlive = new Set<number>();
const open = new Map<number, number>(); // 开着的标签页 → 组
const link = {
  request: async (name: string, args: Record<string, unknown> = {}) => {
    calls.push([name, args]);
    if (name === "tabs") return { tabs: [...open].map(([tabId, groupId]) => ({ tabId, groupId, speedrun: true })) };
    if (name === "openTab") { const g = typeof args.groupId === "number" && groupsAlive.has(args.groupId) ? args.groupId : nextGroup++; groupsAlive.add(g); const tabId = nextTab++; open.set(tabId, g); return { tabId, groupId: g }; }
    if (name === "closeTab") open.delete(Number(args.tabId));
    return {};
  },
};
const win = new AgentWindows(link as never, { label: () => ({ title: "speedrun", color: "blue" }), groupIdleMs: 20_000 });
const K = "a.com-20261101-120000";

const t1 = await win.acquire("https://a.com", K);
assert.equal(calls[0]![0], "closeAllGroups", "第一次用先关掉上一个 daemon 留下的组");
assert.equal(win.winOf(t1), K);
const g = win.groupOf(K)!;
const t2 = await win.acquire("https://b.com", K);
assert.equal(calls.filter(([n]) => n === "openTab").at(-1)![1].groupId, g, "同一个 key 的第二个标签页进同一个组");
assert.equal(win.winOf(t2), K);
assert.equal(calls.filter(([n]) => n === "closeAllGroups").length, 1, "只关一次");

win.adopt(555, g); // 页面自己开出来的标签页（扩展替它开在同一个组里）
assert.equal(win.winOf(555), K); assert.ok(win.isAgentTab(555));
win.adopt(556, 999); // 别的组（用户自己的）
assert.equal(win.winOf(556), "user");
win.adopt(557, undefined); // 不在任何组里
assert.equal(win.winOf(557), "user");

// 闲置：操作进行中不解除附着，结束后过了闲置时间才解除，且只发一次
const done = win.busy(t1);
assert.equal(await win.idle(Date.now() + 60_000), 0, "操作进行中不算闲置");
done();
assert.equal(await win.idle(Date.now() + 1_000), 0, "刚操作完不算闲置");
assert.equal(await win.idle(Date.now() + 60_000), 1);
assert.deepEqual(calls.at(-1), ["idleGroup", { groupId: g }]);
assert.equal(await win.idle(Date.now() + 120_000), 0, "已经闲置的不再发");
win.busy(t2)(); // 再操作一次又算活跃
assert.equal(await win.idle(Date.now() + 60_000), 1);

// 组被用户关了：扩展新建组、回来新组号，映射跟着换（旧组号的消息不再归到这个 key）
groupsAlive.delete(g);
assert.equal(await win.isOpen(K), true);
win.release(t1); win.release(t2);
await win.close(t1); await win.close(t2);
assert.equal(await win.isOpen(K), false, "组里没有标签页了就算关了");
const t3 = await win.acquire("https://a.com", K);
const g2 = win.groupOf(K)!;
assert.notEqual(g2, g); assert.equal(win.winOf(t3), K);
win.adopt(600, g);
assert.equal(win.winOf(600), "user", "旧组号不再归到这个 key");

await win.dispose(K);
assert.deepEqual(calls.at(-1), ["closeGroup", { groupId: g2 }]);
assert.equal(win.winOf(555), "user", "窗口收回后不再算");
assert.equal(win.groupOf(K), undefined);
console.log("window.selfcheck ok");
