// Stop hook：本轮跑过 task 就必须在最终回复里引用回执；没跑过、引用了、已经拦过一次都放行。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { check } from "./stop-receipt.mjs";

const user = (content) => JSON.stringify({ type: "user", message: { role: "user", content } });
const result = (text) => user([{ type: "tool_result", tool_use_id: "t", content: [{ type: "text", text }] }]);
const assistant = (...blocks) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: blocks } });
const text = (t) => ({ type: "text", text: t });
const run = '{\n  "mode": "执行",\n  "receipt": "RC-0a1b2c3d",\n  "status": "success"\n}';

// 没跑过 tabbot run：不管
assert.equal(check([user("你好"), assistant(text("你好"))].join("\n")).block, false);
// 跑过但最终回复没引用：拦
const missing = check([user("取数"), assistant({ type: "tool_use", id: "t", name: "Bash", input: {} }), result(run), assistant(text("结果是 42"))].join("\n"));
assert.equal(missing.block, true); assert.match(missing.reason, /RC-0a1b2c3d/);
// 引用了：放行
assert.equal(check([user("取数"), result(run), assistant(text("结果是 42。回执：RC-0a1b2c3d"))].join("\n")).block, false);
// 只看本轮：上一轮的回执不算
assert.equal(check([user("上一轮"), result(run), assistant(text("好 RC-0a1b2c3d")), user("这一轮"), assistant(text("没有跑 task"))].join("\n")).block, false);
// 引用的回执不是本轮工具输出里出现过的：拦
assert.equal(check([user("取数"), result(run), assistant(text("结果 RC-ffffffff"))].join("\n")).block, true);
// 最终回复还没写进 transcript：没法判断，放行
assert.equal(check([user("取数"), result(run)].join("\n")).block, false);
// 开过学习会话 / 用过 debug，却没有任何回执（没 run 通过，也没 close --blocked）：拦
const bash = (command) => ({ type: "tool_use", id: "t", name: "Bash", input: { command } });
const noProduct = check([user("看聊天"), assistant(bash("tabbot learn claude-chat --site claude.ai --find 消息")), result("学习会话已开"), assistant(bash("~/.tabbot/bin/tabbot debug screenshot")), result("✓ 截图"), assistant(text("聊了这些……"))].join("\n"));
assert.equal(noProduct.block, true); assert.match(noProduct.reason, /close --blocked/);
// 学习会话有产物（run 的回执，或 blocked 关闭的回执）：不因为没产物拦
const blocked = '{\n  "mode": "学不会",\n  "receipt": "RC-0a1b2c3d",\n  "status": "blocked"\n}';
assert.equal(check([user("看聊天"), assistant(bash("tabbot debug close --blocked 读不了")), result(blocked), assistant(text("学不会，原因……回执 RC-0a1b2c3d"))].join("\n")).block, false);
// 没用 learn / debug、也没回执（例如命令名只是文字里提到）：不管
assert.equal(check([user("说明"), assistant(bash("echo tabbot-learn-notes")), result("ok"), assistant(text("好"))].join("\n")).block, false);
// 命令行：已经拦过一次（stop_hook_active）不再拦；没拦过就输出 block
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tb-hook-"));
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
const file = path.join(dir, "t.jsonl");
fs.writeFileSync(file, [user("取数"), result(run), assistant(text("结果是 42"))].join("\n"));
const hook = path.join(path.dirname(fileURLToPath(import.meta.url)), "stop-receipt.mjs");
const call = (input) => execFileSync("node", [hook], { input: JSON.stringify(input), encoding: "utf8" });
assert.equal(call({ transcript_path: file, stop_hook_active: true }), "");
assert.equal(JSON.parse(call({ transcript_path: file })).decision, "block");
console.log("stop-receipt.selfcheck ok");
