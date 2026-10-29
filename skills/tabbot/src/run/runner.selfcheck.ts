// task 运行锁：顺序跑、并发排队、compose 只能组合 task、真跑成功自动晋升。用最小的假 host，task 不碰页面。
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TaskRunner } from "./runner.ts";
import { blockTask, syncTaskLib } from "./tasks.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tc-runner-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
const sitesDir = path.join(root, "sites"), libDir = path.join(root, "lib"), runDir = path.join(root, "run");
const taskDir = path.join(sitesDir, "example.com", "tasks");
fs.mkdirSync(taskDir, { recursive: true });
syncTaskLib(libDir);
fs.writeFileSync(path.join(taskDir, "echo.js"), `/**\n * @summary 回显\n * @status: draft\n * @param v 值\n */\nimport { tabbot, sleep } from "../../../lib/index.js";\nawait tabbot.run(async () => { await sleep(150); return { v: tabbot.params.v }; });\n`);
const host = { op: async () => { throw new Error("不该碰页面"); }, end: async () => {} };
const runner = new TaskRunner(host as never, { sitesDir, libDir, runDir });

// 学不会的 task（blocked）：run 直接拒绝，不执行；原因写在文件头 @note
blockTask(path.join(taskDir, "never.js"), "network 无响应体，DOM 读不到");
const never = await runner.runTask("never", {});
assert.equal(never.status, "failure"); assert.match(String(never.error), /学不会的记录.*@note/);
fs.writeFileSync(path.join(taskDir, "half.js"), "/**\n * @summary 做了一半\n * @status: draft\n * @endpoint GET /a\n */\nawait 1;\n");
blockTask(path.join(taskDir, "half.js"), "试过了");
const half = fs.readFileSync(path.join(taskDir, "half.js"), "utf8");
assert.match(half, /@status: blocked/); assert.ok(!/@status: draft/.test(half), "原来的状态被替换"); assert.match(half, /@endpoint GET \/a/, "其他标签和代码保留"); assert.match(half, /await 1;/);

const a = await runner.runTask("echo", { v: "1" });
assert.deepEqual(a, { status: "success", result: { v: "1" } });
assert.match(fs.readFileSync(path.join(taskDir, "echo.js"), "utf8"), /@status: verified/, "真跑成功自动晋升");
const b = await runner.runTask("echo", { v: "2" }); // 上一个结束后锁必须释放
assert.equal(b.status, "success");
const t0 = Date.now();
const both = await Promise.all([runner.runTask("echo", { v: "a" }), runner.runTask("echo", { v: "b" })]); // 同一个窗口并发：排队，不丢、不超时
assert.deepEqual(both.map((x) => x.status), ["success", "success"]);
assert.ok(Date.now() - t0 >= 300, "排队执行，不是并行");
const parallel = await Promise.all([runner.runTask("echo", { v: "x" }, undefined, { key: "debug-1" }), runner.runTask("echo", { v: "y" }, undefined, { key: "debug-2" })]);
assert.deepEqual(parallel.map((x) => x.status), ["success", "success"], "不同窗口可以同时跑");

const composed = await runner.runCompose(`const r = await task("echo", { v: "c" }); return r.v;`);
assert.deepEqual(composed, { status: "success", result: "c" });
const sdk = await runner.runCompose(`const m = await import(${JSON.stringify(path.join(libDir, "index.js"))}); await m.goto(null, "https://example.com/");`);
assert.equal(sdk.status, "failure");
assert.match((sdk as { error: string }).error, /不该碰页面|compose/, "compose 里的页面操作被拒绝");


// task 按名字在所有站点的 tasks/ 里找；找不到的报错里说明去哪里看
const missing = await runner.runTask("nope", {});
assert.equal(missing.status, "failure");
assert.match((missing as { error: string }).error, /task 不存在/);
console.log("runner selfcheck ok");
