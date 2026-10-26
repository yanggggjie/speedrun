// 命令层：参数解析，以及用假的 holder 能力（假页面、假标签页）端到端跑 delegate / debug / run / replay / status。
// 读日志不是命令（是文件），这里只守住强制规则：主 agent 不能调试、一个 task 只派一个 subagent、debug 窗口收回、重放走原始请求。
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NeedExtensionError } from "../browser/connect.ts";
import { DebugWindows } from "../run/debug-windows.ts";
import { Session } from "../run/host.ts";
import { coveredEndpoints } from "../run/tasks.ts";
import { parseAct, parseReplayArgs, releaseDebugWindow, runCommand, type Ctx } from "./commands.ts";
import { EndpointIndex } from "./endpoints.ts";
import { Ingestor, type PageMsg } from "./ingest.ts";
import { RawStore } from "./raw.ts";
import { SiteLog } from "./sitelog.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tc-cmd-"));
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---- 参数解析 ----
const ok = (args: string[]) => { const r = parseAct(args); assert.ok("cmd" in r, JSON.stringify(r)); return r.cmd; };
const bad = (args: string[]) => { const r = parseAct(args); assert.ok("error" in r, JSON.stringify(r)); return r.error; };
assert.deepEqual(ok(["click", "@e12"]), { kind: "click", ref: "@e12" });
assert.deepEqual(ok(["click", "e12"]), { kind: "click", ref: "@e12" }, "@ 可以省略");
assert.deepEqual(ok(["click", "#go"]), { kind: "click", loc: "#go" }, "CSS 选择器是持久定位");
assert.deepEqual(ok(["click", '{"role":"button","name":"提交"}']), { kind: "click", loc: { role: "button", name: "提交" } });
assert.deepEqual(ok(["fill", "@e5", "你好", "世界"]), { kind: "fill", ref: "@e5", text: "你好 世界" });
assert.deepEqual(ok(["check", "@e3", "--off"]), { kind: "check", ref: "@e3", checked: false });
assert.deepEqual(ok(["press", "Ctrl+K", "@e5"]), { kind: "press", key: "Ctrl+K", ref: "@e5" });
assert.deepEqual(ok(["scroll", "up", "200"]), { kind: "scroll", dy: -200 });
assert.deepEqual(ok(["scroll", "bottom"]), { kind: "scroll", to: "bottom" });
assert.match(bad(["click"]), /需要目标/);
assert.match(bad(["click", "{坏的"]), /不是合法 JSON/);
assert.match(bad(["fill", "@e5"]), /用法：tabbot debug act fill/);
assert.match(bad([]), /用法：tabbot debug act click/);
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
const WINS: Record<number, string> = {};
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
    if (name === "act") {
      const ref = ingest.beginCmd(20, Date.now(), String(a.kind), "x", undefined, "x.com");
      ingest.handleBatch([net(20, Date.now() + 30, { id: 1, rid: "p:1", method: "POST", url: "https://x.com/api/save", reqBody: JSON.stringify({ n: 1 }), body: "{\"saved\":true}", size: 14 })]);
      ingest.endCmd(ref, { detail: { ok: true } });
      return { ok: true, loc: { role: "button", name: "提交" }, settle: { settled: true, waitedMs: 130 }, url: page, title: "示例" };
    }
    if (name === "snapshot") return { url: page, title: "示例", interactiveTotal: 3, interactiveVisible: 2, inViewShown: 2, items: [{ ref: "e1", t: "button", n: "提交" }] };
    if (name === "text") return { url: page, title: "示例", total: 4, text: "你好世界" };
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
  runCompose: async (code: string) => ({ status: "success", result: code }),
};
const disposed: string[] = [];
const debugWindows = new DebugWindows();
const sessions = new Map<string, Session>();
const ctx = {
  ensureExtension: async () => { if (!extension) throw new NeedExtensionError(); },
  tabs: async () => tabs,
  host, runner, win: { isAgentTab: (t: number) => t === 20, dispose: async (k: string) => { disposed.push(k); } }, debugWindows, sessions, ingest, raw, log, index,
  daemon: () => ({ extension, pid: process.pid }),
} as unknown as Ctx;
const run = (...argv: string[]) => runCommand(argv, ctx);
const idOf = (stdout: string) => /debug 窗口：(debug-[0-9a-f]+)/.exec(stdout)![1]!;

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

// 用户之前在 Chrome 里做过的事：点一下，发了一个 POST（原始请求带 token 真值在内存里）
const T = Date.now() - 5_000;
ingest.handleBatch([
  { k: "ev", t: T, tab: 7, page, type: "click", trusted: true, target: { tag: "button", text: "Like", sel: "#like" } },
  net(7, T + 100, { id: 1, rid: "d:1", method: "POST", url: "https://x.com/api/like?access_token=" + SECRET, reqHeaders: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" }, reqBody: JSON.stringify({ tweet_id: "111" }), body: "{\"ok\":true}", size: 11 }),
]);
ingest.flush();
const likeSeq = log.readRows("x.com", { limit: 10 }).find((r) => r.endpoint === "POST /api/like")!.seq;

// 主 agent 没有调试权限：没带 debug 窗口号一律拒绝，run 窗口也不行；delegate 要 --site、task 名全局唯一
let r = await run("debug", "open", "x.com/home");
assert.equal(r.code, 1); assert.match(r.stdout, /主 agent 没有调试权限/);
assert.match((await run("debug", "--window", "run", "open", "x.com")).stdout, /不是 debug 窗口/, "run 窗口不能调试");
assert.equal((await run("debug", "--window", "debug-nope", "open", "x.com")).code, 1);
assert.match((await run("delegate", "like-tweet", "--endpoint", "POST /api/like")).stdout, /需要 --site/);
assert.match((await run("delegate", "Bad Name", "--site", "x.com", "--endpoint", "POST /api/like")).stdout, /用法/);
assert.match((await run("delegate", "no-such", "--site", "x.com", "--endpoint", "POST /api/like", "--fix")).stdout, /不存在，不能 --fix/);
// 一个 subagent 只学一个请求：--endpoint 必填，接口必须在 endpoints.json 里
r = await run("delegate", "like-tweet", "--site", "x.com");
assert.equal(r.code, 1); assert.match(r.stdout, /需要 --endpoint.*--find.*只学一个请求/);
assert.match((await run("delegate", "like-tweet", "--site", "x.com", "--endpoint", "POST /api/like", "--find", "点赞")).stdout, /只能给一个/);
assert.equal(debugWindows.active().length, 0, "被拒绝的 delegate 不开 debug 窗口");

// delegate：开 debug 窗口，创建工作区和 tasks/，导出材料，brief 指向这些文件
r = await run("delegate", "like-tweet", "--note", "tweet_id 做成参数", "--site", "WWW.X.com", "--endpoint", "POST /api/like");
assert.equal(r.code, 0, r.stdout);
const win1 = idOf(r.stdout);
assert.match(r.stdout, /你是 subagent/); assert.match(r.stdout, /为什么分主 agent 和 subagent/); assert.match(r.stdout, /用最快的模型档位.*model: "haiku"/, "派发说明里要求 subagent 用快模型");
assert.match(r.stdout, /学会请求 POST \/api\/like/); assert.match(r.stdout, /只学这一个请求/); assert.match(r.stdout, /先 network，不行才 dom/); assert.match(r.stdout, /补充说明.*tweet_id 做成参数/);
assert.match(r.stdout, new RegExp(`tabbot debug --window ${win1} replay`)); assert.match(r.stdout, /没有读日志的 TabBot 命令/);
const work = path.join(dir, "x.com", "debug", win1);
const manifest = JSON.parse(fs.readFileSync(path.join(work, "material", "manifest.json"), "utf8"));
assert.equal(manifest.site, "x.com", "站点归一：WWW.X.com → x.com");
assert.equal(manifest.counts.anchors, 1);
assert.ok(fs.existsSync(path.join(dir, "x.com", "tasks")));
for (const f of fs.readdirSync(work, { recursive: true, withFileTypes: true })) if (f.isFile()) assert.ok(!fs.readFileSync(path.join(f.parentPath, f.name)).includes(SECRET), "材料里没有 token 真值");
assert.match((await run("delegate", "like-tweet", "--site", "x.com", "--endpoint", "POST /api/like")).stdout, /已经有 debug 窗口 debug-/, "同一个 task 只派一个 subagent");
// 不知道接口：--find 派发，接口写错或没有样本只警告，不拒绝；brief 要求最终只交一个 @endpoint
r = await run("delegate", "typo-endpoint", "--site", "x.com", "--endpoint", "POST /api/nope");
assert.equal(r.code, 0, r.stdout); assert.match(r.stdout, /endpoints\.json 里没有接口「POST \/api\/nope」.*改用 --find/);
r = await run("delegate", "find-share", "--site", "x.com", "--find", "分享推文拿到链接");
assert.equal(r.code, 0, r.stdout); assert.match(r.stdout, /找到并学会「分享推文拿到链接」背后的那一个请求/); assert.match(r.stdout, /最终只交一个 @endpoint/); assert.match(r.stdout, /待你找出来/);
for (const n of ["a-1", "a-2", "a-3"]) assert.equal((await run("delegate", n, "--site", "x.com", "--endpoint", "POST /api/like")).code, 0, "同一个站点的 subagent 不设上限");

// subagent 用 debug 窗口调试：在自己的 agent 窗口里
r = await run("debug", "--window", win1, "open", "x.com/home");
assert.equal(r.code, 0, r.stdout); assert.match(r.stdout, /\[调试\] debug 窗口/); assert.match(r.stdout, /已在 agent 窗口打开 https:\/\/www\.x\.com\/home "示例"/);
assert.match((await run("debug", "--window", win1, "snapshot")).stdout, /tab20 https:\/\/www\.x\.com\/home "示例"\n.*\n@e1 button "提交"/);
assert.match((await run("debug", "--window", win1, "text", "--max", "100")).stdout, /你好世界/);
r = await run("debug", "--window", win1, "act", "click", "@e1");
assert.equal(r.code, 0, r.stdout); assert.match(r.stdout, /✓ click 持久定位 \{"role":"button","name":"提交"\}/);
assert.match(r.stdout, /这一步引发了请求：\n\s+#\d+ POST https:\/\/x\.com\/api\/save → \S+_POST_x\.com_api_save\.json/, "act 告诉你它引发的请求，并给出请求文件");
assert.match((await run("debug", "--window", win1, "act", "click")).stdout, /需要目标/);
const own = log.readRows("x.com", { wins: [win1], limit: 50 });
assert.ok(own.length >= 3 && own.every((x) => x.win === win1 && x.src === "agent"), "subagent 做的一切记在自己窗口的时间线里，来源是 agent");
assert.ok(log.readRows("x.com", { wins: ["user"], limit: 50 }).every((x) => x.win === "user"), "用户的时间线里没有 agent 的行");

// 第二个 subagent 的材料不含第一个（仍开着）的行
const second = await run("delegate", "fav-tweet", "--site", "x.com", "--endpoint", "POST /api/like");
const win2 = idOf(second.stdout);
const m2 = JSON.parse(fs.readFileSync(path.join(dir, "x.com", "debug", win2, "material", "manifest.json"), "utf8"));
assert.ok(m2.windows.excluded.includes(win1) && !m2.windows.included.includes(win1), JSON.stringify(m2.windows));
assert.ok(!fs.existsSync(path.join(dir, "x.com", "debug", win2, "material", `timeline.${win1}.jsonl`)));

// 重放：请求文件在 debug 窗口绑定的站点里找，原始请求（真值）在内存里；非 GET 要 --yes
r = await run("debug", "--window", win1, "replay", String(likeSeq));
assert.equal(r.code, 1); assert.match(r.stdout, /--yes/);
r = await run("debug", "--window", win1, "replay", String(likeSeq), "--yes", "--set", "body.tweet_id=222");
assert.equal(r.code, 0, r.stdout); assert.match(r.stdout, /✓ 重放 #\d+（改了 body\.tweet_id）：POST → 200/); assert.match(r.stdout, /JSON 对象，字段：items/);
const sent = JSON.parse(calls.filter((c) => c.startsWith("replay ")).at(-1)!.slice("replay ".length));
assert.equal(sent.body, "{\"tweet_id\":\"222\"}", "请求体里的字段改了");
assert.equal(sent.headers.authorization, `Bearer ${SECRET}`, "发出去的是真值");
assert.ok(sent.url.includes(SECRET), "地址里的真值也带上");
const replayed = log.readRows("x.com", { wins: [win1], limit: 50 }).filter((x) => x.requestType === "replay").at(-1)!;
assert.equal(replayed.replayOf, likeSeq);
assert.ok(replayed.win === win1 && replayed.src === "agent", "重放记在 subagent 自己窗口的时间线里");
assert.ok(!fs.readFileSync(log.findRequestFile("x.com", replayed.seq)!.abs, "utf8").includes(SECRET), "重放的请求文件里没有真值");
assert.match((await run("debug", "--window", win1, "replay", "999999")).stdout, /找不到站点 x\.com 的请求 #999999/);
// 原始内容不在内存里（重启过）：告诉 subagent 怎么办
const stale = log.findRequestFile("x.com", likeSeq)!;
const staleFile = JSON.parse(fs.readFileSync(stale.abs, "utf8")); staleFile.rid = "never-seen";
fs.writeFileSync(stale.abs, JSON.stringify(staleFile));
r = await run("debug", "--window", win1, "replay", String(likeSeq), "--yes");
assert.equal(r.code, 1); assert.match(r.stdout, /原始内容已经不在 holder 的内存里.*debug --window debug-/);

// run：不带 --window 在 run 窗口里跑；compose 只组合
assert.match((await run("run", "demo", "--q", "你好")).stdout, /"mode": "执行",\n  "status": "success"/);
assert.equal(runs.at(-1), 'demo {"q":"你好"} key=run dry=false');
assert.match((await run("run", "demo", "--q", "x", "--dry")).stdout, /"mode": "试运行"/);
assert.equal((await run("run", "demo", "q")).code, 1);
assert.equal((await run("run", "demo", "--window", "debug-nope")).code, 1);
assert.match((await run("compose", "return 1")).stdout, /"result": "return 1"/);

// subagent 把别的 task 跑通不会收回窗口；跑通自己那份才收回：窗口关掉、工作区删除、再调试被拒；它留下的日志是历史，不删
await run("run", "demo", "--window", win1);
assert.equal(runs.at(-1), `demo {} key=${win1} dry=false`);
assert.deepEqual(disposed, []);
await run("run", "like-tweet", "--window", win1);
assert.equal(runs.at(-1), `like-tweet {} key=${win1} dry=false`);
assert.deepEqual(disposed, [win1]);
assert.ok(!fs.existsSync(work), "工作区（含材料）整个删除");
assert.ok(log.readRows("x.com", { wins: [win1], limit: 50 }).length > 0, "日志留着");
r = await run("debug", "--window", win1, "snapshot");
assert.equal(r.code, 1); assert.match(r.stdout, /已经收回/);
assert.equal((await run("run", "demo", "--window", win1)).code, 1);

// 放弃（debug close）和超时回收都走同一个收回；收回后同名 task 可以重新派
disposed.length = 0;
r = await run("debug", "--window", win2, "close");
assert.equal(r.code, 0, r.stdout); assert.deepEqual(disposed, [win2]); assert.ok(!sessions.has(win2));
assert.equal((await run("delegate", "fav-tweet", "--site", "x.com", "--endpoint", "POST /api/like")).code, 0);
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
assert.match((await run("delegate", "half-done", "--site", "x.com", "--endpoint", "POST /api/save")).stdout, /上次没完成的草稿.*--fix/);
assert.match((await run("delegate", "done", "--site", "x.com", "--endpoint", "POST /api/like")).stdout, /已存在/);
assert.match((await run("delegate", "half-done", "--site", "y.com", "--endpoint", "POST /api/save", "--fix")).stdout, /在站点 x\.com 下/);
r = await run("delegate", "half-done", "--site", "x.com", "--fix");
assert.equal(r.code, 0, r.stdout); assert.match(r.stdout, /接着做或修好它/); assert.match(r.stdout, /学会请求 POST \/api\/save/, "--fix 缺省取 task 文件头的 @endpoint");
// status：日志占用、debug 窗口、没完成的草稿
const st = (await run("status")).stdout;
assert.match(st, /录制：\d+ 个站点，轻量层/); assert.match(st, /debug 窗口：debug-/); assert.match(st, new RegExp(escapeRe(dir)));
fs.writeFileSync(path.join(tasks, "orphan.js"), "/**\n * @status: draft\n */\n");
assert.match((await run("status")).stdout, /没完成的草稿 task.*orphan（x\.com）/);
// endpoints.json 的 task 覆盖标记跟着 tasks/ 里的 @endpoint 走
index.touch("x.com"); index.flush();
assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "x.com", "endpoints.json"), "utf8")).endpoints.find((e: { key: string }) => e.key === "POST /api/like").task, "done");

console.log("commands.selfcheck ok");
