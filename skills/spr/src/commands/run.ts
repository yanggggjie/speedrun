import { EXIT } from "../protocol.ts";
import type { Outcome } from "../run/runner.ts";
import type { Row } from "../record/types.ts";
import { findAction, promoteAction, actionSummary } from "../run/actions.ts";
import { parseArgs, valueOf } from "./args.ts";
import { indent, type Ctx, type Output } from "./context.ts";

export const RUN_USAGE = "spr run <action> [--参数 值 ...] | spr run -e '<js>' [--timeout 秒]";

/**
 * spr run <action> [--参数 值]：直接执行一个 action（draft 也行，真跑成功就变成 verified）。
 * spr run -e '<js>' [--timeout 秒]：在同一个 run 窗口里免落盘组合调用多个 action（内置 action()、sleep()）。
 * 每次 run 新开一个 run 窗口，跑完就关，日志留在 run-windows/<名字>/。
 */
export async function runCommand(argv: string[], ctx: Ctx, out: Output): Promise<void> {
  const a = parseArgs(argv, { values: ["eval", "timeout"], switches: ["help"], short: { e: "eval", h: "help" }, params: true });
  if ("error" in a) return out.usage(`${a.error}。用法：${RUN_USAGE}`);
  if (a.switches.has("help")) { out.line(`ok ${RUN_HELP}`); return; }
  const evalCode = valueOf(a, "eval");
  const timeoutRaw = valueOf(a, "timeout");
  let timeoutMs: number | undefined;
  if (timeoutRaw !== undefined) {
    const sec = Number(timeoutRaw);
    if (!Number.isFinite(sec) || sec <= 0 || sec > 3600) return out.usage(`--timeout 要是 1 到 3600 之间的秒数，收到：${timeoutRaw}`);
    timeoutMs = sec * 1000;
  }
  if (evalCode !== undefined) {
    out.rec.mode = "inline";
    if (a.rest.length || Object.keys(a.params).length) return out.usage(`spr run -e 不接受位置参数或 --<param>，参数直接写在 JS 代码的 action(name, params) 里。用法：${RUN_USAGE}`);
    if (!evalCode.trim()) return out.usage(`-e 的代码不能为空。用法：spr run -e 'return await action("<名字>", { ... })'`);
    await ctx.ensureExtension();
    const outcome = await ctx.runner.runInline(evalCode, { ...(timeoutMs ? { timeoutMs } : {}), ...(out.signal ? { signal: out.signal } : {}) });
    return presentOutcome("-e", outcome, ctx, out, { mode: "inline", code: evalCode, params: {} });
  }
  const [name, ...extra] = a.rest;
  if (!name) return out.usage(`要写 action 的名字，或用 -e '<js>'。用法：${RUN_USAGE}（action 在 ${ctx.log.dir}/<站点>/）`);
  if (extra.length) return out.usage(`多余的参数：${extra.join(" ")}（参数要写成 --<name> <value>）。用法：${RUN_USAGE}`);
  if (name === "list") return out.usage(`list 是保留名`);
  out.rec.mode = "action";
  const found = findAction(ctx.log.dir, name);
  if (!found) {
    const msg = `没有叫 ${name} 的 action：先用 rg 搜 ${ctx.log.dir}，没有现成的就用 spr debug ${name} navigate <网址> 直接完成任务`;
    out.rec.error = { code: "not-defined", message: msg };
    return out.usage(msg);
  }
  await ctx.ensureExtension();
  const outcome = await ctx.runner.runAction(name, a.params, undefined, { ...(out.signal ? { signal: out.signal } : {}) });
  if (timeoutMs !== undefined) {
    // 命令行显式传 --timeout 时仅提示文件头也可声明，单次 runAction 已走文件头或默认上限
  }
  return presentOutcome(name, outcome, ctx, out, { mode: "action", params: a.params });
}

const RUN_HELP = `用法：${RUN_USAGE}
  单步：spr run <action> [--参数 值]（action 在 ~/.speedrun/action/<站点>/<名>.js，说明和参数在文件头，用 rg 找）。
  多步 / 批量 / 裁剪：spr run -e 'return Promise.all(["1","2"].map(id => action("xxx", { id })))' [--timeout 秒]（共用 1 个 run 窗口，内置 action()、sleep()，不留临时文件）。
  时间上限默认 115 秒，文件头 @timeout <秒> 或 -e 的 --timeout <秒> 可改。`;

/** 「结果」最多列这么多字：再长上下文会被撑爆。全文存进 run 窗口目录。 */
const RESULT_MAX = 20_000;
const PAGE_SENT_SHOW_MAX = 8;

function outcomeLines(name: string, outcome: Outcome, saveFull?: (json: string) => string): string[] {
  const lines: string[] = [];
  if (outcome.status === "success") {
    const json = JSON.stringify(outcome.result ?? null, null, 2);
    if (json.length <= RESULT_MAX) lines.push(`ok ${name}`, `结果：\n${indent(json)}`);
    else {
      const file = saveFull?.(json);
      lines.push(`ok ${name}`, `结果（截断了：一共 ${json.length} 字，只列前 ${RESULT_MAX} 字；${file ? `全文在 ${file}` : "全文没存下来"}。需要筛选或汇总时用 spr run -e 在返回前裁剪；用户确实要全部数据时，告诉用户文件位置）：\n${indent(json.slice(0, RESULT_MAX))}`);
    }
  } else {
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
  if (outcome.pageSent?.length) {
    const shown = outcome.pageSent.slice(0, PAGE_SENT_SHOW_MAX);
    const more = outcome.pageSent.length - shown.length;
    lines.push(`页面触发的非 GET 请求：\n${indent([...shown, ...(more > 0 ? [`…另有 ${more} 个，见窗口 timeline.jsonl`] : [])].join("\n"))}`);
  }
  return lines;
}

function finishRun(ctx: Ctx, name: string, outcome: Outcome): string[] {
  const lines: string[] = [];
  const win = outcome.runWindow;
  if (win) {
    const old = ctx.log.readMeta(win);
    if (old) {
      ctx.log.writeMeta(win, {
        ...old,
        status: outcome.status,
        ...(outcome.status === "failure" ? { error: errorOf(outcome) } : {}),
        ...(outcome.sent?.length ? { sent: outcome.sent } : {}),
        ...(outcome.pageSent?.length ? { pageSent: outcome.pageSent } : {}),
        ...(outcome.perf ? { perf: outcome.perf } : {}),
        ...(outcome.ops ? { ops: outcome.ops } : {}),
        endedAt: Date.now(),
      });
    }
    lines.push(`run 窗口目录：${ctx.log.winDir(win)}（窗口已关，日志留着）`);
  }
  if (outcome.status === "success") {
    const promoted = (outcome.drafts ?? []).filter((file) => promoteAction(file)).map((file) => actionSummary(file).name);
    if (promoted.length) lines.push(`已变成 verified：${promoted.join("、")}`);
  }
  if (outcome.status === "failure") {
    const target = outcome.failedAction ?? (name === "-e" ? "explore" : name);
    if (!win) lines.push(`下一步：改好参数或代码后重新运行`);
    else {
      const at = outcome.page?.url && !isWarm(outcome.page.url) ? outcome.page.url : "<网址>";
      lines.push(`下一步：看完整报错或请求日志定位原因；需要看真实页面时 spr debug ${target} navigate ${at}`);
    }
  }
  return lines;
}

function presentOutcome(name: string, outcome: Outcome, ctx: Ctx, out: Output, meta: { mode: "action" | "inline"; code?: string; params: Record<string, string> }): void {
  record(ctx, out, outcome, meta);
  if (outcome.status !== "success") out.code = outcome.code === "usage" ? EXIT.usage : EXIT.fail;
  const win = outcome.runWindow;
  const full = win && outcome.status === "success" ? ctx.log.abs(win, ctx.log.putFile(win, "result.json", JSON.stringify(outcome.result ?? null, null, 2))) : undefined;
  if (win && outcome.status === "failure") {
    ctx.log.putFile(win, "error.txt", [outcome.error, outcome.stack ? `\n--- 完整 stack ---\n${outcome.stack}` : ""].join(""));
    const evidence = requestEvidence(ctx, win, outcome);
    if (evidence) outcome.hint = outcome.hint ? `${evidence}\n${outcome.hint}` : evidence;
  }
  const lines = [...outcomeLines(name, outcome, () => full ?? ""), ...finishRun(ctx, name, outcome)];
  if (win && outcome.status === "failure") lines.splice(lines.findIndex((l) => l.startsWith("run 窗口目录")), 0, `完整报错：${ctx.log.abs(win, "error.txt")}`);
  for (const line of lines) out.line(line);
}

const isWarm = (url: string): boolean => /^https?:\/\/[^/]+\/robots\.txt$/.test(url);

function requestEvidence(ctx: Ctx, win: string, outcome: Extract<Outcome, { status: "failure" }>): string | undefined {
  if (!outcome.page?.url || !isWarm(outcome.page.url)) return undefined;
  const bad = ctx.log.readRows(win, { limit: 2000 }).filter((r: Row & { status?: number; error?: string; file?: string }) => r.type === "request" && r.src === "agent" && ((r.status ?? 0) >= 400 || r.error)).at(-1) as (Row & { status?: number; method?: string; url?: string; file?: string }) | undefined;
  const lead = "这次 run 没打开过页面（停在暖页面 robots.txt，没有截图）";
  if (!bad) return `${lead}；窗口里没有出错的请求，看完整报错`;
  return `${lead}；最后一个出错的请求：${bad.method ?? ""} ${bad.url ?? ""} → ${bad.status ?? "没发出去"}，请求和响应在 ${bad.file ? ctx.log.abs(win, bad.file) : ctx.log.winDir(win)}`;
}

function errorOf(outcome: Extract<Outcome, { status: "failure" }>): Record<string, unknown> {
  return { code: outcome.code ?? "internal", message: outcome.error.split("\n", 1)[0]!.slice(0, 500), ...(outcome.failedAction ? { action: outcome.failedAction } : {}), ...(outcome.at ? { at: outcome.at } : {}) };
}

function sanitizeCode(ctx: Ctx, code: string): string {
  return code.replace(/(?:([A-Za-z_][A-Za-z0-9_]*)\s*:\s*)?(["'])(?:\\.|(?!\2)[^\\\n])*\2/g, (whole, key: string | undefined, quote: string) => {
    const k = key ?? "_";
    const start = whole.indexOf(quote);
    const inner = whole.slice(start + 1, -1);
    const masked = ctx.ingest.sanitizer.headers({ [k]: inner })[k] ?? inner;
    return masked === inner ? whole : `${whole.slice(0, start)}${quote}${masked}${quote}`;
  });
}

function record(ctx: Ctx, out: Output, outcome: Outcome, meta: { mode: "action" | "inline"; code?: string; params: Record<string, string> }): void {
  const r = out.rec;
  r.mode = meta.mode;
  if (meta.mode === "inline" && meta.code !== undefined) {
    const safeCode = sanitizeCode(ctx, meta.code);
    r.code = safeCode.length > 500 ? `${safeCode.slice(0, 500)}…（共 ${safeCode.length} 字）` : safeCode;
  } else {
    r.params = Object.fromEntries(Object.entries(ctx.ingest.sanitizer.headers(meta.params)).map(([k, v]) => [k, v.length > 500 ? `${v.slice(0, 500)}…（共 ${v.length} 字）` : v]));
  }
  if (outcome.runWindow) r.window = outcome.runWindow;
  if (outcome.status === "success") {
    const json = JSON.stringify(outcome.result ?? null);
    const v = outcome.result;
    r.result = { bytes: json.length, ...(Array.isArray(v) ? { count: v.length } : {}), empty: v == null || (Array.isArray(v) && !v.length) || (typeof v === "object" && !Object.keys(v as object).length) || v === "" };
  }
  if (outcome.status === "failure") r.error = errorOf(outcome);
  if (outcome.calls?.length) r.calls = outcome.calls;
  if (outcome.sent?.length) r.sent = outcome.sent;
  if (outcome.pageSent?.length) r.pageSentCount = outcome.pageSent.length;
  if (outcome.perf) r.perf = outcome.perf;
  if (outcome.ops) r.ops = outcome.ops;
}
