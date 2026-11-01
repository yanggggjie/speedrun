#!/usr/bin/env node
// Claude Code 的 Stop hook：本轮如果跑过 tabbot run，最终回复必须引用其中一个回执（RC-xxxxxxxx），
// 证明用户拿到的结果来自 action，而不是来自探索时看到的东西。没引用就拦一次，让 agent 补上。
// 只看本轮（最后一条用户消息之后）工具输出里真实出现过的回执；没跑过 tabbot run 的轮次不管。
// 组合停在 tabbot.ask（输出里有 "resume": "AS-…"）而本轮没有 --resume 恢复，也拦一次。
// 注册方法见 ARCHITECTURE.md：settings.json 的 hooks.Stop 里加 `node ~/.tabbot/src/hooks/stop-receipt.mjs`。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const RECEIPT = /"receipt":\s*"(RC-[0-9a-f]{8})"/g;
const ASK = /"resume":\s*"(AS-[0-9a-f]{8})"/g;
const RESUMED = /--resume[\s=]+['"]?(AS-[0-9a-f]{8})/g;

const textOf = (content) => (typeof content === "string" ? content : Array.isArray(content) ? content.map((b) => (b && typeof b.text === "string" ? b.text : "")).join("\n") : "");
// 真正的用户消息：字符串，或带 text 块；只有 tool_result 的不算
const isUserText = (content) => typeof content === "string" || (Array.isArray(content) && content.some((b) => b && b.type === "text"));

const LEARNING = /(?:^|[\s/;&|])tabbot\s+(?:learn|debug)\b/;
/** 本轮有没有跑过 tabbot learn（旧版本的 debug 也算；assistant 的 Bash 调用）。 */
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
  // 组合停在 tabbot.ask，本轮却没有用 --resume 恢复：结果还没出来
  const asked = new Set(), resumed = new Set();
  for (const r of turn) {
    if (!Array.isArray(r.message?.content)) continue;
    for (const b of r.message.content) {
      if (r.type === "user" && b?.type === "tool_result") for (const m of textOf(b.content).matchAll(ASK)) asked.add(m[1]);
      if (r.type === "assistant" && b?.type === "tool_use" && typeof b.input?.command === "string") for (const m of b.input.command.matchAll(RESUMED)) resumed.add(m[1]);
    }
  }
  const open = [...asked].filter((id) => !resumed.has(id));
  if (open.length) return { block: true, reason: `本轮有组合停在 tabbot.ask 还没恢复（${open.join("、")}）：自己判断后 tabbot run --resume <编号> --answer '<json>' 拿到最终结果；确实要用户来判断，就在回复里写明在等用户的什么回答。` };
  // 开过学习窗口，却没有任何回执：结果没有来自 tabbot run
  if (receipts.size === 0) {
    if (usedLearning(turn)) return { block: true, reason: "本轮用了 tabbot learn，但没有回执：用户的结果必须来自 tabbot run。要么把学到的 action 用 tabbot run（或 run --compose）跑一次拿结果并引用回执；要么学不会时把 action 文件头改成 @status blocked、@note 写原因，在回复里说明卡在哪。" };
    return { block: false };
  }
  // 最后一条工具结果之后的 assistant 文字就是最终回复
  let lastResult = -1;
  turn.forEach((r, i) => { if (r.type === "user") lastResult = i; });
  const finalText = turn.slice(lastResult + 1).filter((r) => r.type === "assistant").map((r) => textOf((r.message?.content ?? []).filter((b) => b?.type === "text"))).join("\n");
  if (!finalText.trim()) return { block: false }; // 最终回复还没写进 transcript，没法判断
  if ([...receipts].some((id) => finalText.includes(id))) return { block: false };
  return { block: true, reason: `本轮用 tabbot run 拿到了结果，但最终回复没有引用回执。请在回复里写出一个回执（本轮有：${[...receipts].join("、")}），用户的结果必须来自 action 的返回值。` };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = {};
  try { input = JSON.parse(readFileSync(0, "utf8")); } catch { /* 没有输入就放行 */ }
  if (input.stop_hook_active || !input.transcript_path) process.exit(0); // 已经拦过一次，不再拦
  let result = { block: false };
  try { result = check(readFileSync(input.transcript_path, "utf8")); } catch { /* 读不了 transcript 就放行 */ }
  if (result.block) process.stdout.write(JSON.stringify({ decision: "block", reason: result.reason }));
}
