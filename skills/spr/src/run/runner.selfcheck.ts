// action 与 spr run -e 运行：每次 run 新开一个 run 窗口、跑完就关、互不排队；draft 真跑成功交给命令层变成 verified；
// blocked 直接拒绝；action 嵌套最多 2 层且共用窗口；spr run -e 支持单表达式、多语句与 spr/helpers/* 导入，且禁止直接操作页面；
// @timeout 与进程退出取消（signal）生效。
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ActionRunner, trimError, type Outcome, type RunWindows } from "./runner.ts";
import { syncActionLib } from "./actions.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "speedrun-runner-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
const actionDir = path.join(root, "action"), libDir = path.join(root, "lib"), helpersDir = path.join(root, "helpers");
const dir = path.join(actionDir, "example.com");
fs.mkdirSync(dir, { recursive: true });
syncActionLib(libDir);
fs.writeFileSync(path.join(helpersDir, "fmt.js"), `export const wrap = (s) => "[" + s + "]";\n`);
fs.writeFileSync(path.join(dir, "echo.js"), `/**\n * @description 回显\n * @status draft\n * @param v 值\n */\nimport { sleep } from "spr";\nimport { wrap } from "spr/helpers/fmt.js";\nexport default async (params) => { await sleep(120); return { v: params.v, wrapped: wrap(params.v) }; };\n`);

const host = {
  op: async (s: { inlineOnly?: boolean }) => {
    if (s.inlineOnly) throw new Error("spr run -e 里只能调用 action(\"名字\", 参数) 和 sleep(ms)，不能直接操作页面或发 request");
    throw new Error("不该碰页面");
  },
  end: async () => {},
  watchSent: () => {},
  takeSent: () => [],
  takePageSent: () => [],
  takeStats: () => ({ perf: { openMs: 0, navMs: 0, reqMs: 0, domMs: 0 }, ops: { nav: 0, req: 0, dom: 0, eval: 0 } }),
  takeDialogs: () => [],
  failureShot: async () => undefined,
  takeRejected: () => undefined,
};
const opened: string[] = [], closed: string[] = [];
let n = 0;
const windows: RunWindows = { open: (label) => { const key = `${label}-${++n}`; opened.push(key); return key; }, close: async (key) => { closed.push(key); }, shotFile: (key) => path.join(root, `${key}-shot`), failureFile: (key) => path.join(root, key) };
const runner = new ActionRunner(host as never, { actionDir }, windows);
const plain = (o: Outcome) => { const { runWindow: _w, drafts: _d, sent: _x, pageSent: _p, dialogs: _g, calls: _c, perf: _pf, ops: _op, ...rest } = o; return rest; };

// 单步直跑 draft action，且 spr/helpers/* 软链导入生效
const a = await runner.runAction("echo", { v: "1" });
assert.deepEqual(plain(a), { status: "success", result: { v: "1", wrapped: "[1]" } }, "draft action 直接跑且支持 spr/helpers/*");
assert.equal(a.runWindow, "echo-1"); assert.deepEqual(closed, ["echo-1"], "跑完就关");
assert.deepEqual(a.drafts, [path.join(dir, "echo.js")], "真跑成功的 draft 交给命令层变成 verified");

// @param 带类型转换与校验
fs.writeFileSync(path.join(dir, "typed.js"), `/**\n * @description 类型\n * @status verified\n * @param n:number 数\n * @param on?:boolean 开关\n */\nexport default async (params) => ({ sum: params.n + 1, on: params.on });\n`);
assert.deepEqual(plain(await runner.runAction("typed", { n: "20", on: "true" })), { status: "success", result: { sum: 21, on: true } });
const bad = await runner.runAction("typed", { n: "x" });
assert.ok(bad.status === "failure" && bad.code === "param" && /要是数字/.test(bad.error));

// 两个 run 并行各开各的窗口
const t0 = Date.now();
const both = await Promise.all([runner.runAction("echo", { v: "a" }), runner.runAction("echo", { v: "b" })]);
assert.deepEqual(both.map((x) => x.status), ["success", "success"]);
assert.notEqual(both[0]!.runWindow, both[1]!.runWindow);
assert.ok(Date.now() - t0 < 260, "不同的 run 同时跑，不排队");
assert.equal(opened.length, closed.length);

// blocked 直接拒绝，不开窗口
fs.writeFileSync(path.join(dir, "never.js"), "/**\n * @description 写不出来\n * @status blocked\n * @note network 无响应体，DOM 读不到\n */\n");
const before = opened.length;
const never = await runner.runAction("never", {});
assert.ok(never.status === "failure" && never.code === "blocked" && /写不出来的 action.*@note/.test(never.error));
assert.equal(opened.length, before, "拒绝的不开窗口");

// action 嵌套调用：允许最多 2 层（step2 -> echo），共用窗口；第 3 层和自递归被拒绝
fs.writeFileSync(path.join(dir, "step2.js"), `/**\n * @status draft\n * @param v 值\n */\nimport { action } from "spr";\nexport default async ({ v }) => { const r = await action("echo", { v }); return r.v + r.v; };\n`);
const nestedOk = await runner.runAction("step2", { v: "k" });
assert.deepEqual(plain(nestedOk), { status: "success", result: "kk" });
assert.equal(nestedOk.calls?.length, 1);
assert.ok(nestedOk.drafts?.includes(path.join(dir, "step2.js")) && nestedOk.drafts?.includes(path.join(dir, "echo.js")));

fs.writeFileSync(path.join(dir, "step3.js"), `/**\n * @status verified\n */\nimport { action } from "spr";\nexport default async () => action("step2", { v: "z" });\n`);
const tooDeep = await runner.runAction("step3", {});
assert.ok(tooDeep.status === "failure" && tooDeep.code === "usage" && /最多 2 层/.test(tooDeep.error), "超过 2 层被拒");

fs.writeFileSync(path.join(dir, "selfloop.js"), `/**\n * @status verified\n */\nimport { action } from "spr";\nexport default async () => action("selfloop", {});\n`);
const loopErr = await runner.runAction("selfloop", {});
assert.ok(loopErr.status === "failure" && loopErr.code === "usage" && /递归/.test(loopErr.error), "自递归被拒");

// spr run -e（runInline）：支持单表达式、多语句 + spr/helpers/*，共用 1 个窗口，禁止直接碰页面，跑完不留临时文件
const winBeforeInline = opened.length;
const inlineExpr = await runner.runInline(`Promise.all(["x", "y"].map(v => action("step2", { v })))`);
assert.deepEqual(plain(inlineExpr), { status: "success", result: ["xx", "yy"] }, "单表达式自动 return，且内部可调 2 层 action");
assert.equal(opened.length, winBeforeInline + 1, "整个 runInline 共用 1 个 run 窗口");

const inlineImport = await runner.runInline(`import { wrap } from "spr/helpers/fmt.js";\nconst r = await action("typed", { n: 5 });\nreturn wrap(r.sum);`);
assert.deepEqual(plain(inlineImport), { status: "success", result: "[6]" }, "支持顶层 import spr/helpers/* 与多语句 return");

const inlineNav = await runner.runInline(`import { navigate } from "spr";\nawait navigate("https://example.com/");`);
assert.ok(inlineNav.status === "failure" && inlineNav.code === "usage" && /不能直接操作页面/.test(inlineNav.error), "run -e 里直接碰页面被拒");
assert.deepEqual(fs.readdirSync(root).filter((f) => f.startsWith(".inline-")), [], "跑完不留临时文件");

// 超时与进程退出取消（signal）
const slowInline = await runner.runInline(`await sleep(3000); return 1;`, { timeoutMs: 800 });
assert.ok(slowInline.status === "failure" && slowInline.code === "timeout" && /超过 1 秒/.test(slowInline.error));

const ac = new AbortController();
setTimeout(() => ac.abort(), 100);
const t1 = Date.now();
const cancelled = await runner.runInline(`await sleep(5000); return 1;`, { signal: ac.signal });
assert.ok(cancelled.status === "failure" && cancelled.code === "cancelled" && Date.now() - t1 < 2000, "取消后立刻结束");

// 报错只留用户文件的帧
const t = trimError("Error: 坏了", "Error: 坏了\n    at Module.default (file:///u/action/x.com/a.js:7:3)\n    at async file:///u/src/run/worker.ts:9:18", ["/u/action/"]);
assert.equal(t.text, "Error: 坏了\nat Module.default (file:///u/action/x.com/a.js:7:3)");
assert.equal(t.at, "/u/action/x.com/a.js:7");

const gone = await runner.runAction("nobody", {});
assert.ok(gone.status === "failure" && gone.code === "not-defined" && /nobody is not defined/.test(gone.error));

console.log("runner selfcheck ok");
