import * as fs from "node:fs";
import * as path from "node:path";
import { EXIT } from "../protocol.ts";
import { missingInSequence } from "../learn/explore.ts";
import type { DraftRun } from "../run/asks.ts";
import type { Outcome, AskState } from "../run/runner.ts";
import { actionSummary, composeTarget, findAction, isComposed, promoteAction, pruneUnnamed, resolveCompose, saveComposed } from "../run/actions.ts";
import { descriptionOf, parseArgs, valueOf } from "./args.ts";
import { DESCRIPTION_HINT, composeDirOf, idleMin, indent, type Ctx, type Output } from "./context.ts";

/**
 * lore run --action <名> --description "…" [--参数 值]：执行一个 action（draft 也行，真跑成功就变成 verified）。
 * lore run --compose <名> …：按名字（或哈希的唯一前缀）再跑一个存下来的 compose。
 * lore run --compose-code '代码' --description "…" [--参数 值]：跑一段 compose 代码（只能 action("名字", 参数) 调用 action），跑通就按代码哈希存下来。
 * 三者必须给且只给一个。
 * 每次 run 新开一个 run 窗口，跑完就关，日志留在 run-windows/<名字>/。用户拿到的结果必须来自这里。
 */
export async function runCommand(argv: string[], ctx: Ctx, out: Output): Promise<void> {
  const usage = `用法：lore run --action <名> --description "…" [--参数 值 ...]；lore run --compose <名> --description "…" [--参数 值 ...]；或 lore run --compose-code 'const a = await action("名字", { 参数: lore.params.x }); return a;' --description "…" [--参数 值 ...]；停在 lore.ask 后用 lore run --resume <编号> --answer '<json>' 恢复（action 在 ${ctx.log.dir}/<站点>/actions/ 和 ${composeDirOf(ctx)}/ 下）`;
  const a = parseArgs(argv, { values: ["action", "compose", "compose-code", "resume", "answer", "timeout", "description"], params: true });
  if ("error" in a) return out.fail(`${a.error}。${usage}`);
  if (a.rest.length) return out.fail(`多余的参数：${a.rest[0]}（action 名要写成 --action ${a.rest[0]}；参数要写成 --名字 值）。${usage}`);
  const description = descriptionOf(a);
  const actionName = valueOf(a, "action"), composeName = valueOf(a, "compose"), code = valueOf(a, "compose-code"), resume = valueOf(a, "resume");
  const timeoutArg = valueOf(a, "timeout");
  const answers = a.values.get("answer") ?? [];
  const hasParams = Object.keys(a.params).length > 0;
  if (resume !== undefined) {
    if (code !== undefined || actionName !== undefined || composeName !== undefined || hasParams || timeoutArg !== undefined) return out.fail("--resume 只接受 --answer：action、参数、--description 沿用停下时的那次 run");
    const rec = ctx.runner.asks.get(resume);
    if (!rec) return out.fail(`恢复编号 ${resume} 不存在（daemon 重启过、已经恢复过，或超过 30 分钟）：重新 run 一次`);
    if (!answers.length) return out.fail(`--resume 要带 --answer '<json>'，回答：${rec.question}`);
    await ctx.ensureExtension();
    const askState: AskState = { journal: rec.journal, answers: [...rec.answers, ...answers.map(parseAnswer)] };
    // 存 compose 用第一次 run 的 --description（用户要做的事）；恢复时的 --description 可省
    const o = { description: rec.description, params: rec.params, timeoutSec: rec.timeoutSec, askState, resumed: resume, priorDrafts: rec.drafts };
    return rec.code !== undefined ? composeRun(ctx, out, { ...o, code: rec.code }) : runNamed(ctx, out, { ...o, actionName: rec.action! });
  }
  if (answers.length) return out.fail("--answer 只配 --resume：lore run --resume <编号> --answer '<json>'");
  const given = [actionName, composeName, code].filter((v) => v !== undefined).length;
  if (given !== 1) return out.fail(`--action、--compose、--compose-code 必须给且只给一个。${usage}`);
  if (!description) return out.fail(`lore run ${DESCRIPTION_HINT}`);
  const timeoutSec = timeoutArg === undefined ? undefined : Number(timeoutArg);
  if (timeoutSec !== undefined && (!Number.isFinite(timeoutSec) || timeoutSec <= 0)) return out.fail("--timeout 需要正数（秒）");
  await ctx.ensureExtension();
  if (code !== undefined) return composeRun(ctx, out, { code, description, params: a.params, timeoutSec });
  let runName = (actionName ?? composeName)!;
  if (composeName !== undefined) {
    const r = resolveCompose(composeDirOf(ctx), composeName);
    if (r && "error" in r) return out.fail(r.error);
    if (r) runName = r.name;
  }
  const found = findAction(ctx.log.dir, runName, composeDirOf(ctx));
  if (found && isComposed(actionSummary(found.file)) !== (composeName !== undefined)) return out.fail(composeName !== undefined ? `${runName} 是 action 不是 compose：lore run --action ${runName}` : `${runName} 是 compose 不是 action：lore run --compose ${runName}`);
  return runNamed(ctx, out, { actionName: runName, description, params: a.params });
}

/** priorDrafts：停在 lore.ask 之前那几次 run 里已经成功的 draft（恢复时不会再执行，最终成功时一起变成 verified）。 */
type RunOpts = { description: string; params: Record<string, string>; timeoutSec?: number; askState?: AskState; resumed?: string; priorDrafts?: DraftRun[] };

/** --answer 按 JSON 解析，解析不了就当字符串（回答一个词不用加引号）。 */
function parseAnswer(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

/**
 * run 的结论和结果，按输出约定写成几段：第一行 ok / fail，然后「结果」（action 的返回值，JSON）、已发出的非 GET 请求、
 * 出错的地方。lore run 和 learn 窗口里的 run 共用；run 窗口目录、变成 verified 的 draft 由 finishRun 接在后面。
 */
export function outcomeLines(name: string, outcome: Outcome): string[] {
  const lines: string[] = [];
  if (outcome.status === "success") {
    lines.push(`ok ${name}`, `结果：\n${indent(JSON.stringify(outcome.result ?? null, null, 2))}`);
  } else if (outcome.status === "failure") {
    const [head, ...more] = outcome.error.split("\n");
    lines.push(`fail ${name}：${head}`);
    if (more.length) lines.push(`错误：\n${indent(more.join("\n"))}`);
    if (outcome.failedAction) lines.push(`出错的 action：${outcome.failedAction}`);
    if (outcome.page) lines.push(`页面：${outcome.page.url} "${outcome.page.title}"`, ...(outcome.page.screenshot ? [`截图：${outcome.page.screenshot}`] : []));
    if (outcome.hint) lines.push(`下一步：${outcome.hint}`);
  }
  if (outcome.sent?.length) lines.push(`已发出的非 GET 请求：\n${indent(outcome.sent.join("\n"))}`);
  return lines;
}

/**
 * run 停在 lore.ask：存恢复记录、输出问题和数据，不存 compose（返回 true）。其他结果返回 false。
 * 恢复成功或再次停下后，用过的恢复编号作废；恢复失败时保留，agent 可以改了回答再恢复。
 */
function handleAsk(ctx: Ctx, out: Output, outcome: Outcome, o: RunOpts, target: { code?: string; action?: string }): boolean {
  if (outcome.status !== "failure" && o.resumed) ctx.runner.asks.delete(o.resumed);
  if (outcome.status !== "ask") return false;
  const id = ctx.runner.asks.add({ question: outcome.question, description: o.description, ...target, params: o.params, timeoutSec: o.timeoutSec, journal: outcome.journal, answers: o.askState?.answers ?? [], drafts: [...(o.priorDrafts ?? []), ...(outcome.drafts ?? []).map((file) => ({ file, window: outcome.runWindow ?? "" }))] });
  out.code = EXIT.wait;
  out.line(`ask ${outcome.question}`);
  out.line(`数据：\n${indent(JSON.stringify(outcome.data ?? null, null, 2))}`);
  if (outcome.sent?.length) out.line(`已发出的非 GET 请求：\n${indent(outcome.sent.join("\n"))}`);
  out.line(`恢复：lore run --resume ${id} --answer '<json>'（前面已执行的 action 不会重跑；30 分钟内有效）`);
  if (outcome.runWindow) out.line(`run 窗口目录：${ctx.log.winDir(outcome.runWindow)}`);
  return true;
}

/** run 结束后的共同收尾：写 run 窗口的 meta，判断 draft 变成 verified（多行 @endpoint 要按顺序发出才变成 verified），提醒开着的 learn 窗口。返回要追加的文字行。 */
function finishRun(ctx: Ctx, outcome: Outcome, o: RunOpts): string[] {
  const lines: string[] = [];
  const win = outcome.runWindow;
  if (win) {
    const old = ctx.log.readMeta(win);
    if (old) ctx.log.writeMeta(win, { ...old, description: o.description, status: outcome.status, ...(outcome.sent?.length ? { sent: outcome.sent } : {}), endedAt: Date.now() });
    lines.push(`run 窗口目录：${ctx.log.winDir(win)}（窗口已关，日志留着）`);
  }
  const drafts: DraftRun[] = [...(o.priorDrafts ?? []), ...(outcome.drafts ?? []).map((file) => ({ file, window: win ?? "" }))];
  if (outcome.status === "success" && drafts.length) {
    ctx.ingest.flush();
    const sentOf = new Map<string, string[]>();
    const sent = (w: string): string[] => {
      let list = sentOf.get(w);
      if (!list) { list = (w ? ctx.log.readRows(w, { limit: 5000 }) : []).filter((r) => (r.type === "cmd" && r.kind === "request") || (r.type === "request" && !r.noise)).map((r) => (r.type === "cmd" ? String(r.detail?.endpoint ?? "") : r.endpoint ?? "")); sentOf.set(w, list); }
      return list;
    };
    const promoted: string[] = [], kept: string[] = [], seen = new Set<string>();
    for (const { file, window } of drafts) {
      if (seen.has(file)) continue;
      seen.add(file);
      const s = actionSummary(file);
      const missing = s.endpoints.length >= 2 ? missingInSequence(s.endpoints, sent(window)) : undefined;
      if (missing) { kept.push(`${s.name}（没有按 @endpoint 的顺序发出「${missing}」：前置请求漏了，或 @endpoint 写错了顺序）`); continue; }
      if (promoteAction(file)) promoted.push(s.name);
    }
    if (promoted.length) lines.push(`已变成 verified：${promoted.join("、")}`);
    if (kept.length) lines.push(`没有变成 verified：${kept.join("；")}`);
  }
  const open = ctx.learn.opened();
  if (outcome.status === "failure" && open.length) lines.push(`下一步：learn 窗口 ${open.map((w) => w.id).join("、")} 还开着：失败的 action 如果在那里 run 成功过，多半是 action 缺了进入那个页面状态的前置步骤（先 goto 哪个页面、少了哪个前置请求），或者 auth 头没声明来源（看观察里的"auth 来源"，写进 request 的 auth）；对比两个窗口的 timeline.jsonl`);
  if (outcome.status === "success" && open.length) lines.push(`下一步：learn 窗口 ${open.map((w) => `${w.id}（空闲 ${idleMin(w)} 分钟）`).join("、")} 还开着，事情做完就 lore learn <句柄> close`);
  return lines;
}

async function runNamed(ctx: Ctx, out: Output, o: RunOpts & { actionName: string }): Promise<void> {
  const { actionName, description } = o;
  const found = findAction(ctx.log.dir, actionName, composeDirOf(ctx));
  const outcome = await ctx.runner.runAction(actionName, o.params, undefined, { askState: o.askState });
  if (handleAsk(ctx, out, outcome, o, { action: actionName })) return;
  if (outcome.status !== "success") out.code = EXIT.fail;
  if (found && outcome.status === "success") {
    const summary = actionSummary(found.file, found.site);
    // 真跑成功：compose 累加 description 和次数；学出来的 action，这句话记成它覆盖的 endpoint 的 description
    if (isComposed(summary)) saveComposed(found.file, fs.readFileSync(found.file, "utf8"), description);
    else if (found.site) for (const ep of summary.endpoints) ctx.index.describe(found.site, ep, { text: description, from: "run" });
  }
  for (const line of [...outcomeLines(actionName, outcome), ...finishRun(ctx, outcome, o)]) out.line(line);
}

async function composeRun(ctx: Ctx, out: Output, o: RunOpts & { code: string }): Promise<void> {
  const globalDir = composeDirOf(ctx);
  const outcome = await ctx.runner.runCompose(o.code, (o.timeoutSec ?? 115) * 1000, o.params, o.askState, "compose");
  if (handleAsk(ctx, out, outcome, o, { code: o.code })) return;
  if (outcome.status !== "success") out.code = EXIT.fail;
  for (const line of outcomeLines("compose", outcome)) out.line(line);
  const tail = finishRun(ctx, outcome, o);
  if (outcome.status === "success") {
    const saved = saveComposed(composeTarget(globalDir, o.code), o.code, o.description);
    pruneUnnamed(globalDir);
    const runName = path.basename(saved.file, ".js");
    out.line(`已存为 compose：${runName}（${saved.file}；下次 lore run --compose ${runName} --description "…" --参数 值；要改就直接改这个文件）`);
    if (!saved.params.length) out.line("下一步：变化的值写成 lore.params.名字 ?? 默认值，下次直接换参数复用，不用改代码");
  }
  for (const line of tail) out.line(line);
}
