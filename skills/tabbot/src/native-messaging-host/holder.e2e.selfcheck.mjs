// 端到端：relay 作为 native host 运行（拉起 daemon），一个假扩展经 stdio 实现 ABI 2 并模拟 run 窗口里的页面；
// 命令经 Unix socket 的 run RPC 执行，也走真实的 CLI。在临时 HOME 下运行，不碰真实 ~/.tabbot。由 npm test 调用。
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tabbot-e2e-"));
const SESSION = path.join(HOME, ".tabbot", "session");
const SOCK = path.join(SESSION, "sock");
const env = { ...process.env, HOME };
const RELAY = path.join(SRC, "native-messaging-host", "relay.ts");
const SECRET = "RAW-SECRET-TOKEN-9f8e7d6c5b4a";
const PAGE = "https://example.com/";

function frame(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

/** 假扩展 + 假页面：实现 ABI 2（call / tabs / goto / openWindow / openTab / activateTab / closeTab / closeWindow），run 窗口里的页面由它模拟。 */
function fakeExtension(child) {
  const log = { calls: [], gotos: [], opened: [], windows: 0, activated: [], closed: [] };
  const runTabs = new Map(); // tabId → { url, windowId }
  const anchors = new Map(); // windowId → anchor tabId
  let nextWin = 9;
  let nextTab = 100;
  let buf = Buffer.alloc(0);
  const send = (obj) => child.stdin.write(frame(obj));
  const reply = (id, result) => send({ id, result });
  const page = (tab, msg, pageUrl = PAGE) => send({ type: "page", tab, frame: 0, top: true, page: pageUrl, msg: { __tcrl: 1, t: Date.now(), ...msg } });
  const tabsList = () => [
    { tabId: 77, windowId: 1, active: true, url: PAGE, title: "示例", status: "complete" },
    ...[...anchors].map(([windowId, tabId]) => ({ tabId, windowId, active: false, url: "chrome-extension://x/anchor.html", title: "tabbot agent", status: "complete", anchor: true })),
    ...[...runTabs].map(([tabId, t]) => ({ tabId, windowId: t.windowId, active: true, url: t.url, title: "run", status: "complete" })),
  ];
  const callPage = (tab, fn, args) => {
    log.calls.push({ tab, fn, args });
    switch (fn) {
      case "act": return { ok: true, loc: { role: "searchbox", name: "搜索" }, target: { tag: "input", text: "搜索", type: "text" }, settle: { settled: true, waitedMs: 150 }, url: PAGE, title: "示例" };
      case "replay": {
        // 页面自己的请求也会被录制端看到：run 窗口里的请求记为 agent 的
        page(tab, { k: "net", via: "fetch", id: 9, rid: `run:${tab}:${log.calls.length}`, method: args[0].method, url: args[0].url, status: 200, ct: "application/json", body: "{\"echo\":1}", size: 10 });
        return { ok: true, status: 200, ct: "application/json", size: 20, ms: 9, text: JSON.stringify({ name: "x", token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig12345678abcdef", n: 1 }) };
      }
      case "text": return { url: PAGE, title: "示例", total: 5, text: "你好，世界" };
      case "snapshot": return { url: PAGE, title: "示例", interactiveTotal: 1, interactiveVisible: 1, inViewShown: 1, items: [{ ref: "e1", t: "input", n: "搜索" }] };
      case "waitFor": return { ok: true, count: 1, ms: 5 };
      case "query": return [{ title: "第一条" }, { title: "第二条" }];
      default: throw new Error(`页面里没有 ${fn}`);
    }
  };
  child.stdout.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      const msg = JSON.parse(buf.subarray(4, 4 + len).toString("utf8"));
      buf = buf.subarray(4 + len);
      const a = msg.args ?? {};
      try {
        switch (msg.name) {
          case "tabs": reply(msg.id, { tabs: tabsList() }); break;
          case "openWindow": { log.windows++; const w = nextWin++; const tabId = 900 + w; anchors.set(w, tabId); reply(msg.id, { windowId: w, tabId }); break; }
          case "closeWindow": { anchors.delete(a.windowId); for (const [id, t] of runTabs) if (t.windowId === a.windowId) runTabs.delete(id); log.closed.push(`w${a.windowId}`); reply(msg.id, {}); break; }
          case "openTab": { const id = nextTab++; runTabs.set(id, { url: a.url, windowId: a.windowId }); log.opened.push(a.url); reply(msg.id, { tabId: id, windowId: a.windowId }); break; }
          case "goto": log.gotos.push(a); if (runTabs.has(a.tabId)) runTabs.get(a.tabId).url = a.url; reply(msg.id, { url: a.url, title: "示例", loaded: true }); break;
          case "activateTab": log.activated.push(a.tabId); reply(msg.id, {}); break;
          case "closeTab": log.closed.push(a.tabId); runTabs.delete(a.tabId); reply(msg.id, {}); break;
          case "call": reply(msg.id, { v: callPage(a.tabId, a.fn, a.args ?? []) }); break;
          default: send({ id: msg.id, error: { message: `未知操作 ${msg.name}` } });
        }
      } catch (e) { send({ id: msg.id, error: { message: String(e.message) } }); }
    }
  });
  const hello = (extra = {}) => send({ type: "hello", abi: 2, chromeVersion: "Chrome/e2e", extensionVersion: "0.3.0", ...extra });
  return { log, page, hello };
}

// ---- RPC：一条长连接 ----
let conn = null;
const pending = new Map();
function connect() {
  return new Promise((resolve, reject) => {
    const sock = net.connect(SOCK);
    let data = "";
    sock.on("connect", () => resolve(sock));
    sock.on("error", reject);
    sock.on("data", (c) => {
      data += c.toString();
      let nl;
      while ((nl = data.indexOf("\n")) >= 0) {
        const r = JSON.parse(data.slice(0, nl));
        data = data.slice(nl + 1);
        const p = pending.get(r.id);
        if (!p) continue;
        pending.delete(r.id);
        "error" in r ? p.reject(Object.assign(new Error(r.error.message), r.error)) : p.resolve(r.result);
      }
    });
  });
}
async function rpc(method, params) {
  conn ??= await connect();
  const id = String(Math.random());
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    conn.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
const run = (...argv) => rpc("run", { argv });
const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; for (;;) { try { if (await fn()) return; } catch {} if (Date.now() > end) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 25)); } };

const child = spawn(process.execPath, [RELAY], { env, stdio: ["pipe", "pipe", "pipe"], cwd: SRC });
child.stderr.on("data", (d) => { if (process.env.E2E_DEBUG) process.stderr.write(d); });
const ext = fakeExtension(child);
ext.hello();

await waitFor(() => fs.existsSync(SOCK));
await waitFor(async () => (await rpc("ping")).extension === true);
const ping = await rpc("ping");
assert.equal(ping.abi, 2);
assert.equal(typeof ping.build, "string");
console.log("ping ok");

// 第二个 daemon：扩展通道 socket 活着，应当直接退出，不覆盖
const second = spawn(process.execPath, [path.join(SRC, "holder.ts")], { env, stdio: ["pipe", "pipe", "pipe"], cwd: SRC });
assert.equal(await new Promise((r) => second.on("exit", r)), 0, "已有活的 holder 时，新 holder 应退出");
console.log("singleton ok");

// 用户自己的页面消息进日志；请求带 token，真值只在内存里
const P = (msg) => ext.page(77, msg);
P({ k: "net", via: "fetch", id: 1, rid: "dz:1", method: "GET", url: `${PAGE}api/x?page=1&access_token=${SECRET}`, reqHeaders: { "x-token": SECRET, authorization: `Bearer ${SECRET}` }, status: 200, ct: "application/json", body: "{\"v\":1}", size: 7 });
P({ k: "net", via: "fetch", id: 2, rid: "dz:2", method: "POST", url: `${PAGE}api/save`, reqHeaders: { "content-type": "application/json" }, reqBody: "{\"a\":1}", status: 200, ct: "application/json", body: "{}", size: 2 });
await waitFor(async () => (await run("log")).stdout.includes("/api/save"));
const log = (await run("log")).stdout;
assert.match(log, /GET \/api\/x\?page=1&access_token=⟨secret_[0-9a-f]{12}:\w+⟩ 200/);
assert.ok(!log.includes(SECRET), "日志里没有真值");
assert.match((await run("tabs")).stdout, /^1 个标签页\ntab77 win1 前台 https:\/\/example\.com\/ "示例"$/, "tabs 只列用户自己的页面");

// Chef 没有调试权限；learn 发票据；Cook 带票据在自己的 agent 窗口里调试，不动用户的 tab77
let r = await run("debug", "open", PAGE);
assert.equal(r.code, 1); assert.match(r.stdout, /Chef 没有调试权限/);
r = await run("learn", "search-demo", "--goal", "搜索演示", "--site", "example.com");
assert.equal(r.code, 0, r.stdout);
const tk = /票据：(t-[0-9a-f]+)/.exec(r.stdout)[1];
r = await run("debug", "--ticket", tk, "open", PAGE + "search?q=1");
assert.equal(r.code, 0, r.stdout);
assert.equal(ext.log.windows, 1, "第一次调试才开一个 agent 窗口（带 anchor）");
assert.deepEqual(ext.log.opened, [PAGE.slice(0, -1) + "/robots.txt"], "暖页面是 robots.txt，很轻");
assert.ok(ext.log.gotos.some((g) => g.url === PAGE + "search?q=1" && g.wait === true && g.tabId === 100), "在 agent 窗口的标签页里导航并等加载");
assert.ok(!ext.log.calls.some((c) => c.tab === 77), "没有碰用户的 tab77");
assert.match((await run("debug", "--ticket", tk, "snapshot")).stdout, /tab100 [\s\S]*@e1 input "搜索"/);
assert.match((await run("debug", "--ticket", tk, "text")).stdout, /你好，世界/);
r = await run("debug", "--ticket", tk, "act", "fill", "@e1", "你好世界");
assert.equal(r.code, 0, r.stdout); assert.match(r.stdout, /✓ fill 持久定位 \{"role":"searchbox","name":"搜索"\}/);
assert.deepEqual(ext.log.calls.at(-1).args[0], { kind: "fill", ref: "@e1", text: "你好世界" }, "文字原样交给页面");
P({ k: "ev", type: "click", trusted: true, target: { tag: "button", text: "取消", sel: "#no" } });
await waitFor(async () => (await run("log", "--src", "human")).stdout.includes("human click button[取消]"));
const agentLog = (await run("log", "--src", "agent", "--all")).stdout;
assert.match(agentLog, /agent cmd goto/); assert.match(agentLog, /agent cmd fill/);
assert.match((await run("tabs")).stdout, /^1 个标签页/, "agent 窗口里的页面不算用户的标签页");
console.log("learn/debug ok");

// 重放（请求优先）：原始内容在 holder 内存里，--set 里可以写别名；在 run 窗口里发，不碰用户的页面
const alias = /access_token=(⟨secret_[0-9a-f]{12}:\w+⟩)/.exec(log)[1];
r = await run("debug", "--ticket", tk, "replay", "1", "--set", "page=2", "--set", `header.x-token2=${alias}`);
assert.equal(r.code, 0, r.stdout); assert.match(r.stdout, /✓ 重放 #1/);
const sent = ext.log.calls.filter((c) => c.fn === "replay").at(-1).args[0];
assert.equal(new URL(sent.url).searchParams.get("page"), "2");
assert.equal(sent.headers["x-token"], SECRET, "原始请求头里的真值原样带上");
assert.equal(sent.headers["x-token2"], SECRET, "别名换成了真值");
assert.ok(!ext.log.calls.some((c) => c.tab === 77), "仍然没碰用户的 tab77");
assert.match(r.stdout, /JSON 对象，字段：name, token, n/);
assert.doesNotMatch(r.stdout, /eyJhbGciOiJIUzI1NiJ9\.eyJzdWIiOiIxIn0/, "响应里的 token 在预览里是别名");
r = await run("debug", "--ticket", tk, "replay", "2");
assert.equal(r.code, 1); assert.match(r.stdout, /--yes/);
assert.match((await run("req", "find", "\"v\": 1")).stdout, /1 处有/);
console.log("replay ok");

// task 运行时：worker 里跑 SDK，同站点复用 run 窗口里的标签页；请求头继承页面自己发过的（authorization 真值只在内存）
const tasks = path.join(HOME, ".tabbot", "task");
fs.writeFileSync(path.join(tasks, "lookup.js"), `/**
 * @summary 查一个词
 * @param q 查询词
 * @param n? 条数
 */
import { tabbot, request, goto, query, click, serializeUrl } from "../task/lib/index.js";
await tabbot.run(async ({ page }) => {
  const res = await request(page, { url: serializeUrl({ bareUrl: "${PAGE}api/x", query: { q: tabbot.params.q } }) });
  if (!res.ok) throw new Error("请求失败 " + res.status);
  const body = res.json();
  return { n: body.n, q: tabbot.params.q, count: Number(tabbot.params.n ?? 1) };
});
`);
fs.writeFileSync(path.join(tasks, "dom.js"), `/**
 * @summary 页面操作
 */
import { tabbot, goto, click, query, waitFor, text } from "../task/lib/index.js";
await tabbot.run(async ({ page }) => {
  await goto(page, "${PAGE}list");
  await waitFor(page, "article");
  await click(page, { role: "button", name: "更多" });
  return { items: await query(page, { css: "article", fields: { title: "h2" } }), text: (await text(page)).text };
});
`);
fs.writeFileSync(path.join(tasks, "boom.js"), `/**\n * @summary 失败\n */\nimport { tabbot, request } from "../task/lib/index.js";\nawait tabbot.run(async ({ page }) => { await request(page, { url: "${PAGE}api/x", method: "NOPE", inherit: true }); throw new Error("故意失败"); });\n`);
fs.writeFileSync(path.join(tasks, "slow.js"), `/**\n * @summary 很慢\n * @timeout 1\n */\nimport { tabbot, sleep } from "../task/lib/index.js";\nawait tabbot.run(async () => { await sleep(5000); });\n`);
const openedBefore = ext.log.opened.length;
r = await run("run", "lookup", "--q", "你好");
assert.equal(r.code, 0, r.stdout);
assert.deepEqual(JSON.parse(r.stdout), { mode: "执行", status: "success", result: { n: 1, q: "你好", count: 1 } });
const lookupCall = ext.log.calls.filter((c) => c.fn === "replay").at(-1);
assert.equal(lookupCall.args[0].headers.authorization, `Bearer ${SECRET}`, "继承了用户页面自己发过的 authorization");
assert.equal(new URL(lookupCall.args[0].url).searchParams.get("q"), "你好");
assert.ok(lookupCall.tab >= 100, "在 run 窗口里发的");
const openedAfterFirst = ext.log.opened.length;
r = await run("run", "lookup", "--q", "再来一次", "--n", "3");
assert.equal(JSON.parse(r.stdout).result.count, 3);
assert.equal(ext.log.opened.length, openedAfterFirst, "第二次运行复用池里的标签页，不再开新的");
assert.equal(openedAfterFirst - openedBefore <= 1, true);
r = await run("run", "lookup");
assert.equal(r.code, 1); assert.match(JSON.parse(r.stdout).error, /缺少必填参数：--q/);
r = await run("run", "lookup", "--zzz", "1", "--q", "a");
assert.match(JSON.parse(r.stdout).error, /没有这些参数/);
r = await run("run", "dom");
assert.equal(r.code, 0, r.stdout);
assert.deepEqual(JSON.parse(r.stdout).result.items, [{ title: "第一条" }, { title: "第二条" }]);
assert.ok(ext.log.calls.some((c) => c.fn === "act" && c.args[0].kind === "click" && c.args[0].loc.role === "button"), "click 带着持久定位交给页面");
r = await run("run", "boom");
assert.equal(r.code, 1); assert.equal(JSON.parse(r.stdout).status, "failure"); assert.match(JSON.parse(r.stdout).error, /故意失败|NOPE/);
r = await run("run", "slow");
assert.equal(r.code, 1); assert.match(JSON.parse(r.stdout).error, /超过 1 秒未结束/);
r = await run("compose", 'const a = await task("lookup", { q: "组合" }); return { got: a.q, n: a.n };');
assert.equal(r.code, 0, r.stdout); assert.deepEqual(JSON.parse(r.stdout).result, { got: "组合", n: 1 });
r = await run("run", "nope");
assert.match(JSON.parse(r.stdout).error, /task 不存在/);
assert.ok(fs.readdirSync(path.join(HOME, ".tabbot", "run", "lookup")).length >= 2, "运行历史落盘");
console.log("task runtime ok");

// 强制机制：compose 只能组合；--dry 不真发；真跑成功自动晋升；@endpoint 覆盖标记；两个 Cook 各自的窗口并行
const libPath = path.join(HOME, ".tabbot", "task", "lib", "index.js");
r = await run("compose", `const m = await import(${JSON.stringify(libPath)}); await m.goto(null, "${PAGE}"); return 1;`);
assert.equal(r.code, 1); assert.match(JSON.parse(r.stdout).error, /compose 里只能组合 task/);
fs.writeFileSync(path.join(tasks, "poster.js"), `/**\n * @summary 发一个 POST\n * @status: draft\n * @endpoint POST /api/save\n */\nimport { tabbot, request } from "../task/lib/index.js";\nawait tabbot.run(async ({ page }) => { const r = await request(page, { method: "POST", url: "${PAGE}api/save", json: { a: 1 } }); return { status: r.status }; });\n`);
const replaysBefore = ext.log.calls.filter((c) => c.fn === "replay").length;
r = await run("run", "poster", "--dry");
assert.equal(r.code, 0, r.stdout); const dry = JSON.parse(r.stdout);
assert.equal(dry.mode, "试运行"); assert.match(dry.dry[0], /^POST http:\/\/|^POST https:\/\/example\.com\/api\/save \{"a":1\}/);
assert.equal(ext.log.calls.filter((c) => c.fn === "replay").length, replaysBefore, "试运行没有真的发出去");
assert.match(fs.readFileSync(path.join(tasks, "poster.js"), "utf8"), /@status: draft/, "试运行不晋升");
r = await run("run", "poster");
assert.equal(r.code, 0, r.stdout);
assert.equal(ext.log.calls.filter((c) => c.fn === "replay").length, replaysBefore + 1);
assert.match(fs.readFileSync(path.join(tasks, "poster.js"), "utf8"), /@status: verified/, "真跑成功自动晋升");
const apiLines = (await run("api", "example.com")).stdout.split("\n");
const iGet = apiLines.findIndex((l) => /^GET .*\/api\/x/.test(l)), iPost = apiLines.findIndex((l) => /^POST .*\/api\/save/.test(l));
assert.ok(iGet >= 0 && iPost > iGet, "没有 task 覆盖的接口排在前面");
assert.match(apiLines[iPost], /task:poster/);
const windowsBefore = ext.log.windows;
const [ca, cb] = await Promise.all([run("learn", "par-a", "--goal", "a", "--site", "example.com"), run("learn", "par-b", "--goal", "b")]);
const ta = /票据：(t-[0-9a-f]+)/.exec(ca.stdout)[1], tb = /票据：(t-[0-9a-f]+)/.exec(cb.stdout)[1];
assert.match((await run("learn", "par-c", "--goal", "c", "--site", "example.com")).stdout, /最多 2 个同时/, "同一站点最多 2 个 Cook");
await Promise.all([run("debug", "--ticket", ta, "open", PAGE + "a"), run("debug", "--ticket", tb, "open", PAGE + "b")]);
assert.equal(ext.log.windows - windowsBefore, 2, "两个 Cook 各有自己的 agent 窗口");
const winOf = (url) => { const g = ext.log.gotos.find((x) => x.url === url); return g.tabId; };
assert.notEqual(winOf(PAGE + "a"), winOf(PAGE + "b"));
console.log("enforcement ok");

// CLI：真实命令行 → holder（holder 已经在跑）
const cli = (...args) => spawnSync(process.execPath, [path.join(SRC, "cli", "tabbot.ts"), ...args], { env, encoding: "utf8", timeout: 30_000 });
const viaCli = cli("log", "--src", "human");
assert.equal(viaCli.status, 0, viaCli.stdout + viaCli.stderr); assert.equal(viaCli.stderr, ""); assert.match(viaCli.stdout, /human click button\[取消\]/);
assert.equal(cli("log", "--src", "nobody").status, 1);
console.log("cli ok");

// 整个 ~/.tabbot 里任何文件都没有 token 真值（日志库、响应体、快照、日志文件）
function scan(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) scan(f);
    else if (e.isFile()) assert.ok(!fs.readFileSync(f).includes(SECRET), `${f} 里不该有真值`);
  }
}
await rpc("run", { argv: ["status"] });
scan(path.join(HOME, ".tabbot"));
console.log("no secrets on disk ok");

// relay 断开：daemon 还在，ping.extension 为 false；命令说清楚缺什么
const daemonPid = ping.pid;
child.stdin.end(); // Chrome 退出 = relay stdin 关闭
await new Promise((r2) => child.on("exit", r2));
await waitFor(async () => (await rpc("ping")).extension === false);
assert.equal(fs.existsSync(SOCK), true, "relay 退出后 daemon 应仍在运行");
assert.match((await run("log")).stdout, /human click/, "读日志不需要扩展");
r = await run("tabs");
assert.equal(r.code, 1); assert.match(r.stdout, /need-(install|chrome|extension)/);
console.log("relay exit keeps daemon ok");

// 旧版扩展（没有 ABI 2）：连上了，但命令告诉用户去刷新
const relay2 = spawn(process.execPath, [RELAY], { env, stdio: ["pipe", "pipe", "pipe"], cwd: SRC });
fakeExtension(relay2);
relay2.stdin.write(frame({ type: "hello", abi: 1, chromeVersion: "Chrome/old" }));
await waitFor(async () => (await rpc("ping")).extension === true);
assert.equal((await rpc("ping")).pid, daemonPid, "重连后 daemon pid 不变");
r = await run("tabs");
assert.equal(r.code, 1); assert.match(r.stdout, /扩展是旧版本.*刷新 TabBot 扩展/);
console.log("old extension ok");
relay2.stdin.end();
await new Promise((r2) => relay2.on("exit", r2));

// SIGTERM 走 shutdown：退出后 socket 文件被清掉（tabbot daemon restart 就是按 pid 发这个信号）
process.kill(daemonPid, "SIGTERM");
await waitFor(async () => !fs.existsSync(SOCK));
assert.equal(fs.existsSync(path.join(SESSION, "ext.sock")), false, "daemon 退出后扩展 socket 应被删除");
console.log("shutdown ok");
console.log("E2E OK");
conn?.destroy();
fs.rmSync(HOME, { recursive: true, force: true });
