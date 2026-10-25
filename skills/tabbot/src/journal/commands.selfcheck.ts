// 命令层：参数解析，以及用假的 holder 能力（假页面、假标签页）端到端跑 log / tabs / open / act / replay / req / task。HOME 指向临时目录。
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "tc-cmd-"));
process.on("exit", () => fs.rmSync(home, { recursive: true, force: true })); // 自检结束清掉临时目录
process.env.HOME = home;
const { parseAct, parseReplayArgs, runCommand } = await import("./commands.ts");
const { Ingestor } = await import("./ingest.ts");
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
assert.deepEqual(ok(["click", "#go"]), { kind: "click", loc: "#go" }, "CSS 选择器是持久定位");
assert.deepEqual(ok(["click", '{"role":"button","name":"提交"}']), { kind: "click", loc: { role: "button", name: "提交" } });
assert.deepEqual(ok(["fill", "@e5", "你好", "世界"]), { kind: "fill", ref: "@e5", text: "你好 世界" });
assert.deepEqual(ok(["fill", "@e5", ""]), { kind: "fill", ref: "@e5", text: "" }, "可以清空");
assert.deepEqual(ok(["select", "@e9", "香蕉"]), { kind: "select", ref: "@e9", text: "香蕉" });
assert.deepEqual(ok(["check", "@e3", "--off"]), { kind: "check", ref: "@e3", checked: false });
assert.deepEqual(ok(["press", "Ctrl+K", "@e5"]), { kind: "press", key: "Ctrl+K", ref: "@e5" });
assert.deepEqual(ok(["press", "Enter"]), { kind: "press", key: "Enter" });
assert.deepEqual(ok(["scroll", "up", "200"]), { kind: "scroll", dy: -200 });
assert.deepEqual(ok(["scroll", "down", "300", "@e2"]), { kind: "scroll", dy: 300, ref: "@e2" });
assert.deepEqual(ok(["scroll", "bottom"]), { kind: "scroll", to: "bottom" });
assert.match(bad(["click"]), /需要目标/);
assert.match(bad(["click", "{坏的"]), /不是合法 JSON/);
assert.match(bad(["fill", "@e5"]), /用法：tabbot act fill/);
assert.match(bad(["scroll", "sideways"]), /用法：tabbot act scroll/);
assert.match(bad(["goto", "example.com"]), /用法：tabbot act click/, "打开网址用 tabbot open");
assert.match(bad([]), /用法：tabbot act click/);
const rp = (args: string[]) => { const r = parseReplayArgs(args); assert.ok(!("error" in r), JSON.stringify(r)); return r; };
assert.deepEqual(rp(["#210", "--set", "page=2", "--set=body.filter.on=false", "--yes"]), { seq: 210, sets: ["page=2", "body.filter.on=false"], yes: true });
for (const [args, re] of [[[], /用法：tabbot replay/], [["abc"], /请求编号要是整数/], [["1", "2"], /多余的参数/], [["1", "--set"], /缺少值/], [["1", "--wat"], /不认识的参数/]] as [string[], RegExp][]) {
  const r = parseReplayArgs(args); assert.ok("error" in r && re.test(r.error), JSON.stringify([args, r]));
}

// ---- 假的 holder 能力 ----
const store = new JournalStore();
await store.open();
const raw = new RawStore();
const ingest = new Ingestor(store, { aliasKey: "k", raw });
const SECRET = "REAL-TOKEN-0123456789abcdef";
const page = "https://www.example.com/p";
const tabs = [
  { tabId: 7, windowId: 1, active: true, url: page, title: "示例", status: "complete" },
  { tabId: 20, windowId: 9, active: true, url: "https://www.example.com/robots.txt", title: "", status: "complete" },
  { tabId: 21, windowId: 9, active: true, url: "chrome-extension://x/anchor.html", title: "tabbot agent", status: "complete", anchor: true },
];
const calls: string[] = [];
let extension = true;
const taskDir = path.join(home, "tasks");
const { Session } = await import("../run/host.ts");
const hostOps: string[] = [];
const host = {
  op: async (s: InstanceType<typeof Session>, name: string, a: Record<string, unknown>) => {
    hostOps.push(`${name} ${JSON.stringify(a)}`);
    if (name === "goto") { s.tab = 20; s.origin = "https://www.example.com"; ingest.endCmd(ingest.beginCmd(20, Date.now(), "goto", "https://www.example.com/p", { bareUrl: "https://www.example.com/p", query: { q: "x" } }), { detail: { bareUrl: "https://www.example.com/p", query: { q: "x" }, ok: true } }); return { url: page, title: "示例" }; }
    if (name === "act") { ingest.endCmd(ingest.beginCmd(20, Date.now(), "click", "x", { kind: "click" }), { detail: { kind: "click", loc: { role: "button", name: "提交" }, ok: true } }); return { ok: true, loc: { role: "button", name: "提交" }, settle: { settled: true, waitedMs: 130 }, url: page, title: "示例" }; }
    if (name === "snapshot") return { url: page, title: "示例", interactiveTotal: 3, interactiveVisible: 2, inViewShown: 2, items: [{ ref: "e1", t: "button", n: "提交" }] };
    if (name === "text") return { url: page, title: "示例", total: 4, text: "你好世界" };
    throw new Error(`没有预期的操作 ${name}`);
  },
  bind: async (s: InstanceType<typeof Session>) => { s.tab = 20; return 20; },
  end: async (s: InstanceType<typeof Session>) => { s.tab = undefined; },
  callTab: async (_tab: number, fn: string, args: unknown[]) => {
    calls.push(`${fn} ${JSON.stringify(args[0])}`);
    if (fn === "replay") return { ok: true, status: 200, ct: "application/json", size: 17, text: "{\"items\":[1,2,3]}", ms: 9 };
    throw new Error(`没有预期的调用：${fn}`);
  },
};
const { Tickets } = await import("../run/tickets.ts");
const tickets = new Tickets();
const runs: string[] = [];
const runner = {
  runTask: async (name: string, params: Record<string, string>, _n: unknown, opts: { key?: string; dry?: boolean } = {}) => { runs.push(`${name} ${JSON.stringify(params)} key=${opts.key ?? "main"} dry=${opts.dry === true}`); return { status: "success", result: { name, params } }; },
  runCompose: async (code: string) => ({ status: "success", result: code }),
};
const disposed: string[] = [];
const ctx = {
  ensureExtension: async () => { if (!extension) throw new NeedExtensionError(); },
  tabs: async () => tabs,
  host, runner, win: { isAgentTab: (t: number) => t === 20, dispose: async (k: string) => { disposed.push(k); } }, tickets, sessions: new Map(), ingest, raw, taskDir,
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
assert.match(shown, /task 代码：\n@endpoint GET \/api\/list/); assert.match(shown, /await request\(page, \{ method: "GET"/);

// tabs 只列用户自己的页面（run 窗口的和 anchor 页不算）
assert.match((await run("tabs")).stdout, /^1 个标签页\ntab7 win1 前台 https:\/\/www\.example\.com\/p "示例"$/);

// Chef 没有调试权限：没有票据一律拒绝；learn 发票据并给出 brief
let r = await run("debug", "open", "example.com/p");
assert.equal(r.code, 1); assert.match(r.stdout, /Chef 没有调试权限/);
assert.equal((await run("snapshot")).code, 1, "旧的探索命令已经移走");
assert.equal((await run("debug", "--ticket", "t-nope", "open", "example.com")).code, 1);
r = await run("learn", "demo-new", "--goal", "给回答点赞", "--site", "www.example.com");
assert.equal(r.code, 0, r.stdout);
const ticket = /票据：(t-[0-9a-f]+)/.exec(r.stdout)![1]!;
assert.match(r.stdout, /你是 Cook/); assert.match(r.stdout, /为什么分 Chef 和 Cook/); assert.match(r.stdout, new RegExp(`tabbot debug --ticket ${ticket} replay`));

// Cook 用票据调试：在自己的 agent 窗口里
r = await run("debug", "--ticket", ticket, "open", "example.com/p");
assert.equal(r.code, 0, r.stdout); assert.match(r.stdout, /\[调试\] 票据/); assert.match(r.stdout, /已在 agent 窗口打开 https:\/\/www\.example\.com\/p "示例"/);
assert.match((await run("debug", "--ticket", ticket, "snapshot")).stdout, /tab20 https:\/\/www\.example\.com\/p "示例"\n.*\n@e1 button "提交"/);
assert.match((await run("debug", "--ticket", ticket, "text", "--max", "100")).stdout, /你好世界/);
r = await run("debug", "--ticket", ticket, "act", "click", "@e1");
assert.equal(r.code, 0, r.stdout); assert.match(r.stdout, /✓ click 持久定位 \{"role":"button","name":"提交"\}/);
assert.ok(hostOps.some((o) => o.startsWith('act {"kind":"click","ref":"@e1"}')));
assert.match((await run("debug", "--ticket", ticket, "act", "click")).stdout, /需要目标/);

// task：列出、骨架、run、compose
assert.match((await run("task")).stdout, /还没有 task/);
fs.mkdirSync(taskDir, { recursive: true });
fs.writeFileSync(path.join(taskDir, "demo.js"), "/**\n * @summary 演示\n * @endpoint GET /api/list\n * @param q 查询词\n */\n");
assert.deepEqual(JSON.parse((await run("task")).stdout)[0], { name: "demo", endpoints: ["GET /api/list"], status: "verified", summary: "演示", params: ["q 查询词"] });
assert.match((await run("run", "demo", "--q", "你好")).stdout, /"mode": "执行",\n  "status": "success"/);
assert.equal(runs.at(-1), 'demo {"q":"你好"} key=main dry=false');
assert.match((await run("run", "demo", "--q", "x", "--dry")).stdout, /"mode": "试运行"/);
assert.equal((await run("run", "demo", "q")).code, 1);
assert.match((await run("compose", "return 1")).stdout, /"result": "return 1"/);
assert.equal((await run("task", "new", "demo-new", "--summary", "探索出来的")).code, 0);
const skeleton = fs.readFileSync(path.join(taskDir, "demo-new.js"), "utf8");
assert.match(skeleton, /@status: draft/); assert.match(skeleton, /@endpoint/); assert.match(skeleton, /\.\.\/task\/lib\/index\.js/);
assert.equal((await run("task", "new", "demo-new")).code, 1, "不覆盖已有的");
// Cook 把自己那份 task 真跑通：票据结束，窗口关掉，再调试被拒
r = await run("run", "demo-new", "--ticket", ticket);
assert.equal(runs.at(-1), "demo-new {} key=" + ticket + " dry=false");
assert.deepEqual(disposed, [ticket]);
r = await run("debug", "--ticket", ticket, "snapshot");
assert.equal(r.code, 1); assert.match(r.stdout, /已经交付/);

// 重放（Cook 的调试）：原始内容在内存里；--set 里可以写别名；非 GET 要 --yes
const tk2 = /票据：(t-[0-9a-f]+)/.exec((await run("learn", "replay-demo", "--goal", "重放")).stdout)![1]!;
const alias = /access_token=(⟨secret_[0-9a-f]{12}:\w+⟩)/.exec(log[2]!)![1]!;
raw.put(7, "d:2", { method: "POST", url: "https://www.example.com/api/save", headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` }, body: "{\"a\":1}", page, t: T });
const lastReplay = (): { method: string; url: string; headers: Record<string, string>; body: string | null } => {
  const c = calls.filter((x) => x.startsWith("replay ")).at(-1)!;
  return JSON.parse(c.slice("replay ".length));
};
r = await run("debug", "--ticket", tk2, "replay", "2", "--set", "page=2", "--set", `header.x-token=${alias}`);
assert.equal(r.code, 0, r.stdout); assert.match(r.stdout, /✓ 重放 #2（改了 page, header\.x-token）：GET → 200/);
let sent = lastReplay();
assert.equal(sent.headers["x-token"], SECRET, "页面里发出的是真值（别名已换成真值）");
assert.equal(new URL(sent.url).searchParams.get("page"), "2", "--set 生效");
assert.match(r.stdout, /JSON 对象，字段：items/);
r = await run("debug", "--ticket", tk2, "replay", "3");
assert.equal(r.code, 1); assert.match(r.stdout, /--yes/);
r = await run("debug", "--ticket", tk2, "replay", "3", "--yes", "--set", "body.a=5");
assert.equal(r.code, 0, r.stdout); assert.match(r.stdout, /POST → 200/);
sent = lastReplay();
assert.equal(sent.body, "{\"a\":5}", "请求体里的字段改了");
assert.equal(sent.headers.authorization, `Bearer ${SECRET}`, "原始请求头里的真值原样带上");
r = await run("debug", "--ticket", tk2, "replay", "2", "--set", "header.x-token=⟨secret_000000000000:jwt⟩");
assert.equal(r.code, 1); assert.match(r.stdout, /已失效|holder 重启/);
r = await run("debug", "--ticket", tk2, "replay", "99");
assert.match(r.stdout, /找不到事件/);

// ---- context / api：把日志整理成"用户最近做了什么"和"这个站点有哪些接口" ----
const T2 = Date.now() - 5_000;
const gql = (t: number, over: Record<string, unknown>) => ({ k: "net", t, tab: 7, page, via: "fetch", status: 200, ct: "application/json", ...over });
ingest.handleBatch([
  { k: "doc", t: T2 - 200, tab: 7, page, url: "https://www.example.com/home", html: "<html></html>" },
  { k: "ev", t: T2, tab: 7, page, type: "click", trusted: true, target: { tag: "button", text: "Like", sel: "#like" } },
  gql(T2 + 40, { id: 10, rid: "d:10", method: "POST", url: "https://www.example.com/i/api/graphql/qid123/FavoriteTweet", reqBody: "{\"variables\":{\"tweet_id\":\"111\"},\"queryId\":\"qid123\"}", reqHeaders: { "content-type": "application/json" }, body: "{\"data\":{\"favorite_tweet\":\"Done\"}}", size: 30 }),
  gql(T2 + 3500, { id: 12, method: "GET", url: "https://www.example.com/i/api/graphql/qidU/UserByScreenName?variables=%7B%22screen_name%22%3A%22a%22%7D", body: "{\"data\":{\"user\":{\"result\":{\"id\":\"1\",\"legacy\":{}}}}}", size: 40 }), // 没有 rid：原始内容没存下来
  gql(T2 + 3000, { id: 11, rid: "d:11", method: "GET", url: `https://www.example.com/i/api/graphql/qidABC/HomeTimeline?variables=${encodeURIComponent(JSON.stringify({ count: 20, cursor: "c1" }))}`, body: "{\"data\":{\"home\":{\"home_timeline_urt\":{\"instructions\":[],\"metadata\":{}}}}}", size: 70 }),
]);
raw.put(7, "d:10", { method: "POST", url: "https://www.example.com/i/api/graphql/qid123/FavoriteTweet", headers: { "content-type": "application/json" }, body: "{\"variables\":{\"tweet_id\":\"111\"},\"queryId\":\"qid123\"}", page, t: T2 });
const ctxOut = (await run("context")).stdout;
assert.match(ctxOut, /^最近 180 分钟的活动：1 个站点/);
assert.match(ctxOut, /■ example\.com .*tab7/);
assert.match(ctxOut, /访问：www\.example\.com\/home/);
assert.match(ctxOut, /你的操作：.*click button\[Like\]/);
assert.match(ctxOut, /human click button\[Like\] → POST graphql FavoriteTweet/, "用户的操作和它引发的请求配好对");
assert.match((await run("context", "other.com")).stdout, /没有 other\.com 的活动记录/);
assert.match((await run("context", "www.example.com", "--minutes", "10")).stdout, /^最近 10 分钟的活动/);
const apiOut = (await run("api", "example.com")).stdout;
assert.match(apiOut, /^example\.com 的接口：\d+ 个/);
assert.match(apiOut, /POST graphql FavoriteTweet  ×1  #\d+ 200 ✓  变量：tweet_id  ← human click button\[Like\]/, "写操作排前面，带触发它的用户操作、变量、能不能直接重放");
assert.match(apiOut, /GET  graphql HomeTimeline  ×1  #\d+ 200 ✓  变量：variables\.count, variables\.cursor\n\s+响应：data\.home\.home_timeline_urt\.\{instructions,metadata\}/);
assert.match(apiOut, /GET  graphql UserByScreenName  ×1  #\d+ 200 ✗  变量：variables\.screen_name/, "没存下原始内容的标 ✗：要先在页面上再触发一次");
assert.ok(apiOut.indexOf("FavoriteTweet") < apiOut.indexOf("HomeTimeline"));
assert.match((await run("api", "nowhere.org")).stdout, /没有 nowhere\.org 的请求记录/);
assert.equal((await run("api")).code, 1);
// 能直接拿这一行去重放：点赞换一个帖子 id
const likeSeq = /#(\d+) 200 ✓/.exec(apiOut)![1]!;
r = await run("debug", "--ticket", tk2, "replay", likeSeq, "--yes", "--set", "body.variables.tweet_id=222");
assert.equal(r.code, 0, r.stdout);
assert.equal(JSON.parse(lastReplay().body!).variables.tweet_id, "222");
// req show 列出 JSON 查询参数里能改的字段
const homeSeq = /GET  graphql HomeTimeline  ×1  #(\d+)/.exec(apiOut)![1]!;
assert.match((await run("req", "show", homeSeq)).stdout, /可以改的查询参数：variables\.count, variables\.cursor/);

// 日志和磁盘上任何地方都没有 token 真值
ingest.flush();
const files = fs.readdirSync(path.join(home, ".tabbot"), { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
for (const f of files) {
  if (/-wal$|-shm$/.test(f.name)) continue;
  assert.ok(!fs.readFileSync(path.join(f.parentPath, f.name)).includes(SECRET), `${f.name} 里不该有真值`);
}

console.log("commands.selfcheck ok");
