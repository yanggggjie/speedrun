import { EXIT } from "../protocol.ts";
import type { Outcome, AskState } from "../run/runner.ts";
import { actionSummary, findAction, isCompose, paramSpecs, promoteAction } from "../run/actions.ts";
import { descriptionOf, parseArgs } from "./args.ts";
import { DESCRIPTION_HINT, composeDirOf, idleMin, indent, type Ctx, type Output } from "./context.ts";

export const RUN_USAGE = 'spr run <名> --description "…" [--参数 值 ...]（action 或 compose 都用这一条；spr run <名> --help 看参数）';
export const RESUME_USAGE = "spr resume <编号> --answer '<json>' [--description \"为什么这样回答\"]";

/**
 * spr run <名> --description "…" [--参数 值]：执行一个 action 或 compose（draft 也行，真跑成功就变成 verified）。
 * 每次 run 新开一个 run 窗口，跑完就关，日志留在 run-windows/<名字>/。用户拿到的结果必须来自这里。
 */
export async function runCommand(argv: string[], ctx: Ctx, out: Output): Promise<void> {
  const where = `（action 在 ${ctx.log.dir}/<站点>/actions/，compose 在 ${composeDirOf(ctx)}/）`;
  const a = parseArgs(argv, { values: ["description"], switches: ["help"], params: true });
  if ("error" in a) return out.usage(`${a.error}。用法：${RUN_USAGE}`);
  const [name, ...extra] = a.rest;
  if (!name && a.switches.has("help")) { out.line(`ok ${RUN_HELP}`); return; }
  if (!name) return out.usage(`要写 action 或 compose 的名字。用法：${RUN_USAGE}${where}`);
  if (extra.length) return out.usage(`多余的参数：${extra.join(" ")}（参数要写成 --名字 值）。用法：${RUN_USAGE}`);
  const found = findAction(ctx.log.dir, name, composeDirOf(ctx));
  if (!found) return out.usage(`没有叫 ${name} 的 action 或 compose${where}：ls 看有哪些，名字要写全`);
  if (a.switches.has("help")) return runHelp(out, name, found);
  const description = descriptionOf(a);
  if (!description) return out.usage(`spr run ${DESCRIPTION_HINT}`);
  await ctx.ensureExtension();
  return runNamed(ctx, out, { name, description, params: a.params });
}

/**
 * spr resume <编号> --answer '<json>'：从 spr.ask 停下的地方接着跑。前面执行过的 action 不重跑；
 * 用的是停下那一刻的 compose 代码，中途改了文件也不影响。--description 说明为什么这样回答，记进 run 窗口的日志。
 */
export async function resumeCommand(argv: string[], ctx: Ctx, out: Output): Promise<void> {
  const a = parseArgs(argv, { values: ["answer", "description"] });
  if ("error" in a) return out.usage(`${a.error}。用法：${RESUME_USAGE}`);
  const [id, ...extra] = a.rest;
  if (!id || extra.length) return out.usage(`用法：${RESUME_USAGE}`);
  const rec = ctx.runner.asks.get(id);
  if (!rec) return out.usage(`恢复编号 ${id} 不存在（daemon 重启过、已经恢复过，或超过 30 分钟）：重新 spr run 一次`);
  const answers = a.values.get("answer") ?? [];
  if (!answers.length) return out.usage(`要带 --answer '<json>'，回答：${rec.question}。用法：${RESUME_USAGE}`);
  await ctx.ensureExtension();
  const askState: AskState = { journal: rec.journal, answers: [...rec.answers, ...answers.map(parseAnswer)] };
  const why = descriptionOf(a);
  return runNamed(ctx, out, { name: rec.name, description: rec.description, params: rec.params, askState, code: rec.code, resumed: id, priorDrafts: rec.drafts, ...(why ? { answerWhy: why } : {}) });
}

const RUN_HELP = `用法：${RUN_USAGE}
  action 在 ~/.speedrun/sites/<站点>/actions/<名>.js，compose 在 ~/.speedrun/compose/<名>.js；compose 先用 Write 写好文件再 run。
  时间上限写在文件头的 @timeout <秒>，没写是 115 秒。
  停在 spr.ask 时第一行是 ask，用 ${RESUME_USAGE} 接着跑。`;

/** spr run <名> --help：从文件头列出说明、参数、@timeout、@write、@status。 */
function runHelp(out: Output, name: string, found: { file: string; site?: string }): void {
  const s = actionSummary(found.file, found.site);
  const specs = paramSpecs(found.file);
  out.line(`ok ${name}（${isCompose(found) ? "compose" : `action，站点 ${found.site}`}，@status ${s.status}${s.write ? "，@write 会改东西" : ""}）`);
  if (s.summary) out.line(`说明：${s.summary}`);
  out.line(`参数：${specs.length ? "" : "（无）"}`);
  for (const p of specs) out.line(`  --${p.name}${p.type === "string" ? "" : `（${p.type}）`}${p.optional ? "（可选）" : "（必填）"} ${p.description}`);
  out.line(`时间上限：${s.timeout ? `${s.timeout} 秒（@timeout）` : "115 秒（默认，要更久在文件头加 @timeout <秒>）"}`);
  out.line(`文件：${found.file}`);
  out.line(`用法：spr run ${name} --description "…"${specs.map((p) => p.optional ? ` [--${p.name} 值]` : ` --${p.name} 值`).join("")}`);
}

/** priorDrafts：停在 spr.ask 之前那几次 run 里已经成功的 draft（恢复时不会再执行，最终成功时一起变成 verified）。code：恢复时停下那一刻的 compose 代码。answerWhy：恢复时 --description 说明的为什么这样回答。 */
type RunOpts = { name: string; description: string; params: Record<string, string>; askState?: AskState; code?: string; resumed?: string; priorDrafts?: string[]; answerWhy?: string };

/** --answer 按 JSON 解析，解析不了就当字符串（回答一个词不用加引号）。 */
function parseAnswer(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

/**
 * run 的结论和结果，按输出约定写成几段：第一行 ok / fail，然后「结果」（action 的返回值，JSON）、已发出的非 GET 请求、
 * 出错的地方。spr run 和 learn 窗口里的 run 共用；run 窗口目录、变成 verified 的 draft 由 finishRun 接在后面。
 */
/** 「结果」最多列这么多字：再长 agent 的上下文会被撑爆、被 harness 静默截断。全文存进 run 窗口目录。 */
const RESULT_MAX = 20_000;

export function outcomeLines(name: string, outcome: Outcome, saveFull?: (json: string) => string): string[] {
  const lines: string[] = [];
  if (outcome.status === "success") {
    const json = JSON.stringify(outcome.result ?? null, null, 2);
    if (json.length <= RESULT_MAX) lines.push(`ok ${name}`, `结果：\n${indent(json)}`);
    else {
      const file = saveFull?.(json);
      lines.push(`ok ${name}`, `结果（截断了：一共 ${json.length} 字，只列前 ${RESULT_MAX} 字；${file ? `全文在 ${file}，用 node 或 jq 读` : "让 action 只返回要用的字段"}）：\n${indent(json.slice(0, RESULT_MAX))}`);
    }
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
 * run 停在 spr.ask：存恢复记录、输出问题和数据，不存 compose（返回 true）。其他结果返回 false。
 * 恢复成功或再次停下后，用过的恢复编号作废；恢复失败时保留，agent 可以改了回答再恢复。
 */
function handleAsk(ctx: Ctx, out: Output, outcome: Outcome, o: RunOpts): boolean {
  if (outcome.status !== "failure" && o.resumed) ctx.runner.asks.delete(o.resumed);
  if (outcome.status !== "ask") return false;
  const id = ctx.runner.asks.add({ question: outcome.question, description: o.description, name: o.name, ...(outcome.code !== undefined ? { code: outcome.code } : {}), params: o.params, journal: outcome.journal, answers: o.askState?.answers ?? [], drafts: [...(o.priorDrafts ?? []), ...(outcome.drafts ?? [])] });
  out.code = EXIT.wait;
  out.line(`ask ${outcome.question}`);
  out.line(`数据：\n${indent(JSON.stringify(outcome.data ?? null, null, 2))}`);
  if (outcome.sent?.length) out.line(`已发出的非 GET 请求：\n${indent(outcome.sent.join("\n"))}`);
  out.line(`恢复：spr resume ${id} --answer '<json>' --description "为什么这样回答"（前面已执行的 action 不会重跑；30 分钟内有效）`);
  if (outcome.runWindow) out.line(`run 窗口目录：${ctx.log.winDir(outcome.runWindow)}`);
  return true;
}

/** run 结束后的共同收尾：写 run 窗口的 meta，跑成功的 draft 变成 verified，提醒开着的 learn 窗口。返回要追加的文字行。 */
function finishRun(ctx: Ctx, outcome: Outcome, o: RunOpts): string[] {
  const lines: string[] = [];
  const win = outcome.runWindow;
  if (win) {
    const old = ctx.log.readMeta(win);
    if (old) ctx.log.writeMeta(win, { ...old, description: o.description, ...(o.resumed ? { resumed: o.resumed } : {}), ...(o.answerWhy ? { answerWhy: o.answerWhy } : {}), status: outcome.status, ...(outcome.sent?.length ? { sent: outcome.sent } : {}), endedAt: Date.now() });
    lines.push(`run 窗口目录：${ctx.log.winDir(win)}（窗口已关，日志留着）`);
  }
  // 跑成功就是事实：执行过的 draft 都变成 verified（action 自己检查状态码和返回值）
  const drafts = new Set([...(o.priorDrafts ?? []), ...(outcome.drafts ?? [])]);
  if (outcome.status === "success") {
    const promoted = [...drafts].filter((file) => promoteAction(file)).map((file) => actionSummary(file).name);
    if (promoted.length) lines.push(`已变成 verified：${promoted.join("、")}`);
  }
  const open = ctx.learn.opened();
  if (outcome.status === "failure" && open.length) lines.push(`下一步：learn 窗口 ${open.map((w) => w.id).join("、")} 还开着：失败的 action 如果在那里 try_action 成功过，多半是 action 缺了进入那个页面状态的前置步骤（先 goto 哪个页面、少了哪个前置请求），或者页面这次没发带某个头的请求（看观察里的「请求头」，照位置写进 request 的 auth）；对比两个窗口的 timeline.jsonl`);
  if (outcome.status === "success" && open.length) lines.push(`下一步：learn 窗口 ${open.map((w) => `${w.id}（空闲 ${idleMin(w)} 分钟）`).join("、")} 还开着，事情做完就 spr learn close <句柄>`);
  return lines;
}

async function runNamed(ctx: Ctx, out: Output, o: RunOpts): Promise<void> {
  const { name, description } = o;
  const found = findAction(ctx.log.dir, name, composeDirOf(ctx));
  const outcome = await ctx.runner.runAction(name, o.params, undefined, { askState: o.askState, ...(o.code !== undefined ? { code: o.code } : {}) });
  if (handleAsk(ctx, out, outcome, o)) return;
  if (outcome.status !== "success") out.code = EXIT.fail;
  // 学出来的 action 真跑成功：这句话记成它覆盖的 endpoint 的 description
  if (found?.site && outcome.status === "success") for (const ep of actionSummary(found.file, found.site).endpoints) ctx.index.describe(found.site, ep, { text: description, from: "run" });
  const saveFull = outcome.runWindow ? (json: string): string => ctx.log.abs(outcome.runWindow!, ctx.log.putFile(outcome.runWindow!, "result.json", json)) : undefined;
  for (const line of [...outcomeLines(name, outcome, saveFull), ...finishRun(ctx, outcome, o)]) out.line(line);
}
