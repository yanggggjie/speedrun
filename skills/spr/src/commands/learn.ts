import * as fs from "node:fs";
import * as path from "node:path";
import { EXIT } from "../protocol.ts";
import { HANDLE, type LearnWindow } from "../learn/windows.ts";
import { makeLearnGuide } from "../learn/guide.ts";
import { observe } from "../learn/observe.ts";
import { actionSummary, findAction, isCompose } from "../run/actions.ts";
import { normalizeSite } from "../record/digest.ts";
import { siteDirName, siteOfUrl } from "../utils/url.ts";
import { descriptionOf, parseArgs, valueOf, type ArgSpec } from "./args.ts";
import { DESCRIPTION_HINT, composeDirOf, idleMin, indent, pageContent, type Ctx, type Output } from "./context.ts";
import { outcomeLines } from "./run.ts";
import type { Session } from "../browser/host.ts";
import type { Row } from "../record/types.ts";


/** learn 窗口里的工具：和 Claude in Chrome 同名、同参数、同语义（read_page、find、get_page_text、computer、form_input、navigate），加一个 speedrun 自有的 try_action。 */
const TOOLS = new Set(["read_page", "find", "get_page_text", "computer", "form_input", "navigate", "try_action"]);
/** 只看不动的工具（不计次数、不要 --description、不附带观察）。 */
const LOOK_TOOLS = new Set(["read_page", "find", "get_page_text"]);
/** computer 里只看不动的（不计次数、不要 --description）：screenshot、zoom 不附带观察；wait 等完附带一次观察（等晚到的请求就用它）。 */
const LOOK_ONLY = new Set(["screenshot", "zoom", "wait"]);
const LEARN_USAGE = 'spr learn new --url <链接|tab 号> --description "要做的事"（打开 learn 窗口，返回句柄）；spr learn list；spr learn close <句柄>；spr learn <句柄> read_page | find "<查询>" | get_page_text | computer <action> … | form_input <ref> <值> | navigate <网址|back|forward> | try_action <名> [--参数 值]';
export const LEARN_HELP = `${LEARN_USAGE}
  只看不动（不要 --description，不计次数）：read_page [--filter interactive|all] [--depth 15] [--ref ref_N] [--max-chars 50000]、find "<查询>"、get_page_text [--max 20000]、computer screenshot | zoom <x0> <y0> <x1> <y1> | wait <秒>
  会改变页面（要带 --description）：computer left_click | right_click | double_click | triple_click | hover | left_click_drag | scroll | scroll_to | type | key …（坐标或 --ref ref_N）、form_input <ref_N> <值>、navigate <网址|back|forward>、try_action <名> [--参数 值]
  同一个句柄上一次只能有一条命令：上一条还没返回时，后到的直接报错。`;

/** spr learn new …：打开；spr learn list：列出；spr learn close <句柄>：关掉；spr learn <句柄> <工具>：在那个 learn 窗口里探索。学 action 都在这里，每一步都进日志，改变页面的操作后附带一次观察。 */
export async function learnCommand(args: string[], ctx: Ctx, out: Output): Promise<void> {
  const [first, ...rest] = args;
  if (first === "new") return startLearn(rest, ctx, out);
  if (first === "list") {
    if (rest.length) return out.usage(`spr learn list 不接受参数，收到：${rest.join(" ")}`);
    return listLearn(ctx, out);
  }
  if (first === "close") {
    if (rest.length !== 1) return out.usage(`用法：spr learn close <句柄>`);
    return closeLearn(rest[0]!, ctx, out);
  }
  if (first === "--help" || first === "-h") { out.line(`ok ${LEARN_HELP}`); return; }
  if (!first || first.startsWith("--")) return out.usage(`用法：${LEARN_USAGE}`);
  const [sub, ...more] = rest;
  if (!sub || !TOOLS.has(sub)) {
    if (HANDLE.test(first)) return out.usage(`不认识的操作「${sub ?? ""}」。用法：${LEARN_USAGE}`);
    return out.usage(`「${first}」不是 learn 窗口的句柄。用法：${LEARN_USAGE}`);
  }
  return windowCommand(first, sub, more, ctx, out);
}

function listLearn(ctx: Ctx, out: Output): void {
  const all = ctx.learn.list();
  const logs = `关掉的窗口只能看日志：${path.join(ctx.log.root, "learn-windows")}/<句柄>/`;
  if (!all.length) return out.line(`ok 没有开着的 learn 窗口（${logs}）\n下一步：${LEARN_USAGE}`);
  out.line(`ok ${all.length} 个开着的 learn 窗口（新的在前，最多列 10 个；${logs}）`);
  for (const w of all.slice(0, 10)) out.line(`  ${w.id} ${w.url} 操作 ${w.ops} 次，空闲 ${idleMin(w)} 分钟「${w.description}」`);
}

/** --url 的值：http(s) 链接原样用；`tab123` 或 `123` 是用户的标签页号（spr tabs 列出的），只取它的地址，不碰那个标签页。 */
async function resolveStartUrl(ctx: Ctx, given: string): Promise<{ url: string } | { error: string }> {
  const m = /^(?:tab)?(\d+)$/i.exec(given.trim());
  if (!m) return siteOfUrl(given) ? { url: given.trim() } : { error: `--url 要是 http(s) 链接，或 spr tabs 列出的标签页号（如 tab123），收到：${given}` };
  await ctx.ensureExtension();
  const tab = (await ctx.tabs()).find((t) => t.tabId === Number(m[1]) && !t.speedrun);
  if (!tab) return { error: `没有标签页 ${given}：先 spr tabs 看用户的标签页，按标题、地址对出要的那个` };
  return siteOfUrl(tab.url) ? { url: tab.url } : { error: `标签页 ${given} 不是 http(s) 页面：${tab.url}` };
}

/**
 * spr learn new --url <链接|tab 号> --description "…"：打开一个 learn 窗口，返回句柄、窗口目录、learn 指引和起点的观察。
 * learn 指引写在 ~/.speedrun/learn-guide.md：内容变了（第一次、或升级后）才在输出里给全文，其余时候只给路径。
 */
async function startLearn(argv: string[], ctx: Ctx, out: Output): Promise<void> {
  const usage = `用法：${LEARN_USAGE}`;
  const a = parseArgs(argv, { values: ["url", "description"] });
  if ("error" in a) return out.usage(`${a.error}：learn 窗口只要 --url 和 --description。${usage}`);
  if (a.rest.length) return out.usage(`多余的参数：${a.rest.join(" ")}。${usage}`);
  const given = valueOf(a, "url");
  const description = descriptionOf(a);
  if (!given) return out.usage(`要带 --url（起点：链接，或 spr tabs 列出的标签页号）。${usage}`);
  if (!description) return out.usage(`要带 --description "要做的事"（用户的话，如"在知乎搜 agent，给硬核技术的回答点赞同"）。${usage}`);
  const start = await resolveStartUrl(ctx, given);
  if ("error" in start) return out.usage(start.error);
  await ctx.ensureExtension();
  const w = ctx.learn.create({ site: normalizeSite(siteOfUrl(start.url)), description, url: start.url });
  const { sess, opened } = await ctx.learn.page(w);
  await ctx.host.quiet(sess); // 起点加载期的请求都到了再观察
  const obs = await observe(ctx, w, sess);
  ctx.learn.save(w);
  const guideFile = path.join(ctx.log.root, "learn-guide.md");
  const guide = makeLearnGuide({ learnDir: path.join(ctx.log.root, "learn-windows"), sitesDir: ctx.log.dir, composeDir: composeDirOf(ctx), libDir: path.join(ctx.log.root, "lib"), helpersDir: path.join(ctx.log.root, "helpers") });
  let fresh = true;
  try { fresh = fs.readFileSync(guideFile, "utf8") !== guide; } catch { /* 第一次 */ }
  if (fresh) fs.writeFileSync(guideFile, guide);
  out.line([
    `ok learn 窗口已打开：${w.id}`,
    `句柄：${w.id}（之后的命令：spr learn ${w.id} <工具>，工具和 Claude in Chrome 一样：read_page、find、get_page_text、computer、form_input、navigate，再加 try_action）`,
    `要做的事：${description}`,
    `窗口目录：${ctx.log.winDir(w.id)}`,
    `learn 指引：${guideFile}${fresh ? "（第一次给出或有更新，全文在最后）" : "（开始前先读一遍）"}`,
    "注意：这里的工具只在 learn 窗口里探索、触发页面行为，让 speedrun 录到请求、学出 action；用户要的结果只能来自 spr run，不要把在这里看到的直接交给用户",
    ...(opened ? [`起点：${opened.url} "${opened.title}"`] : []),
    obs,
    ...(fresh ? ["", guide] : []),
  ].join("\n"));
}

const SPECS: Record<string, ArgSpec> = {
  computer: { values: ["description", "scale", "modifiers", "repeat", "ref", "to"] },
  read_page: { values: ["filter", "depth", "ref", "max-chars"] },
  find: { values: [] },
  get_page_text: { values: ["max"] },
  form_input: { values: ["description"] },
  try_action: { values: ["description"], params: true },
};

async function closeLearn(id: string, ctx: Ctx, out: Output): Promise<void> {
  const w = ctx.learn.get(id);
  if (!w) {
    if (ctx.log.kindOf(id) === "learn") return out.line(`ok learn 窗口 ${id} 已经关了\n窗口目录：${ctx.log.winDir(id)}（只能看日志）`);
    return out.usage(`没有 learn 窗口 ${id}：spr learn list 列出开着的`);
  }
  await ctx.learn.close(w);
  const delivered = ctx.log.runsSince(w.createdAt).some((m) => m.status === "success");
  out.line([`ok 已关掉 learn 窗口 ${id}`, `窗口目录：${ctx.log.winDir(id)}（日志留着；这个句柄不能再操作，要接着学就 spr learn new 开新窗口）`, ...(delivered ? [] : ["下一步：这个窗口学到的还没用 spr run 交付过：用户要的结果要来自 spr run（把要的请求写成 action，写成 compose，spr run <名字>）"])].join("\n"));
}

/**
 * 同一个句柄一次只跑一条命令：几条同时到（agent 并行发了几个 Bash 调用）时，后到的直接报错，不排队，
 * 否则操作在同一个页面上交错，观察的游标也会把一条命令引发的请求算到另一条头上。
 */
async function windowCommand(id: string, sub: string, argv: string[], ctx: Ctx, out: Output): Promise<void> {
  if (!ctx.learn.claim(id)) return out.fail(`learn 窗口 ${id} 上一条命令还没结束：等它返回后再发（同一个句柄上的命令要一条一条发，不要并行）`);
  try {
    return await windowCommandInner(id, sub, argv, ctx, out);
  } finally {
    ctx.learn.release(id);
  }
}

async function windowCommandInner(id: string, sub: string, argv: string[], ctx: Ctx, out: Output): Promise<void> {
  const a = parseArgs(argv, SPECS[sub] ?? { values: ["description"] });
  if ("error" in a) return out.usage(a.error);
  const description = descriptionOf(a);
  // 先检查参数，再碰浏览器
  let computer: ComputerCmd | undefined;
  if (sub === "computer") {
    const parsed = parseComputer(a.rest, { scale: valueOf(a, "scale"), modifiers: valueOf(a, "modifiers"), repeat: valueOf(a, "repeat"), ref: valueOf(a, "ref"), to: valueOf(a, "to") });
    if ("error" in parsed) return out.usage(parsed.error);
    computer = parsed.cmd;
  }
  let look: Record<string, unknown> | undefined;
  if (sub === "read_page") {
    const filter = valueOf(a, "filter") ?? "all";
    if (filter !== "all" && filter !== "interactive") return out.usage("--filter 是 interactive 或 all");
    const depth = Number(valueOf(a, "depth") ?? 15), maxChars = Number(valueOf(a, "max-chars") ?? 50_000);
    if (!(depth >= 1 && depth <= 100) || !(maxChars >= 1000)) return out.usage("--depth 是 1 到 100，--max-chars 至少 1000");
    const ref = valueOf(a, "ref");
    if (ref !== undefined && !REF.test(ref)) return out.usage(`--ref 要写成 ref_数字（read_page、find 给出的），收到：${ref}`);
    if (a.rest.length) return out.usage(`多余的参数：${a.rest.join(" ")}。用法：spr learn ${id} read_page [--filter interactive|all] [--depth 15] [--ref ref_N] [--max-chars 50000]`);
    look = { filter, depth, maxChars, ...(ref ? { ref } : {}) };
  } else if (sub === "find") {
    if (!a.rest.length) return out.usage(`用法：spr learn ${id} find "<查询>"（按目的或文字找，如 "搜索框"、"评论"）`);
    look = { query: a.rest.join(" ") };
  } else if (sub === "get_page_text") {
    const max = Number(valueOf(a, "max") ?? 20_000);
    if (!(max >= 100)) return out.usage("--max 至少 100");
    if (a.rest.length) return out.usage(`多余的参数：${a.rest.join(" ")}。用法：spr learn ${id} get_page_text [--max 20000]`);
    look = { max };
  }
  let form: { ref: string; value: string } | undefined;
  if (sub === "form_input") {
    const [ref, ...value] = a.rest;
    if (!ref || !REF.test(ref) || !value.length) return out.usage(`用法：spr learn ${id} form_input <ref_N> <值> --description "…"（文本框写文字，下拉框写选项文字或值，复选框写 true / false）`);
    form = { ref, value: value.join(" ") };
  }
  const lookOnly = LOOK_TOOLS.has(sub) || (computer !== undefined && LOOK_ONLY.has(computer.action));
  const counted = !lookOnly;
  const found = ctx.learn.forOp(id, counted);
  if ("error" in found) return found.usage ? out.usage(found.error) : out.fail(found.error);
  const w: LearnWindow = found;
  if (counted && !description) return out.usage(`learn ${id} ${sub}${computer ? ` ${computer.action}` : ""} ${DESCRIPTION_HINT}`);
  let target: { name: string; params: Record<string, string>; site?: string; endpoints: string[] } | undefined;
  if (sub === "navigate" && !a.rest[0]) return out.usage(`用法：spr learn ${id} navigate <网址|back|forward> --description "…"`);
  if (sub === "try_action") {
    const name = a.rest[0];
    if (!name || a.rest.length > 1) return out.usage(`用法：spr learn ${id} try_action <名> [--参数 值] --description "…"`);
    const found = findAction(ctx.log.dir, name, composeDirOf(ctx));
    if (!found) return out.usage(`action 不存在：${name}（在 ${ctx.log.dir}/<站点>/actions/ 下）`);
    const summary = actionSummary(found.file, found.site);
    if (isCompose(found)) return out.usage(`${name} 是 compose：用 spr run ${name} --description "…" 跑`);
    target = { name, params: a.params, site: found.site, endpoints: summary.endpoints };
  }

  await ctx.ensureExtension();
  const head: string[] = [];
  const { sess } = await ctx.learn.page(w);
  w.lastActive = Date.now();
  const shotFile = async (kind: string, args: { region?: number[]; scale?: number } = {}): Promise<{ file: string; w: number; h: number; vw: number; vh: number }> => {
    const shot = (await ctx.host.op(sess, "screenshot", args)) as { data: string; mime: string; w: number; h: number; vw: number; vh: number };
    const rel = ctx.log.putFile(id, `screenshots/${String(ctx.log.reserve()).padStart(6, "0")}-${kind}.${shot.mime.includes("png") ? "png" : "jpg"}`, Buffer.from(shot.data, "base64"));
    return { file: ctx.log.abs(id, rel), w: shot.w, h: shot.h, vw: shot.vw, vh: shot.vh };
  };
  if (computer?.action === "screenshot" || computer?.action === "zoom") {
    const zoom = computer.action === "zoom";
    const shot = await shotFile(computer.action, { ...(zoom ? { region: computer.region } : {}), ...(computer.scale ? { scale: computer.scale } : {}) });
    ctx.learn.save(w);
    const how = zoom ? `区域 [${computer.region!.join(", ")}] 放大看；图上的坐标不是页面坐标，点的时候用这个区域在整页截图里的坐标` : computer.scale ? `缩小到 ${computer.scale}；坐标仍按视口 ${shot.vw}×${shot.vh} 算（图上的坐标除以 ${computer.scale}）` : "图上的像素坐标就是 computer 操作的坐标，左上角 (0,0)";
    return out.line([`ok ${computer.action} ${shot.w}×${shot.h}`, ...head, `文件：${shot.file}（用读图片的方式看；${how}；页面变了要重新截）`].join("\n"));
  }
  if (look) {
    const lines = await lookTool(ctx, w, sess, sub, look);
    ctx.learn.save(w);
    return out.line([lines[0]!, ...head, ...lines.slice(1)].join("\n"));
  }
  let first = `ok ${sub}${computer ? ` ${computer.action}` : ""}`;
  const body: string[] = [];
  if (sub === "navigate") {
    const res = (await ctx.host.op(sess, "navigate", { url: a.rest[0], description })) as { url: string; title: string };
    first = `ok 已打开 ${res.url} "${res.title}"`;
  } else if (target) {
    const o = await ctx.runner.runInLearn(target.name, target.params, sess);
    if (o.status !== "success") out.code = EXIT.fail;
    else if (target.site) for (const ep of target.endpoints) ctx.index.describe(target.site, ep, { text: description!, from: "learn" });
    const lines = o.status === "ask" ? [`fail ${target.name}：action 里不能用 spr.ask`, ...(o.sent?.length ? [`已发出的非 GET 请求：\n${indent(o.sent.join("\n"))}`] : [])] : outcomeLines(target.name, o);
    first = lines[0]!;
    body.push(...lines.slice(1));
  } else if (computer?.action === "wait") {
    const done = sess.tab !== undefined ? ctx.win.busy(sess.tab) : () => {}; // 等的时候页面要一直在渲染（组不算闲置）
    try { await new Promise((r) => setTimeout(r, computer!.seconds! * 1000)); } finally { done(); }
    first = `ok wait ${computer.seconds}s`;
  } else {
    const { action, ...rest } = computer ?? { action: "form_input" };
    const res = (await ctx.host.op(sess, "input", { action, ...rest, ...(form ? { ref: form.ref, value: form.value } : {}), description })) as InputResult;
    body.push(...inputLines(res, action));
  }
  if (counted) w.ops++;
  // 等页面安静、这一步引发的记录都到 daemon，再观察
  const q = await ctx.host.quiet(sess);
  body.push(q.settled ? `稳定：页面已安静，等了 ${(q.waitedMs / 1000).toFixed(1)}s` : `稳定：等了 ${(q.waitedMs / 1000).toFixed(1)}s 页面还在变化（晚到的请求用 computer wait 等一会儿再看）`);
  if (computer?.action === "scroll") body.push(`截图：${(await shotFile("scroll")).file}（滚动之后的样子）`);
  const obs = await observe(ctx, w, sess, description);
  // 操作了很多次还没写 action：提醒一次（这里只是探索，结果要来自 spr run）
  const nudge = counted && w.ops % NUDGE_EVERY === 0 && !obs.includes("\n下一步：") && !actionsNewerThan(ctx.log.dir, w.site, w.createdAt)
    ? [`下一步：已经操作 ${w.ops} 次，还没有写 action。看到的东西不能直接交给用户：把要的请求写成 action（读不了的写成 DOM action），spr run 交付`] : [];
  ctx.learn.save(w);
  out.line([first, ...head, ...body, obs, ...nudge].join("\n"));
}

const REF = /^ref_\d+$/;

/** 只看不动的工具：read_page（全文存进 pages/，时间线记一行 snap a11y）、find、get_page_text。 */
async function lookTool(ctx: Ctx, w: LearnWindow, sess: Session, tool: string, args: Record<string, unknown>): Promise<string[]> {
  if (tool === "read_page") {
    const r = (await ctx.host.op(sess, "read_page", args)) as { url: string; title: string; text: string; count: number; truncated: boolean; viewport: number[] };
    const seq = ctx.log.reserve();
    const rel = ctx.log.putFile(w.id, `pages/${String(seq).padStart(6, "0")}-a11y.txt`, `${r.url}\n${r.title}\n\n${r.text}`);
    ctx.log.append({ seq, t: Date.now(), win: w.id, site: siteOfUrl(r.url) || w.site, src: "agent", tab: sess.tab ?? 0, type: "snap", kind: "a11y", target: `"${r.title.slice(0, 40)}" ${r.count}`, page: r.url.split("?")[0], file: rel } as Row);
    const what = args.filter === "interactive" ? "交互元素" : "元素";
    return [
      `ok read_page ${what} ${r.count} 个（全文：${ctx.log.abs(w.id, rel)}）`,
      `页面：${r.url} "${r.title}"（视口 ${r.viewport.join("×")}）`,
      ...(r.text.trim() ? pageContent([r.text.trimEnd()]) : ["（没有可列的元素：页面可能还在加载，computer wait 2 再看；或者内容在 iframe 里）"]),
      ...(r.truncated ? [`（超过 ${args.maxChars} 字，截断了：用 --ref 只看某一块，或 --filter interactive、--depth 小一点）`] : []),
      "下一步：用 ref 操作（computer left_click --ref ref_N、form_input ref_N 值），ref 只在这个页面里有效；写 action 用操作输出的「定位：」",
    ];
  }
  if (tool === "find") {
    const r = (await ctx.host.op(sess, "find", args)) as { more: number; items: Array<{ ref: string; role: string; name: string; x: number; y: number; offViewport: boolean; loc: unknown }> };
    if (!r.items.length) return [`ok find 没有找到「${args.query}」`, "下一步：换个说法（页面上的原文、控件类型如 textbox / button），或 read_page --filter interactive 看全部"];
    return [
      `ok find ${r.items.length} 个${r.more ? `（还有 ${r.more} 个没列，写得更具体些）` : ""}`,
      ...pageContent(r.items.map((e) => `  ${e.ref} ${e.role} "${e.name}" (${e.x},${e.y})${e.offViewport ? " 视口外" : ""}  定位：${JSON.stringify(e.loc)}`)),
    ];
  }
  const r = (await ctx.host.op(sess, "get_page_text", args)) as { url: string; title: string; source: string; total: number; text: string };
  return [`ok get_page_text ${r.total} 字（取自 ${r.source}${r.total > r.text.length ? `，截断了，只列前 ${r.text.length} 字：要更多用 --max 调大` : ""}）`, `页面：${r.url} "${r.title}"`, ...pageContent([r.text])];
}

/** 输入的结果（host 的 input）。 */
type InputResult = { target?: Target; loc?: unknown; warning?: string; covered?: string; scrolled?: boolean; dropTarget?: Target; scrollY?: number; navigated?: boolean; url?: string; title?: string; value?: string; checked?: boolean; password?: boolean; chars?: number };

function inputLines(res: InputResult, action: string): string[] {
  const out: string[] = [];
  if (res.target) out.push(`落在：${describeTarget(res.target)}${res.scrolled ? "（先滚进了视口）" : ""}`);
  if (res.covered) out.push(`被遮挡：目标被 ${res.covered} 盖住，点击落在了它上面`);
  if (res.loc) out.push(`定位：${JSON.stringify(res.loc)}（写 action 时放进 ${action === "form_input" ? "form_input(定位, 值)" : action === "hover" ? "hover(定位)" : action === "scroll_to" ? "scroll_to(定位)" : action === "key" ? 'key("…", { loc: 定位 })' : "click(定位)"}）`);
  if (res.warning) out.push(`提醒：${res.warning}`);
  if (res.dropTarget) out.push(`松开在：${describeTarget(res.dropTarget)}`);
  if (res.value !== undefined) out.push(`值：${res.value}`);
  if (res.checked !== undefined) out.push(`勾选：${res.checked}`);
  if (res.scrollY !== undefined) out.push(`滚动位置：${res.scrollY}`);
  if (res.navigated) out.push(`跳转：${res.url ?? ""} "${res.title ?? ""}"`);
  return out;
}

/** 页面脚本描述的元素（common.js 的 T.desc）。 */
type Target = { tag: string; role?: string | null; type?: string | null; text?: string } | string;
const describeTarget = (t: Target): string => (typeof t === "string" ? t : `<${t.tag}${t.role ? ` role=${t.role}` : ""}${t.type && t.tag === "input" ? ` type=${t.type}` : ""}>${t.text ? ` "${t.text}"` : ""}`);

/** 每操作这么多次检查一下有没有写 action。 */
const NUDGE_EVERY = 15;

/** 这个站点的 actions/ 里有没有比 t 新的文件（这个窗口打开以后写过、改过 action）。 */
function actionsNewerThan(sitesDir: string, site: string, t: number): boolean {
  const dir = path.join(sitesDir, siteDirName(site), "actions");
  try { return fs.readdirSync(dir).some((f) => f.endsWith(".js") && fs.statSync(path.join(dir, f)).mtimeMs > t); } catch { return false; }
}

/** computer 的一个动作，参数照工具的 schema：坐标是截图上的 CSS 像素。 */
export type ComputerCmd = {
  action: string;
  x?: number; y?: number; sx?: number; sy?: number;
  /** --ref ref_N：read_page / find 给出的元素，代替坐标；--to ref_N：拖拽的终点。 */
  ref?: string; toRef?: string;
  text?: string; keys?: string; repeat?: number;
  direction?: string; amount?: number;
  region?: number[]; scale?: number; seconds?: number;
  mods?: Record<string, boolean>;
};

const NUM = /^-?\d+(\.\d+)?$/;
const ACTIONS = ["screenshot", "zoom", "left_click", "right_click", "double_click", "triple_click", "hover", "left_click_drag", "type", "key", "scroll", "scroll_to", "wait"];
const MOD_NAMES: Record<string, string> = { cmd: "cmd", command: "cmd", meta: "cmd", ctrl: "ctrl", control: "ctrl", alt: "alt", option: "alt", shift: "shift" };

/**
 * 解析 computer <action> …（和 computer 工具一一对应）：
 * screenshot [--scale s] | zoom <x0> <y0> <x1> <y1> [--scale s] | left_click|right_click|double_click|triple_click|hover (<x> <y> | --ref ref_N) [--modifiers cmd+shift]
 * | left_click_drag (<sx> <sy> <x> <y> | --ref ref_A --to ref_B) | type "文字" | key "<键 键…>" [--repeat n] | scroll (<x> <y> | --ref ref_N) <up|down|left|right> [格数]
 * | scroll_to (<x> <y> | --ref ref_N) | wait <秒>
 */
export function parseComputer(args: string[], opts: { scale?: string; modifiers?: string; repeat?: string; ref?: string; to?: string } = {}): { cmd: ComputerCmd } | { error: string } {
  const [action, ...rest] = args;
  const usage = (u: string): { error: string } => ({ error: `用法：spr learn <句柄> computer ${u}（坐标取自截图，CSS 像素，左上角 (0,0)；或用 --ref ref_N 指 read_page / find 给出的元素）` });
  for (const [flag, v] of [["ref", opts.ref], ["to", opts.to]] as const) if (v !== undefined && !/^ref_\d+$/.test(v)) return { error: `--${flag} 要写成 ref_数字（read_page、find 给出的），收到：${v}` };
  const ref = opts.ref;
  if (!action || !ACTIONS.includes(action)) return { error: `computer 的 action 是 ${ACTIONS.join("、")} 之一，收到：${action ?? "（空）"}` };
  const nums = (n: number): number[] | undefined => (rest.length === n && rest.every((v) => NUM.test(v)) ? rest.map(Number) : undefined);
  let mods: Record<string, boolean> | undefined;
  if (opts.modifiers !== undefined) {
    mods = {};
    for (const p of opts.modifiers.split("+").filter(Boolean)) { const m = MOD_NAMES[p.toLowerCase()]; if (!m) return { error: `不认识的修饰键「${p}」：--modifiers 用 cmd、ctrl、alt、shift，用 + 连接` }; mods[m] = true; }
  }
  const scale = opts.scale === undefined ? undefined : Number(opts.scale);
  if (scale !== undefined && !(scale > 0 && scale <= 1)) return { error: "--scale 要是 0 到 1 之间的数，如 0.5" };
  const withMods = (cmd: ComputerCmd): { cmd: ComputerCmd } => ({ cmd: mods ? { ...cmd, mods } : cmd });
  switch (action) {
    case "screenshot": return rest.length ? usage("screenshot [--scale 0.5]") : { cmd: { action, ...(scale ? { scale } : {}) } };
    case "zoom": {
      const r = nums(4);
      if (!r || r[2]! <= r[0]! || r[3]! <= r[1]!) return usage("zoom <x0> <y0> <x1> <y1> [--scale s]（左上角和右下角）");
      return { cmd: { action, region: r, ...(scale ? { scale } : {}) } };
    }
    case "left_click": case "right_click": case "double_click": case "triple_click": case "hover": case "scroll_to": {
      if (ref) return rest.length ? usage(`${action} <x> <y> 或 ${action} --ref ref_N（二选一）`) : withMods({ action, ref });
      const c = nums(2);
      return c ? withMods({ action, x: c[0], y: c[1] }) : usage(`${action} <x> <y>`);
    }
    case "left_click_drag": {
      if (ref || opts.to) {
        if (!ref || !opts.to || rest.length) return usage("left_click_drag --ref ref_A --to ref_B");
        return withMods({ action, ref, toRef: opts.to });
      }
      const c = nums(4);
      return c ? withMods({ action, sx: c[0], sy: c[1], x: c[2], y: c[3] }) : usage("left_click_drag <起点 x> <起点 y> <终点 x> <终点 y>");
    }
    case "type": return rest.length ? { cmd: { action, text: rest.join(" ") } } : usage('type "文字"（输入到获得焦点的输入框，先 left_click 它）');
    case "key": {
      const repeat = opts.repeat === undefined ? 1 : Number(opts.repeat);
      if (!Number.isInteger(repeat) || repeat < 1 || repeat > 100) return { error: "--repeat 要是 1 到 100 的整数" };
      return rest.length ? { cmd: { action, keys: rest.join(" "), ...(repeat > 1 ? { repeat } : {}) } } : usage('key "<键 键…>" [--repeat n]（如 Enter、cmd+a、"Backspace Backspace"）');
    }
    case "scroll": {
      if (ref) {
        const [direction, amount] = rest;
        if (!direction || !["up", "down", "left", "right"].includes(direction) || rest.length > 2 || (amount !== undefined && !/^\d+$/.test(amount))) return usage("scroll --ref ref_N <up|down|left|right> [格数]");
        return withMods({ action, ref, direction, amount: Math.min(Math.max(1, Number(amount ?? 3)), 10) });
      }
      const [x, y, direction, amount] = rest;
      if (!x || !y || !NUM.test(x) || !NUM.test(y) || !direction || !["up", "down", "left", "right"].includes(direction) || rest.length > 4 || (amount !== undefined && !/^\d+$/.test(amount))) return usage("scroll <x> <y> <up|down|left|right> [格数，一格 100 像素，最多 10]");
      return withMods({ action, x: Number(x), y: Number(y), direction, amount: Math.min(Math.max(1, Number(amount ?? 3)), 10) });
    }
    case "wait": {
      const sec = rest.length === 1 && NUM.test(rest[0]!) ? Number(rest[0]) : NaN;
      return sec > 0 && sec <= 10 ? { cmd: { action, seconds: sec } } : usage("wait <秒>（最多 10 秒；等完附带一次观察：等晚到的请求、动画就用它）");
    }
  }
  return usage(action);
}
