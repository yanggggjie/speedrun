// 命令层：参数解析，以及用假的 daemon 能力（假页面、假标签页、假 runner）端到端跑 learn / observe / run。
// 读日志不是命令（是文件），这里只守住坏了会静默出错的点：观察按游标不漏不重（晚到的请求下次出现、不重复）、句柄持久（重启后读回）、
// 不是句柄被拒、观察里给出 auth 来源和 request 草稿（没有真值）、learn 窗口里 run 输出真发出的 write 请求、run 真跑成功的 draft 变成 verified（多行 @endpoint 顺序不对就不变成 verified）。
// 输出约定：第一行是 ok / fail / ask，退出码 0 / 1 / 2。
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LearnWindows } from "../run/learn-windows.ts";
import { Session } from "../run/host.ts";
import { actionSummary } from "../run/actions.ts";
import { parsePointer, runCommand, type Ctx } from "./commands.ts";
import { EndpointIndex } from "./endpoints.ts";
import { Ingestor, type PageMsg } from "./ingest.ts";
import { RawStore } from "./raw.ts";
import { WindowLog } from "./windowlog.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tc-cmd-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));

// ---- 参数解析 ----
const ok = (kind: string, args: string[]) => { const r = parsePointer(kind, args); assert.ok("cmd" in r, JSON.stringify(r)); return r.cmd; };
const bad = (kind: string, args: string[]) => { const r = parsePointer(kind, args); assert.ok("error" in r, JSON.stringify(r)); return r.error; };
assert.deepEqual(ok("click", ["120", "340.5"]), { kind: "click", x: 120, y: 340.5 });
assert.deepEqual(ok("type", ["你好", "世界"]), { kind: "type", text: "你好 世界" });
assert.deepEqual(ok("scroll", ["down", "300", "500", "400"]), { kind: "scroll", dy: 300, x: 500, y: 400 }, "给了坐标就滚那个位置的可滚动区域");
assert.deepEqual(ok("scroll", ["down", "500", "400"]), { kind: "scroll", dy: 600, x: 500, y: 400 }, "两个数是坐标，不是像素");
assert.match(bad("click", ["@e12"]), /用法：lore learn <句柄> click <x> <y>/);

// ---- 假的 daemon 能力 ----
const log = new WindowLog({ root });
log.open();
const raw = new RawStore();
const index = new EndpointIndex({ dir: log.dir, raw, flushMs: 5 });
const WINS: Record<number, string> = {};
const ingest = new Ingestor(log, { aliasKey: "k", raw, index, winOf: (tab) => WINS[tab] ?? "user" });
const page = "https://www.x.com/home";
const net = (t: number, over: Record<string, unknown>): PageMsg => ({ k: "net", t, tab: 20, page, via: "fetch", method: "GET", status: 200, ct: "application/json", ms: 10, ...over }) as PageMsg;
const tabs = [
  { tabId: 7, windowId: 1, active: true, url: page, title: "用户的", status: "complete" },
  { tabId: 20, windowId: 9, active: true, url: page, title: "示例", status: "complete" },
  { tabId: 21, windowId: 9, active: true, url: "chrome-extension://x/anchor.html", title: "lore agent", status: "complete", anchor: true },
];
const requests: Array<Record<string, unknown>> = [];
const host = {
  op: async (s: Session, name: string, a: Record<string, unknown>) => {
    WINS[20] = s.key;
    s.tab = 20; s.origin = "https://www.x.com";
    if (name === "goto") {
      ingest.endCmd(ingest.beginCmd(20, Date.now(), "goto", page, undefined, "x.com"), { detail: { ok: true } });
      ingest.handleBatch([net(Date.now(), { id: 1, rid: "p:1", url: "https://www.x.com/api/feed", body: "{\"items\":[]}", size: 12, at: 10 })]);
      return { url: page, title: "示例" };
    }
    if (name === "pointer") {
      const ref = ingest.beginCmd(20, Date.now(), String(a.kind), "x", { description: a.description }, "x.com");
      ingest.handleBatch([net(Date.now() + 20, { id: 2, rid: "p:2", method: "POST", url: "https://www.x.com/api/answers/12345678/voters", reqHeaders: { "x-xsrftoken": "XSRF-REAL-0123456789", "x-zse-96": "2.0_SIGN" }, reqBody: "{\"type\":\"up\"}", body: "{\"ok\":1}", size: 8 })]);
      ingest.endCmd(ref, { detail: { description: a.description, ok: true } });
      return { ok: true, loc: { role: "button", name: "赞同" }, settle: { settled: true, waitedMs: 100 } };
    }
    if (name === "request") { requests.push(a); return { ok: true, status: 200, ct: "application/json", size: 8, text: "{\"ok\":1}", ms: 3, source: { inheritedFrom: { method: "GET", endpoint: "GET /api/feed", url: "https://www.x.com/api/feed" }, auth: {}, signatureMismatch: { headers: ["x-zse-96"], changed: ["路径", "请求体"] } } }; }
    throw new Error(`没有预期的操作 ${name}`);
  },
  end: async (s: Session) => { s.tab = undefined; },
  // 页面存储：x-xsrftoken 的值在 cookie _xsrf 里
  authSnapshot: async () => ({ cookie: { _xsrf: "XSRF-REAL-0123456789" }, local: {}, session: {}, meta: {} }),
};
let nextOutcome: Record<string, unknown> = {};
const runner = {
  runAction: async (name: string) => ({ status: "success", result: { name }, ...nextOutcome }),
  runInLearn: async (name: string) => ({ status: "success", result: { name }, writes: name === "like" ? ["POST /api/like ×1"] : [] }),
  runCompose: async () => ({ status: "success", result: 1, ...nextOutcome }),
};
const learn = new LearnWindows(log);
const ctx = {
  ensureExtension: async () => {},
  tabs: async () => tabs,
  host, runner,
  win: { isAgentTab: (t: number) => t === 20, windowIdOf: () => 9, isOpen: async () => true, dispose: async () => {} },
  learn, sessions: new Map<string, Session>(), ingest, raw, log, index,
  daemon: () => ({ extension: true, pid: process.pid }),
  composeDir: path.join(root, "compose"),
} as unknown as Ctx;
const run = (...argv: string[]) => runCommand(argv, ctx);
const seqsIn = (text: string): number[] => [...text.matchAll(/#(\d+) (?:GET|POST)/g)].map((m) => Number(m[1]));

// 不是句柄、不带 new 都被拒
const old = await run("learn", "zhihu-search", "--url", page, "--description", "搜");
assert.equal(old.code, 1); assert.match(old.stdout, /^fail 「zhihu-search」不是 learn 窗口的句柄/);
assert.equal((await run("learn", "--url", page, "--description", "搜")).code, 1, "打开要写 learn new");

// 打开 learn 窗口：返回句柄、窗口目录，起点加载期的请求在第一次观察里
const opened = await run("learn", "new", "--url", page, "--description", "给第一条回答点赞同");
assert.equal(opened.code, 0, opened.stdout);
const id = /^ok learn 窗口已打开：(\S+)/.exec(opened.stdout)![1]!;
assert.match(id, /^x\.com-\d{8}-\d{6}$/);
assert.match(opened.stdout, new RegExp(`窗口目录：.*learn-windows/${id.replace(/\./g, "\\.")}`));
const first = seqsIn(opened.stdout);
assert.equal(first.length, 1, `起点加载期的请求：${opened.stdout}`);

// 观察按游标：没有新东西就不重复列
const again = await run("learn", id, "observe");
assert.deepEqual(seqsIn(again.stdout), [], "已经观察过的不再出现");

// 页面操作自动附带观察：只列这一步之后的；写请求标 write，带语义化的请求文件名
const clicked = await run("learn", id, "click", "100", "200", "--description", "点第一个赞同");
const second = seqsIn(clicked.stdout);
assert.equal(second.length, 1); assert.ok(second[0]! > first[0]!);
assert.match(clicked.stdout, /write #\d+ POST \/api\/answers\/:id\/voters → 200 application\/json，有响应体，requests\/\d{6}-POST-api-answers-_id-voters\.json/);

// write 请求的 auth 来源：cookie 里的值认出来，签名认出来；草稿带 auth 声明；输出里只有来源，没有真值
assert.match(clicked.stdout, /^ok click/);
assert.match(clicked.stdout, /auth 来源：.*x-xsrftoken ← cookie _xsrf.*x-zse-96 ← 签名/);
assert.match(clicked.stdout, /草稿：await request\(\{ url: "https:\/\/www\.x\.com\/api\/answers\/12345678\/voters", method: "POST", json: \{"type":"up"\}, auth: \{"x-xsrftoken":"cookie:_xsrf"\} \}\);/);
assert.ok(!clicked.stdout.includes("XSRF-REAL-0123456789"), "输出里没有 auth 头的真值");

// 晚到的请求（操作之后才到）：下一次观察出现，而且只出现一次
ingest.handleBatch([net(Date.now() + 5000, { id: 3, rid: "p:3", url: "https://www.x.com/api/lazy", body: "{}", size: 2 })]);
const late = await run("learn", id, "observe");
const lateSeqs = seqsIn(late.stdout);
assert.equal(lateSeqs.length, 1, late.stdout); assert.ok(lateSeqs[0]! > second[0]!);
assert.deepEqual(seqsIn((await run("learn", id, "observe")).stdout), [], "不重复");
// --since 重看，不推进游标
const relook = await run("learn", id, "observe", "--since", String(first[0]!));
assert.deepEqual(seqsIn(relook.stdout), [...second, ...lateSeqs]);
assert.deepEqual(seqsIn((await run("learn", id, "observe")).stdout), [], "--since 不推进游标");

// learn 窗口里 run：在当前页面跑 action；@write 不拦，输出列出真发出的 write 请求
const actions = path.join(log.dir, "x.com", "actions");
fs.mkdirSync(actions, { recursive: true });
fs.writeFileSync(path.join(actions, "vote.js"), "/**\n * @status draft\n * @endpoint POST /api/answers/:id/voters\n */\n");
fs.writeFileSync(path.join(actions, "like.js"), "/**\n * @status draft\n * @write\n * @endpoint POST /api/like\n */\n");
const tried = await run("learn", id, "run", "--action", "vote", "--description", "试一下点赞同");
assert.equal(tried.code, 0, tried.stdout); assert.match(tried.stdout, /^ok vote\n/); assert.match(tried.stdout, /结果：/);
const liked = await run("learn", id, "run", "--action", "like", "--description", "点喜欢");
assert.equal(liked.code, 0, liked.stdout); assert.match(liked.stdout, /已发出的 write 请求：\n  POST \/api\/like ×1/);
assert.equal(actionSummary(path.join(actions, "vote.js")).status, "draft", "learn 窗口里 run 不变成 verified");

// 句柄持久：新的登记（daemon 重启）从 meta.json 读回，游标接着上次，Chrome 窗口当作已关
const reborn = new LearnWindows(log).get(id)!;
assert.equal(reborn.description, "给第一条回答点赞同");
assert.equal(reborn.cursor, learn.get(id)!.cursor);
assert.equal(reborn.open, false);

// run：真跑成功的 draft 变成 verified；多行 @endpoint 顺序不对的不变成 verified；输出写 run 窗口目录
fs.writeFileSync(path.join(actions, "two.js"), "/**\n * @status draft\n * @endpoint GET /api/token\n * @endpoint POST /api/save\n */\n");
log.openWindow("vote-20261101-120000", "run", { action: "vote" });
nextOutcome = { runWindow: "vote-20261101-120000", drafts: [path.join(actions, "vote.js"), path.join(actions, "two.js")] };
const ran = await run("run", "--action", "vote", "--description", "给回答点赞同");
assert.equal(ran.code, 0, ran.stdout);
assert.equal(actionSummary(path.join(actions, "vote.js")).status, "verified", "真跑成功的 draft 变成 verified");
assert.equal(actionSummary(path.join(actions, "two.js")).status, "draft", "@endpoint 的请求没有按顺序发出：不变成 verified");
assert.match(ran.stdout, /已变成 verified：vote/); assert.match(ran.stdout, /没有变成 verified：two/);
assert.match(ran.stdout, /^ok vote\n/); assert.match(ran.stdout, /run 窗口目录：.*run-windows\/vote-20261101-120000/);
assert.match(ran.stdout, new RegExp(`learn 窗口 ${id.replace(/\./g, "\\.")}.*还开着`), "提醒开着的 learn 窗口");

// 停在 lore.ask 之前已经成功的 draft：恢复时不会再执行，最终成功时也要变成 verified
fs.writeFileSync(path.join(actions, "search.js"), "/**\n * @status draft\n * @endpoint GET /api/search\n */\n");
log.openWindow("compose-20261101-130000", "run");
log.openWindow("compose-20261101-130100", "run");
let composeCalls = 0;
(runner as { runCompose: () => Promise<unknown> }).runCompose = async () => (++composeCalls === 1
  ? { status: "ask", question: "挑", data: [1], journal: [], runWindow: "compose-20261101-130000", drafts: [path.join(actions, "search.js")] }
  : { status: "success", result: 1, runWindow: "compose-20261101-130100", drafts: [] });
nextOutcome = {};
const asked = await run("run", "--compose-code", "return 1", "--description", "搜了再挑");
assert.equal(asked.code, 2, asked.stdout); assert.match(asked.stdout, /^ask 挑\n/);
const resumeId = /--resume (AS-[0-9a-f]+)/.exec(asked.stdout)![1]!;
assert.equal(actionSummary(path.join(actions, "search.js")).status, "draft", "停在 ask 时还不变成 verified");
const resumedRun = await run("run", "--resume", resumeId, "--answer", "[1]");
assert.equal(resumedRun.code, 0, resumedRun.stdout);
assert.equal(actionSummary(path.join(actions, "search.js")).status, "verified", "ask 之前成功的 draft 在最终成功时变成 verified");

// 落盘的文件里也没有 auth 头的真值（日志、请求文件、endpoints.json 只有别名和来源）
index.flush();
for (const f of fs.readdirSync(root, { recursive: true, withFileTypes: true })) if (f.isFile()) assert.ok(!fs.readFileSync(path.join(f.parentPath, f.name)).includes("XSRF-REAL-0123456789"), `${f.name} 里不该有真值`);
assert.equal(JSON.parse(fs.readFileSync(path.join(log.dir, "x.com", "endpoints.json"), "utf8")).endpoints.find((e: { key: string }) => e.key === "POST /api/answers/:id/voters").auth["x-xsrftoken"], "cookie:_xsrf", "来源记进 endpoints.json");

console.log("commands.selfcheck ok");
