// 命令层：参数解析，以及用假的 holder 能力（假页面、假标签页、假 runner）端到端跑 learn / observe / run。
// 读日志不是命令（是文件），这里只守住坏了会静默出错的点：观察按游标不漏不重（晚到的请求下次出现、不重复）、句柄持久（重启后读回）、
// 旧写法（按 action 名开会话）被拒、run 真跑成功的草稿晋升（多行 @endpoint 顺序不对就不晋升）。
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LearnWindows } from "../run/learn-windows.ts";
import { Session } from "../run/host.ts";
import { actionSummary } from "../run/actions.ts";
import { parsePointer, parseReplayArgs, runCommand, type Ctx } from "./commands.ts";
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
assert.match(bad("click", ["@e12"]), /用法：deft learn <句柄> click <x> <y>/);
const rp = parseReplayArgs(["#210", "--set", "page=2", "--yes"]);
assert.deepEqual(rp, { seq: 210, sets: ["page=2"], yes: true, raw: false });

// ---- 假的 holder 能力 ----
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
  { tabId: 21, windowId: 9, active: true, url: "chrome-extension://x/anchor.html", title: "deft agent", status: "complete", anchor: true },
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

// 旧写法：按 action 名开会话被拒
const old = await run("learn", "zhihu-search", "--url", page, "--description", "搜");
assert.equal(old.code, 1); assert.match(old.stdout, /不是学习窗口的句柄/);

// 打开学习窗口：返回句柄、窗口目录，起点加载期的请求在第一次观察里
const opened = await run("learn", "--url", page, "--description", "给第一条回答点赞同");
assert.equal(opened.code, 0, opened.stdout);
const id = /学习窗口 (\S+)（句柄/.exec(opened.stdout)![1]!;
assert.match(id, /^x\.com-\d{8}-\d{6}$/);
assert.match(opened.stdout, new RegExp(`窗口目录 .*learn-windows/${id.replace(/\./g, "\\.")}`));
const first = seqsIn(opened.stdout);
assert.equal(first.length, 1, `起点加载期的请求：${opened.stdout}`);

// 观察按游标：没有新东西就不重复列
const again = await run("learn", id, "observe");
assert.deepEqual(seqsIn(again.stdout), [], "已经观察过的不再出现");

// 页面操作自动附带观察：只列这一步之后的；写请求标 ★，带语义化的请求文件名
const clicked = await run("learn", id, "click", "100", "200", "--description", "点第一个赞同");
const second = seqsIn(clicked.stdout);
assert.equal(second.length, 1); assert.ok(second[0]! > first[0]!);
assert.match(clicked.stdout, /★ #\d+ POST \/api\/answers\/:id\/voters → 200 application\/json，有响应体，requests\/\d{6}-POST-api-answers-_id-voters\.json/);

// ★ 写请求的身份头来源：cookie 里的值认出来，签名认出来；输出里只有来源，没有真值
assert.match(clicked.stdout, /身份头来源：.*x-xsrftoken ← cookie _xsrf.*x-zse-96 ← 签名/);
assert.ok(!clicked.stdout.includes("XSRF-REAL-0123456789"), "输出里没有身份头的真值");

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

// replay 和 action 走同一条路径：经 host 的 request（同一套请求头继承），输出继承来源、签名不匹配、可贴进 action 的一行（带 auth 声明）
const voteSeq = second[0]!;
const replayed = await run("learn", id, "replay", String(voteSeq), "--yes", "--description", "再点一次赞同");
assert.equal(requests.length, 1, `replay 走 request：${replayed.stdout}`);
assert.equal((requests[0]!.headers as Record<string, string>)["x-xsrftoken"], undefined, "身份头不从原请求原样带，按继承规则来");
assert.match(replayed.stdout, /请求头继承自 GET \/api\/feed/);
assert.match(replayed.stdout, /签名头 x-zse-96 来自 GET \/api\/feed/);
assert.match(replayed.stdout, /可贴进 action：await request\(page, \{ url: "https:\/\/www\.x\.com\/api\/answers\/12345678\/voters", method: "POST", json: \{"type":"up"\}, auth: \{"x-xsrftoken":"cookie:_xsrf"\} \}\);/);
await run("learn", id, "observe");

// 句柄持久：新的登记（holder 重启）从 meta.json 读回，游标接着上次，Chrome 窗口当作已关
const reborn = new LearnWindows(log).get(id)!;
assert.equal(reborn.description, "给第一条回答点赞同");
assert.equal(reborn.cursor, learn.get(id)!.cursor);
assert.equal(reborn.open, false);

// run：真跑成功的草稿晋升；多行 @endpoint 顺序不对的不晋升；输出写 run 窗口目录
const actions = path.join(log.dir, "x.com", "actions");
fs.mkdirSync(actions, { recursive: true });
fs.writeFileSync(path.join(actions, "vote.js"), "/**\n * @status draft\n * @endpoint POST /api/answers/:id/voters\n */\n");
fs.writeFileSync(path.join(actions, "two.js"), "/**\n * @status draft\n * @endpoint GET /api/token\n * @endpoint POST /api/save\n */\n");
log.openWindow("vote-20261101-120000", "run", { action: "vote" });
nextOutcome = { runWindow: "vote-20261101-120000", drafts: [path.join(actions, "vote.js"), path.join(actions, "two.js")] };
const ran = await run("run", "vote", "--description", "给回答点赞同");
assert.equal(ran.code, 0, ran.stdout);
assert.equal(actionSummary(path.join(actions, "vote.js")).status, "verified", "真跑成功的草稿晋升");
assert.equal(actionSummary(path.join(actions, "two.js")).status, "draft", "@endpoint 的请求没有按顺序发出：不晋升");
assert.match(ran.stdout, /草稿已晋升 verified：vote/); assert.match(ran.stdout, /草稿没有晋升：two/);
assert.match(ran.stdout, /run 窗口目录 .*run-windows\/vote-20261101-120000/);
assert.match(ran.stdout, new RegExp(`学习窗口 ${id.replace(/\./g, "\\.")}.*还开着`), "提醒开着的学习窗口");
assert.equal((log.readMeta("vote-20261101-120000") as { receipt?: string }).receipt?.slice(0, 3), "RC-", "run 窗口的 meta 记下回执");

// 停在 deft.ask 之前已经成功的草稿：恢复时不会再执行，最终成功时也要晋升
fs.writeFileSync(path.join(actions, "search.js"), "/**\n * @status draft\n * @endpoint GET /api/search\n */\n");
log.openWindow("compose-20261101-130000", "run");
log.openWindow("compose-20261101-130100", "run");
let composeCalls = 0;
(runner as { runCompose: () => Promise<unknown> }).runCompose = async () => (++composeCalls === 1
  ? { status: "ask", question: "挑", data: [1], journal: [], runWindow: "compose-20261101-130000", drafts: [path.join(actions, "search.js")] }
  : { status: "success", result: 1, runWindow: "compose-20261101-130100", drafts: [] });
nextOutcome = {};
const asked = await run("run", "--compose", "return 1", "--description", "搜了再挑");
const resumeId = /"resume": "(AS-[0-9a-f]+)"/.exec(asked.stdout)![1]!;
assert.equal(actionSummary(path.join(actions, "search.js")).status, "draft", "停在 ask 时还不晋升");
const resumedRun = await run("run", "--resume", resumeId, "--answer", "[1]");
assert.equal(resumedRun.code, 0, resumedRun.stdout);
assert.equal(actionSummary(path.join(actions, "search.js")).status, "verified", "ask 之前成功的草稿在最终成功时晋升");

// 落盘的文件里也没有身份头的真值（日志、请求文件、endpoints.json 只有别名和来源）
index.flush();
for (const f of fs.readdirSync(root, { recursive: true, withFileTypes: true })) if (f.isFile()) assert.ok(!fs.readFileSync(path.join(f.parentPath, f.name)).includes("XSRF-REAL-0123456789"), `${f.name} 里不该有真值`);
assert.equal(JSON.parse(fs.readFileSync(path.join(log.dir, "x.com", "endpoints.json"), "utf8")).endpoints.find((e: { key: string }) => e.key === "POST /api/answers/:id/voters").auth["x-xsrftoken"], "cookie:_xsrf", "来源记进 endpoints.json");

console.log("commands.selfcheck ok");
