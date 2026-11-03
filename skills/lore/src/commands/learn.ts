import * as fs from "node:fs";
import * as path from "node:path";
import { EXIT } from "../protocol.ts";
import { HANDLE, type LearnWindow } from "../learn/windows.ts";
import { makeLearnGuide } from "../learn/guide.ts";
import { observe } from "../learn/observe.ts";
import { actionSummary, findAction, isComposed } from "../run/actions.ts";
import { normalizeSite } from "../record/digest.ts";
import { siteDirName, siteOfUrl } from "../utils/url.ts";
import { descriptionOf, parseArgs, valueOf, type ArgSpec } from "./args.ts";
import { DESCRIPTION_HINT, composeDirOf, idleMin, indent, type Ctx, type Output } from "./context.ts";
import { outcomeLines } from "./run.ts";


const SUBS = new Set(["computer", "navigate", "observe", "run", "close"]);
/** computer 里只看不动的（不计次数、不要 --description）：screenshot、zoom 也不附带观察。 */
const LOOK_ONLY = new Set(["screenshot", "zoom", "wait"]);
const LEARN_USAGE = 'lore learn new --url <链接|tab 号> --description "要做的事"（打开 learn 窗口，返回句柄）；lore learn <句柄> computer <action> … | navigate <网址|back|forward> | observe | run --action <名> | close；lore learn list（列出 learn 窗口）';

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
    `句柄：${w.id}（之后的命令：lore learn ${w.id} <操作>）`,
    `要做的事：${description}`,
    `窗口目录：${ctx.log.winDir(w.id)}`,
    `learn 指引：${guideFile}${fresh ? "（第一次给出或有更新，全文在最后）" : "（开始前先读一遍）"}`,
    "注意：这里的 computer 只在 learn 窗口里触发页面行为，让 lore 录到请求、学出 action；用户要的结果只能来自 lore run，不要把在这里看到的直接交给用户",
    ...(opened ? [`起点：${opened.url} "${opened.title}"`] : []),
    obs,
    ...(fresh ? ["", guide] : []),
  ].join("\n"));
}

const SPECS: Record<string, ArgSpec> = {
  computer: { values: ["description", "scale", "modifiers", "repeat"] },
  observe: { values: ["description"], switches: ["all"] },
  run: { values: ["action", "description"], params: true },
};

async function windowCommand(id: string, sub: string, argv: string[], ctx: Ctx, out: Output): Promise<void> {
  const a = parseArgs(argv, SPECS[sub] ?? { values: ["description"] });
  if ("error" in a) return out.fail(a.error);
  const description = descriptionOf(a);
  // 先检查参数，再碰浏览器
  let computer: ComputerCmd | undefined;
  if (sub === "computer") {
    const parsed = parseComputer(a.rest, { scale: valueOf(a, "scale"), modifiers: valueOf(a, "modifiers"), repeat: valueOf(a, "repeat") });
    if ("error" in parsed) return out.fail(parsed.error);
    computer = parsed.cmd;
  }
  const lookOnly = computer !== undefined && LOOK_ONLY.has(computer.action);
  const counted = (sub === "computer" && !lookOnly) || sub === "navigate" || sub === "run";
  const found = counted ? ctx.learn.forOp(id) : ctx.learn.get(id) ?? { error: `没有 learn 窗口 ${id}：lore learn list 列出有哪些` };
  if ("error" in found) return out.fail(found.error);
  const w: LearnWindow = found;
  if (counted && !description) return out.fail(`learn ${id} ${sub}${computer ? ` ${computer.action}` : ""} ${DESCRIPTION_HINT}`);
  if (sub === "close") {
    if (!w.open) return out.line(`ok learn 窗口 ${id} 的 Chrome 窗口已经关了\n窗口目录：${ctx.log.winDir(id)}`);
    await ctx.learn.close(w);
    const delivered = ctx.log.runsSince(w.createdAt).some((m) => m.status === "success");
    return out.line([`ok 已关掉 learn 窗口 ${id}`, `窗口目录：${ctx.log.winDir(id)}（句柄和目录保留，再对它操作会从 ${w.url} 重新打开）`, ...(delivered ? [] : ["下一步：这个窗口学到的还没用 lore run 交付过：用户要的结果要来自 lore run（把要的请求写成 action，lore run --action / --compose-code）"])].join("\n"));
  }
  if (sub === "observe") {
    if (w.open) await ctx.ensureExtension();
    const text = await observe(ctx, w, ctx.learn.session(id), undefined, a.switches.has("all"));
    ctx.learn.save(w);
    return out.line(`ok 观察 ${id}\n${text}`);
  }
  let target: { name: string; params: Record<string, string>; site?: string; endpoints: string[] } | undefined;
  if (sub === "navigate" && !a.rest[0]) return out.fail(`用法：lore learn ${id} navigate <网址|back|forward> --description "…"`);
  if (sub === "run") {
    const name = valueOf(a, "action");
    if (!name) return out.fail(`用法：lore learn ${id} run --action <名> [--参数 值] --description "…"`);
    const found = findAction(ctx.log.dir, name, composeDirOf(ctx));
    if (!found) return out.fail(`action 不存在：${name}（在 ${ctx.log.dir}/<站点>/actions/ 下）`);
    const summary = actionSummary(found.file, found.site);
    if (isComposed(summary)) return out.fail(`${name} 是 compose：用 lore run --compose ${name} 跑`);
    target = { name, params: a.params, site: found.site, endpoints: summary.endpoints };
  }

  await ctx.ensureExtension();
  const head: string[] = [];
  const { sess, opened } = await ctx.learn.page(w);
  if (opened) head.push(`重新打开：${opened.url} "${opened.title}"（Chrome 窗口之前关了，页面状态没了，回到了上次的 URL）`);
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
  let first = `ok ${sub}${computer ? ` ${computer.action}` : ""}`;
  const body: string[] = [];
  if (sub === "navigate") {
    const res = (await ctx.host.op(sess, "navigate", { url: a.rest[0], description })) as { url: string; title: string };
    first = `ok 已打开 ${res.url} "${res.title}"`;
  } else if (target) {
    const o = await ctx.runner.runInLearn(target.name, target.params, sess);
    if (o.status !== "success") out.code = EXIT.fail;
    else if (target.site) for (const ep of target.endpoints) ctx.index.describe(target.site, ep, { text: description!, from: "learn" });
    const lines = o.status === "ask" ? [`fail ${target.name}：action 里不能用 lore.ask`, ...(o.sent?.length ? [`已发出的非 GET 请求：\n${indent(o.sent.join("\n"))}`] : [])] : outcomeLines(target.name, o);
    first = lines[0]!;
    body.push(...lines.slice(1));
  } else if (computer?.action === "wait") {
    await new Promise((r) => setTimeout(r, computer!.seconds! * 1000));
    first = `ok wait ${computer.seconds}s`;
  } else if (computer) {
    const { action, ...rest } = computer;
    const res = (await ctx.host.op(sess, "pointer", { action, ...rest, description })) as { navigated?: boolean; url?: string; title?: string; target?: Target; loc?: unknown; warning?: string; dropTarget?: Target; scrollY?: number };
    if (res.target) body.push(`落在：${describeTarget(res.target)}`);
    if (res.loc) body.push(`定位：${JSON.stringify(res.loc)}（写 action 时放进 click(定位) / fill(定位, …)）`);
    if (res.warning) body.push(`提醒：${res.warning}`);
    if (res.dropTarget) body.push(`松开在：${describeTarget(res.dropTarget)}`);
    if (res.scrollY !== undefined) body.push(`滚动位置：${res.scrollY}`);
    if (res.navigated) body.push(`跳转：${res.url ?? ""} "${res.title ?? ""}"`);
  }
  if (counted) w.ops++;
  // 等页面安静、这一步引发的记录都到 daemon，再观察（不用再单独 observe 才看到这一步的请求）
  const q = await ctx.host.quiet(sess);
  body.push(q.settled ? `稳定：页面已安静，等了 ${(q.waitedMs / 1000).toFixed(1)}s` : `稳定：等了 ${(q.waitedMs / 1000).toFixed(1)}s 页面还在变化（晚到的请求下次 observe 出现）`);
  if (computer?.action === "scroll") body.push(`截图：${(await shotFile("scroll")).file}（滚动之后的样子）`);
  const obs = await observe(ctx, w, sess, description);
  // 操作了很多次还没写 action：提醒一次（computer 只是触发页面行为，结果要来自 lore run）
  const nudge = counted && w.ops % NUDGE_EVERY === 0 && !obs.includes("\n下一步：") && !actionsNewerThan(ctx.log.dir, w.site, w.createdAt)
    ? [`下一步：已经操作 ${w.ops} 次，还没有写 action。看到的东西不能直接交给用户：把要的请求写成 action（读不了的写成 DOM action），lore run 交付`] : [];
  ctx.learn.save(w);
  out.line([first, ...head, ...body, obs, ...nudge].join("\n"));
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
 * screenshot [--scale s] | zoom <x0> <y0> <x1> <y1> [--scale s] | left_click|right_click|double_click|triple_click|hover <x> <y> [--modifiers cmd+shift]
 * | left_click_drag <sx> <sy> <x> <y> | type "文字" | key "<键 键…>" [--repeat n] | scroll <x> <y> <up|down|left|right> [格数] | scroll_to <x> <y> | wait <秒>
 */
export function parseComputer(args: string[], opts: { scale?: string; modifiers?: string; repeat?: string } = {}): { cmd: ComputerCmd } | { error: string } {
  const [action, ...rest] = args;
  const usage = (u: string): { error: string } => ({ error: `用法：lore learn <句柄> computer ${u}（坐标取自截图，CSS 像素，左上角 (0,0)）` });
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
      const c = nums(2);
      return c ? withMods({ action, x: c[0], y: c[1] }) : usage(`${action} <x> <y>`);
    }
    case "left_click_drag": {
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
      const [x, y, direction, amount] = rest;
      if (!x || !y || !NUM.test(x) || !NUM.test(y) || !direction || !["up", "down", "left", "right"].includes(direction) || rest.length > 4 || (amount !== undefined && !/^\d+$/.test(amount))) return usage("scroll <x> <y> <up|down|left|right> [格数，一格 100 像素，最多 10]");
      return withMods({ action, x: Number(x), y: Number(y), direction, amount: Math.min(Math.max(1, Number(amount ?? 3)), 10) });
    }
    case "wait": {
      const sec = rest.length === 1 && NUM.test(rest[0]!) ? Number(rest[0]) : NaN;
      return sec > 0 && sec <= 10 ? { cmd: { action, seconds: sec } } : usage("wait <秒>（最多 10 秒；每步之后已经自动等页面安静，只在要等动画时用）");
    }
  }
  return usage(action);
}
