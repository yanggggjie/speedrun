// action 运行：每次 run 新开一个 run 窗口、跑完就关、不沿用上次的（不同的 run 各开各的、不排队）；draft 能直接跑，真跑成功才算要变成 verified 的；
// 写不出来的拒绝；compose（agent 写的 compose/<名>.js）只能调用 action、draft 跑通也变成 verified、@timeout 生效；
// ask 恢复时不重跑之前的 action，并且用停下那一刻的代码。用最小的假 host，action 不碰页面。
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ActionRunner, trimError, type Outcome, type RunWindows } from "./runner.ts";
import { syncActionLib } from "./actions.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "speedrun-runner-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
const actionDir = path.join(root, "action"), libDir = path.join(root, "lib"), composeDir = path.join(root, "compose");
const dir = path.join(actionDir, "example.com");
fs.mkdirSync(dir, { recursive: true });
fs.mkdirSync(composeDir, { recursive: true });
/** 写一个 compose 文件：和 action 一样的文件头和 export default，从 "spr" 引 action、ask。 */
const compose = (name: string, body: string, head = " * @status verified"): string => {
  const file = path.join(composeDir, `${name}.js`);
  fs.writeFileSync(file, `/**\n * @description ${name}\n${head}\n */\nimport { action, ask } from "spr";\nexport default async (params) => {\n${body}\n};\n`);
  return file;
};
syncActionLib(libDir);
fs.writeFileSync(path.join(dir, "echo.js"), `/**\n * @description 回显\n * @status draft\n * @param v 值\n */\nimport { sleep } from "spr";\nexport default async (params) => { await sleep(150); return { v: params.v }; };\n`);
const host = { op: async () => { throw new Error("不该碰页面"); }, end: async () => {}, watchSent: () => {}, takeSent: () => [], takeDialogs: () => [], failureShot: async () => undefined, takeRejected: () => undefined };
// 假的 run 窗口：记下开了哪些、关了哪些
const opened: string[] = [], closed: string[] = [];
let n = 0;
const windows: RunWindows = { open: (label) => { const key = `${label}-${++n}`; opened.push(key); return key; }, close: async (key) => { closed.push(key); }, shotFile: (key) => path.join(root, `${key}-shot`), failureFile: (key) => path.join(root, key) };
const runner = new ActionRunner(host as never, { actionDir, composeDir }, windows);
const plain = (o: Outcome) => { const { runWindow: _w, drafts: _d, sent: _x, dialogs: _g, calls: _c, ...rest } = o; return rest; };

// 每次 run 新开一个窗口，跑完就关；嵌套调用共用这次的窗口
const a = await runner.runAction("echo", { v: "1" });
assert.deepEqual(plain(a), { status: "success", result: { v: "1" } }, "draft 也能直接跑");
assert.equal(a.runWindow, "echo-1"); assert.deepEqual(closed, ["echo-1"], "跑完就关");
assert.deepEqual(a.drafts, [path.join(dir, "echo.js")], "真跑成功的 draft 交给命令层变成 verified");
// @param 带类型：命令行的字符串按类型转好（不转的话 offset + 20 会变成字符串拼接，静默出错）
fs.writeFileSync(path.join(dir, "typed.js"), `/**\n * @description 类型\n * @status verified\n * @param n:number 数\n * @param on?:boolean 开关\n */\nexport default async (params) => ({ sum: params.n + 1, on: params.on });\n`);
assert.deepEqual(plain(await runner.runAction("typed", { n: "20", on: "true" })), { status: "success", result: { sum: 21, on: true } });
const bad = await runner.runAction("typed", { n: "x" });
assert.ok(bad.status === "failure" && /要是数字/.test(bad.error), "转不了就报错");
// export default 写法：返回值就是结果，抛错就是失败（不交回结果的话 run 会挂到超时）
fs.writeFileSync(path.join(dir, "plain.js"), `/**\n * @description 新写法\n * @status verified\n * @param n:number 数\n */\nexport default async (params) => { if (params.n < 0) throw new Error("负数"); return { double: params.n * 2 }; };\n`);
assert.deepEqual(plain(await runner.runAction("plain", { n: "4" })), { status: "success", result: { double: 8 } });
const neg = await runner.runAction("plain", { n: "-1" });
assert.ok(neg.status === "failure" && /负数/.test(neg.error), "export default 里抛错就是失败");
const t0 = Date.now();
const both = await Promise.all([runner.runAction("echo", { v: "a" }), runner.runAction("echo", { v: "b" })]);
assert.deepEqual(both.map((x) => x.status), ["success", "success"]);
assert.notEqual(both[0]!.runWindow, both[1]!.runWindow, "两个 run 各开各的窗口，不沿用");
assert.ok(Date.now() - t0 < 290, "不同的 run 同时跑，不排队");
assert.equal(opened.length, closed.length, "开了几个就关了几个");

// 写不出来的（blocked）：直接拒绝，不执行，不开窗口
fs.writeFileSync(path.join(dir, "never.js"), "/**\n * @description 写不出来\n * @status blocked\n * @note network 无响应体，DOM 读不到\n */\n");
const before = opened.length;
const never = await runner.runAction("never", {});
assert.equal(never.status, "failure"); assert.match(String((never as { error: string }).error), /写不出来的 action.*@note/);
assert.equal(opened.length, before, "拒绝的不开窗口");

// compose：只能 action(名字, 参数)；页面操作被拒绝；compose 里能调用 draft；嵌套调用不另开窗口
compose("one", `const r = await action("echo", { v: "c" }); return r.v;`);
const composed = await runner.runAction("one", {});
assert.deepEqual(plain(composed), { status: "success", result: "c" });
assert.equal(composed.runWindow, opened.at(-1), "compose 里的 action 共用 compose 的窗口");
fs.writeFileSync(path.join(composeDir, "nav.js"), `/**\n * @description 碰页面\n */\nimport { navigate } from "spr";\nexport default async (params) => { await navigate("https://example.com/"); };\n`);
const sdk = await runner.runAction("nav", {});
assert.equal(sdk.status, "failure");
assert.match((sdk as { error: string }).error, /不该碰页面|compose/, "compose 里的页面操作被拒绝");
assert.deepEqual(fs.readdirSync(composeDir).filter((f) => f.startsWith(".")), [], "跑完不留临时文件");

// compose 的参数和 action 一样按 @param 检查；compose 不能调用 compose；@status draft 的 compose 跑通后交给命令层变成 verified
const twice = compose("twice", `const a = await action("echo", { v: params.v ?? "z" }); return a.v + a.v;`, " * @status draft\n * @param v? 值");
const tw = await runner.runAction("twice", { v: "k" });
assert.deepEqual(plain(tw), { status: "success", result: "kk" });
assert.ok(tw.drafts?.includes(twice), "draft 的 compose 跑通也要变成 verified");
compose("outer", `return await action("twice", { v: "q" });`);
const outer = await runner.runAction("outer", {});
assert.ok(outer.status === "failure" && /outer 里调用了 compose twice：compose 只能调用 action/.test(outer.error), "运行时也拒绝 compose 调用 compose");
const unknown = await runner.runAction("twice", { w: "1" });
assert.ok(unknown.status === "failure" && /没有这些参数/.test(unknown.error), "compose 的参数也按 @param 检查");

// @timeout：文件头写多久就是多久（不再有 --timeout）
compose("slow", `await new Promise((r) => setTimeout(r, 3000)); return 1;`, " * @timeout 1");
const slow = await runner.runAction("slow", {});
assert.ok(slow.status === "failure" && /超过 1 秒/.test(slow.error), "@timeout 生效");

// ask：第一次停下交回问题和停下那一刻的代码；恢复时 ask 之前已执行的 action 不再执行（否则写请求会重复发出，点赞两次就是取消），
// 中途改了 compose 文件也照停下时的代码重放
const counter = path.join(root, "count.txt");
fs.writeFileSync(path.join(dir, "count.js"), `/**\n * @description 计数\n * @status verified\n */\nimport * as fs from "node:fs";\nexport default async (params) => { fs.appendFileSync(${JSON.stringify(counter)}, "x"); return fs.readFileSync(${JSON.stringify(counter)}, "utf8").length; };\n`);
const askFile = compose("asker", `const a = await action("count", {}); const pick = await ask("挑一个", [a]); const b = await action("count", {}); return { a, pick, b };`);
const asked = await runner.runAction("asker", {});
if (asked.status !== "ask") throw new Error(`应该停在 ask：${JSON.stringify(asked)}`);
assert.equal(asked.question, "挑一个");
assert.equal(asked.code, fs.readFileSync(askFile, "utf8"), "交回停下那一刻的代码");
compose("asker", `return "改过了";`);
const resumed = await runner.runAction("asker", {}, undefined, { askState: { journal: asked.journal, answers: [{ question: "挑一个", answer: "ok" }] }, code: asked.code });
assert.deepEqual(plain(resumed), { status: "success", result: { a: 1, pick: "ok", b: 2 } }, "用停下时的代码重放");
assert.equal(fs.readFileSync(counter, "utf8"), "xx", "恢复时 ask 之前的 action 没有重跑");

// action 按名字在所有站点目录和 compose 目录里找；找不到的报错里说明去哪里看
const missing = await runner.runAction("nope", {});
assert.equal(missing.status, "failure");
assert.match((missing as { error: string }).error, /nope is not defined/);
// 失败后恢复：journal 带出来；修好文件后已完成的 action 不重跑，失败的 action 用当前文件重新执行，failedAction 指到它
fs.writeFileSync(path.join(root, "count2.txt"), "");
fs.writeFileSync(path.join(dir, "done.js"), `/**\n * @status verified\n */\nimport * as fs from "node:fs";\nexport default async () => { fs.appendFileSync(${JSON.stringify(path.join(root, "count2.txt"))}, "x"); return 1; };\n`);
const brokenFile = path.join(dir, "broken.js");
fs.writeFileSync(brokenFile, `/**\n * @status draft\n */\nexport default async () => { throw new Error("坏了"); };\n`);
compose("fix", `const a = await action("done", {}); const b = await action("broken", {}); return { a, b };`);
const failed = await runner.runAction("fix", {});
if (failed.status !== "failure") throw new Error(`应该失败：${JSON.stringify(failed)}`);
assert.equal(failed.failedAction, "broken", "失败输出指到出错的 action");
assert.equal(failed.journal?.length, 1, "已完成的 action 进 journal");
fs.writeFileSync(brokenFile, `/**\n * @status draft\n */\nexport default async () => 2;\n`);
const fixed = await runner.runAction("fix", {}, undefined, { askState: { journal: failed.journal!, answers: failed.answers ?? [] } });
assert.deepEqual(plain(fixed), { status: "success", result: { a: 1, b: 2 } }, "失败的 action 读当前文件重新执行");
assert.equal(fs.readFileSync(path.join(root, "count2.txt"), "utf8"), "x", "已完成的 action 没有重跑");
// 恢复按内容复用：修 action 时改了调用参数，只有这一次重新执行，其余的照样复用，不因为「和上次不同」整个失败；
// 同样的调用出现多次（循环轮询）按顺序取记下的结果，用完了再真执行
fs.writeFileSync(path.join(root, "count3.txt"), "");
fs.writeFileSync(path.join(dir, "tick.js"), `/**\n * @status verified\n * @param k? 键\n * @param extra? 新加的参数\n */\nimport * as fs from "node:fs";\nexport default async (p) => { fs.appendFileSync(${JSON.stringify(path.join(root, "count3.txt"))}, "x"); return fs.readFileSync(${JSON.stringify(path.join(root, "count3.txt"))}, "utf8").length; };\n`);
fs.writeFileSync(brokenFile, `/**\n * @status draft\n */\nexport default async () => { throw new Error("坏了"); };\n`);
compose("loop", `const a = await action("tick", { k: "a" }); const b = await action("tick", { k: "a" }); const c = await action("tick", { k: "b" }); await action("broken", {}); return { a, b, c };`);
const looped = await runner.runAction("loop", {});
if (looped.status !== "failure") throw new Error(`应该失败：${JSON.stringify(looped)}`);
assert.equal(looped.code, "action-throw", "失败带类别");
fs.writeFileSync(brokenFile, `/**\n * @status draft\n */\nexport default async () => 0;\n`);
compose("loop", `const a = await action("tick", { k: "a" }); const b = await action("tick", { k: "a" }); const c = await action("tick", { k: "b", extra: "1" }); await action("broken", {}); return { a, b, c };`);
const relooped = await runner.runAction("loop", {}, undefined, { askState: { journal: looped.journal!, answers: [] } });
assert.deepEqual(plain(relooped).status, "success", "参数变了的那次重新执行，不报和上次不同");
assert.deepEqual((relooped as { result: unknown }).result, { a: 1, b: 2, c: 4 }, "同样的调用按顺序复用，变了的才重跑");
assert.deepEqual(relooped.calls?.map((c) => c.cached ?? false), [true, true, false, false], "每次调用记下是不是复用的");

// 取消：调用 spr 的进程退出（signal）就中止，不在后台接着跑
compose("forever", `await new Promise((r) => setTimeout(r, 5000)); return 1;`);
const ac = new AbortController();
setTimeout(() => ac.abort(), 100);
const t1 = Date.now();
const cancelled = await runner.runAction("forever", {}, undefined, { signal: ac.signal });
assert.ok(cancelled.status === "failure" && cancelled.code === "cancelled" && Date.now() - t1 < 2000, "取消后立刻结束");

// 报错只留用户文件的帧，第一个用户文件的位置单独给出
const t = trimError("Error: 坏了", "Error: 坏了\n    at Module.default (file:///u/action/x.com/a.js:7:3)\n    at async file:///u/src/run/worker.ts:9:18\n    at MessagePort.<anonymous> (file:///u/lib/index.js:14:29)", ["/u/action/"]);
assert.equal(t.text, "Error: 坏了\nat Module.default (file:///u/action/x.com/a.js:7:3)");
assert.equal(t.at, "/u/action/x.com/a.js:7");

const gone = await runner.runAction("nobody", {});
assert.ok(gone.status === "failure" && /nobody is not defined/.test(gone.error), "运行时也报 is not defined");

console.log("runner selfcheck ok");
