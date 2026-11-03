import * as fs from "node:fs";
import * as path from "node:path";
import { EXIT } from "../protocol.ts";
import { HANDLE, type LearnWindow } from "../learn/windows.ts";
import { makeLearnGuide } from "../learn/guide.ts";
import { observe } from "../learn/observe.ts";
import { stepLine } from "../learn/explore.ts";
import { actionSummary, findAction, isComposed } from "../run/actions.ts";
import { normalizeSite } from "../record/digest.ts";
import { siteOfUrl } from "../utils/url.ts";
import { descriptionOf, parseArgs, valueOf, type ArgSpec } from "./args.ts";
import { DESCRIPTION_HINT, composeDirOf, idleMin, indent, type Ctx, type Output } from "./context.ts";
import { outcomeLines } from "./run.ts";

/** 页面操作之后等页面消息经扩展到 daemon 的时间。 */
const AFTER_OP_MS = 300;
/** 打开起点后等这么久再观察（加载期的请求）。 */
const LOAD_SETTLE_MS = 1_500;

const SUBS = new Set(["open", "screenshot", "click", "type", "key", "scroll", "observe", "run", "close"]);
const NEEDS_DESCRIPTION = new Set(["open", "click", "type", "key", "scroll", "run"]);
/** 计入操作次数的（成功后才计）。 */
const PAGE_OPS = NEEDS_DESCRIPTION;
const LEARN_USAGE = 'lore learn new --url <链接|tab 号> --description "要做的事"（打开 learn 窗口，返回句柄）；lore learn <句柄> open|screenshot|click|type|key|scroll|observe|run|close …；lore learn list（列出 learn 窗口）';

/** lore learn new …：打开；lore learn list：列出；lore learn <句柄> <操作>：在那个 learn 窗口里操作。学 action 都在这里，每一步都进日志，操作后附带一次观察。 */
export async function learnCommand(args: string[], ctx: Ctx, out: Output): Promise<void> {
  const [first, ...rest] = args;
  if (first === "new") return startLearn(rest, ctx, out);
  if (first === "list" && rest.length === 0) return listLearn(ctx, out);
  if (!first || first.startsWith("--")) return out.fail(`用法：${LEARN_USAGE}`);
  const [sub, ...more] = rest;
  if (!sub || !SUBS.has(sub)) {
    if (HANDLE.test(first)) return out.fail(`不认识的操作「${sub ?? ""}」。用法：${LEARN_USAGE}`);
    return out.fail(`「${first}」不是 learn 窗口的句柄。用法：${LEARN_USAGE}`);
  }
  return windowCommand(first, sub, more, ctx, out);
}

function listLearn(ctx: Ctx, out: Output): void {
  const all = ctx.learn.list();
  if (!all.length) return out.line(`ok 还没有 learn 窗口\n下一步：${LEARN_USAGE}`);
  out.line(`ok ${all.length} 个 learn 窗口（新的在前，最多列 10 个）`);
  for (const w of all.slice(0, 10)) out.line(`  ${w.id} ${w.open ? "开着" : "已关"} ${w.url} 操作 ${w.ops} 次，空闲 ${idleMin(w)} 分钟「${w.description}」`);
}

/** --url 的值：http(s) 链接原样用；`tab123` 或 `123` 是用户的标签页号（lore tabs 列出的），只取它的地址，不碰那个标签页。 */
async function resolveStartUrl(ctx: Ctx, given: string): Promise<{ url: string } | { error: string }> {
  const m = /^(?:tab)?(\d+)$/i.exec(given.trim());
  if (!m) return siteOfUrl(given) ? { url: given.trim() } : { error: `--url 要是 http(s) 链接，或 lore tabs 列出的标签页号（如 tab123），收到：${given}` };
  await ctx.ensureExtension();
  const tab = (await ctx.tabs()).find((t) => t.tabId === Number(m[1]) && !t.anchor && !ctx.win.isAgentTab(t.tabId));
  if (!tab) return { error: `没有标签页 ${given}：先 lore tabs 看用户的标签页，按标题、地址对出要的那个` };
  return siteOfUrl(tab.url) ? { url: tab.url } : { error: `标签页 ${given} 不是 http(s) 页面：${tab.url}` };
}

/**
 * lore learn new --url <链接|tab 号> --description "…"：打开一个 learn 窗口，返回句柄、窗口目录、learn 指引和起点的观察。
 * learn 指引写在 ~/.lore/learn-guide.md：内容变了（第一次、或升级后）才在输出里给全文，其余时候只给路径。
 */
async function startLearn(argv: string[], ctx: Ctx, out: Output): Promise<void> {
  const usage = `用法：${LEARN_USAGE}`;
  const a = parseArgs(argv, { values: ["url", "description"] });
  if ("error" in a) return out.fail(`${a.error}：learn 窗口只要 --url 和 --description。${usage}`);
  if (a.rest.length) return out.fail(`多余的参数：${a.rest.join(" ")}。${usage}`);
  const given = valueOf(a, "url");
  const description = descriptionOf(a);
  if (!given) return out.fail(`要带 --url（起点：链接，或 lore tabs 列出的标签页号）。${usage}`);
  if (!description) return out.fail(`要带 --description "要做的事"（用户的话，如"在知乎搜 agent，给硬核技术的回答点赞同"）。${usage}`);
  const start = await resolveStartUrl(ctx, given);
  if ("error" in start) return out.fail(start.error);
  await ctx.ensureExtension();
  const w = ctx.learn.create({ site: normalizeSite(siteOfUrl(start.url)), description, url: start.url });
  const { sess, opened } = await ctx.learn.page(w);
  await new Promise((r) => setTimeout(r, LOAD_SETTLE_MS));
  const obs = await observe(ctx, w, sess);
  ctx.learn.save(w);
  const guideFile = path.join(ctx.log.root, "learn-guide.md");
  const guide = makeLearnGuide({ learnDir: path.join(ctx.log.root, "learn-windows"), sitesDir: ctx.log.dir, composeDir: composeDirOf(ctx), libDir: path.join(ctx.log.root, "lib"), helpersDir: path.join(ctx.log.root, "helpers") });
  let fresh = true;
  try { fresh = fs.readFileSync(guideFile, "utf8") !== guide; } catch { /* 第一次 */ }
  if (fresh) fs.writeFileSync(guideFile, guide);
  out.line([
    `ok learn 窗口已打开：${w.id}`,
    `句柄：${w.id}（之后的命令：lore learn ${w.id} <操作>）`,
    `要做的事：${description}`,
    `窗口目录：${ctx.log.winDir(w.id)}`,
    `learn 指引：${guideFile}${fresh ? "（第一次给出或有更新，全文在最后）" : "（开始前先读一遍）"}`,
    ...(opened ? [`起点：${opened.url} "${opened.title}"`] : []),
    obs,
    ...(fresh ? ["", guide] : []),
  ].join("\n"));
}

const SPECS: Record<string, ArgSpec> = {
  observe: { values: ["description"], switches: ["all"] },
  run: { values: ["action", "description"], params: true },
};

async function windowCommand(id: string, sub: string, argv: string[], ctx: Ctx, out: Output): Promise<void> {
  const a = parseArgs(argv, SPECS[sub] ?? { values: ["description"] });
  if ("error" in a) return out.fail(a.error);
  const description = descriptionOf(a);
  const counted = PAGE_OPS.has(sub);
  const found = counted ? ctx.learn.forOp(id) : ctx.learn.get(id) ?? { error: `没有 learn 窗口 ${id}：lore learn list 列出有哪些` };
  if ("error" in found) return out.fail(found.error);
  const w: LearnWindow = found;
  if (NEEDS_DESCRIPTION.has(sub) && !description) return out.fail(`learn ${id} ${sub} ${DESCRIPTION_HINT}`);
  if (sub === "close") {
    if (!w.open) return out.line(`ok learn 窗口 ${id} 的 Chrome 窗口已经关了\n窗口目录：${ctx.log.winDir(id)}`);
    await ctx.learn.close(w);
    return out.line(`ok 已关掉 learn 窗口 ${id}\n窗口目录：${ctx.log.winDir(id)}（句柄和目录保留，再对它操作会从 ${w.url} 重新打开）`);
  }
  if (sub === "observe") {
    if (w.open) await ctx.ensureExtension();
    const text = await observe(ctx, w, ctx.learn.session(id), undefined, a.switches.has("all"));
    ctx.learn.save(w);
    return out.line(`ok 观察 ${id}\n${text}`);
  }
  // 先检查参数，再碰浏览器
  let target: { name: string; params: Record<string, string>; site?: string; endpoints: string[] } | undefined;
  if (sub === "open" && !a.rest[0]) return out.fail(`用法：lore learn ${id} open <网址> --description "…"`);
  if (sub === "run") {
    const name = valueOf(a, "action");
    if (!name) return out.fail(`用法：lore learn ${id} run --action <名> [--参数 值] --description "…"`);
    const found = findAction(ctx.log.dir, name, composeDirOf(ctx));
    if (!found) return out.fail(`action 不存在：${name}（在 ${ctx.log.dir}/<站点>/actions/ 下）`);
    const summary = actionSummary(found.file, found.site);
    if (isComposed(summary)) return out.fail(`${name} 是 compose：用 lore run --compose ${name} 跑`);
    target = { name, params: a.params, site: found.site, endpoints: summary.endpoints };
  }
  const parsed = sub in { click: 1, type: 1, key: 1, scroll: 1 } ? parsePointer(sub, a.rest) : undefined;
  if (parsed && "error" in parsed) return out.fail(parsed.error);

  await ctx.ensureExtension();
  const head: string[] = [];
  const { sess, opened } = await ctx.learn.page(w);
  if (opened) head.push(`重新打开：${opened.url} "${opened.title}"（Chrome 窗口之前关了，页面状态没了，回到了上次的 URL）`);
  w.lastActive = Date.now();
  let first = `ok ${sub}`;
  const body: string[] = [];
  if (sub === "screenshot") {
    const shot = (await ctx.host.op(sess, "screenshot", {})) as { data: string; mime: string; w: number; h: number };
    const rel = ctx.log.putFile(id, `screenshots/${String(ctx.log.reserve()).padStart(6, "0")}-screenshot.${shot.mime.includes("png") ? "png" : "jpg"}`, Buffer.from(shot.data, "base64"));
    ctx.learn.save(w);
    return out.line([`ok 截图 ${shot.w}×${shot.h}`, ...head, `文件：${ctx.log.abs(id, rel)}（用读图片的方式看；图上的像素坐标就是 click / scroll 的坐标，左上角 (0,0)；页面变了要重新截）`].join("\n"));
  }
  if (sub === "open") {
    const res = (await ctx.host.op(sess, "goto", { url: a.rest[0], description })) as { url: string; title: string };
    first = `ok 已打开 ${res.url}`;
  } else if (target) {
    const o = await ctx.runner.runInLearn(target.name, target.params, sess);
    if (o.status !== "success") out.code = EXIT.fail;
    else if (target.site) for (const ep of target.endpoints) ctx.index.describe(target.site, ep, { text: description!, from: "learn" });
    const lines = o.status === "ask" ? [`fail ${target.name}：action 里不能用 lore.ask`, ...(o.writes?.length ? [`已发出的 write 请求：\n${indent(o.writes.join("\n"))}`] : [])] : outcomeLines(target.name, o);
    first = lines[0]!;
    body.push(...lines.slice(1));
  } else if (parsed) {
    const res = (await ctx.host.op(sess, "pointer", { ...parsed.cmd, settle: true, description })) as { navigated?: boolean; url?: string; title?: string; loc?: unknown; scrollY?: number; settle?: { settled: boolean; waitedMs: number } };
    if (res.loc) body.push(`定位：${JSON.stringify(res.loc)}`);
    if (res.scrollY !== undefined) body.push(`滚动位置：${res.scrollY}`);
    if (res.settle) body.push(res.settle.settled ? `稳定：页面已稳定，等了 ${(res.settle.waitedMs / 1000).toFixed(1)}s` : "稳定：等了很久页面还在变化");
    if (res.navigated) body.push(`跳转：${res.url ?? ""} "${res.title ?? ""}"`);
    const step = stepLine(parsed.cmd, res.loc);
    if (step) body.push(`草稿：${step}`);
  }
  if (counted) w.ops++;
  await new Promise((r) => setTimeout(r, AFTER_OP_MS));
  const obs = await observe(ctx, w, sess, description);
  ctx.learn.save(w);
  out.line([first, ...head, ...body, obs].join("\n"));
}

export type PointerCmd = { kind: string; x?: number; y?: number; text?: string; key?: string; dx?: number; dy?: number; to?: string };

const NUM = /^-?\d+(\.\d+)?$/;

/** 解析按坐标的操作：click <x> <y> | type "文字" | key <键> | scroll down|up [像素] [x y] | scroll top|bottom [x y]。 */
export function parsePointer(kind: string, args: string[]): { cmd: PointerCmd } | { error: string } {
  switch (kind) {
    case "click": {
      if (args.length !== 2 || !args.every((a) => NUM.test(a))) return { error: "用法：lore learn <句柄> click <x> <y>（坐标取自截图，像素，左上角 (0,0)）" };
      return { cmd: { kind, x: Number(args[0]), y: Number(args[1]) } };
    }
    case "type": {
      if (!args.length) return { error: "用法：lore learn <句柄> type \"文字\"（输入到当前获得焦点的输入框，先 click 输入框）" };
      return { cmd: { kind, text: args.join(" ") } };
    }
    case "key": {
      if (!args[0]) return { error: "用法：lore learn <句柄> key Enter（组合键如 Ctrl+K、Cmd+A，作用在当前获得焦点的元素上）" };
      return { cmd: { kind, key: args[0] } };
    }
    case "scroll": {
      const dir = args[0];
      if (!dir || !["down", "up", "top", "bottom"].includes(dir)) return { error: "用法：lore learn <句柄> scroll down|up [像素] [x y] | scroll top|bottom [x y]（给了 x y 就滚动那个位置所在的可滚动区域，否则滚整页）" };
      const rest = args.slice(1);
      const amount = (dir === "down" || dir === "up") && rest[0] !== undefined && rest.length !== 2 && NUM.test(rest[0]) ? Number(rest.shift()) : 600;
      if (rest.length !== 0 && !(rest.length === 2 && rest.every((a) => NUM.test(a)))) return { error: "滚动的位置要写成 x y 两个数" };
      const at = rest.length === 2 ? { x: Number(rest[0]), y: Number(rest[1]) } : {};
      if (dir === "top" || dir === "bottom") return { cmd: { kind, to: dir, ...at } };
      return { cmd: { kind, dy: dir === "up" ? -amount : amount, ...at } };
    }
    default: return { error: `用法：${LEARN_USAGE}` };
  }
}
