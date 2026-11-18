// 命令层：参数解析，以及用假的 daemon 能力端到端跑 debug / run（直跑 action 与 -e 内联组合）。
// 守住关键约束：debug 无需预先建文件、同站已有 action 自动提示、观察按游标不漏不重、有未覆盖请求时提示派发 distiller（已标 @from 或 distiller 角色时不重复提示）、
// 关窗与重启遗留 meta.json 同步更新 open: false + closedBy、run -e 代码脱敏进 invocations.jsonl、debug list 不污染 name。
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DebugWindows } from "../debug/windows.ts";
import { Session } from "../browser/host.ts";
import { actionSummary } from "../run/actions.ts";
import { runCommand, type Ctx } from "./index.ts";
import { parseComputer } from "./debug.ts";
import { EndpointIndex } from "../record/endpoints.ts";
import { Ingestor, type PageMsg } from "../record/ingest.ts";
import { InvocationLog } from "../record/invocations.ts";
import { RawStore } from "../record/raw.ts";
import { WindowLog } from "../record/windowlog.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "speedrun-cmd-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));

// ---- 参数解析 ----
const ok = (args: string[], o = {}) => { const r = parseComputer(args, o); assert.ok("cmd" in r, JSON.stringify(r)); return r.cmd; };
const bad = (args: string[], o = {}) => { const r = parseComputer(args, o); assert.ok("error" in r, JSON.stringify(r)); return r.error; };
assert.deepEqual(ok(["left_click", "120", "340.5"]), { action: "left_click", x: 120, y: 340.5 });
assert.deepEqual(ok(["right_click", "1", "2"], { modifiers: "Cmd+shift" }), { action: "right_click", x: 1, y: 2, mods: { cmd: true, shift: true } });
assert.deepEqual(ok(["left_click_drag", "10", "20", "300", "400"]), { action: "left_click_drag", sx: 10, sy: 20, x: 300, y: 400 });
assert.deepEqual(ok(["type", "你好", "世界"]), { action: "type", text: "你好 世界" });
assert.deepEqual(ok(["key", "cmd+a", "Backspace"], { repeat: "3" }), { action: "key", keys: "cmd+a Backspace", repeat: 3 });
assert.deepEqual(ok(["scroll", "500", "400", "down", "50"]), { action: "scroll", x: 500, y: 400, direction: "down", amount: 10 });
assert.deepEqual(ok(["scroll", "500", "400", "up"]), { action: "scroll", x: 500, y: 400, direction: "up", amount: 3 });
assert.deepEqual(ok(["zoom", "0", "0", "200", "100"], { scale: "0.5" }), { action: "zoom", region: [0, 0, 200, 100], scale: 0.5 });
assert.match(bad(["left_click", "@e12"]), /用法：spr debug <名> computer left_click <x> <y>/);
assert.match(bad(["scroll", "500", "400", "bottom"]), /up\|down\|left\|right/);
assert.match(bad(["key", "Enter"], { repeat: "101" }), /--repeat/);
assert.match(bad(["left_click", "1", "2"], { modifiers: "hyper" }), /不认识的修饰键/);
assert.match(bad(["zoom", "100", "100", "50", "50"]), /左上角和右下角/);
assert.match(bad(["wait", "30"]), /最多 10 秒/);
assert.match(bad(["click", "1", "2"]), /computer 的 action 是/);
assert.deepEqual(ok(["left_click"], { ref: "ref_12" }), { action: "left_click", ref: "ref_12" });
assert.deepEqual(ok(["left_click_drag"], { ref: "ref_1", to: "ref_2" }), { action: "left_click_drag", ref: "ref_1", toRef: "ref_2" });
assert.deepEqual(ok(["scroll", "down", "2"], { ref: "ref_3" }), { action: "scroll", ref: "ref_3", direction: "down", amount: 2 });
assert.match(bad(["left_click", "1", "2"], { ref: "ref_1" }), /二选一/);
assert.match(bad(["left_click"], { ref: "e12" }), /--ref 要写成 ref_数字/);

// ---- 假的 daemon 能力 ----
const log = new WindowLog({ root });
log.open();
const invFile = path.join(root, "invocations.jsonl");
const invocations = new InvocationLog(invFile);
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
let inputs = 0;
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
      const n = 100 + inputs++;
      ingest.handleBatch([net(Date.now() + 20, { id: n, rid: `p:${n}`, method: "POST", url: "https://www.x.com/api/answers/12345678/voters", reqHeaders: { "x-xsrftoken": "XSRF-REAL-0123456789", "x-zse-96": "2.0_SIGN" }, reqBody: "{\"type\":\"up\"}", body: "{\"ok\":1}", size: 8 })]);
      ingest.endCmd(ref, { detail: { ok: true } });
      return { ok: true, loc: { role: "button", name: "赞同" }, settle: { settled: true, waitedMs: 100 } };
    }
    throw new Error(`没有预期的操作 ${name}`);
  },
  end: async (s: Session) => { s.tab = undefined; },
  quiet: async () => { ingest.flush(); return { settled: true, waitedMs: 1 }; },
  authSnapshot: async () => ({ cookie: { _xsrf: "XSRF-REAL-0123456789" }, local: {}, session: {}, meta: {} }),
};
let nextOutcome: Record<string, unknown> = {};
const runner = {
  runAction: async (name: string, params: Record<string, unknown>) => ({ status: "success", result: { name, params }, ...nextOutcome }),
  runInline: async (code: string) => ({ status: "success", result: { codeLen: code.length }, calls: [{ name: "vote", ms: 5, status: "success" }], ...nextOutcome }),
};
const win = { isAgentTab: (t: number) => t === 20, winOf: (t: number) => WINS[t] ?? "user", isOpen: async () => true, dispose: async () => {}, busy: () => () => {} };
const debug = new DebugWindows({ log, host, win });
const ctx = {
  ensureExtension: async () => {},
  tabs: async () => tabs,
  host, runner, win, debug, ingest, raw, log, index, invocations,
  daemon: () => ({ extension: true, pid: process.pid }),
} as unknown as Ctx;
const run = (...argv: string[]) => runCommand(argv, ctx, { cwd: "/tmp/proj", caller: { host: "claude", session: "s-abc123", role: "main" } });
const seqsIn = (text: string): number[] => [...text.matchAll(/#(\d+) (?:GET|POST)/g)].map((m) => Number(m[1]));

const actions = path.join(log.dir, "x.com");
fs.mkdirSync(actions, { recursive: true });
const writeAction = (name: string, head = " * @status draft"): void => fs.writeFileSync(path.join(actions, `${name}.js`), `/**\n${head}\n */\n`);

assert.equal((await run("nope")).code, 3);
assert.equal((await run("resume", "AS-123")).code, 3, "resume 命令已移除");
assert.equal((await run("debug", "BAD_NAME", "navigate", page)).code, 3, "窗口名只允许小写字母数字和 -");
assert.equal((await run("debug", "flow", "read_page")).code, 3, "窗口没开时报错");
assert.equal((await run("debug", "flow", "navigate", "back")).code, 3, "没有窗口时不能 back");
assert.equal((await run("debug", "flow", "navigate", "ftp://x")).code, 3, "只接受 http(s) 和 tab 号");

// 先放一个同站已有 action：打开 debug 窗口时不要求存在 flow.js，且自动提示同站已有 action
writeAction("x-existing", " * @status verified\n * @param q 搜索词");
const opened = await run("debug", "flow", "navigate", page);
assert.equal(opened.code, 0, opened.stdout);
assert.match(opened.stdout, /^ok debug 窗口已打开：flow/);
assert.match(opened.stdout, /同站已有 action（x\.com）：x-existing\(q\)/, "自动提示同站已有 action 防漏复用");
const id = debug.of("flow")!.id;
assert.match(id, /^flow-\d{8}-\d{6}$/);
assert.match(opened.stdout, /未沉淀窗口：.*distiller\.md/, "有未覆盖请求时给出沉淀提示");
const first = seqsIn(opened.stdout);
assert.equal(first.length, 1);

// 观察按游标不重复
assert.deepEqual(seqsIn((await run("debug", "flow", "computer", "wait", "0.1")).stdout), []);

// 页面操作自动附带观察 + 请求头信号脱敏
const clicked = await run("debug", "flow", "computer", "left_click", "100", "200");
const second = seqsIn(clicked.stdout);
assert.equal(second.length, 1); assert.ok(second[0]! > first[0]!);
assert.match(clicked.stdout, /请求头：.*x-xsrftoken 样本太少 ← cookie _xsrf/);
assert.ok(!clicked.stdout.includes("XSRF-REAL-0123456789"), "输出里没有 auth 头的真值");

// 并发串行保护
const [earlier, later] = await Promise.all([run("debug", "flow", "computer", "wait", "0.2"), run("debug", "flow", "computer", "wait", "0.1")]);
assert.equal(earlier.code, 0);
assert.equal(later.code, 1); assert.match(later.stdout, /上一条命令还没结束/);

// 当 distiller 已经为该窗口写出了带 @from <id> 的 action，或调用方是 distiller 角色时，不再重复出沉淀提示
assert.ok(!(await runCommand(["debug", "flow", "computer", "wait", "0.1"], ctx, { caller: { role: "distiller" } })).stdout.includes("未沉淀窗口"), "distiller 自己不弹提示");
writeAction("vote", ` * @status draft\n * @from ${id}`);
assert.ok(!(await run("debug", "flow", "computer", "wait", "0.1")).stdout.includes("未沉淀窗口"), "已有 @from <窗口id> 的 action 后不再提示未沉淀");

// spr run 直接跑 action（draft 跑通变 verified）+ spr run -e 内联运行
assert.equal((await run("run", "missing")).code, 3);
log.openWindow("vote-20261101-120000", "run", { action: "vote" });
nextOutcome = {
  runWindow: "vote-20261101-120000",
  drafts: [path.join(actions, "vote.js")],
  sent: ["POST /api/answers/:id/voters ×1"],
  pageSent: ["POST /ffs/e ×2"],
  perf: { openMs: 12, navMs: 80, reqMs: 15, domMs: 0 },
  ops: { nav: 1, req: 1, dom: 0, eval: 0 },
};
const ran = await run("run", "vote");
assert.equal(ran.code, 0, ran.stdout);
assert.equal(actionSummary(path.join(actions, "vote.js")).status, "verified", "draft 直跑成功变成 verified");
assert.match(ran.stdout, /已变成 verified：vote/);
assert.match(ran.stdout, /已发出的非 GET 请求：\n  POST \/api\/answers\/:id\/voters ×1/);
assert.match(ran.stdout, /页面触发的非 GET 请求：\n  POST \/ffs\/e ×2/);

// spr run -e：内联代码里的秘密字面量在 invocations.jsonl 里被脱敏，普通代码可读
log.openWindow("inline-20261101-120100", "run", { action: "-e" });
nextOutcome = { runWindow: "inline-20261101-120100", drafts: [] };
const inlineRan = await run("run", "-e", `return action("vote", { token: "SUPERSECRET123456", id: "42" })`);
assert.equal(inlineRan.code, 0, inlineRan.stdout);

// close 更新 meta.json 的 open: false 与 closedBy: "cmd"；遗留 open: true 的旧窗口由 closeStaleMeta 标为 restart
await run("debug", "list");
const closed = await run("debug", "flow", "close");
assert.match(closed.stdout, /^ok 已关掉 flow 的 debug 窗口/);
const closedMeta = log.readMeta(id)!;
assert.equal(closedMeta.open, false);
assert.equal(closedMeta.closedBy, "cmd");

log.openWindow("orphan-20261101-090000", "debug", { id: "orphan-20261101-090000", open: true });
debug.closeStaleMeta();
assert.equal(log.readMeta("orphan-20261101-090000")?.open, false);
assert.equal(log.readMeta("orphan-20261101-090000")?.closedBy, "restart");

// 核对落盘文件无真值 + invocations.jsonl 字段完整准确
index.flush();
for (const f of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
  if (f.isFile()) {
    const content = fs.readFileSync(path.join(f.parentPath, f.name), "utf8");
    assert.ok(!content.includes("XSRF-REAL-0123456789"), `${f.name} 不该含请求头真值`);
    assert.ok(!content.includes("SUPERSECRET123456"), `${f.name} 不该含 -e 代码里的秘密真值`);
  }
}
const invRows = fs.readFileSync(invFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const listRow = invRows.find((r) => r.cmd === "debug" && r.tool === "list")!;
assert.equal(listRow.name, undefined, "debug list 不把 list 写进 name");
const navUsageRow = invRows.find((r) => r.cmd === "debug" && r.tool === "navigate" && r.status === "usage")!;
assert.equal(navUsageRow.exit, 3, "用法错误的 debug 命令也记下了 tool");
const openRow = invRows.find((r) => r.cmd === "debug" && r.tool === "navigate" && r.status === "ok")!;
assert.equal(openRow.site, "x.com");
assert.equal(openRow.siteActions, 1);
assert.equal(openRow.promptedDistill, true);
assert.equal(openRow.caller.host, "claude");
const missingRow = invRows.find((r) => r.cmd === "run" && r.name === "missing")!;
assert.equal(missingRow.error.code, "not-defined", "找不到 action 时记录 not-defined");
const inlineRow = invRows.find((r) => r.cmd === "run" && r.mode === "inline")!;
assert.equal(inlineRow.name, "-e");
assert.match(inlineRow.code, /⟨secret_.*⟩/, "-e 里的 token 值已换成别名");
assert.match(inlineRow.code, /id: "42"/, "-e 里的普通参数保持可读");

console.log("commands.selfcheck ok");
