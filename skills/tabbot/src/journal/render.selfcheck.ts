import assert from "node:assert/strict";
import { renderSnapshot } from "./render.ts";

const text = renderSnapshot({
  url: "https://example.com/", title: "示例", headings: ["标题一"], interactiveTotal: 10, interactiveVisible: 4, inViewShown: 2,
  items: [{ ref: "e1", t: "button", n: "提交" }, { ref: "e2", t: "input", k: "text", n: "搜索", v: "abc" }],
}, 7);
assert.match(text, /^tab7 https:\/\/example\.com\/ "示例"/);
assert.match(text, /@e1 button "提交"/);
assert.match(text, /@e2 input\[text\] "搜索" value="abc"/);
assert.match(text, /只列出视图内/);

console.log("render.selfcheck ok");
