// 执行前检查：缺的 action 一次报全，否则前面的 action 已经发出去，才发现后面的不存在；注释和字符串里的文字不能算调用，否则一直报缺。
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { actionCalls, checkCompose } from "./link.ts";

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

fs.writeFileSync(path.join(actions, "ok.js"), "/**\n * @status verified\n */\n");
fs.writeFileSync(path.join(actions, "stuck.js"), "/**\n * @status blocked\n * @note 读不到\n */\n");
compose("inner", `await action("ok"); await action("gone2");`);
compose("flow", `await action("ok"); await action("gone1"); await action("inner"); await action("gone1");`);
assert.deepEqual(check("flow"), { missing: ["gone1", "gone2"], blocked: [], errors: [] }, "递归报全，不重复");
compose("hard", `await action("stuck");`);
assert.deepEqual(check("hard").blocked, [{ name: "stuck", note: "读不到" }]);
compose("dyn", `await action(pick);`);
assert.match(check("dyn").errors[0]!, /名字要写成字面量/);
compose("loop1", `await action("loop2");`);
compose("loop2", `await action("loop1");`);
assert.match(check("loop1").errors[0]!, /循环调用：loop1 → loop2 → loop1/);

console.log("link.selfcheck ok");
