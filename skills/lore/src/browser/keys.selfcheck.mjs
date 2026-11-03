// 键名 → CDP 按键事件（chrome-extension/keys.js，扩展和这里共用同一份源码）。键映射错了会静默打错字、快捷键不生效，所以守住：
// Enter 带 "\r"（表单提交、keypress 靠它）、cmd+a 不输入 a 且在 mac 上带 selectAll、上档符号按 shift、中文只插入文字、写错的键被拒。
import assert from "node:assert/strict";
import { keySequence, parseKeys, typeSteps, charKey } from "../chrome-extension/keys.js";

const [enterDown, enterUp] = keySequence("Enter");
assert.equal(enterDown.type, "keyDown");
assert.equal(enterDown.text, "\r", "Enter 带文字 \\r，页面的回车提交才会触发");
assert.equal(enterDown.windowsVirtualKeyCode, 13);
assert.equal(enterUp.type, "keyUp");

const [selDown] = keySequence("cmd+a", 1, true);
assert.equal(selDown.type, "rawKeyDown", "按着 cmd 不产生文字");
assert.equal(selDown.text, undefined);
assert.equal(selDown.modifiers, 4);
assert.deepEqual(selDown.commands, ["selectAll"], "mac 上 cmd+a 要带编辑命令，否则不会全选");
assert.equal(keySequence("ctrl+a", 1, false)[0].commands, undefined, "非 mac 的 ctrl+a 交给页面和浏览器自己处理");
assert.deepEqual(keySequence("shift+cmd+z", 1, true)[0].commands, ["redo"]);

const bang = keySequence("!")[0];
assert.equal(bang.code, "Digit1");
assert.equal(bang.modifiers, 8, "上档符号按着 shift");
assert.equal(bang.text, "!");
assert.deepEqual(charKey("A"), { code: "KeyA", vk: 65, shift: true });

assert.equal(keySequence("Backspace Backspace", 3).length, 12, "多个键、重复次数");
assert.equal(keySequence("Tab")[0].type, "rawKeyDown");

assert.throws(() => parseKeys("hyper+a"), /不认识的修饰键/);
assert.throws(() => parseKeys("Entr"), /不认识的按键/);

// 输入文字：ASCII 每个字符 rawKeyDown → insertText → keyUp（文字只插入一次），中文只 insertText
const steps = typeSteps("a你");
assert.deepEqual(steps.map((s) => s.params.type ?? `insert:${s.params.text}`), ["rawKeyDown", "insert:a", "keyUp", "insert:你"]);
assert.equal(steps.filter((s) => s.method === "Input.insertText").map((s) => s.params.text).join(""), "a你", "文字原样插入，不重复");

console.log("keys.selfcheck ok");
