// 命令层：参数解析，以及用假的 daemon 能力（假页面、假标签页、假 runner）端到端跑 learn / run。
// 读日志不是命令（是文件），这里只守住坏了会静默出错的点：观察按游标不漏不重（晚到的请求下次出现、不重复）、句柄持久（重启后读回）、
// 不是句柄被拒、观察里给出请求头的信号（没有真值）、learn 窗口里 run 输出实际发出的非 GET 请求、run 真跑成功的 draft 变成 verified（漏了就一直是 draft）。
// 输出约定：第一行是 ok / fail / ask，退出码 0 / 1 / 2；命令写错了是 fail、退出码 3（agent 要改命令，不是重试）。
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LearnWindows } from "../learn/windows.ts";
import { Session } from "../browser/host.ts";
import { actionSummary } from "../run/actions.ts";
import { runCommand, type Ctx } from "./index.ts";
import { parseComputer } from "./learn.ts";
import { PendingAsks } from "../run/asks.ts";
import { EndpointIndex } from "../record/endpoints.ts";
import { Ingestor, type PageMsg } from "../record/ingest.ts";
import { RawStore } from "../record/raw.ts";
import { WindowLog } from "../record/windowlog.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "habit-cmd-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));

// ---- 参数解析 ----
// computer 的参数照工具的 schema：坐标错位、方向写错、超过上限都要拒绝（否则点到别处、滚错方向）
const ok = (args: string[], o = {}) => { const r = parseComputer(args, o); assert.ok("cmd" in r, JSON.stringify(r)); return r.cmd; };
const bad = (args: string[], o = {}) => { const r = parseComputer(args, o); assert.ok("error" in r, JSON.stringify(r)); return r.error; };
assert.deepEqual(ok(["left_click", "120", "340.5"]), { action: "left_click", x: 120, y: 340.5 });
assert.deepEqual(ok(["right_click", "1", "2"], { modifiers: "Cmd+shift" }), { action: "right_click", x: 1, y: 2, mods: { cmd: true, shift: true } });
assert.deepEqual(ok(["left_click_drag", "10", "20", "300", "400"]), { action: "left_click_drag", sx: 10, sy: 20, x: 300, y: 400 }, "起点在前");
assert.deepEqual(ok(["type", "你好", "世界"]), { action: "type", text: "你好 世界" });
assert.deepEqual(ok(["key", "cmd+a", "Backspace"], { repeat: "3" }), { action: "key", keys: "cmd+a Backspace", repeat: 3 });
assert.deepEqual(ok(["scroll", "500", "400", "down", "50"]), { action: "scroll", x: 500, y: 400, direction: "down", amount: 10 }, "最多 10 格");
assert.deepEqual(ok(["scroll", "500", "400", "up"]), { action: "scroll", x: 500, y: 400, direction: "up", amount: 3 }, "默认 3 格");
assert.deepEqual(ok(["zoom", "0", "0", "200", "100"], { scale: "0.5" }), { action: "zoom", region: [0, 0, 200, 100], scale: 0.5 });
assert.match(bad(["left_click", "@e12"]), /用法：habit learn <句柄> computer left_click <x> <y>/);
assert.match(bad(["scroll", "500", "400", "bottom"]), /up\|down\|left\|right/);
assert.match(bad(["key", "Enter"], { repeat: "101" }), /--repeat/);
assert.match(bad(["left_click", "1", "2"], { modifiers: "hyper" }), /不认识的修饰键/);
assert.match(bad(["zoom", "100", "100", "50", "50"]), /左上角和右下角/);
assert.match(bad(["wait", "30"]), /最多 10 秒/);
assert.match(bad(["click", "1", "2"]), /computer 的 action 是/);
// --ref 代替坐标（read_page / find 给出的元素）；二选一，写错的 ref 被拒
assert.deepEqual(ok(["left_click"], { ref: "ref_12" }), { action: "left_click", ref: "ref_12" });
assert.deepEqual(ok(["left_click_drag"], { ref: "ref_1", to: "ref_2" }), { action: "left_click_drag", ref: "ref_1", toRef: "ref_2" });
assert.deepEqual(ok(["scroll", "down", "2"], { ref: "ref_3" }), { action: "scroll", ref: "ref_3", direction: "down", amount: 2 });
assert.match(bad(["left_click", "1", "2"], { ref: "ref_1" }), /二选一/);
assert.match(bad(["left_click"], { ref: "e12" }), /--ref 要写成 ref_数字/);

// ---- 假的 daemon 能力 ----
const log = new WindowLog({ root });
log.open();
const raw = new RawStore();
const index = new EndpointIndex({ dir: log.dir, flushMs: 5 });
const WINS: Record<number, string> = {};
const ingest = new Ingestor(log, { aliasKey: "k", raw, index, winOf: (tab) => WINS[tab] ?? "user" });
const page = "https://www.x.com/home";
const net = (t: number, over: Record<string, unknown>): PageMsg => ({ k: "net", t, tab: 20, page, via: "fetch", method: "GET", status: 200, ct: "application/json", ms: 10, ...over }) as PageMsg;
const tabs = [
  { tabId: 7, windowId: 1, groupId: -1, active: true, url: page, title: "用户的", status: "complete" },
  { tabId: 20, windowId: 1, groupId: 5, habit: true, active: false, url: page, title: "示例", status: "complete" },
];
const requests: Array<Record<string, unknown>> = [];
const host = {
  op: async (s: Session, name: string, a: Record<string, unknown>) => {
    WINS[20] = s.key;
    s.tab = 20; s.origin = "https://www.x.com";
    if (name === "navigate") {
      ingest.endCmd(ingest.beginCmd(20, Date.now(), "navigate", page, undefined, "x.com"), { detail: { ok: true } });
      ingest.handleBatch([net(Date.now(), { id: 1, rid: "p:1", url: "https://www.x.com/api/feed", body: "{\"items\":[]}", size: 12, at: 10 })]);
      return { url: page, title: "示例" };
    }
    if (name === "input") {
      const ref = ingest.beginCmd(20, Date.now(), String(a.action), "x", { description: a.description }, "x.com");
      ingest.handleBatch([net(Date.now() + 20, { id: 2, rid: "p:2", method: "POST", url: "https://www.x.com/api/answers/12345678/voters", reqHeaders: { "x-xsrftoken": "XSRF-REAL-0123456789", "x-zse-96": "2.0_SIGN" }, reqBody: "{\"type\":\"up\"}", body: "{\"ok\":1}", size: 8 })]);
      ingest.endCmd(ref, { detail: { description: a.description, ok: true } });
      return { ok: true, loc: { role: "button", name: "赞同" }, settle: { settled: true, waitedMs: 100 } };
    }
    if (name === "request") { requests.push(a); return { ok: true, status: 200, ct: "application/json", size: 8, text: "{\"ok\":1}", ms: 3 }; }
    throw new Error(`没有预期的操作 ${name}`);
  },
  end: async (s: Session) => { s.tab = undefined; },
  quiet: async () => { ingest.flush(); return { settled: true, waitedMs: 1 }; },
  // 页面存储：x-xsrftoken 的值在 cookie _xsrf 里
  authSnapshot: async () => ({ cookie: { _xsrf: "XSRF-REAL-0123456789" }, local: {}, session: {}, meta: {} }),
};
let nextOutcome: Record<string, unknown> = {};
const runner = {
  asks: new PendingAsks(),
  runAction: async (name: string) => ({ status: "success", result: { name }, ...nextOutcome }),
  runInLearn: async (name: string) => ({ status: "success", result: { name }, sent: name === "like" ? ["POST /api/like ×1"] : [] }),
};
const win = { isAgentTab: (t: number) => t === 20, groupOf: () => 5, isOpen: async () => true, dispose: async () => {}, busy: () => () => {} };
const learn = new LearnWindows({ log, host, win });
const ctx = {
  ensureExtension: async () => {},
  tabs: async () => tabs,
  host, runner, win, learn, ingest, raw, log, index,
  daemon: () => ({ extension: true, pid: process.pid }),
  composeDir: path.join(root, "compose"),
} as unknown as Ctx;
const run = (...argv: string[]) => runCommand(argv, ctx);
const seqsIn = (text: string): number[] => [...text.matchAll(/#(\d+) (?:GET|POST)/g)].map((m) => Number(m[1]));

// 不是句柄、不带 new 都被拒
const old = await run("learn", "zhihu-search", "--url", page, "--description", "搜");
assert.equal(old.code, 3); assert.match(old.stdout, /^fail 「zhihu-search」不是 learn 窗口的句柄/);
assert.equal((await run("learn", "--url", page, "--description", "搜")).code, 3, "打开要写 learn new");
assert.equal((await run("nope")).code, 3, "不认识的命令是用法错误");
// 值不能以 -- 开头：漏写了 --description 的值时，--url 不能被当成 description 吞掉
const swallowed = await run("learn", "new", "--description", "--url", page);
assert.equal(swallowed.code, 3); assert.match(swallowed.stdout, /--description 缺少值.*--description=--url/);
assert.match((await run("learn", "new", "--descripton", "x")).stdout, /是不是想写 --description/, "拼错的参数名给提示");

// 打开 learn 窗口：返回句柄、窗口目录，起点加载期的请求在第一次观察里
const opened = await run("learn", "new", "--url", page, "--description", "给第一条回答点赞同");
assert.equal(opened.code, 0, opened.stdout);
const id = /^ok learn 窗口已打开：(\S+)/.exec(opened.stdout)![1]!;
assert.match(id, /^x\.com-\d{8}-\d{6}$/);
assert.match(opened.stdout, new RegExp(`窗口目录：.*learn-windows/${id.replace(/\./g, "\\.")}`));
const first = seqsIn(opened.stdout);
assert.equal(first.length, 1, `起点加载期的请求：${opened.stdout}`);

// 观察按游标：没有新东西就不重复列
const again = await run("learn", id, "computer", "wait", "0.1");
assert.deepEqual(seqsIn(again.stdout), [], "已经观察过的不再出现");

// 页面操作自动附带观察：只列这一步之后的；请求行没有 write 前缀，带语义化的请求文件名
const clicked = await run("learn", id, "computer", "left_click", "100", "200", "--description", "点第一个赞同");
const second = seqsIn(clicked.stdout);
assert.equal(second.length, 1); assert.ok(second[0]! > first[0]!);
assert.match(clicked.stdout, /\n  #\d+ POST \/api\/answers\/:id\/voters → 200 application\/json，有响应体，requests\/\d{6}-POST-api-answers-_id-voters\.json/);

// 请求头的信号：cookie 里的值认出来（给 auth 用）；输出里只有类别和来源，没有真值；不再有 request 草稿
assert.match(clicked.stdout, /^ok computer left_click/);
assert.match(clicked.stdout, /请求头：.*x-xsrftoken 样本太少 ← cookie _xsrf.*x-zse-96 样本太少/);
assert.ok(!clicked.stdout.includes("草稿"), "观察里没有草稿");
assert.ok(!clicked.stdout.includes("XSRF-REAL-0123456789"), "输出里没有 auth 头的真值");
// computer 只是触发：这一步引发了没有 action 覆盖的 endpoint 时提醒写成 action（否则 agent 容易把看到的直接交给用户）
assert.match(clicked.stdout, /下一步：POST \/api\/answers\/:id\/voters 还没有 action 覆盖 → 要用的写成 action/);
// close 时这个窗口学到的还没用 habit run 交付过：提醒一次
const closed = await run("learn", "close", id);
assert.match(closed.stdout, /^ok 已关掉/); assert.match(closed.stdout, /还没用 habit run 交付过/);

// 晚到的请求（操作之后才到）：下一次观察出现，而且只出现一次
ingest.handleBatch([net(Date.now() + 5000, { id: 3, rid: "p:3", url: "https://www.x.com/api/lazy", body: "{}", size: 2 })]);
const late = await run("learn", id, "computer", "wait", "0.1");
const lateSeqs = seqsIn(late.stdout);
assert.equal(lateSeqs.length, 1, late.stdout); assert.ok(lateSeqs[0]! > second[0]!);
assert.deepEqual(seqsIn((await run("learn", id, "computer", "wait", "0.1")).stdout), [], "不重复");
// 同站请求被 401 拒：观察里提醒像是登录失效，先看页面（不然 agent 会以为 action 写错了，重新 learn）
assert.ok(!late.stdout.includes("像是登录失效"), "没有 401 时不提醒");
ingest.handleBatch([net(Date.now() + 5000, { id: 4, rid: "p:4", url: "https://www.x.com/api/me", status: 401, body: "{}", size: 2 })]);
assert.match((await run("learn", id, "computer", "wait", "0.1")).stdout, /下一步：像是登录失效（#\d+ .*401）：先 computer screenshot 或 read_page 看页面/);
// 不再有 observe（computer wait 就是等一会儿再观察）
assert.match((await run("learn", id, "observe")).stdout, /^fail 不认识的操作「observe」/);
// 同一个句柄上两条命令同时到：后到的立刻报错，先到的照常完成，之后句柄又能用
const [earlier, later] = await Promise.all([run("learn", id, "computer", "wait", "0.2"), run("learn", id, "computer", "wait", "0.1")]);
assert.equal(earlier.code, 0, earlier.stdout);
assert.equal(later.code, 1); assert.match(later.stdout, /上一条命令还没结束/);
assert.equal((await run("learn", id, "computer", "wait", "0.1")).code, 0, "前一条结束后句柄又能用");

// learn 窗口里 try_action：在当前页面跑 action；@write 不拦，输出列出实际发出的非 GET 请求
const actions = path.join(log.dir, "x.com", "actions");
fs.mkdirSync(actions, { recursive: true });
fs.writeFileSync(path.join(actions, "vote.js"), "/**\n * @status draft\n * @endpoint POST /api/answers/:id/voters\n */\n");
fs.writeFileSync(path.join(actions, "like.js"), "/**\n * @status draft\n * @write\n * @endpoint POST /api/like\n */\n");
const tried = await run("learn", id, "try_action", "vote", "--description", "试一下点赞同");
assert.equal(tried.code, 0, tried.stdout); assert.match(tried.stdout, /^ok vote\n/); assert.match(tried.stdout, /结果：/);
const liked = await run("learn", id, "try_action", "like", "--description", "点喜欢");
assert.equal(liked.code, 0, liked.stdout); assert.match(liked.stdout, /已发出的非 GET 请求：\n  POST \/api\/like ×1/);
assert.equal(actionSummary(path.join(actions, "vote.js")).status, "draft", "learn 窗口里 try_action 不变成 verified");

// 句柄持久：新的登记（daemon 重启）从 meta.json 读回，游标接着上次，habit 组当作已关
const reborn = new LearnWindows({ log, host, win }).get(id)!;
assert.equal(reborn.description, "给第一条回答点赞同");
assert.equal(reborn.cursor, learn.get(id)!.cursor);
assert.equal(reborn.open, false);

// run：真跑成功的 draft 都变成 verified；输出写 run 窗口目录
fs.writeFileSync(path.join(actions, "two.js"), "/**\n * @status draft\n * @endpoint GET /api/token\n * @endpoint POST /api/save\n */\n");
log.openWindow("vote-20261101-120000", "run", { action: "vote" });
nextOutcome = { runWindow: "vote-20261101-120000", drafts: [path.join(actions, "vote.js"), path.join(actions, "two.js")] };
assert.equal((await run("run", "vote")).code, 3, "run 要带 --description");
assert.equal((await run("run", "missing", "--description", "x")).code, 3, "名字不对是用法错误");
const help = await run("run", "vote", "--help");
assert.equal(help.code, 0, help.stdout); assert.match(help.stdout, /^ok vote（action/); assert.match(help.stdout, /时间上限：/);
const ran = await run("run", "vote", "--description", "给回答点赞同");
assert.equal(ran.code, 0, ran.stdout);
assert.equal(actionSummary(path.join(actions, "vote.js")).status, "verified", "真跑成功的 draft 变成 verified");
assert.equal(actionSummary(path.join(actions, "two.js")).status, "verified", "多行 @endpoint 的也一样：跑成功就是 verified");
assert.match(ran.stdout, /已变成 verified：vote、two/);
assert.match(ran.stdout, /^ok vote\n/); assert.match(ran.stdout, /run 窗口目录：.*run-windows\/vote-20261101-120000/);
assert.match(ran.stdout, new RegExp(`learn 窗口 ${id.replace(/\./g, "\\.")}.*还开着`), "提醒开着的 learn 窗口");

// 停在 habit.ask 之前已经成功的 draft：恢复时不会再执行，最终成功时也要变成 verified；恢复用停下那一刻的代码
fs.writeFileSync(path.join(actions, "search.js"), "/**\n * @status draft\n * @endpoint GET /api/search\n */\n");
fs.mkdirSync(path.join(root, "compose"), { recursive: true });
fs.writeFileSync(path.join(root, "compose", "pick.js"), "/**\n * @description 搜了再挑\n */\n");
log.openWindow("pick-20261101-130000", "run");
log.openWindow("pick-20261101-130100", "run");
const calls: Array<{ name: string; code?: string }> = [];
(runner as { runAction: (name: string, p: unknown, n: unknown, o: { code?: string }) => Promise<unknown> }).runAction = async (name, _p, _n, o) => (calls.push({ name, ...(o?.code ? { code: o.code } : {}) }), calls.length === 1
  ? { status: "ask", question: "挑", data: [1], journal: [], code: "停下时的代码", runWindow: "pick-20261101-130000", drafts: [path.join(actions, "search.js")] }
  : { status: "success", result: 1, runWindow: "pick-20261101-130100", drafts: [] });
nextOutcome = {};
const asked = await run("run", "pick", "--description", "搜了再挑");
assert.equal(asked.code, 2, asked.stdout); assert.match(asked.stdout, /^ask 挑\n/);
const resumeId = /habit resume (AS-[0-9a-f]+)/.exec(asked.stdout)![1]!;
assert.equal(actionSummary(path.join(actions, "search.js")).status, "draft", "停在 ask 时还不变成 verified");
assert.equal((await run("resume", resumeId)).code, 3, "resume 要带 --answer");
const resumedRun = await run("resume", resumeId, "--answer", "[1]", "--description", "选第一个");
assert.equal(resumedRun.code, 0, resumedRun.stdout);
assert.deepEqual(calls.at(-1), { name: "pick", code: "停下时的代码" }, "恢复用停下那一刻的代码");
assert.equal(actionSummary(path.join(actions, "search.js")).status, "verified", "ask 之前成功的 draft 在最终成功时变成 verified");
assert.equal(log.readMeta("pick-20261101-130100")?.answerWhy, "选第一个", "恢复时的 --description 记进 run 窗口");

// 落盘的文件里也没有 auth 头的真值（日志、请求文件、endpoints.json 只有别名和来源）
index.flush();
for (const f of fs.readdirSync(root, { recursive: true, withFileTypes: true })) if (f.isFile()) assert.ok(!fs.readFileSync(path.join(f.parentPath, f.name)).includes("XSRF-REAL-0123456789"), `${f.name} 里不该有真值`);
assert.deepEqual(JSON.parse(fs.readFileSync(path.join(log.dir, "x.com", "endpoints.json"), "utf8")).endpoints.find((e: { key: string }) => e.key === "POST /api/answers/:id/voters").headers["x-xsrftoken"], { kind: "few", source: "cookie:_xsrf" }, "类别和来源记进 endpoints.json，没有值");

// 跑过成功的 run 之后再 close：不再提醒
await run("learn", id, "computer", "left_click", "1", "1", "--description", "重新打开窗口");
const closedAgain = await run("learn", id, "close");
assert.ok(!closedAgain.stdout.includes("还没用 habit run 交付过"), closedAgain.stdout);

console.log("commands.selfcheck ok");
