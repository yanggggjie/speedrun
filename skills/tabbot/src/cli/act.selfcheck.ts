import assert from "node:assert/strict";
import { parseAct, parseReplayArgs } from "./journal.ts";

const ok = (args: string[]) => { const r = parseAct(args); assert.ok("cmd" in r, JSON.stringify(r)); return r.cmd; };
const bad = (args: string[]) => { const r = parseAct(args); assert.ok("error" in r, JSON.stringify(r)); return r.error; };

assert.deepEqual(ok(["click", "@e12"]), { kind: "click", ref: "@e12" });
assert.deepEqual(ok(["click", "e12"]), { kind: "click", ref: "@e12" }, "@ 可以省略");
assert.deepEqual(ok(["fill", "@e5", "你好", "世界"]), { kind: "fill", ref: "@e5", text: "你好 世界" }, "文字里的空格保留（没加引号时多个词拼起来）");
assert.deepEqual(ok(["fill", "@e5", ""]), { kind: "fill", ref: "@e5", text: "" }, "可以清空");
assert.deepEqual(ok(["select", "@e9", "香蕉"]), { kind: "select", ref: "@e9", text: "香蕉" });
assert.deepEqual(ok(["check", "@e3"]), { kind: "check", ref: "@e3", checked: true });
assert.deepEqual(ok(["check", "@e3", "--off"]), { kind: "check", ref: "@e3", checked: false });
assert.deepEqual(ok(["press", "Enter"]), { kind: "press", key: "Enter" });
assert.deepEqual(ok(["press", "Ctrl+K", "@e5"]), { kind: "press", key: "Ctrl+K", ref: "@e5" });
assert.deepEqual(ok(["scroll", "down"]), { kind: "scroll", dy: 600 });
assert.deepEqual(ok(["scroll", "up", "200"]), { kind: "scroll", dy: -200 });
assert.deepEqual(ok(["scroll", "bottom"]), { kind: "scroll", to: "bottom" });
assert.deepEqual(ok(["scroll", "down", "300", "@e8"]), { kind: "scroll", dy: 300, ref: "@e8" });
assert.deepEqual(ok(["goto", "example.com/a?b=1"]), { kind: "goto", url: "https://example.com/a?b=1" });
assert.deepEqual(ok(["goto", "http://localhost:3000"]), { kind: "goto", url: "http://localhost:3000/" });

assert.match(bad(["click"]), /需要元素引用/);
assert.match(bad(["click", "按钮"]), /需要元素引用/);
assert.match(bad(["fill", "@e5"]), /用法：tabbot act fill/);
assert.match(bad(["press"]), /用法：tabbot act press/);
assert.match(bad(["press", "Enter", "abc"]), /元素引用/);
assert.match(bad(["scroll", "sideways"]), /用法：tabbot act scroll/);
assert.match(bad(["scroll", "down", "很多"]), /数字/);
assert.match(bad(["goto"]), /用法：tabbot act goto/);
assert.match(bad(["goto", "javascript:alert(1)"]), /不是有效的网址/);
assert.match(bad(["goto", "file:///etc/passwd"]), /不是有效的网址/, "只允许 http / https");
assert.match(bad(["dance"]), /用法：tabbot act click/);
assert.match(bad([]), /用法：tabbot act click/);

// replay 参数：编号、可重复的 --set、--tab、--yes
const rp = (args: string[]) => { const r = parseReplayArgs(args); assert.ok(!("error" in r), JSON.stringify(r)); return r; };
assert.deepEqual(rp(["210"]), { seq: 210, sets: [], yes: false });
assert.deepEqual(rp(["#210", "--set", "page=2", "--set=body.filter.on=false", "--tab", "5", "--yes"]), { seq: 210, sets: ["page=2", "body.filter.on=false"], tabId: 5, yes: true });
assert.deepEqual(rp(["--set", "q=a b", "7"]), { seq: 7, sets: ["q=a b"], yes: false }, "编号可以放在后面");
for (const [args, re] of [[[], /用法：tabbot replay/], [["abc"], /请求编号要是整数/], [["1", "2"], /多余的参数/], [["1", "--set"], /缺少值/], [["1", "--tab", "x"], /非负整数/], [["1", "--wat"], /不认识的参数/]] as [string[], RegExp][]) {
  const r = parseReplayArgs(args); assert.ok("error" in r && re.test(r.error), JSON.stringify([args, r]));
}

console.log("act cli selfcheck ok");
