// action 运行：每次 run 新开一个 run 窗口、跑完就关、不沿用上次的（不同的 run 各开各的、不排队）；draft 能直接跑，真跑成功才算要变成 verified 的；
// 学不会的拒绝；compose 只能调用 action；存下来的 compose 按名字能再跑；lore.ask 恢复时不重跑之前的 action。用最小的假 host，action 不碰页面。
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ActionRunner, looksLoggedOut, type Outcome, type RunWindows } from "./runner.ts";
import { saveComposed, syncActionLib } from "./actions.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "lore-runner-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
const sitesDir = path.join(root, "sites"), libDir = path.join(root, "lib"), composeDir = path.join(root, "compose"), tmpDir = path.join(root, "session");
const dir = path.join(sitesDir, "example.com", "actions");
fs.mkdirSync(dir, { recursive: true });
syncActionLib(libDir);
fs.writeFileSync(path.join(dir, "echo.js"), `/**\n * @summary 回显\n * @status draft\n * @param v 值\n */\nimport { lore, sleep } from "../../../lib/index.js";\nexport default async () => { await sleep(150); return { v: lore.params.v }; };\n`);
const host = { op: async () => { throw new Error("不该碰页面"); }, end: async () => {}, watchWrites: () => {}, takeWrites: () => [], failureShot: async () => undefined };
// 假的 run 窗口：记下开了哪些、关了哪些
const opened: string[] = [], closed: string[] = [];
let n = 0;
const windows: RunWindows = { open: (label) => { const key = `${label}-${++n}`; opened.push(key); return key; }, close: async (key) => { closed.push(key); }, failureFile: (key) => path.join(root, key) };
const runner = new ActionRunner(host as never, { sitesDir, libDir, composeDir, tmpDir }, windows);
const plain = (o: Outcome) => { const { runWindow: _w, drafts: _d, writes: _x, ...rest } = o; return rest; };

// 每次 run 新开一个窗口，跑完就关；嵌套调用共用这次的窗口
const a = await runner.runAction("echo", { v: "1" });
assert.deepEqual(plain(a), { status: "success", result: { v: "1" } }, "draft 也能直接跑");
assert.equal(a.runWindow, "echo-1"); assert.deepEqual(closed, ["echo-1"], "跑完就关");
assert.deepEqual(a.drafts, [path.join(dir, "echo.js")], "真跑成功的 draft 交给命令层变成 verified");
// @param 带类型：命令行的字符串按类型转好（不转的话 offset + 20 会变成字符串拼接，静默出错）
fs.writeFileSync(path.join(dir, "typed.js"), `/**\n * @summary 类型\n * @status verified\n * @param n:number 数\n * @param on?:boolean 开关\n */\nimport { lore } from "../../../lib/index.js";\nexport default async () => ({ sum: lore.params.n + 1, on: lore.params.on });\n`);
assert.deepEqual(plain(await runner.runAction("typed", { n: "20", on: "true" })), { status: "success", result: { sum: 21, on: true } });
const bad = await runner.runAction("typed", { n: "x" });
assert.ok(bad.status === "failure" && /要是数字/.test(bad.error), "转不了就报错");
// export default 写法：返回值就是结果，抛错就是失败（不交回结果的话 run 会挂到超时）
fs.writeFileSync(path.join(dir, "plain.js"), `/**\n * @summary 新写法\n * @status verified\n * @param n:number 数\n */\nimport { lore } from "../../../lib/index.js";\nexport default async () => { if (lore.params.n < 0) throw new Error("负数"); return { double: lore.params.n * 2 }; };\n`);
assert.deepEqual(plain(await runner.runAction("plain", { n: "4" })), { status: "success", result: { double: 8 } });
const neg = await runner.runAction("plain", { n: "-1" });
assert.ok(neg.status === "failure" && /负数/.test(neg.error), "export default 里抛错就是失败");
const t0 = Date.now();
const both = await Promise.all([runner.runAction("echo", { v: "a" }), runner.runAction("echo", { v: "b" })]);
assert.deepEqual(both.map((x) => x.status), ["success", "success"]);
assert.notEqual(both[0]!.runWindow, both[1]!.runWindow, "两个 run 各开各的窗口，不沿用");
assert.ok(Date.now() - t0 < 290, "不同的 run 同时跑，不排队");
assert.equal(opened.length, closed.length, "开了几个就关了几个");

// 学不会的（blocked）：直接拒绝，不执行，不开窗口
fs.writeFileSync(path.join(dir, "never.js"), "/**\n * @summary 学不会\n * @status blocked\n * @note network 无响应体，DOM 读不到\n */\n");
const before = opened.length;
const never = await runner.runAction("never", {});
assert.equal(never.status, "failure"); assert.match(String((never as { error: string }).error), /学不会的 action.*@note/);
assert.equal(opened.length, before, "拒绝的不开窗口");

// compose：只能 action(名字, 参数)；页面操作被拒绝；compose 里能调用 draft；嵌套调用不另开窗口
const composed = await runner.runCompose(`const r = await action("echo", { v: "c" }); return r.v;`);
assert.deepEqual(plain(composed), { status: "success", result: "c" });
assert.equal(composed.runWindow, opened.at(-1), "compose 里的 action 共用 compose 的窗口");
const sdk = await runner.runCompose(`const m = await import(${JSON.stringify(path.join(libDir, "index.js"))}); await m.goto(null, "https://example.com/");`);
assert.equal(sdk.status, "failure");
assert.match((sdk as { error: string }).error, /不该碰页面|compose/, "compose 里的页面操作被拒绝");

// 存下来的 compose 本身就是 action：按名字跑（站点目录或跨站点目录），参数照样传，compose 里的 compose 也能调用
saveComposed(path.join(composeDir, "twice.js"), `const a = await action("echo", { v: lore.params.v ?? "z" }); return a.v + a.v;`, "回显两遍");
assert.match(fs.readFileSync(path.join(composeDir, "twice.js"), "utf8"), /@compose echo/);
assert.deepEqual(plain(await runner.runAction("twice", { v: "k" })), { status: "success", result: "kk" });
assert.deepEqual(plain(await runner.runCompose(`return await action("twice", { v: "q" });`)), { status: "success", result: "qq" }, "compose 可以调用 compose");

// lore.ask：第一次停下交回问题；恢复时 ask 之前已执行的 action 不再执行（否则写请求会重复发出，点赞两次就是取消）
const counter = path.join(root, "count.txt");
fs.writeFileSync(path.join(dir, "count.js"), `/**\n * @summary 计数\n * @status verified\n */\nimport * as fs from "node:fs";\nimport { lore } from "../../../lib/index.js";\nexport default async () => { fs.appendFileSync(${JSON.stringify(counter)}, "x"); return fs.readFileSync(${JSON.stringify(counter)}, "utf8").length; };\n`);
const askCode = `const a = await action("count", {}); const pick = await lore.ask("挑一个", [a]); const b = await action("count", {}); return { a, pick, b };`;
const asked = await runner.runCompose(askCode);
if (asked.status !== "ask") throw new Error(`应该停在 ask：${JSON.stringify(asked)}`);
assert.equal(asked.question, "挑一个");
const resumed = await runner.runCompose(askCode, undefined, {}, { journal: asked.journal, answers: ["ok"] });
assert.deepEqual(plain(resumed), { status: "success", result: { a: 1, pick: "ok", b: 2 } });
assert.equal(fs.readFileSync(counter, "utf8"), "xx", "恢复时 ask 之前的 action 没有重跑");

// action 按名字在所有站点的 actions/ 和跨站点目录里找；找不到的报错里说明去哪里看
const missing = await runner.runAction("nope", {});
assert.equal(missing.status, "failure");
assert.match((missing as { error: string }).error, /action 不存在/);
// 登录失效判断：登录页 URL 或 401/403 算；普通业务错误、普通页面不算
assert.equal(looksLoggedOut("x", "https://passport.example.com/login?next=/"), true);
assert.equal(looksLoggedOut("请求返回 401", "https://example.com/home"), true);
assert.equal(looksLoggedOut("元素没找到", "https://example.com/author/list"), false);
assert.equal(looksLoggedOut("元素没找到", undefined), false);
console.log("runner selfcheck ok");
