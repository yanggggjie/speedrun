// 执行前检查：缺的 action 一次报全，否则前面的 action 已经发出去，才发现后面的不存在；注释和字符串里的文字不能算调用，否则一直报缺。
// 参数源码原样取出（字符串里的逗号、括号不能截断它），名字不是字面量的只列出、不拦；compose 调用 compose 要拦。
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { actionCalls, checkCompose, missingText } from "./link.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "speedrun-link-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));
const actionDir = path.join(root, "action"), composeDir = path.join(root, "compose");
const actions = path.join(actionDir, "x.com");
fs.mkdirSync(actions, { recursive: true });
fs.mkdirSync(composeDir, { recursive: true });
const compose = (name: string, code: string): void => fs.writeFileSync(path.join(composeDir, `${name}.js`), `/**\n * @description ${name}\n */\n${code}\n`);
const check = (name: string) => checkCompose(name, { actionDir, composeDir });

assert.deepEqual(actionCalls(`
  // action("注释")
  /* action("块注释") */
  const s = 'action("字符串")';
  const t = \`action("模板") \${action("里面")}\`;
  obj.action("方法");
  await action("a", { q });
  await action( 'b' );
  await action(\`c\`);
`).map((c) => c.name), ["a", "b", "c"]);
assert.deepEqual(actionCalls(`action(name); action(\`x-\${n}\`);`).map((c) => [c.name, c.text]), [[undefined, "name"], [undefined, "`x-${n}`"]]);

// 参数源码：普通对象、字符串里有逗号和括号、没有第二个参数、多行、嵌套括号
const args = (code: string): string[] => actionCalls(code).map((c) => c.args);
assert.deepEqual(args(`action("a", { q, n })`), ["{ q, n }"]);
assert.deepEqual(args(`action("a", { id: x.id, text: "a,b)" })`), [`{ id: x.id, text: "a,b)" }`]);
assert.deepEqual(args(`action("a")`), [""]);
assert.deepEqual(args(`action("a", {\n  page,\n  size: 20,\n})`), ["{ page, size: 20 }"]);
assert.deepEqual(args(`action("a", { ids: list.map((x) => x.id) })`), ["{ ids: list.map((x) => x.id) }"]);
assert.ok(args(`action("a", { ${"k".repeat(80)}: 1 })`)[0]!.endsWith("…"), "太长截断");

fs.writeFileSync(path.join(actions, "ok.js"), "/**\n * @status verified\n */\n");
fs.writeFileSync(path.join(actions, "stuck.js"), "/**\n * @status blocked\n * @note 读不到\n */\n");
compose("flow", `await action("ok"); await action("gone1", { id }); await action("gone2"); await action("gone1", { id }); await action("gone1", { id: 2 });`);
const flow = check("flow");
assert.deepEqual(flow.missing, [{ name: "gone1", calls: ["gone1({ id })", "gone1({ id: 2 })"] }, { name: "gone2", calls: ["gone2()"] }], "报全，同名的每处调用都记、去重");
assert.equal(missingText(flow.missing), "gone1({ id }) 等 2 处调用、gone2()");
assert.deepEqual(flow.errors, []);
compose("hard", `await action("stuck");`);
assert.deepEqual(check("hard").blocked, [{ name: "stuck", note: "读不到" }]);
compose("dyn", `await action(pick, { id }); await action("ok");`);
assert.deepEqual(check("dyn"), { missing: [], blocked: [], errors: [], dynamic: ["pick"] }, "名字不是字面量：只列出，不拦");
compose("inner", `await action("ok");`);
compose("outer", `await action("inner");`);
assert.match(check("outer").errors[0]!, /outer 里调用了 compose inner：compose 只能调用 action/, "compose 调用 compose 要拦");

console.log("link.selfcheck ok");
