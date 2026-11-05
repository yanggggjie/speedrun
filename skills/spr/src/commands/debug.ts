import * as fs from "node:fs";
import * as path from "node:path";
import { EXIT } from "../protocol.ts";
import { notOpen, type DebugWindow } from "../debug/windows.ts";
import { makeDebugGuide } from "../debug/guide.ts";
import { observe } from "../debug/observe.ts";
import { clues, mergeCalls, mergeScan, scanPage, traceEnd, traceStart, type PageScan, type TraceCall } from "../debug/page-api.ts";
import { findAction, isCompose } from "../run/actions.ts";
import { checkCompose } from "../run/link.ts";
import { normalizeSite } from "../record/digest.ts";
import { siteOfUrl } from "../utils/url.ts";
import { parseArgs, valueOf, type ArgSpec } from "./args.ts";
import { composeDirOf, idleMin, pageContent, type Ctx, type Output } from "./context.ts";
import type { Session } from "../browser/host.ts";
import type { Row } from "../record/types.ts";


/** debug 窗口里的工具：和 Claude in Chrome 同名、同参数、同语义（read_page、find、get_page_text、computer、form_input、navigate），加 inspect、trace。 */
const TOOLS = new Set(["read_page", "find", "get_page_text", "computer", "form_input", "navigate", "inspect", "trace"]);
/** 只看不动的工具（不计次数、不附带观察）。 */
const LOOK_TOOLS = new Set(["read_page", "find", "get_page_text", "inspect", "trace"]);
/** computer 里只看不动的（不计次数）：screenshot、zoom 不附带观察；wait 等完附带一次观察（等晚到的请求就用它）。 */
const LOOK_ONLY = new Set(["screenshot", "zoom", "wait"]);
const DEBUG_USAGE = 'spr debug <compose> navigate <网址|tab 号|back|forward>（窗口没开就打开）；spr debug <compose> read_page | find "<查询>" | get_page_text | computer <action> … | form_input <ref_N> <值> | inspect --path <对象> | trace <函数路径…>；spr debug <compose> close；spr debug list';
export const DEBUG_HELP = `${DEBUG_USAGE}
  <compose> 是要用 spr run 运行的 compose，文件要先写好；一个窗口可以处理它缺的多个 action。
  只看不动（不计次数）：read_page [--filter interactive|all] [--depth 15] [--ref ref_N] [--max-chars 50000]、find "<查询>"、get_page_text [--max 20000]、computer screenshot | zoom <x0> <y0> <x1> <y1> | wait <秒>、inspect --path <对象>、trace <函数路径…> [--seconds 10] | trace --stop。
  会改变页面：computer left_click | right_click | double_click | triple_click | hover | left_click_drag | scroll | scroll_to | type | key …（坐标或 --ref ref_N）、form_input <ref_N> <值>、navigate <网址|tab 号|back|forward>。
  同一个 compose 上一次只能有一条命令：上一条还没返回时，后到的直接报错。`;

/** spr debug <compose> <工具>：在这个 compose 的 debug 窗口里操作；spr debug <compose> close：关掉；spr debug list：列出。写 action 都在这里，每一步都进日志，改变页面的操作后附带一次观察。 */
export async function debugCommand(args: string[], ctx: Ctx, out: Output): Promise<void> {
  const [first, ...rest] = args;
  if (first === "list") {
    if (rest.length) return out.usage(`spr debug list 不接受参数，收到：${rest.join(" ")}`);
    return listDebug(ctx, out);
  }
  if (first === "--help" || first === "-h") { out.line(`ok ${DEBUG_HELP}`); return; }
  if (!first || first.startsWith("--")) return out.usage(`用法：${DEBUG_USAGE}`);
  const found = findAction(ctx.log.dir, first, composeDirOf(ctx));
  if (!found) return out.usage(`没有 compose ${first}：先写 ${composeDirOf(ctx)}/${first}.js，调用要用的 action，缺的也先写上`);
  if (!isCompose(found)) return out.usage(`${first} 是 action：spr debug 后面写 compose 的名字（调用它的那个 compose）`);
  const [sub, ...more] = rest;
  if (sub === "close") {
    if (more.length) return out.usage(`用法：spr debug ${first} close`);
    return closeDebug(first, ctx, out);
  }
  if (!sub || !TOOLS.has(sub)) return out.usage(`不认识的操作「${sub ?? ""}」。用法：${DEBUG_USAGE}`);
  return windowCommand(first, sub, more, ctx, out);
}

function listDebug(ctx: Ctx, out: Output): void {
  const all = ctx.debug.list();
  const logs = `关掉的窗口只能看日志：${path.join(ctx.log.root, "debug-windows")}/`;
  if (!all.length) return out.line(`ok 没有开着的 debug 窗口（${logs}）\n下一步：${DEBUG_USAGE}`);
  out.line(`ok ${all.length} 个开着的 debug 窗口（新的在前，最多列 10 个；${logs}）`);
  for (const w of all.slice(0, 10)) out.line(`  ${w.compose} ${w.url} 操作 ${w.ops} 次，空闲 ${idleMin(w)} 分钟`);
}

/** navigate 的目标：http(s) 链接原样用；`tab123` 或 `123` 是用户的标签页号（spr tabs 列出的），只取它的地址，不碰那个标签页。 */
async function resolveStartUrl(ctx: Ctx, given: string): Promise<{ url: string } | { error: string }> {
  const m = /^(?:tab)?(\d+)$/i.exec(given.trim());
  if (!m) return siteOfUrl(given) ? { url: given.trim() } : { error: `要是 http(s) 链接，或 spr tabs 列出的标签页号（如 tab123），收到：${given}` };
  await ctx.ensureExtension();
  const tab = (await ctx.tabs()).find((t) => t.tabId === Number(m[1]) && !t.speedrun);
  if (!tab) return { error: `没有标签页 ${given}：先 spr tabs 看用户的标签页，按标题、地址对出要的那个` };
  return siteOfUrl(tab.url) ? { url: tab.url } : { error: `标签页 ${given} 不是 http(s) 页面：${tab.url}` };
}

/**
 * 这个 compose 还没有窗口时的 navigate：打开一个 debug 窗口，返回窗口目录、debug 指引和起点的观察。
 * debug 指引写在 ~/.speedrun/debug-guide.md：内容变了（第一次、或升级后）才在输出里给全文，其余时候只给路径。
 */
async function openWindow(compose: string, url: string, ctx: Ctx, out: Output): Promise<void> {
  await ctx.ensureExtension();
  const w = ctx.debug.create({ compose, site: normalizeSite(siteOfUrl(url)), url });
  const { sess, opened } = await ctx.debug.page(w);
  await ctx.host.quiet(sess); // 起点加载期的请求都到了再观察
  await snapshotPage(ctx, w, sess);
  const obs = await observe(ctx, w, sess);
  ctx.debug.save(w);
  const guideFile = path.join(ctx.log.root, "debug-guide.md");
  const guide = makeDebugGuide({ debugDir: path.join(ctx.log.root, "debug-windows"), actionDir: ctx.log.dir, composeDir: composeDirOf(ctx), libDir: path.join(ctx.log.root, "lib"), helpersDir: path.join(ctx.log.root, "helpers") });
  let fresh = true;
  try { fresh = fs.readFileSync(guideFile, "utf8") !== guide; } catch { /* 第一次 */ }
  if (fresh) fs.writeFileSync(guideFile, guide);
  out.line([
    `ok debug 窗口已打开：${compose}`,
    `窗口目录：${ctx.log.winDir(w.id)}`,
    `debug 指引：${guideFile}${fresh ? "（第一次给出或有更新，全文在最后）" : "（开始前先读一遍）"}`,
    "注意：这里的工具只用来触发页面行为、写 action；用户要的结果只能来自 spr run，不要把在这里看到的直接交给用户",
    ...(opened ? [`起点：${opened.url} "${opened.title}"`] : []),
    obs,
    ...(fresh ? ["", guide] : []),
  ].join("\n"));
}

/** 快照页面函数落盘：窗口里 page-api/，站点累积 page-api.json；只把线索留给观察。失败不影响操作。 */
async function snapshotPage(ctx: Ctx, w: DebugWindow, sess: Session): Promise<void> {
  try {
    const scan = await ctx.host.peek(sess, scanPage, [{}]) as PageScan | undefined;
    if (!scan) return;
    const dir = writeScan(ctx, w, scan, "snapshot");
    const api = clues(scan.objects);
    w.page = { canvas: scan.canvas, api, dir, fresh: scan.canvas || api.length > 0 };
    w.apiUrl = scan.url.split("#")[0]!;
  } catch { /* 页面在跳转、受限页面：下一步再说 */ }
}

const SPECS: Record<string, ArgSpec> = {
  computer: { values: ["scale", "modifiers", "repeat", "ref", "to"] },
  read_page: { values: ["filter", "depth", "ref", "max-chars"] },
  find: { values: [] },
  get_page_text: { values: ["max"] },
  inspect: { values: ["path"] },
  trace: { values: ["seconds"], switches: ["stop"] },
};

/** trace 默认录多久。 */
const TRACE_SECONDS = 10;

/** 写窗口里的快照文件并进站点文件，返回窗口的 page-api 目录。 */
function writeScan(ctx: Ctx, w: DebugWindow, scan: PageScan, kind: string): string {
  const site = normalizeSite(siteOfUrl(scan.url)) || w.site;
  const seq = String(ctx.log.reserve()).padStart(6, "0");
  ctx.log.putFile(w.id, `page-api/${seq}-${kind}.json`, JSON.stringify({ url: ctx.ingest.sanitizer.url(scan.url).bareUrl, canvas: scan.canvas, objects: scan.objects }, null, 1));
  mergeScan(ctx.log.dir, site, scan);
  return ctx.log.abs(w.id, "page-api");
}

/** 取 trace 的记录：恢复页面函数，详情（脱敏）写进 calls/，结构并进站点文件，返回摘要。 */
async function collectTrace(ctx: Ctx, w: DebugWindow, sess: Session): Promise<string[]> {
  const paths = w.trace?.paths ?? [];
  w.trace = undefined;
  const r = await ctx.host.peek(sess, traceEnd);
  if (!r?.found) return [`提醒：trace 的记录丢了：页面跳转或刷新过（${paths.join("、")}）。重新 trace，操作时不要离开这个页面`];
  const calls = r.calls.map((c: TraceCall) => ctx.ingest.sanitizer.body(c) as TraceCall);
  if (!calls.length) return [`trace：${paths.join("、")} 没有被调用：页面可能走了别的函数，或内部直接用了原函数的引用；换上一层或相邻的函数再试`];
  const rel = ctx.log.putFile(w.id, `calls/${String(ctx.log.reserve()).padStart(6, "0")}-trace.json`, JSON.stringify(calls, null, 1));
  const site = normalizeSite(siteOfUrl(w.url)) || w.site;
  const sum = mergeCalls(ctx.log.dir, site, calls);
  return [`trace：${calls.length} 次调用${r.dropped ? `（另有 ${r.dropped} 次超过上限没记）` : ""}，详情：${ctx.log.abs(w.id, rel)}`, ...sum.slice(0, 10).map((c) => `  ${c.path} ×${c.count} 参数 (${c.args.join(", ")})`)];
}

async function closeDebug(compose: string, ctx: Ctx, out: Output): Promise<void> {
  const w = ctx.debug.of(compose);
  if (!w) return out.line(`ok ${compose} 没有开着的 debug 窗口`);
  if (w.trace && w.open) { try { await collectTrace(ctx, w, (await ctx.debug.page(w)).sess); } catch { /* 页面没了，函数已经跟着没了 */ } }
  await ctx.debug.close(w);
  out.line([`ok 已关掉 ${compose} 的 debug 窗口`, `窗口目录：${ctx.log.winDir(w.id)}（日志留着）`].join("\n"));
}

/** 输出末行：这个窗口要达成的目标。代替分散的提醒：缺什么由 compose 文件算出来。 */
function targetLine(compose: string, ctx: Ctx): string {
  const { missing } = checkCompose(compose, { actionDir: ctx.log.dir, composeDir: composeDirOf(ctx) });
  return `目标：spr run ${compose}${missing.length ? `（还缺 ${missing.join("、")}）` : ""}`;
}

/**
 * 同一个 compose 一次只跑一条命令：几条同时到（agent 并行发了几个 Bash 调用）时，后到的直接报错，不排队，
 * 否则操作在同一个页面上交错，观察的游标也会把一条命令引发的请求算到另一条头上。
 */
async function windowCommand(compose: string, sub: string, argv: string[], ctx: Ctx, out: Output): Promise<void> {
  if (!ctx.debug.claim(compose)) return out.fail(`${compose} 的 debug 窗口上一条命令还没结束：等它返回后再发（同一个 compose 上的命令要一条一条发，不要并行）`);
  try {
    await windowCommandInner(compose, sub, argv, ctx, out);
    if (out.code === EXIT.ok) out.line(targetLine(compose, ctx));
  } finally {
    ctx.debug.release(compose);
  }
}

async function windowCommandInner(compose: string, sub: string, argv: string[], ctx: Ctx, out: Output): Promise<void> {
  const a = parseArgs(argv, SPECS[sub] ?? {});
  if ("error" in a) return out.usage(a.error);
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
    if (a.rest.length) return out.usage(`多余的参数：${a.rest.join(" ")}。用法：spr debug ${compose} read_page [--filter interactive|all] [--depth 15] [--ref ref_N] [--max-chars 50000]`);
    look = { filter, depth, maxChars, ...(ref ? { ref } : {}) };
  } else if (sub === "find") {
    if (!a.rest.length) return out.usage(`用法：spr debug ${compose} find "<查询>"（按目的或文字找，如 "搜索框"、"评论"）`);
    look = { query: a.rest.join(" ") };
  } else if (sub === "get_page_text") {
    const max = Number(valueOf(a, "max") ?? 20_000);
    if (!(max >= 100)) return out.usage("--max 至少 100");
    if (a.rest.length) return out.usage(`多余的参数：${a.rest.join(" ")}。用法：spr debug ${compose} get_page_text [--max 20000]`);
    look = { max };
  } else if (sub === "inspect") {
    const at = valueOf(a, "path");
    if (!at || a.rest.length) return out.usage(`用法：spr debug ${compose} inspect --path <对象路径>（如 SpreadsheetApp.behaviorApi；页面接口的快照先看窗口目录的 page-api/）`);
    look = { path: at };
  } else if (sub === "trace") {
    const seconds = Number(valueOf(a, "seconds") ?? TRACE_SECONDS);
    const stop = a.switches?.has("stop") === true;
    if (!(seconds >= 1 && seconds <= 120)) return out.usage("--seconds 是 1 到 120");
    if (stop ? a.rest.length : !a.rest.length) return out.usage(`用法：spr debug ${compose} trace <函数路径…> [--seconds ${TRACE_SECONDS}]，或 trace --stop 提前取记录`);
    look = { paths: a.rest, seconds, stop };
  }
  let form: { ref: string; value: string } | undefined;
  if (sub === "form_input") {
    const [ref, ...value] = a.rest;
    if (!ref || !REF.test(ref) || !value.length) return out.usage(`用法：spr debug ${compose} form_input <ref_N> <值>（文本框写文字，下拉框写选项文字或值，复选框写 true / false）`);
    form = { ref, value: value.join(" ") };
  }
  let goTo: string | undefined;
  if (sub === "navigate") {
    const given = a.rest[0];
    if (!given || a.rest.length > 1) return out.usage(`用法：spr debug ${compose} navigate <网址|tab 号|back|forward>`);
    if (given === "back" || given === "forward") {
      if (!ctx.debug.of(compose)) return out.usage(notOpen(compose));
      goTo = given;
    } else {
      const start = await resolveStartUrl(ctx, given);
      if ("error" in start) return out.usage(`navigate ${start.error}`);
      goTo = start.url;
      if (!ctx.debug.of(compose)) return openWindow(compose, goTo, ctx, out);
    }
  }
  const lookOnly = LOOK_TOOLS.has(sub) || (computer !== undefined && LOOK_ONLY.has(computer.action));
  const counted = !lookOnly;
  const found = ctx.debug.forOp(compose, counted);
  if ("error" in found) return found.usage ? out.usage(found.error) : out.fail(found.error);
  const w: DebugWindow = found;
  const id = w.id;

  await ctx.ensureExtension();
  const head: string[] = [];
  const { sess } = await ctx.debug.page(w);
  w.lastActive = Date.now();
  // 录制时间到了：先取记录（函数在页面里已经恢复），放在这条命令的输出前面
  if (w.trace && sub !== "trace" && Date.now() >= w.trace.until) head.push(...await collectTrace(ctx, w, sess));
  const shotFile = async (kind: string, args: { region?: number[]; scale?: number } = {}): Promise<{ file: string; w: number; h: number; vw: number; vh: number }> => {
    const shot = (await ctx.host.op(sess, "screenshot", args)) as { data: string; mime: string; w: number; h: number; vw: number; vh: number };
    const rel = ctx.log.putFile(id, `screenshots/${String(ctx.log.reserve()).padStart(6, "0")}-${kind}.${shot.mime.includes("png") ? "png" : "jpg"}`, Buffer.from(shot.data, "base64"));
    return { file: ctx.log.abs(id, rel), w: shot.w, h: shot.h, vw: shot.vw, vh: shot.vh };
  };
  if (computer?.action === "screenshot" || computer?.action === "zoom") {
    const zoom = computer.action === "zoom";
    const shot = await shotFile(computer.action, { ...(zoom ? { region: computer.region } : {}), ...(computer.scale ? { scale: computer.scale } : {}) });
    ctx.debug.save(w);
    const how = zoom ? `区域 [${computer.region!.join(", ")}] 放大看；图上的坐标不是页面坐标，点的时候用这个区域在整页截图里的坐标` : computer.scale ? `缩小到 ${computer.scale}；坐标仍按视口 ${shot.vw}×${shot.vh} 算（图上的坐标除以 ${computer.scale}）` : "图上的像素坐标就是 computer 操作的坐标，左上角 (0,0)";
    return out.line([`ok ${computer.action} ${shot.w}×${shot.h}`, ...head, `文件：${shot.file}（用读图片的方式看；${how}；页面变了要重新截）`].join("\n"));
  }
  if (sub === "inspect" || sub === "trace") {
    const lines = sub === "inspect" ? await inspectTool(ctx, w, sess, String(look!.path)) : await traceTool(ctx, w, sess, look!);
    ctx.debug.save(w);
    return out.line(lines.join("\n"));
  }
  if (look) {
    const lines = await lookTool(ctx, w, sess, sub, look);
    ctx.debug.save(w);
    return out.line([lines[0]!, ...head, ...lines.slice(1)].join("\n"));
  }
  let first = `ok ${sub}${computer ? ` ${computer.action}` : ""}`;
  const body: string[] = [];
  let navigated = false;
  if (sub === "navigate") {
    const res = (await ctx.host.op(sess, "navigate", { url: goTo })) as { url: string; title: string };
    first = `ok 已打开 ${res.url} "${res.title}"`;
  } else if (computer?.action === "wait") {
    const done = sess.tab !== undefined ? ctx.win.busy(sess.tab) : () => {}; // 等的时候页面要一直在渲染（组不算闲置）
    try { await new Promise((r) => setTimeout(r, computer!.seconds! * 1000)); } finally { done(); }
    first = `ok wait ${computer.seconds}s`;
  } else {
    const { action, ...rest } = computer ?? { action: "form_input" };
    const res = (await ctx.host.op(sess, "input", { action, ...rest, ...(form ? { ref: form.ref, value: form.value } : {}) })) as InputResult;
    navigated = res.navigated === true;
    body.push(...inputLines(res, action));
  }
  if (counted) w.ops++;
  // 等页面安静、这一步引发的记录都到 daemon，再观察
  const q = await ctx.host.quiet(sess);
  // 页面函数的快照：打开新页面、第一次操作之后（单页应用的对象可能晚点才出现）
  if (counted && (sub === "navigate" || w.ops === 1 || navigated)) await snapshotPage(ctx, w, sess);
  body.push(q.settled ? `稳定：页面已安静，等了 ${(q.waitedMs / 1000).toFixed(1)}s` : `稳定：等了 ${(q.waitedMs / 1000).toFixed(1)}s 页面还在变化（晚到的请求用 computer wait 等一会儿再看）`);
  if (computer?.action === "scroll") body.push(`截图：${(await shotFile("scroll")).file}（滚动之后的样子）`);
  const obs = await observe(ctx, w, sess, [computer?.text, form?.value].filter((v): v is string => !!v));
  ctx.debug.save(w);
  out.line([first, ...head, ...body, obs].join("\n"));
}

const REF = /^ref_\d+$/;

/** inspect --path：快照没覆盖到的对象，规则和快照相同（路径上的属性可以是 getter），结果并进站点文件，输出只给摘要。 */
async function inspectTool(ctx: Ctx, w: DebugWindow, sess: Session, at: string): Promise<string[]> {
  const scan = await ctx.host.peek(sess, scanPage, [{ path: at }]) as PageScan | undefined;
  if (!scan) return ["fail 这个窗口还没有页面"];
  if (scan.error) return [`ok inspect ${scan.error}`, "下一步：看窗口目录的 page-api/ 有哪些对象"];
  const dir = writeScan(ctx, w, scan, "inspect");
  const top = scan.objects[0];
  if (!top) return [`ok inspect ${at}：是元素、数组这类不展开的值`, "下一步：看窗口目录的 page-api/ 有哪些对象"];
  return [
    `ok inspect ${at}：${scan.objects.length} 个对象（详情：${dir}）`,
    `方法：${top.methods.slice(0, 40).join("、") || "（没有）"}`,
    `子对象：${top.props.filter((p) => !p.includes(":")).slice(0, 40).join("、") || "（没有）"}`,
    ...(top.getters.length ? [`getter（不调用，要看就 inspect --path 到它）：${top.getters.slice(0, 20).join("、")}`] : []),
    "下一步：要参数就 trace <函数路径>，再操作一次页面",
  ];
}

/** trace：包住函数后立刻返回（录制期间要用别的命令操作页面）；--stop 提前取记录。 */
async function traceTool(ctx: Ctx, w: DebugWindow, sess: Session, a: Record<string, unknown>): Promise<string[]> {
  if (a.stop) {
    if (!w.trace) return ["ok 没有在录的 trace"];
    return ["ok trace 结束", ...await collectTrace(ctx, w, sess)];
  }
  const paths = a.paths as string[], seconds = a.seconds as number;
  const r = await ctx.host.peek(sess, traceStart, [paths, seconds]) as { wrapped: string[]; failed: string[] } | undefined;
  if (!r) return ["fail 这个窗口还没有页面"];
  if (!r.wrapped.length) return [`fail 没有包住任何函数：${r.failed.join("；")}`];
  w.trace = { until: Date.now() + seconds * 1000, paths: r.wrapped };
  return [
    `ok trace 录 ${seconds} 秒：${r.wrapped.join("、")}`,
    ...(r.failed.length ? [`没包住：${r.failed.join("；")}`] : []),
    `下一步：现在操作一次页面；到时间后下一条命令会带上记录，或 spr debug ${w.id} trace --stop。这期间不要跳转页面`,
  ];
}

/** 只看不动的工具：read_page（全文存进 pages/，时间线记一行 snap a11y）、find、get_page_text。 */
async function lookTool(ctx: Ctx, w: DebugWindow, sess: Session, tool: string, args: Record<string, unknown>): Promise<string[]> {
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
export const ACTIONS = ["screenshot", "zoom", "left_click", "right_click", "double_click", "triple_click", "hover", "left_click_drag", "type", "key", "scroll", "scroll_to", "wait"];
const MOD_NAMES: Record<string, string> = { cmd: "cmd", command: "cmd", meta: "cmd", ctrl: "ctrl", control: "ctrl", alt: "alt", option: "alt", shift: "shift" };

/**
 * 解析 computer <action> …（和 computer 工具一一对应）：
 * screenshot [--scale s] | zoom <x0> <y0> <x1> <y1> [--scale s] | left_click|right_click|double_click|triple_click|hover (<x> <y> | --ref ref_N) [--modifiers cmd+shift]
 * | left_click_drag (<sx> <sy> <x> <y> | --ref ref_A --to ref_B) | type "文字" | key "<键 键…>" [--repeat n] | scroll (<x> <y> | --ref ref_N) <up|down|left|right> [格数]
 * | scroll_to (<x> <y> | --ref ref_N) | wait <秒>
 */
export function parseComputer(args: string[], opts: { scale?: string; modifiers?: string; repeat?: string; ref?: string; to?: string } = {}): { cmd: ComputerCmd } | { error: string } {
  const [action, ...rest] = args;
  const usage = (u: string): { error: string } => ({ error: `用法：spr debug <compose> computer ${u}（坐标取自截图，CSS 像素，左上角 (0,0)；或用 --ref ref_N 指 read_page / find 给出的元素）` });
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
