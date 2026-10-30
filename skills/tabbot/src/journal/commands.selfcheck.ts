// 命令层：参数解析，以及用假的 holder 能力（假页面、假标签页）端到端跑 delegate / debug / run / replay / status。
// 读日志不是命令（是文件），这里只守住强制规则：调试只能在学习会话里、一个 task 只开一个会话、会话收回、重放走原始请求、run 发回执。
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NeedExtensionError } from "../browser/connect.ts";
import { DebugWindows } from "../run/debug-windows.ts";
import { Session } from "../run/host.ts";
import { coveredEndpoints } from "../run/tasks.ts";
import { parsePointer, parseReplayArgs, releaseDebugWindow, runCommand, type Ctx } from "./commands.ts";
import { EndpointIndex } from "./endpoints.ts";
import { Ingestor, type PageMsg } from "./ingest.ts";
import { RawStore } from "./raw.ts";
import { SiteLog } from "./sitelog.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-cmd-"));
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---- 参数解析 ----
const ok = (kind: string, args: string[]) => { const r = parsePointer(kind, args); assert.ok("cmd" in r, JSON.stringify(r)); return r.cmd; };
const bad = (kind: string, args: string[]) => { const r = parsePointer(kind, args); assert.ok("error" in r, JSON.stringify(r)); return r.error; };
// 探索只有截图加按坐标的操作：没有元素引用、没有可访问树
assert.deepEqual(ok("click", ["120", "340.5"]), { kind: "click", x: 120, y: 340.5 });
assert.deepEqual(ok("type", ["你好", "世界"]), { kind: "type", text: "你好 世界" });
assert.deepEqual(ok("key", ["Ctrl+K"]), { kind: "key", key: "Ctrl+K" });
assert.deepEqual(ok("scroll", ["up", "200"]), { kind: "scroll", dy: -200 });
assert.deepEqual(ok("scroll", ["down"]), { kind: "scroll", dy: 600 });
assert.deepEqual(ok("scroll", ["down", "300", "500", "400"]), { kind: "scroll", dy: 300, x: 500, y: 400 }, "给了坐标就滚那个位置的可滚动区域");
assert.deepEqual(ok("scroll", ["down", "500", "400"]), { kind: "scroll", dy: 600, x: 500, y: 400 }, "两个数是坐标，不是像素");
assert.deepEqual(ok("scroll", ["bottom"]), { kind: "scroll", to: "bottom" });
assert.match(bad("click", ["@e12"]), /用法：tabbot debug click <x> <y>/);
assert.match(bad("click", ["10"]), /用法：tabbot debug click/);
assert.match(bad("type", []), /用法：tabbot debug type/);
assert.match(bad("scroll", ["sideways"]), /用法：tabbot debug scroll/);
assert.match(bad("hover", []), /open\|screenshot\|click\|type\|key\|scroll/);
const rp = (args: string[]) => { const r = parseReplayArgs(args); assert.ok(!("error" in r), JSON.stringify(r)); return r; };
assert.deepEqual(rp(["#210", "--set", "page=2", "--set=body.filter.on=false", "--yes"]), { seq: 210, sets: ["page=2", "body.filter.on=false"], yes: true });
for (const [args, re] of [[[], /用法：tabbot debug/], [["abc"], /日志编号要是整数/], [["1", "2"], /多余的参数/], [["1", "--set"], /缺少值/], [["1", "--wat"], /不认识的参数/]] as [string[], RegExp][]) {
  const r = parseReplayArgs(args); assert.ok("error" in r && re.test(r.error), JSON.stringify([args, r]));
}

// ---- 假的 holder 能力 ----
const log = new SiteLog({ dir });
log.open();
const raw = new RawStore();
const index = new EndpointIndex({ dir, raw, coverage: (site) => coveredEndpoints(dir, site), flushMs: 5 });
const WINS: Record<number, string> = { 8: "run" };
const ingest = new Ingestor(log, { aliasKey: "k", raw, index, winOf: (tab) => WINS[tab] ?? "user" });
const SECRET = "REAL-TOKEN-0123456789abcdef";
const page = "https://www.x.com/home";
const net = (tab: number, t: number, over: Record<string, unknown>): PageMsg => ({ k: "net", t, tab, page, via: "fetch", method: "GET", status: 200, ct: "application/json", ms: 10, ...over }) as PageMsg;
const tabs = [
  { tabId: 7, windowId: 1, active: true, url: page, title: "示例", status: "complete" },
  { tabId: 20, windowId: 9, active: true, url: "https://x.com/robots.txt", title: "", status: "complete" },
  { tabId: 21, windowId: 9, active: true, url: "chrome-extension://x/anchor.html", title: "tabbot agent", status: "complete", anchor: true },
];
let extension = true;
const calls: string[] = [];
const host = {
  op: async (s: Session, name: string, a: Record<string, unknown>) => {
    WINS[20] = s.key;
    s.tab = 20;
    if (name === "goto") {
      const ref = ingest.beginCmd(20, Date.now(), "goto", "https://x.com/home", undefined, "x.com");
      ingest.endCmd(ref, { detail: { ok: true } });
      return { url: page, title: "示例" };
    }
    if (name === "screenshot") return { data: Buffer.from("jpeg-bytes").toString("base64"), mime: "image/jpeg", w: 1280, h: 720 };
    if (name === "pointer") {
      const detail = a.description ? { description: a.description } : {};
      const ref = ingest.beginCmd(20, Date.now(), String(a.kind), "x", detail, "x.com");
      if (a.x === 777) { // 点了一个跳到别的站点的链接：请求记在 y.com 下
        ingest.handleBatch([net(20, Date.now() + 30, { id: 2, rid: "p:2", url: "https://y.com/api/mr/5", page: "https://y.com/mr/5", body: "{\"mr\":5}", size: 8 })]);
        ingest.endCmd(ref, { detail: { ...detail, ok: true } });
        return { ok: true, navigated: true, url: "https://y.com/mr/5", title: "MR 5" };
      }
      ingest.handleBatch([net(20, Date.now() + 30, { id: 1, rid: "p:1", method: "POST", url: "https://x.com/api/save", reqBody: JSON.stringify({ n: 1 }), body: "{\"saved\":true}", size: 14 })]);
      ingest.endCmd(ref, { detail: { ...detail, ok: true } });
      return { ok: true, loc: { role: "button", name: "提交" }, settle: { settled: true, waitedMs: 130 }, url: page, title: "示例" };
    }
    throw new Error(`没有预期的操作 ${name}`);
  },
  bind: async (s: Session) => { WINS[20] = s.key; s.tab = 20; return 20; },
  end: async (s: Session) => { s.tab = undefined; },
  callTab: async (_tab: number, fn: string, args: unknown[]) => {
    calls.push(`${fn} ${JSON.stringify(args[0])}`);
    if (fn === "replay") return { ok: true, status: 200, ct: "application/json", size: 17, text: "{\"items\":[1,2,3]}", ms: 9 };
    throw new Error(`没有预期的调用：${fn}`);
  },
};
const runs: string[] = [];
const runner = {
  runTask: async (name: string, params: Record<string, string>, _n: unknown, opts: { key?: string; dry?: boolean } = {}) => { runs.push(`${name} ${JSON.stringify(params)} key=${opts.key ?? "run"} dry=${opts.dry === true}`); return { status: "success", result: { name, params } }; },
  runCompose: async (code: string, _k: unknown, _t: unknown, params: Record<string, string> = {}) => (code.includes("FAIL") ? { status: "failure", error: "x" } : { status: "success", result: Object.keys(params).length ? { code, params } : code }),
};
const disposed: string[] = [];
const debugWindows = new DebugWindows();
const sessions = new Map<string, Session>();
const ctx = {
  ensureExtension: async () => { if (!extension) throw new NeedExtensionError(); },
  tabs: async () => tabs,
  host, runner, win: { isAgentTab: (t: number) => t === 20, dispose: async (k: string) => { disposed.push(k); } }, debugWindows, sessions, ingest, raw, log, index,
  daemon: () => ({ extension, pid: process.pid }),
  composeDir: path.join(dir, "compose"),
} as unknown as Ctx;
const D = ["--description", "测试这一步"];
const run = (...argv: string[]) => runCommand(argv, ctx);
const idOf = (stdout: string) => /学习会话：(debug-[0-9a-f]+)/.exec(stdout)![1]!;

// 用法、已经没有的命令、握手
assert.equal((await run()).code, 1);
assert.match((await run("bogus")).stdout, /用法/);
for (const gone of ["log", "sql", "req", "context", "api", "task"]) {
  const r = await run(gone, "x");
  assert.equal(r.code, 1);
  assert.match(r.stdout, new RegExp(`tabbot ${gone} 已经没有了.*${escapeRe(dir)}`), "告诉 agent 日志和 task 现在是哪里的文件");
}
extension = false;
const hs = await run("tabs");
assert.equal(hs.code, 1); assert.equal(JSON.parse(hs.stdout).status, "need-extension");
extension = true;
// tabs 只列用户自己的页面（agent 窗口的和 anchor 页不算）
assert.match((await run("tabs")).stdout, /^1 个标签页\ntab7 win1 前台 https:\/\/www\.x\.com\/home "示例"$/);

// 之前在 run 窗口里做过的事：点一下，发了一个 POST（原始请求带 token 真值在内存里）。用户自己的窗口（tab 7）也发了一个：不录
const T = Date.now() - 5_000;
ingest.handleBatch([
  net(7, T - 100, { id: 9, rid: "u:9", method: "POST", url: "https://x.com/api/mine", body: "{}", size: 2 }),
  { k: "ev", t: T, tab: 8, page, type: "click", trusted: true, target: { tag: "button", text: "Like", sel: "#like" } },
  net(8, T + 100, { id: 1, rid: "d:1", method: "POST", url: "https://x.com/api/like?access_token=" + SECRET, reqHeaders: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" }, reqBody: JSON.stringify({ tweet_id: "111" }), body: "{\"ok\":true}", size: 11 }),
]);
ingest.flush();
const likeSeq = log.readRows("x.com", { limit: 10 }).find((r) => r.endpoint === "POST /api/like")!.seq;
assert.ok(!log.readRows("x.com", { limit: 50 }).some((r) => r.endpoint === "POST /api/mine"), "用户窗口的请求不录");

// 调试只能在学习会话里：没开会话拒绝，run 窗口也不行；learn 要 --site、task 名全局唯一
let r = await run("debug", "open", "x.com/home");
assert.equal(r.code, 1); assert.match(r.stdout, /没有学习会话.*tabbot learn/);
assert.match((await run("debug", "--window", "run", "open", "x.com")).stdout, /不是学习会话/, "run 窗口不能调试");
assert.equal((await run("debug", "--window", "debug-nope", "open", "x.com")).code, 1);
assert.match((await run("learn", "like-tweet", "--endpoint", "POST /api/like")).stdout, /需要 --site/);
assert.match((await run("learn", "Bad Name", "--site", "x.com", "--endpoint", "POST /api/like")).stdout, /用法/);
assert.match((await run("learn", "no-such", "--site", "x.com", "--endpoint", "POST /api/like", "--fix")).stdout, /不存在，不能 --fix/);
// 一次只学一个请求：--endpoint 和 --find 二选一
r = await run("learn", "like-tweet", "--site", "x.com");
assert.equal(r.code, 1); assert.match(r.stdout, /需要 --endpoint.*--find.*只学一个请求/);
assert.match((await run("learn", "like-tweet", "--site", "x.com", "--endpoint", "POST /api/like", "--find", "点赞")).stdout, /只能给一个/);
assert.equal(debugWindows.active().length, 0, "被拒绝的 learn 不开学习会话");

// learn：开学习会话，创建工作区和 tasks/，导出材料，学习指引指向这些文件
r = await run("learn", "like-tweet", "--note", "tweet_id 做成参数", "--site", "WWW.X.com", "--endpoint", "POST /api/like");
assert.equal(r.code, 0, r.stdout);
const win1 = idOf(r.stdout);
assert.match(r.stdout, /学习会话已开：这次只学会一个请求/); assert.match(r.stdout, /纪律/); assert.match(r.stdout, /最终回复要引用 run 输出里的回执/);
assert.ok(!/subagent|haiku/.test(r.stdout), "没有 subagent 这个角色了");
assert.ok(!/示范/.test(r.stdout), "没有用户示范");
assert.match(r.stdout, /# 起点：已在会话窗口打开 https:\/\/www\.x\.com\/home/, "没给 --url 就在会话窗口打开站点首页");
assert.match(r.stdout, /学会请求 POST \/api\/like/); assert.match(r.stdout, /探索即写 task/); assert.match(r.stdout, /引发请求后会锁定/); assert.match(r.stdout, /close --blocked/); assert.ok(!/snapshot|@e12|debug-\w+ act /.test(r.stdout), "学习指引里没有可访问树那套探索"); assert.match(r.stdout, /只学这一个请求/); assert.match(r.stdout, /先 network，不行才 dom/); assert.match(r.stdout, /补充：tweet_id 做成参数/);
assert.match(r.stdout, /tabbot debug replay <编号>/); assert.match(r.stdout, /没有读日志的 TabBot 命令/);
const work = path.join(dir, "x.com", "debug", win1);
const manifest = JSON.parse(fs.readFileSync(path.join(work, "material", "manifest.json"), "utf8"));
assert.equal(manifest.site, "x.com", "站点归一：WWW.X.com → x.com");
assert.equal(manifest.counts.anchors, 1);
assert.ok(fs.existsSync(path.join(dir, "x.com", "tasks")));
for (const f of fs.readdirSync(work, { recursive: true, withFileTypes: true })) if (f.isFile()) assert.ok(!fs.readFileSync(path.join(f.parentPath, f.name)).includes(SECRET), "材料里没有 token 真值");
assert.match((await run("learn", "like-tweet", "--site", "x.com", "--endpoint", "POST /api/like")).stdout, /已经有学习会话 debug-/, "同一份 task 只开一个会话");
// 不知道接口：--find 派发，接口写错或没有样本只警告，不拒绝；brief 要求最终只交一个 @endpoint
r = await run("learn", "typo-endpoint", "--site", "x.com", "--endpoint", "POST /api/nope");
assert.equal(r.code, 0, r.stdout); assert.match(r.stdout, /endpoints\.json 里没有接口「POST \/api\/nope」.*改用 --find/);
r = await run("learn", "find-share", "--site", "x.com", "--find", "分享推文拿到链接");
assert.equal(r.code, 0, r.stdout); assert.match(r.stdout, /找到并学会「分享推文拿到链接」背后的那一个请求/); assert.match(r.stdout, /最终只写一个 @endpoint/); assert.match(r.stdout, /待你找出来/);
// --url：用户说"我的某某页面"时，agent 用 tabbot tabs 对出标签页号；只取它的地址，在会话窗口里重新打开；站点可以从地址推出来
r = await run("learn", "from-tab", "--url", "tab7", "--find", "首页列表");
assert.equal(r.code, 0, r.stdout); assert.match(r.stdout, /站点：x\.com/); assert.match(r.stdout, /# 起点：已在会话窗口打开/);
assert.match((await run("learn", "from-tab2", "--url", "tab999", "--find", "x")).stdout, /没有标签页 tab999.*tabbot tabs/);
assert.match((await run("learn", "from-tab3", "--url", "20", "--find", "x")).stdout, /没有标签页 20/, "agent 窗口的标签页不算用户给的");
assert.match((await run("learn", "from-tab4", "--url", "ftp://x", "--find", "x")).stdout, /--url 要是 http\(s\) 链接/);
r = await run("learn", "from-link", "--url", "https://www.x.com/item/5", "--find", "详情");
assert.equal(r.code, 0, r.stdout); assert.match(r.stdout, /站点：x\.com/);
for (const n of ["a-1", "a-2", "a-3"]) assert.equal((await run("learn", n, "--site", "x.com", "--endpoint", "POST /api/like")).code, 0, "同一个站点的学习会话不设上限");

// 在学习会话里调试：在自己的 agent 窗口里（开着好几个会话时要写 --window）
r = await run("debug", "open", "x.com/home");
assert.equal(r.code, 1); assert.match(r.stdout, /开着 \d+ 个学习会话.*--window/);
// 关键动作要带 --description：没带就拒绝，且不占操作次数
const opsNoDesc = debugWindows.get(win1)!.ops;
r = await run("debug", "--window", win1, "click", "1", "1");
assert.equal(r.code, 1); assert.match(r.stdout, /要带 --description/);
assert.equal(debugWindows.get(win1)!.ops, opsNoDesc, "没带 description 被拒绝不占操作次数");
r = await run("debug", "--window", win1, "open", "x.com/home", ...D);
assert.equal(r.code, 0, r.stdout); assert.match(r.stdout, /\[调试\] 学习会话/); assert.match(r.stdout, /已在 agent 窗口打开 https:\/\/www\.x\.com\/home "示例"/);
// 探索：只有截图和按坐标的操作；截图存成文件，图上的坐标就是操作的坐标
r = await run("debug", "--window", win1, "screenshot");
assert.equal(r.code, 0, r.stdout); assert.match(r.stdout, /✓ 截图 \S+debug\/debug-\w+\/shots\/001\.jpg（1280×720/);
const shotFile = r.stdout.match(/截图 (\S+\.jpg)/)![1]!;
assert.equal(fs.readFileSync(shotFile, "utf8"), "jpeg-bytes", "图片内容按原样写成文件");
assert.match((await run("debug", "--window", win1, "screenshot")).stdout, /shots\/002\.jpg/);
r = await run("debug", "--window", win1, "click", "120", "340", "--description", "点提交保存表单");
assert.equal(r.code, 0, r.stdout); assert.match(r.stdout, /✓ click 元素的持久定位（写 task 用这个）\{"role":"button","name":"提交"\}/);
assert.match(r.stdout, /这一步引发了请求：\n\s+#\d+ POST https:\/\/x\.com\/api\/save → 200 application\/json，有响应体，请求文件 \S+_POST_x\.com_api_save\.json/, "click 告诉你它引发的请求、内容类型、有没有响应体，并给出请求文件");
assert.match(r.stdout, /可贴进 task：await click\(page, \{"role":"button","name":"提交"\}\);/, "每一步给一行可贴进 task 的代码");
// 引发请求后锁定：先更新 task 草稿才能继续动作；screenshot 不受限；被拒绝的动作不占操作次数
assert.match(r.stdout, /已锁定：先更新 task 草稿/);
const opsBefore = debugWindows.get(win1)!.ops;
r = await run("debug", "--window", win1, "click", "10", "10", ...D);
assert.equal(r.code, 1); assert.match(r.stdout, /已锁定：上一步引发了请求（#\d+）.*screenshot 和 replay 不受限/);
assert.equal(debugWindows.get(win1)!.ops, opsBefore, "被拒绝的动作不占操作次数");
assert.equal((await run("debug", "--window", win1, "open", "x.com/home", ...D)).code, 1, "open 也被锁");
assert.match((await run("debug", "--window", win1, "screenshot")).stdout, /✓ 截图/, "screenshot 不受锁定");
const draftFile = path.join(dir, "x.com", "tasks", "like-tweet.js");
fs.writeFileSync(draftFile, "/**\n * @summary 点赞\n * @status: draft\n * @endpoint POST /api/save\n */\n");
const later = new Date(Date.now() + 5000); fs.utimesSync(draftFile, later, later); // 草稿在锁定之后被改过
assert.match((await run("debug", "--window", win1, "click", "@e1", ...D)).stdout, /用法：tabbot debug click <x> <y>/);
assert.equal(debugWindows.get(win1)!.lock, undefined, "草稿改过就解锁");
// description 进了时间线；它引发的请求所在接口的 endpoints.json 记下这句（来源 click）
assert.ok(log.readRows("x.com", { wins: [win1], limit: 100 }).some((x) => x.type === "cmd" && x.description === "点提交保存表单"));
const saveDesc = index.snapshot("x.com").endpoints.find((e) => e.key === "POST /api/save")!.descriptions!;
assert.equal(saveDesc[0]!.text, "点提交保存表单"); assert.equal(saveDesc[0]!.from, "click");
// 再点一次（同一句）只留一份；换一句时，输出里带上这个接口以前的 description
fs.utimesSync(draftFile, new Date(Date.now() + 6000), new Date(Date.now() + 6000));
r = await run("debug", "--window", win1, "click", "120", "340", "--description", "点提交保存表单");
assert.doesNotMatch(r.stdout, /以前：点提交保存表单/, "刚写的这句不算以前");
fs.utimesSync(draftFile, new Date(Date.now() + 7000), new Date(Date.now() + 7000));
r = await run("debug", "--window", win1, "click", "120", "340", "--description", "再保存一次");
assert.match(r.stdout, /（以前：点提交保存表单）/);
assert.equal(index.snapshot("x.com").endpoints.find((e) => e.key === "POST /api/save")!.descriptions!.filter((d) => d.text === "点提交保存表单").length, 1);
fs.utimesSync(draftFile, new Date(Date.now() + 9000), new Date(Date.now() + 9000));
// 跨站点：页面跳到 y.com，这一步的请求记在 y.com，输出写明并列出来
r = await run("debug", "--window", win1, "click", "777", "1", "--description", "点开 MR 5");
assert.match(r.stdout, /页面跳到了 y\.com（另一个站点）/); assert.match(r.stdout, /#\d+ GET https:\/\/y\.com\/api\/mr\/5/);
assert.equal(index.snapshot("y.com").endpoints.find((e) => e.key.startsWith("GET /api/mr/"))?.descriptions?.[0]?.text, "点开 MR 5", "跨站点的请求也记下这句");
fs.utimesSync(draftFile, new Date(Date.now() + 12000), new Date(Date.now() + 12000));
for (const gone of ["snapshot", "text", "act"]) assert.match((await run("debug", "--window", win1, gone)).stdout, /open\|screenshot\|click/, `${gone} 没有了`);
const own = log.readRows("x.com", { wins: [win1], limit: 50 });
assert.ok(own.length >= 3 && own.every((x) => x.win === win1 && x.src === "agent"), "学习会话里做的一切记在自己窗口的时间线里，来源是 agent");
assert.equal(log.readRows("x.com", { wins: ["user"], limit: 50 }).length, 0, "没有用户窗口的时间线");

// 第二个学习会话的材料不含第一个（仍开着）的行
const second = await run("learn", "fav-tweet", "--site", "x.com", "--endpoint", "POST /api/like");
const win2 = idOf(second.stdout);
const m2 = JSON.parse(fs.readFileSync(path.join(dir, "x.com", "debug", win2, "material", "manifest.json"), "utf8"));
assert.ok(m2.windows.excluded.includes(win1) && !m2.windows.included.includes(win1), JSON.stringify(m2.windows));
assert.ok(!fs.existsSync(path.join(dir, "x.com", "debug", win2, "material", `timeline.${win1}.jsonl`)));

// 重放：请求文件在 debug 窗口绑定的站点里找，原始请求（真值）在内存里；非 GET 要 --yes
r = await run("debug", "--window", win1, "replay", String(likeSeq), ...D);
assert.equal(r.code, 1); assert.match(r.stdout, /--yes/);
r = await run("debug", "--window", win1, "replay", String(likeSeq), "--yes", "--set", "body.tweet_id=222", ...D);
assert.equal(r.code, 0, r.stdout); assert.match(r.stdout, /✓ 重放 #\d+（改了 body\.tweet_id）：POST → 200/); assert.match(r.stdout, /JSON 对象，字段：items/);
const sent = JSON.parse(calls.filter((c) => c.startsWith("replay ")).at(-1)!.slice("replay ".length));
assert.equal(sent.body, "{\"tweet_id\":\"222\"}", "请求体里的字段改了");
assert.equal(sent.headers.authorization, `Bearer ${SECRET}`, "发出去的是真值");
assert.ok(sent.url.includes(SECRET), "地址里的真值也带上");
const replayed = log.readRows("x.com", { wins: [win1], limit: 50 }).filter((x) => x.requestType === "replay").at(-1)!;
assert.equal(replayed.replayOf, likeSeq);
assert.ok(replayed.win === win1 && replayed.src === "agent", "重放记在学习会话自己窗口的时间线里");
assert.ok(!fs.readFileSync(log.findRequestFile("x.com", replayed.seq)!.abs, "utf8").includes(SECRET), "重放的请求文件里没有真值");
assert.match((await run("debug", "--window", win1, "replay", "999999", ...D)).stdout, /找不到站点 x\.com 的请求 #999999/);
// 原始内容不在内存里（重启过）：告诉 agent 怎么办
const stale = log.findRequestFile("x.com", likeSeq)!;
const staleFile = JSON.parse(fs.readFileSync(stale.abs, "utf8")); staleFile.rid = "never-seen";
fs.writeFileSync(stale.abs, JSON.stringify(staleFile));
r = await run("debug", "--window", win1, "replay", String(likeSeq), "--yes", ...D);
assert.equal(r.code, 1); assert.match(r.stdout, /原始内容已经不在 holder 的内存里.*debug --window debug-/);

// run：不带 --window 在 run 窗口里跑；compose 只组合
assert.match((await run("run", "demo", "--q", "你好")).stdout, /要带 --description/, "run 要带 description");
r = await run("run", "demo", "--q", "你好", ...D);
assert.match(r.stdout, /"mode": "执行",\n  "receipt": "RC-[0-9a-f]{8}",\n  "status": "success"/);
// 回执：每次 run / compose 发一个，写进 sites/.receipts.jsonl，最终回复要引用它（hooks/stop-receipt.mjs 检查）
const rc1 = /"receipt": "(RC-[0-9a-f]{8})"/.exec(r.stdout)![1]!;
assert.match(fs.readFileSync(path.join(dir, ".receipts.jsonl"), "utf8"), new RegExp(`"receipt":"${rc1}".*"task":"demo".*"status":"success"`));

assert.equal(runs.at(-1), 'demo {"q":"你好"} key=run dry=false');
r = await run("run", "demo", "--q", "x", "--dry", ...D);
assert.match(r.stdout, /"mode": "试运行"/);
assert.notEqual(/"receipt": "(RC-[0-9a-f]{8})"/.exec(r.stdout)![1], rc1, "每次的回执都不一样");
assert.equal((await run("run", "demo", "q", ...D)).code, 1);
assert.equal((await run("run", "demo", "--window", "debug-nope", ...D)).code, 1);
// compose：要带 description；成功的代码存进 compose 目录（头里有 description、用到的 task、参数），同样的代码只存一份
assert.match((await run("compose", "return 1")).stdout, /要带 --description/);
assert.match((await run("compose", "return 1", ...D)).stdout, /"result": "return 1"/);
assert.match((await run("compose", "return 1", ...D)).stdout, /"receipt": "RC-[0-9a-f]{8}"/, "compose 也发回执");
const cdir = path.join(dir, "compose");
const combo = 'const a = await task("like-tweet", { id: tabbot.params.id ?? "1" }); return a;';
r = await run("compose", "--description", "给某条推文点赞", combo, "--id", "9");
assert.match(r.stdout, /"params": \{\n\s+"id": "9"/, "参数传给了 compose"); assert.match(r.stdout, /这段已存为/);
const savedFile = /这段已存为 (\S+\.js)/.exec(r.stdout)![1]!;
let saved = fs.readFileSync(savedFile, "utf8");
assert.match(saved, /^\/\/ 给某条推文点赞\n/); assert.match(saved, /@uses like-tweet/); assert.match(saved, /@params id/); assert.match(saved, /@ok 1 次/);
// 拿存下的文件带参数再跑：头不算进代码，还是同一份，description 累加、次数加一
r = await run("compose", "--description", "点赞", savedFile, "--id", "10");
assert.equal(r.code, 0, r.stdout);
saved = fs.readFileSync(savedFile, "utf8");
assert.match(saved, /^\/\/ 点赞\n/); assert.match(saved, /@description 给某条推文点赞/); assert.match(saved, /@ok 2 次/);
assert.equal(fs.readdirSync(cdir).filter((f) => f.endsWith(".js")).length, 2, "return 1 一份、点赞组合一份");
assert.match((await run("compose", "return 2", ...D)).stdout, /提示：变化的值写成 tabbot\.params/, "没用参数的提示一句");
assert.doesNotMatch((await run("compose", "FAIL()", ...D)).stdout, /这段已存为/, "失败的不存");

// 在会话里把别的 task 跑通不会收回会话；跑通自己那份才收回：窗口关掉、工作区删除、再调试被拒；它留下的日志是历史，不删
await run("run", "demo", "--window", win1, ...D);
assert.equal(runs.at(-1), `demo {} key=${win1} dry=false`);
assert.deepEqual(disposed, []);
await run("run", "like-tweet", "--window", win1, "--description", "保存这条记录");
assert.ok(index.snapshot("x.com").endpoints.find((e) => e.key === "POST /api/save")!.descriptions!.some((d) => d.text === "保存这条记录" && d.from === "run"), "run 成功时这句记到 task 覆盖的接口上");
assert.equal(runs.at(-1), `like-tweet {} key=${win1} dry=false`);
assert.deepEqual(disposed, [win1]);
assert.ok(!fs.existsSync(work), "工作区（含材料）整个删除");
assert.ok(log.readRows("x.com", { wins: [win1], limit: 50 }).length > 0, "日志留着");
r = await run("debug", "--window", win1, "screenshot");
assert.equal(r.code, 1); assert.match(r.stdout, /已经收回/);
assert.equal((await run("run", "demo", "--window", win1, ...D)).code, 1);

// 放弃（debug close）和超时回收都走同一个收回；收回后同名 task 可以重新派
disposed.length = 0;
r = await run("debug", "--window", win2, "close");
assert.equal(r.code, 1); assert.match(r.stdout, /close --blocked/, "不带 --blocked 不让关：会话要么 run 通过，要么留下学不会的记录");
assert.deepEqual(disposed, []);
r = await run("debug", "--window", win2, "close", "--blocked", "试过 #5 重放，响应无内容；DOM 读不到");
assert.equal(r.code, 0, r.stdout); assert.deepEqual(disposed, [win2]); assert.ok(!sessions.has(win2));
assert.match(r.stdout, /"mode": "学不会",\n  "receipt": "RC-[0-9a-f]{8}"/, "blocked 关闭也发回执");
const blockedFile = path.join(dir, "x.com", "tasks", "fav-tweet.js");
const blockedText = fs.readFileSync(blockedFile, "utf8");
assert.match(blockedText, /@status: blocked/); assert.match(blockedText, /@note 学不会：试过 #5 重放/);
assert.match((await run("learn", "fav-tweet", "--site", "x.com", "--endpoint", "POST /api/like")).stdout, /学不会的记录.*不要再探索/, "blocked 的 task 不再探索");
assert.equal((await run("learn", "fav-tweet", "--site", "x.com", "--endpoint", "POST /api/like", "--fix")).code, 0, "有新证据才用 --fix 重开");
assert.match(fs.readFileSync(blockedFile, "utf8"), /@status: draft/, "重开改回草稿，否则 run 会拒绝");
fs.rmSync(draftFile, { force: true });
const a1 = debugWindows.active().find((w) => w.task === "a-1")!;
assert.ok(debugWindows.idle(Date.now() + 31 * 60_000).some((w) => w.id === a1.id), "30 分钟没有操作就该回收");
assert.equal(debugWindows.idle().length, 0);
disposed.length = 0;
await releaseDebugWindow(ctx, a1.id);
assert.deepEqual(disposed, [a1.id]);

// 草稿：上次没完成的 task（draft）再 delegate 要 --fix；task 在别的站点就不能在这个站点续
const tasks = path.join(dir, "x.com", "tasks");
fs.writeFileSync(path.join(tasks, "half-done.js"), "/**\n * @summary 做了一半\n * @status: draft\n * @endpoint POST /api/save\n */\n");
fs.writeFileSync(path.join(tasks, "done.js"), "/**\n * @summary 做完了\n * @status: verified\n * @endpoint POST /api/like\n */\n");
assert.match((await run("learn", "half-done", "--site", "x.com", "--endpoint", "POST /api/save")).stdout, /上次没完成的草稿.*--fix/);
assert.match((await run("learn", "done", "--site", "x.com", "--endpoint", "POST /api/like")).stdout, /已存在/);
assert.match((await run("learn", "half-done", "--site", "y.com", "--endpoint", "POST /api/save", "--fix")).stdout, /在站点 x\.com 下/);
r = await run("learn", "half-done", "--site", "x.com", "--fix");
assert.equal(r.code, 0, r.stdout); assert.match(r.stdout, /接着做或修好它/); assert.match(r.stdout, /学会请求 POST \/api\/save/, "--fix 缺省取 task 文件头的 @endpoint");
// status：日志占用、debug 窗口、没完成的草稿
const st = (await run("status")).stdout;
assert.match(st, /录制：\d+ 个站点，轻量层/); assert.match(st, /学习会话：debug-/); assert.match(st, new RegExp(escapeRe(dir)));
fs.writeFileSync(path.join(tasks, "orphan.js"), "/**\n * @status: draft\n */\n");
assert.match((await run("status")).stdout, /没完成的草稿 task.*orphan（x\.com）/);
// endpoints.json 的 task 覆盖标记跟着 tasks/ 里的 @endpoint 走
index.touch("x.com"); index.flush();
assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "x.com", "endpoints.json"), "utf8")).endpoints.find((e: { key: string }) => e.key === "POST /api/like").task, "done");

// 只开着一个学习会话时，调试可以不写窗口号
const solo = new DebugWindows();
assert.match((solo.use(undefined) as { error: string }).error, /没有学习会话/);
const only = solo.open({ task: "t1", goal: "", site: "x.com", fix: false }) as { id: string };
assert.equal((solo.use(undefined) as { id: string }).id, only.id);
solo.open({ task: "t2", goal: "", site: "x.com", fix: false });
assert.match((solo.use(undefined) as { error: string }).error, /开着 2 个学习会话/);

console.log("commands.selfcheck ok");
