import { EXIT } from "../protocol.ts";
import type { Outcome, AskState } from "../run/runner.ts";
import type { Row } from "../record/types.ts";
import { findAction, isCompose, promoteAction, actionSummary } from "../run/actions.ts";
import { checkCompose, missingText } from "../run/link.ts";
import { parseArgs } from "./args.ts";
import { composeDirOf, indent, type Ctx, type Output } from "./context.ts";

export const RUN_USAGE = "spr run <compose> [--参数 值 ...]";
export const RESUME_USAGE = "spr resume <编号> [--answer '<json>']（停在 ask 的要带 --answer，失败后修好的不带）";

/**
 * spr run <compose> [--参数 值]：执行一个 compose（draft 也行，真跑成功就变成 verified）。
 * 每次 run 新开一个 run 窗口，跑完就关，日志留在 run-windows/<名字>/。用户拿到的结果必须来自这里。
 */
export async function runCommand(argv: string[], ctx: Ctx, out: Output): Promise<void> {
  const a = parseArgs(argv, { switches: ["help"], params: true });
  if ("error" in a) return out.usage(`${a.error}。用法：${RUN_USAGE}`);
  if (a.switches.has("help")) { out.line(`ok ${RUN_HELP}`); return; }
  const [name, ...extra] = a.rest;
  if (!name) return out.usage(`要写 compose 的名字。用法：${RUN_USAGE}（compose 在 ${composeDirOf(ctx)}/）`);
  if (extra.length) return out.usage(`多余的参数：${extra.join(" ")}（参数要写成 --<name> <value>）。用法：${RUN_USAGE}`);
  if (name === "list") return out.usage(`list 是保留名，compose 换一个名字`);
  const found = findAction(ctx.log.dir, name, composeDirOf(ctx));
  if (!found) return out.usage(`没有叫 ${name} 的 compose：写 ${composeDirOf(ctx)}/${name}.js，再 spr run ${name}`);
  if (!isCompose(found)) return out.usage(`${name} 是 action，spr run 只运行 compose：写一个调用它的 compose（${composeDirOf(ctx)}/<名>.js）`);
  if (!linked(name, ctx, out)) return;
  await ctx.ensureExtension();
  return runNamed(ctx, out, { name, params: a.params });
}

/**
 * 执行前检查：缺 action、依赖 blocked、调用了 compose 都在这里报，什么都不发。通过返回 true。
 * 名字不是字面量的调用检查不了，照常运行，只列出来。
 */
function linked(name: string, ctx: Ctx, out: Output): boolean {
  const { missing, blocked, errors, dynamic } = checkCompose(name, { actionDir: ctx.log.dir, composeDir: composeDirOf(ctx) });
  if (errors.length) { out.usage(errors.join("；")); return false; }
  if (!missing.length && !blocked.length) {
    if (dynamic.length) out.line(`检查不了：这几处 action() 的名字不是字面量，执行前检查不了：${dynamic.join("、")}；运行时缺了会报 is not defined`);
    return true;
  }
  out.code = EXIT.fail;
  if (missing.length) {
    out.line(`fail ${name}：${missingText(missing)} is not defined（没有执行任何操作）`);
    out.line(`下一步：spr debug ${name} navigate <网址>，写好后再 spr run ${name}`);
  }
  if (blocked.length) {
    if (!missing.length) out.line(`fail ${name}：依赖的 action 写不出来（没有执行任何操作）`);
    for (const b of blocked) out.line(`blocked：${b.name}${b.note ? `：${b.note}` : ""}`);
    out.line("下一步：向用户说明卡在哪；有新证据才把 @status 改回 draft，在 @note 写明为什么");
  }
  return false;
}

/**
 * spr resume <编号>：接着跑，前面执行过的 action 不重跑。
 * 停在 ask 的要带 --answer，用停下那一刻的 compose 代码；失败后修好的不带 --answer，读当前文件，失败的 action 重新执行。
 */
export async function resumeCommand(argv: string[], ctx: Ctx, out: Output): Promise<void> {
  const a = parseArgs(argv, { values: ["answer"] });
  if ("error" in a) return out.usage(`${a.error}。用法：${RESUME_USAGE}`);
  const [id, ...extra] = a.rest;
  if (!id || extra.length) return out.usage(`用法：${RESUME_USAGE}`);
  const rec = ctx.runner.asks.get(id);
  if (!rec) return out.usage(`恢复编号 ${id} 不存在（daemon 重启过、已经恢复过，或超过 30 分钟）：重新 spr run 一次`);
  const answers = a.values.get("answer") ?? [];
  if (rec.failed && answers.length) return out.usage(`${id} 是失败后恢复，不用 --answer：spr resume ${id}`);
  if (!rec.failed && !answers.length) return out.usage(`要带 --answer '<json>'，回答：${rec.question}。用法：${RESUME_USAGE}`);
  if (rec.failed && !linked(rec.name, ctx, out)) return;
  await ctx.ensureExtension();
  const askState: AskState = { journal: rec.journal, answers: [...rec.answers, ...answers.map((x) => ({ question: rec.question, answer: parseAnswer(x) }))] };
  return runNamed(ctx, out, { name: rec.name, params: rec.params, askState, code: rec.code, resumed: id, priorDrafts: rec.drafts, ...(rec.failed ? { failedResume: true } : {}) });
}

const RUN_HELP = `用法：${RUN_USAGE}
  compose 在 ~/.speedrun/compose/<名>.js，先写好文件再 run；说明和参数在文件头，用 rg 或直接读文件。
  时间上限写在文件头的 @timeout <秒>，没写是 115 秒。
  停在 ask 时第一行是 ask，失败时输出恢复编号，都用 ${RESUME_USAGE} 接着跑。`;

/** priorDrafts：恢复之前已经成功的 draft（恢复时不会再执行，最终成功时一起变成 verified）。code：ask 恢复时停下那一刻的 compose 代码。failedResume：这次是失败后恢复。 */
type RunOpts = { name: string; params: Record<string, string>; askState?: AskState; code?: string; resumed?: string; priorDrafts?: string[]; failedResume?: boolean };

/** --answer 按 JSON 解析，解析不了就当字符串（回答一个词不用加引号）。 */
function parseAnswer(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

/**
 * run 的结论和结果，按输出约定写成几段：第一行 ok / fail，然后「结果」（action 的返回值，JSON）、已发出的非 GET 请求、
 * 出错的地方；run 窗口目录、变成 verified 的 draft 由 finishRun 接在后面。
 */
/** 「结果」最多列这么多字：再长 agent 的上下文会被撑爆、被 harness 静默截断。全文存进 run 窗口目录。 */
const RESULT_MAX = 20_000;

function outcomeLines(name: string, outcome: Outcome, saveFull?: (json: string) => string): string[] {
  const lines: string[] = [];
  if (outcome.status === "success") {
    const json = JSON.stringify(outcome.result ?? null, null, 2);
    if (json.length <= RESULT_MAX) lines.push(`ok ${name}`, `结果：\n${indent(json)}`);
    else {
      const file = saveFull?.(json);
      lines.push(`ok ${name}`, `结果（截断了：一共 ${json.length} 字，只列前 ${RESULT_MAX} 字；${file ? `全文在 ${file}` : "全文没存下来"}。在 compose 里做筛选、统计，只返回回答用户要的东西；用户确实要全部数据时，告诉用户文件位置，不要把全文读进上下文）：\n${indent(json.slice(0, RESULT_MAX))}`);
    }
  } else if (outcome.status === "failure") {
    const [head, ...more] = outcome.error.split("\n");
    lines.push(`fail ${name}：${head}`);
    if (more.length) lines.push(`错误：\n${indent(more.join("\n"))}`);
    if (outcome.failedAction) lines.push(`出错的 action：${outcome.failedAction}`);
    if (outcome.at) lines.push(`位置：${outcome.at}`);
    if (outcome.page && !isWarm(outcome.page.url)) lines.push(`页面：${outcome.page.url} "${outcome.page.title}"`, ...(outcome.page.screenshot ? [`截图：${outcome.page.screenshot}`] : []));
    if (outcome.hint) lines.push(`说明：\n${indent(outcome.hint)}`);
  }
  if (outcome.dialogs?.length) lines.push(`被拦下的系统弹窗（alert 放过，confirm、prompt 选取消，离开确认直接离开，有没保存的改动要核对）：\n${indent(outcome.dialogs.join("\n"))}`);
  if (outcome.sent?.length) lines.push(`已发出的非 GET 请求：\n${indent(outcome.sent.join("\n"))}`);
  return lines;
}

/**
 * run 停在 ask：存恢复记录、输出问题和数据，不存 compose（返回 true）。其他结果返回 false。
 * 恢复成功或再次停下后，用过的恢复编号作废；ask 恢复失败时保留，agent 可以改了回答再恢复。
 */
function handleAsk(ctx: Ctx, out: Output, outcome: Outcome, o: RunOpts): boolean {
  if ((outcome.status !== "failure" || o.failedResume) && o.resumed) ctx.runner.asks.delete(o.resumed);
  if (outcome.status !== "ask") return false;
  const id = ctx.runner.asks.add({ question: outcome.question, name: o.name, ...(outcome.code !== undefined ? { code: outcome.code } : {}), params: o.params, journal: outcome.journal, answers: o.askState?.answers ?? [], drafts: [...(o.priorDrafts ?? []), ...(outcome.drafts ?? [])] });
  out.code = EXIT.wait;
  out.line(`ask ${outcome.question}`);
  out.line(`数据：\n${indent(JSON.stringify(outcome.data ?? null, null, 2))}`);
  if (outcome.sent?.length) out.line(`已发出的非 GET 请求：\n${indent(outcome.sent.join("\n"))}`);
  out.line(`恢复：spr resume ${id} --answer '<json>'（你自己判断，或转问用户后回答；回答就是 ask() 的返回值。compose 从头重新执行，已完成的 action 直接返回记录的结果；30 分钟内有效）`);
  if (outcome.runWindow) out.line(`run 窗口目录：${ctx.log.winDir(outcome.runWindow)}`);
  return true;
}

/** compose 失败、前面已经有 action 完成：留一条恢复记录，修好后不用重跑它们。不存代码，恢复时读当前文件。 */
function keepForResume(ctx: Ctx, outcome: Outcome, o: RunOpts): string | undefined {
  if (outcome.status !== "failure" || !outcome.journal?.length) return undefined;
  return ctx.runner.asks.add({ question: "", failed: true, name: o.name, params: o.params, journal: outcome.journal, answers: outcome.answers ?? [], drafts: [...(o.priorDrafts ?? []), ...(outcome.drafts ?? [])] });
}

/** run 结束后的共同收尾：写 run 窗口的 meta，跑成功的 draft 变成 verified，失败时给下一步。返回要追加的文字行。 */
function finishRun(ctx: Ctx, outcome: Outcome, o: RunOpts, resumeId: string | undefined): string[] {
  const lines: string[] = [];
  const win = outcome.runWindow;
  if (win) {
    const old = ctx.log.readMeta(win);
    if (old) ctx.log.writeMeta(win, { ...old, ...(o.resumed ? { resumed: o.resumed } : {}), status: outcome.status, ...(outcome.status === "failure" ? { error: errorOf(outcome) } : {}), ...(outcome.sent?.length ? { sent: outcome.sent } : {}), endedAt: Date.now() });
    lines.push(`run 窗口目录：${ctx.log.winDir(win)}（窗口已关，日志留着）`);
  }
  // 跑成功就是事实：执行过的 draft 都变成 verified（action 自己检查状态码和返回值）
  const drafts = new Set([...(o.priorDrafts ?? []), ...(outcome.drafts ?? [])]);
  if (outcome.status === "success") {
    const promoted = [...drafts].filter((file) => promoteAction(file)).map((file) => actionSummary(file).name);
    if (promoted.length) lines.push(`已变成 verified：${promoted.join("、")}`);
  }
  if (outcome.status === "failure") {
    // 没开 run 窗口就失败的（参数不对）：什么都没执行，改参数重跑就行
    if (!win) lines.push(`下一步：改好参数后重新 spr run ${o.name}`);
    else {
      const fix = outcome.failedAction ? `修好 ${outcome.failedAction} 后` : "修好后";
      const at = outcome.page?.url && !isWarm(outcome.page.url) ? outcome.page.url : "<网址>";
      lines.push(`下一步：spr debug ${o.name} navigate ${at}，${fix} ${resumeId ? `spr resume ${resumeId}（已完成的 action 不重跑；30 分钟内有效）` : `spr run ${o.name}`}`);
      if (!resumeId && outcome.sent?.length) lines.push(`这次已经发出上面「已发出的非 GET 请求」；没有恢复编号，重新 spr run 会从头执行`);
    }
  }
  return lines;
}

async function runNamed(ctx: Ctx, out: Output, o: RunOpts): Promise<void> {
  const outcome = await ctx.runner.runAction(o.name, o.params, undefined, { askState: o.askState, ...(o.code !== undefined ? { code: o.code } : {}), ...(out.signal ? { signal: out.signal } : {}) });
  record(ctx, out, outcome, o);
  if (handleAsk(ctx, out, outcome, o)) return;
  if (outcome.status !== "success") out.code = EXIT.fail;
  const resumeId = keepForResume(ctx, outcome, o);
  const win = outcome.runWindow;
  // 结果、完整报错都存进 run 窗口目录：输出里裁掉的，在这里找得到
  const full = win && outcome.status === "success" ? ctx.log.abs(win, ctx.log.putFile(win, "result.json", JSON.stringify(outcome.result ?? null, null, 2))) : undefined;
  if (win && outcome.status === "failure") {
    ctx.log.putFile(win, "error.txt", [outcome.error, outcome.stack ? `\n--- 完整 stack ---\n${outcome.stack}` : ""].join(""));
    const evidence = requestEvidence(ctx, win, outcome);
    if (evidence) outcome.hint = outcome.hint ? `${evidence}\n${outcome.hint}` : evidence;
  }
  const lines = [...outcomeLines(o.name, outcome, () => full ?? ""), ...finishRun(ctx, outcome, o, resumeId)];
  if (win && outcome.status === "failure") lines.splice(lines.findIndex((l) => l.startsWith("run 窗口目录")), 0, `完整报错：${ctx.log.abs(win, "error.txt")}`);
  for (const line of lines) out.line(line);
}

/** 暖页面：只发请求的 action 用的落脚页（origin/robots.txt，见 browser/window.ts 的 acquire）。停在这里说明 action 没打开过页面，截图和页面地址没用。 */
const isWarm = (url: string): boolean => /^https?:\/\/[^/]+\/robots\.txt$/.test(url);

/** 停在暖页面的失败：证据是这个窗口里最后一个出错的请求（状态码 ≥ 400 或没发出去），给出它的请求文件。 */
function requestEvidence(ctx: Ctx, win: string, outcome: Extract<Outcome, { status: "failure" }>): string | undefined {
  if (!outcome.page?.url || !isWarm(outcome.page.url)) return undefined;
  const bad = ctx.log.readRows(win, { limit: 2000 }).filter((r: Row & { status?: number; error?: string; file?: string }) => r.type === "request" && r.src === "agent" && ((r.status ?? 0) >= 400 || r.error)).at(-1) as (Row & { status?: number; method?: string; url?: string; file?: string }) | undefined;
  const lead = "这次 run 没打开过页面（停在暖页面 robots.txt，没有截图）";
  if (!bad) return `${lead}；窗口里没有出错的请求，看完整报错`;
  return `${lead}；最后一个出错的请求：${bad.method ?? ""} ${bad.url ?? ""} → ${bad.status ?? "没发出去"}，请求和响应在 ${bad.file ? ctx.log.abs(win, bad.file) : ctx.log.winDir(win)}`;
}

/** 失败写进 meta 和调用记录的部分：类别、第一行原文、出错的 action、位置。 */
function errorOf(outcome: Extract<Outcome, { status: "failure" }>): Record<string, unknown> {
  return { code: outcome.code ?? "internal", message: outcome.error.split("\n", 1)[0]!.slice(0, 500), ...(outcome.failedAction ? { action: outcome.failedAction } : {}), ...(outcome.at ? { at: outcome.at } : {}) };
}

/** 调用记录的补充字段：参数、窗口、结果的大小和条数、失败的类别、每次 action() 调用、发出的非 GET 请求、从哪次恢复。 */
function record(ctx: Ctx, out: Output, outcome: Outcome, o: RunOpts): void {
  const r = out.rec;
  // 参数和请求头一样按名字、值判断秘密（token、cookie 这类换成别名）；太长的（SQL 这类）截到 500 字
  r.params = Object.fromEntries(Object.entries(ctx.ingest.sanitizer.headers(o.params)).map(([k, v]) => [k, v.length > 500 ? `${v.slice(0, 500)}…（共 ${v.length} 字）` : v]));
  if (outcome.runWindow) r.window = outcome.runWindow;
  if (o.resumed) r.resumedFrom = o.resumed;
  if (outcome.status === "success") {
    const json = JSON.stringify(outcome.result ?? null);
    const v = outcome.result;
    r.result = { bytes: json.length, ...(Array.isArray(v) ? { count: v.length } : {}), empty: v == null || (Array.isArray(v) && !v.length) || (typeof v === "object" && !Object.keys(v as object).length) || v === "" };
  }
  if (outcome.status === "failure") r.error = errorOf(outcome);
  if (outcome.status === "ask") r.question = outcome.question.slice(0, 200);
  if (outcome.calls?.length) r.calls = outcome.calls;
  if (outcome.sent?.length) r.sent = outcome.sent;
}
