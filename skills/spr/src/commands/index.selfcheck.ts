// 命令层：参数解析，以及用假的 daemon 能力（假页面、假标签页、假 runner）端到端跑 debug / run。
// 读日志不是命令（是文件），这里只守住坏了会静默出错的点：观察按游标不漏不重（晚到的请求下次出现、不重复）、debug 只接受已写好的 compose、
// run 只接受 compose 并在执行前报全缺的 action、run 之后 debug 窗口还在、观察里给出请求头的信号（没有真值）、run 真跑成功的 draft 变成 verified、失败后能恢复。
// 输出约定：第一行是 ok / fail / ask，退出码 0 / 1 / 2；命令写错了是 fail、退出码 3（agent 要改命令，不是重试）。
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DebugWindows } from "../debug/windows.ts";
import { Session } from "../browser/host.ts";
import { actionSummary } from "../run/actions.ts";
import { runCommand, type Ctx } from "./index.ts";
import { parseComputer } from "./debug.ts";
import { PendingAsks } from "../run/asks.ts";
import { EndpointIndex } from "../record/endpoints.ts";
import { Ingestor, type PageMsg } from "../record/ingest.ts";
import { RawStore } from "../record/raw.ts";
import { WindowLog } from "../record/windowlog.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "speedrun-cmd-"));
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
assert.match(bad(["left_click", "@e12"]), /用法：spr debug <compose> computer left_click <x> <y>/);
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
  { tabId: 20, windowId: 1, groupId: 5, speedrun: true, active: false, url: page, title: "示例", status: "complete" },
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
      const ref = ingest.beginCmd(20, Date.now(), String(a.action), "x", undefined, "x.com");
      ingest.handleBatch([net(Date.now() + 20, { id: 2, rid: "p:2", method: "POST", url: "https://www.x.com/api/answers/12345678/voters", reqHeaders: { "x-xsrftoken": "XSRF-REAL-0123456789", "x-zse-96": "2.0_SIGN" }, reqBody: "{\"type\":\"up\"}", body: "{\"ok\":1}", size: 8 })]);
      ingest.endCmd(ref, { detail: { ok: true } });
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
const runner: { asks: PendingAsks; runAction: (name: string) => Promise<unknown> } = {
  asks: new PendingAsks(),
  runAction: async (name: string) => ({ status: "success", result: { name }, ...nextOutcome }),
};
const win = { isAgentTab: (t: number) => t === 20, groupOf: () => 5, isOpen: async () => true, dispose: async () => {}, busy: () => () => {} };
const debug = new DebugWindows({ log, host, win });
const ctx = {
  ensureExtension: async () => {},
  tabs: async () => tabs,
  host, runner, win, debug, ingest, raw, log, index,
  daemon: () => ({ extension: true, pid: process.pid }),
  composeDir: path.join(root, "compose"),
} as unknown as Ctx;
const run = (...argv: string[]) => runCommand(argv, ctx);
const seqsIn = (text: string): number[] => [...text.matchAll(/#(\d+) (?:GET|POST)/g)].map((m) => Number(m[1]));

const composeDir = path.join(root, "compose");
const actions = path.join(log.dir, "x.com");
fs.mkdirSync(composeDir, { recursive: true });
fs.mkdirSync(actions, { recursive: true });
const writeCompose = (name: string, code: string): void => fs.writeFileSync(path.join(composeDir, `${name}.js`), `/**\n * @description ${name}\n */\nimport { action } from "spr";\nexport default async () => {\n${code}\n};\n`);
const writeAction = (name: string, head = " * @status draft"): void => fs.writeFileSync(path.join(actions, `${name}.js`), `/**\n${head}\n */\n`);

// debug 的第一个参数必须是已写好的 compose：保证先写 compose 再 debug
assert.equal((await run("nope")).code, 3, "不认识的命令是用法错误");
const noCompose = await run("debug", "flow", "navigate", page);
assert.equal(noCompose.code, 3); assert.match(noCompose.stdout, /没有 compose flow：先写 .*flow\.js/);
writeAction("vote0");
const onAction = await run("debug", "vote0", "navigate", page);
assert.equal(onAction.code, 3); assert.match(onAction.stdout, /vote0 是 action/);
writeCompose("flow", `await action("vote", {}); return action("like", {});`);
const noWindow = await run("debug", "flow", "read_page");
assert.equal(noWindow.code, 3); assert.match(noWindow.stdout, /debug 窗口没开.*navigate/);
assert.equal((await run("debug", "flow", "navigate", "back")).code, 3, "没有窗口时不能 back");
assert.equal((await run("debug", "flow", "navigate", "ftp://x")).code, 3, "只接受 http(s) 和 tab 号");

// run 只接受 compose；执行前报全缺的 action，什么都不跑
let ranCalls = 0;
const realRun = runner.runAction;
runner.runAction = async (name: string) => { ranCalls++; return realRun(name); };
const onlyCompose = await run("run", "vote0");
assert.equal(onlyCompose.code, 3); assert.match(onlyCompose.stdout, /vote0 是 action，spr run 只运行 compose/);
assert.equal((await run("run", "missing")).code, 3, "名字不对是用法错误");
const notDefined = await run("run", "flow");
assert.equal(notDefined.code, 1, notDefined.stdout);
assert.match(notDefined.stdout, /^fail flow：vote、like is not defined（没有执行任何操作）/);
assert.match(notDefined.stdout, /下一步：spr debug flow navigate/);
assert.equal(ranCalls, 0, "缺 action 时什么都不执行");

// 打开 debug 窗口：navigate 就是打开，起点加载期的请求在第一次观察里，末行是目标
const opened = await run("debug", "flow", "navigate", page);
assert.equal(opened.code, 0, opened.stdout);
assert.match(opened.stdout, /^ok debug 窗口已打开：flow/);
const id = debug.of("flow")!.id;
assert.match(id, /^flow-\d{8}-\d{6}$/);
assert.match(opened.stdout, new RegExp(`窗口目录：.*debug-windows/${id}`));
assert.match(opened.stdout, /目标：spr run flow（还缺 vote、like）$/);
const first = seqsIn(opened.stdout);
assert.equal(first.length, 1, `起点加载期的请求：${opened.stdout}`);

// 观察按游标：没有新东西就不重复列
const again = await run("debug", "flow", "computer", "wait", "0.1");
assert.deepEqual(seqsIn(again.stdout), [], "已经观察过的不再出现");

// 页面操作自动附带观察：只列这一步之后的；请求行没有 write 前缀，带语义化的请求文件名
assert.match((await run("debug", "flow", "computer", "left_click", "1", "2", "--description", "x")).stdout, /不认识的参数 --description/);
const clicked = await run("debug", "flow", "computer", "left_click", "100", "200");
const second = seqsIn(clicked.stdout);
assert.equal(second.length, 1); assert.ok(second[0]! > first[0]!);
assert.match(clicked.stdout, /\n  #\d+ POST \/api\/answers\/:id\/voters → 200 application\/json，有响应体，requests\/\d{6}-POST-api-answers-_id-voters\.json/);

// 请求头的信号：cookie 里的值认出来（给 auth 用）；输出里只有类别和来源，没有真值；不再有 request 草稿
assert.match(clicked.stdout, /^ok computer left_click/);
assert.match(clicked.stdout, /请求头：.*x-xsrftoken 样本太少 ← cookie _xsrf.*x-zse-96 样本太少/);
assert.ok(!clicked.stdout.includes("草稿"), "观察里没有草稿");
assert.ok(!clicked.stdout.includes("XSRF-REAL-0123456789"), "输出里没有 auth 头的真值");
// 晚到的请求（操作之后才到）：下一次观察出现，而且只出现一次
ingest.handleBatch([net(Date.now() + 5000, { id: 3, rid: "p:3", url: "https://www.x.com/api/lazy", body: "{}", size: 2 })]);
const late = await run("debug", "flow", "computer", "wait", "0.1");
const lateSeqs = seqsIn(late.stdout);
assert.equal(lateSeqs.length, 1, late.stdout); assert.ok(lateSeqs[0]! > second[0]!);
assert.deepEqual(seqsIn((await run("debug", "flow", "computer", "wait", "0.1")).stdout), [], "不重复");
// 同站请求被 401 拒：观察里提醒像是登录失效，先看页面（不然 agent 会以为 action 写错了）
assert.ok(!late.stdout.includes("像是登录失效"), "没有 401 时不提醒");
ingest.handleBatch([net(Date.now() + 5000, { id: 4, rid: "p:4", url: "https://www.x.com/api/me", status: 401, body: "{}", size: 2 })]);
assert.match((await run("debug", "flow", "computer", "wait", "0.1")).stdout, /下一步：像是登录失效（#\d+ .*401）：先 computer screenshot 或 read_page 看页面/);
// 不再有 observe、try_action
assert.match((await run("debug", "flow", "observe")).stdout, /^fail 不认识的操作「observe」/);
assert.match((await run("debug", "flow", "try_action", "vote")).stdout, /^fail 不认识的操作「try_action」/);
// 同一个 compose 上两条命令同时到：后到的立刻报错，先到的照常完成，之后又能用
const [earlier, later] = await Promise.all([run("debug", "flow", "computer", "wait", "0.2"), run("debug", "flow", "computer", "wait", "0.1")]);
assert.equal(earlier.code, 0, earlier.stdout);
assert.equal(later.code, 1); assert.match(later.stdout, /上一条命令还没结束/);
assert.equal((await run("debug", "flow", "computer", "wait", "0.1")).code, 0, "前一条结束后又能用");

// 写好一个 action，目标行跟着变；都写好后只剩 spr run
writeAction("vote");
assert.match((await run("debug", "flow", "computer", "wait", "0.1")).stdout, /目标：spr run flow（还缺 like）$/);
writeAction("like", " * @status draft\n * @write");
assert.match((await run("debug", "flow", "computer", "wait", "0.1")).stdout, /目标：spr run flow$/);

// daemon 重启后：新的登记里没有旧窗口
assert.equal(new DebugWindows({ log, host, win } as never).of("flow"), undefined);

// run：真跑成功的 draft 都变成 verified；输出写 run 窗口目录；debug 窗口不关、也不提醒
log.openWindow("flow-20261101-120000", "run", { action: "flow" });
nextOutcome = { runWindow: "flow-20261101-120000", drafts: [path.join(actions, "vote.js"), path.join(actions, "like.js")] };
assert.match((await run("run", "--help")).stdout, /^ok 用法：spr run <compose>/);
const ran = await run("run", "flow");
assert.equal(ran.code, 0, ran.stdout);
assert.equal(actionSummary(path.join(actions, "vote.js")).status, "verified", "真跑成功的 draft 变成 verified");
assert.match(ran.stdout, /已变成 verified：vote、like/);
assert.match(ran.stdout, /^ok flow\n/); assert.match(ran.stdout, /run 窗口目录：.*run-windows\/flow-20261101-120000/);
assert.ok(debug.of("flow"), "run 成功后 debug 窗口还在");
assert.ok(!ran.stdout.includes("还开着"), "不提醒关窗口");

// run 失败：debug 窗口还在；有已完成的 action 时给恢复编号，不带 --answer 恢复，读当前文件
writeAction("search");
writeCompose("pick", `return action("search", {});`);
log.openWindow("pick-20261101-125900", "run");
const seen: Array<{ code?: string; state?: unknown }> = [];
const script: Array<Record<string, unknown>> = [];
runner.runAction = (async (_name: string, _p: unknown, _n: unknown, o: { code?: string; askState?: unknown }) => { seen.push({ ...(o?.code ? { code: o.code } : {}), ...(o?.askState ? { state: o.askState } : {}) }); return script.shift(); }) as never;
script.push({ status: "failure", error: "[search] 403", failedAction: "search", page: { url: "https://www.x.com/s", title: "搜" }, journal: [{ name: "a", params: {}, result: 1 }], answers: [], runWindow: "pick-20261101-125900", drafts: [path.join(actions, "search.js")] });
const failedRun = await run("run", "pick");
assert.equal(failedRun.code, 1, failedRun.stdout);
assert.match(failedRun.stdout, /^fail pick：\[search\] 403/);
assert.ok(debug.of("flow"), "run 失败后 debug 窗口还在");
const failedId = /下一步：spr debug pick navigate https:\/\/www\.x\.com\/s，修好 search 后 spr resume (AS-[0-9a-f]+)/.exec(failedRun.stdout)?.[1];
assert.ok(failedId, failedRun.stdout);
assert.equal((await run("resume", failedId!, "--answer", "1")).code, 3, "失败后恢复不用 --answer");
script.push({ status: "success", result: 1, runWindow: "pick-20261101-125900", drafts: [] });
const resumedFix = await run("resume", failedId!);
assert.equal(resumedFix.code, 0, resumedFix.stdout);
assert.equal(seen.at(-1)!.code, undefined, "失败后恢复读当前文件");
assert.deepEqual((seen.at(-1)!.state as { journal: unknown[] }).journal, [{ name: "a", params: {}, result: 1 }], "带着 journal 恢复");
assert.equal(actionSummary(path.join(actions, "search.js")).status, "verified", "失败前成功的 draft 在最终成功时变成 verified");
assert.equal((await run("resume", failedId!)).code, 3, "恢复成功后编号作废");

// 停在 ask 之前已经成功的 draft：恢复时不会再执行，最终成功时也要变成 verified；恢复用停下那一刻的代码
writeAction("search2");
writeCompose("pick2", `return action("search2", {});`);
log.openWindow("pick2-20261101-130000", "run");
log.openWindow("pick2-20261101-130100", "run");
script.push({ status: "ask", question: "挑", data: [1], journal: [], code: "停下时的代码", runWindow: "pick2-20261101-130000", drafts: [path.join(actions, "search2.js")] });
const asked = await run("run", "pick2");
assert.equal(asked.code, 2, asked.stdout); assert.match(asked.stdout, /^ask 挑\n/);
const resumeId = /spr resume (AS-[0-9a-f]+)/.exec(asked.stdout)![1]!;
assert.equal(actionSummary(path.join(actions, "search2.js")).status, "draft", "停在 ask 时还不变成 verified");
assert.equal((await run("resume", resumeId)).code, 3, "resume 要带 --answer");
script.push({ status: "success", result: 1, runWindow: "pick2-20261101-130100", drafts: [] });
const resumedRun = await run("resume", resumeId, "--answer", "[1]");
assert.equal(resumedRun.code, 0, resumedRun.stdout);
assert.equal(seen.at(-1)!.code, "停下时的代码", "恢复用停下那一刻的代码");
assert.equal(actionSummary(path.join(actions, "search2.js")).status, "verified", "ask 之前成功的 draft 在最终成功时变成 verified");

// 落盘的文件里也没有 auth 头的真值（日志、请求文件、endpoints.json 只有别名和来源）
index.flush();
for (const f of fs.readdirSync(root, { recursive: true, withFileTypes: true })) if (f.isFile()) assert.ok(!fs.readFileSync(path.join(f.parentPath, f.name)).includes("XSRF-REAL-0123456789"), `${f.name} 里不该有真值`);
assert.deepEqual(JSON.parse(fs.readFileSync(path.join(log.dir, "x.com", "endpoints.json"), "utf8")).endpoints.find((e: { key: string }) => e.key === "POST /api/answers/:id/voters").headers["x-xsrftoken"], { kind: "few", source: "cookie:_xsrf" });

// close：日志留着；再操作是用法错误，告诉 agent 重新 navigate（不会悄悄回到上次的 URL 接着用）
const closed = await run("debug", "flow", "close");
assert.match(closed.stdout, /^ok 已关掉 flow 的 debug 窗口/);
const reuse = await run("debug", "flow", "computer", "left_click", "1", "1");
assert.equal(reuse.code, 3, reuse.stdout); assert.match(reuse.stdout, /debug 窗口没开.*navigate/);
assert.equal((await run("debug", "flow", "read_page")).code, 3, "只看不动的工具也不行");
assert.match((await run("debug", "flow", "close")).stdout, /^ok flow 没有开着的 debug 窗口/);
assert.ok(!(await run("debug", "list")).stdout.includes("flow"), "debug list 只列开着的");
// 关掉后重开：换一个目录，同一个 compose 又能用
assert.equal((await run("debug", "flow", "navigate", page)).code, 0);
assert.match((await run("debug", "list")).stdout, /  flow https:\/\/www\.x\.com\/home/);

console.log("commands.selfcheck ok");
