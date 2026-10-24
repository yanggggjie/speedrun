// 命令层：参数解析，以及用假的 holder 能力（假页面、假标签页）端到端跑 log / tabs / takeover / act / replay / req。HOME 指向临时目录。
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "tc-cmd-"));
process.on("exit", () => fs.rmSync(home, { recursive: true, force: true })); // 自检结束清掉临时目录
process.env.HOME = home;
const { parseAct, parseReplayArgs, runCommand } = await import("./commands.ts");
const { Ingestor } = await import("./ingest.ts");
const { Leases } = await import("./lease.ts");
const { RawStore } = await import("./raw.ts");
const { JournalStore } = await import("./store.ts");
const { NeedExtensionError } = await import("../browser/connect.ts");
const { JOURNAL_DIR } = await import("../utils/constants.ts");
assert.ok(JOURNAL_DIR.startsWith(home), "日志目录应在临时 HOME 下");

// ---- 参数解析 ----
const ok = (args: string[]) => { const r = parseAct(args); assert.ok("cmd" in r, JSON.stringify(r)); return r.cmd; };
const bad = (args: string[]) => { const r = parseAct(args); assert.ok("error" in r, JSON.stringify(r)); return r.error; };
assert.deepEqual(ok(["click", "@e12"]), { kind: "click", ref: "@e12" });
assert.deepEqual(ok(["click", "e12"]), { kind: "click", ref: "@e12" }, "@ 可以省略");
assert.deepEqual(ok(["fill", "@e5", "你好", "世界"]), { kind: "fill", ref: "@e5", text: "你好 世界" });
assert.deepEqual(ok(["fill", "@e5", ""]), { kind: "fill", ref: "@e5", text: "" }, "可以清空");
assert.deepEqual(ok(["select", "@e9", "香蕉"]), { kind: "select", ref: "@e9", text: "香蕉" });
assert.deepEqual(ok(["check", "@e3", "--off"]), { kind: "check", ref: "@e3", checked: false });
assert.deepEqual(ok(["press", "Ctrl+K", "@e5"]), { kind: "press", key: "Ctrl+K", ref: "@e5" });
assert.deepEqual(ok(["scroll", "up", "200"]), { kind: "scroll", dy: -200 });
assert.deepEqual(ok(["scroll", "bottom"]), { kind: "scroll", to: "bottom" });
assert.deepEqual(ok(["goto", "example.com/a?b=1"]), { kind: "goto", url: "https://example.com/a?b=1" });
assert.match(bad(["click"]), /需要元素引用/);
assert.match(bad(["fill", "@e5"]), /用法：tabbot act fill/);
assert.match(bad(["scroll", "down", "很多"]), /数字/);
assert.match(bad(["goto", "file:///etc/passwd"]), /不是有效的网址/, "只允许 http / https");
assert.match(bad([]), /用法：tabbot act click/);
const rp = (args: string[]) => { const r = parseReplayArgs(args); assert.ok(!("error" in r), JSON.stringify(r)); return r; };
assert.deepEqual(rp(["#210", "--set", "page=2", "--set=body.filter.on=false", "--tab", "5", "--yes"]), { seq: 210, sets: ["page=2", "body.filter.on=false"], tabId: 5, yes: true });
for (const [args, re] of [[[], /用法：tabbot replay/], [["abc"], /请求编号要是整数/], [["1", "2"], /多余的参数/], [["1", "--set"], /缺少值/], [["1", "--wat"], /不认识的参数/]] as [string[], RegExp][]) {
  const r = parseReplayArgs(args); assert.ok("error" in r && re.test(r.error), JSON.stringify([args, r]));
}

// ---- 假的 holder 能力 ----
const store = new JournalStore();
await store.open();
const raw = new RawStore();
const ingest = new Ingestor(store, { aliasKey: "k", raw });
const leases = new Leases();
const SECRET = "REAL-TOKEN-0123456789abcdef";
const page = "https://www.example.com/p";
const tabs = [{ tabId: 7, windowId: 1, active: true, url: page, title: "示例", status: "complete" }];
const calls: string[] = [];
let extension = true;
const ctx = {
  ensureExtension: async () => { if (!extension) throw new NeedExtensionError(); },
  tabs: async () => tabs,
  call: async (_tab: number, expr: string) => {
    calls.push(expr);
    if (expr.includes("exec.act(")) return { ok: true, target: { tag: "button", text: "提交" }, settle: { settled: true, waitedMs: 130 }, url: page, title: "示例" };
    if (expr.includes("exec.snapshot(")) return { url: page, title: "示例", interactiveTotal: 3, interactiveVisible: 2, inViewShown: 2, items: [{ ref: "e1", t: "button", n: "提交" }] };
    if (expr.includes("exec.text(")) return { url: page, title: "示例", total: 4, text: "你好世界" };
    if (expr.includes("exec.replay(")) return { ok: true, status: 200, ct: "application/json", size: 17, text: "{\"items\":[1,2,3]}", ms: 9 };
    throw new Error(`没有预期的调用：${expr}`);
  },
  goto: async () => {},
  waitLoaded: async () => ({ url: page, title: "示例" }),
  leases, ingest, raw,
  daemon: () => ({ extension, pid: process.pid }),
};
const run = (...argv: string[]) => runCommand(argv, ctx as never);

// 用法、握手
assert.equal((await run()).code, 1);
assert.match((await run("bogus")).stdout, /用法/);
extension = false;
const hs = await run("tabs");
assert.equal(hs.code, 1); assert.equal(JSON.parse(hs.stdout).status, "need-extension");
extension = true;
assert.match((await run("log")).stdout, /^无新事件/);

// 一条人的点击和一个它引发的请求，一个带 token 的 POST
const T = Date.now() - 10_000;
ingest.handleBatch([
  { k: "ev", t: T, tab: 7, page, type: "click", trusted: true, target: { tag: "a", text: "更多", sel: "#more" } },
  { k: "net", t: T + 50, tab: 7, page, via: "fetch", id: 1, rid: "d:1", method: "GET", url: `https://www.example.com/api/list?page=1&access_token=${SECRET}`, reqHeaders: { "x-token": SECRET, accept: "*/*" }, status: 200, ct: "application/json", body: "{\"items\":[\"独一无二的标题\"]}", size: 28 },
  { k: "net", t: T + 60, tab: 7, page, via: "fetch", id: 2, rid: "d:2", method: "POST", url: "https://www.example.com/api/save", reqHeaders: { "content-type": "application/json" }, reqBody: "{\"a\":1}", status: 200, ct: "application/json", body: "{}", size: 2 },
]);
const log = (await run("log")).stdout.split("\n");
assert.match(log[0]!, /^3 条事件，其中人的操作 1 条（游标 3，下次加 --since 3）$/);
assert.match(log[1]!, /^#1 \d\d:\d\d:\d\d tab7 human click a\[更多\]$/);
assert.match(log[2]!, /GET \/api\/list\?page=1&access_token=⟨secret_[0-9a-f]{12}:\w+⟩ 200 28B body:000001\/[0-9a-f]+\.json ← #1$/);
assert.match((await run("log", "--src", "human")).stdout, /^1 条事件/);
assert.equal((await run("log", "--src", "nobody")).code, 1);
assert.match((await run("log", "--since", "3")).stdout, /^无新事件（游标 3）/);

// 查询、req find / show
assert.match((await run("sql", "SELECT COUNT(*) AS n FROM events")).stdout, /1 行\nn\n3/);
assert.match((await run("req", "find", "独一无二的标题")).stdout, /1 处有「独一无二的标题」/);
const shown = (await run("req", "show", "2")).stdout;
assert.match(shown, /地址：https:\/\/www\.example\.com\/api\/list/);
assert.match(shown, /tabbot replay 2/);

// tabs / snapshot / text
assert.match((await run("tabs")).stdout, /^1 个标签页\ntab7 win1 前台 https:\/\/www\.example\.com\/p "示例"/);
assert.match((await run("snapshot")).stdout, /^tab7 https:\/\/www\.example\.com\/p "示例"\n.*\n@e1 button "提交"/);
assert.match((await run("text", "--max", "100")).stdout, /你好世界/);

// 没有租约不能动手；takeover 之后可以；人一动手撤销
let r = await run("act", "click", "@e1", "--tab", "7");
assert.equal(r.code, 1); assert.match(r.stdout, /没有租约/);
r = await run("takeover");
assert.equal(r.code, 0); assert.match(r.stdout, /已获取 tab7 的租约/);
r = await run("act", "click", "@e1");
assert.equal(r.code, 0, r.stdout); assert.match(r.stdout, /^✓ click @e1（页面已稳定，等了 0\.1s）/);
assert.ok(calls.some((c) => c.includes('exec.act({"kind":"click","ref":"@e1"})')));
leases.humanInput(7, "click");
r = await run("act", "click", "@e1", "--tab", "7");
assert.equal(r.code, 1); assert.match(r.stdout, /租约被撤销了/);
assert.match((await run("takeover")).stdout, /没有获取租约：人还在操作 tab7/);
leases.humanInput(7, "wheel"); // 滚轮不影响下面
// 命令记录进了日志（含被拒绝的），输入的文字不进日志
const cmds = (await run("log", "--all", "-n", "100")).stdout;
assert.match(cmds, /cmd click @e1|cmd click button\[提交\]/);
assert.match((await run("release", "--tab", "7")).stdout, /本来就没有租约/);

// 重放：原始内容在内存里；--set 里可以写别名；非 GET 要 --yes 和租约
const alias = /access_token=(⟨secret_[0-9a-f]{12}:\w+⟩)/.exec(log[2]!)![1]!;
raw.put(7, "d:2", { method: "POST", url: "https://www.example.com/api/save", headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` }, body: "{\"a\":1}", page, t: T });
const lastReplay = (): { method: string; url: string; headers: Record<string, string>; body: string | null } => {
  const expr = calls.filter((c) => c.includes("exec.replay(")).at(-1)!;
  return JSON.parse(expr.slice("window.__tcr.exec.replay(".length, -1));
};
r = await run("replay", "2", "--set", "page=2", "--set", `header.x-token=${alias}`);
assert.equal(r.code, 0, r.stdout); assert.match(r.stdout, /^✓ 重放 #2（改了 page, header\.x-token）：GET → 200/);
let sent = lastReplay();
assert.equal(sent.headers["x-token"], SECRET, "页面里发出的是真值（别名已换成真值）");
assert.equal(new URL(sent.url).searchParams.get("page"), "2", "--set 生效");
assert.match(r.stdout, /JSON 对象，字段：items/);
r = await run("replay", "3");
assert.equal(r.code, 1); assert.match(r.stdout, /--yes/);
r = await run("replay", "3", "--yes");
assert.equal(r.code, 1); assert.match(r.stdout, /需要租约/);
(leases as unknown as { humanAt: Map<number, number> }).humanAt.clear(); // 人早就停手了
await run("takeover");
r = await run("replay", "3", "--yes", "--set", "body.a=5");
assert.equal(r.code, 0, r.stdout); assert.match(r.stdout, /POST → 200/);
sent = lastReplay();
assert.equal(sent.body, "{\"a\":5}", "请求体里的字段改了");
assert.equal(sent.headers.authorization, `Bearer ${SECRET}`, "原始请求头里的真值原样带上");
r = await run("replay", "2", "--set", "header.x-token=⟨secret_000000000000:jwt⟩");
assert.equal(r.code, 1); assert.match(r.stdout, /已失效|holder 重启/);
r = await run("replay", "99");
assert.match(r.stdout, /找不到事件/);

// 日志和磁盘上任何地方都没有 token 真值
ingest.flush();
const files = fs.readdirSync(path.join(home, ".tabbot"), { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
for (const f of files) {
  if (/-wal$|-shm$/.test(f.name)) continue;
  assert.ok(!fs.readFileSync(path.join(f.parentPath, f.name)).includes(SECRET), `${f.name} 里不该有真值`);
}

console.log("commands.selfcheck ok");
