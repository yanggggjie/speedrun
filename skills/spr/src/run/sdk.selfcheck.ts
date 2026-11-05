// debug 的页面操作在 action 的 SDK 里都要有：两边能力不一致时，debug 学到的做法写不进 action。
import assert from "node:assert/strict";
import { ACTIONS } from "../commands/debug.ts";

const sdk = (await import("../action-lib/index.js" as string)) as Record<string, unknown>;

/** debug 的 computer action → SDK 函数（只有名字不同的写在这里；wait 就是 sleep，zoom 是带 region 的 screenshot）。 */
const SAME: Record<string, string> = { left_click: "click", right_click: "click", double_click: "click", triple_click: "click", left_click_drag: "drag", zoom: "screenshot", wait: "sleep" };
for (const a of [...ACTIONS, "form_input", "navigate", "find", "read_page", "get_page_text"]) {
  assert.equal(typeof sdk[SAME[a] ?? a], "function", `debug 的 ${a} 在 SDK 里没有对应的函数`);
}
console.log("sdk.selfcheck ok");
