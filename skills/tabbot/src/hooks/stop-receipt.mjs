#!/usr/bin/env node
// Claude Code 的 Stop hook：本轮如果跑过 tabbot run / compose，最终回复必须引用其中一个回执（RC-xxxxxxxx），
// 证明用户拿到的结果来自 task，而不是来自探索时看到的东西。没引用就拦一次，让 agent 补上。
// 只看本轮（最后一条用户消息之后）工具输出里真实出现过的回执；没跑过 tabbot run 的轮次不管。
// 注册方法见 ARCHITECTURE.md：settings.json 的 hooks.Stop 里加 `node ~/.tabbot/src/hooks/stop-receipt.mjs`。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const RECEIPT = /"receipt":\s*"(RC-[0-9a-f]{8})"/g;

const textOf = (content) => (typeof content === "string" ? content : Array.isArray(content) ? content.map((b) => (b && typeof b.text === "string" ? b.text : "")).join("\n") : "");
// 真正的用户消息：字符串，或带 text 块；只有 tool_result 的不算
const isUserText = (content) => typeof content === "string" || (Array.isArray(content) && content.some((b) => b && b.type === "text"));

const LEARNING = /(?:^|[\s/;&|])tabbot\s+(?:learn|debug)\b/;
/** 本轮有没有跑过 tabbot learn / debug（assistant 的 Bash 调用）。 */
function usedLearning(turn) {
  for (const r of turn) {
    if (r.type !== "assistant" || !Array.isArray(r.message?.content)) continue;
    for (const b of r.message.content) if (b?.type === "tool_use" && typeof b.input?.command === "string" && LEARNING.test(b.input.command)) return true;
  }
  return false;
}

/** 返回 { block: false } 或 { block: true, reason }。transcript 是 jsonl 文本。 */
export function check(transcript) {
  const rows = [];
  for (const line of String(transcript).split("\n")) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* 坏行跳过 */ }
  }
  let start = -1;
  rows.forEach((r, i) => { if (r.type === "user" && isUserText(r.message?.content)) start = i; });
  const turn = rows.slice(start + 1);
  const receipts = new Set();
  for (const r of turn) {
    if (r.type !== "user" || !Array.isArray(r.message?.content)) continue;
    for (const b of r.message.content) {
      if (b?.type !== "tool_result") continue;
      for (const m of textOf(b.content).matchAll(RECEIPT)) receipts.add(m[1]);
    }
  }
  // 开过学习会话或用过 debug，却没有任何回执：会话没有产物（task 没 run 通过，也没有 close --blocked）
  if (receipts.size === 0) {
    if (usedLearning(turn)) return { block: true, reason: "本轮用了 tabbot learn / debug，但没有回执：学习会话必须有产物。要么把 task 写好并 tabbot run <task 名> --window <会话号> 跑通，要么确认学不会：tabbot debug close --blocked \"原因和证据\"。不要在没有产物时直接交付。" };
    return { block: false };
  }
  // 最后一条工具结果之后的 assistant 文字就是最终回复
  let lastResult = -1;
  turn.forEach((r, i) => { if (r.type === "user") lastResult = i; });
  const finalText = turn.slice(lastResult + 1).filter((r) => r.type === "assistant").map((r) => textOf((r.message?.content ?? []).filter((b) => b?.type === "text"))).join("\n");
  if (!finalText.trim()) return { block: false }; // 最终回复还没写进 transcript，没法判断
  if ([...receipts].some((id) => finalText.includes(id))) return { block: false };
  return { block: true, reason: `本轮用 tabbot run / compose 拿到了结果，但最终回复没有引用回执。请在回复里写出一个回执（本轮有：${[...receipts].join("、")}），用户的结果必须来自 task 的返回值。` };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = {};
  try { input = JSON.parse(readFileSync(0, "utf8")); } catch { /* 没有输入就放行 */ }
  if (input.stop_hook_active || !input.transcript_path) process.exit(0); // 已经拦过一次，不再拦
  let result = { block: false };
  try { result = check(readFileSync(input.transcript_path, "utf8")); } catch { /* 读不了 transcript 就放行 */ }
  if (result.block) process.stdout.write(JSON.stringify({ decision: "block", reason: result.reason }));
}
