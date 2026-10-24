// 端到端：relay 作为 native host 运行（拉起 daemon），一个假扩展经 stdio 实现 ABI（register / exec / tabs / goto）并模拟页面；
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

/** 假扩展 + 假页面：实现 ABI，exec 时按表达式模拟页面的回应（经 page 消息发回 res）。 */
function fakeExtension(child, { userScripts = true } = {}) {
  const log = { registered: [], execs: [], gotos: [] };
  let buf = Buffer.alloc(0);
  const send = (obj) => child.stdin.write(frame(obj));
  const reply = (id, result) => send({ id, result });
  const page = (tab, msg) => send({ type: "page", tab, frame: 0, top: true, page: PAGE, msg: { __tcrl: 1, t: Date.now(), ...msg } });
  const respond = (tab, uid, v) => setTimeout(() => page(tab, { k: "res", u: uid, ok: true, v }), 5);
  child.stdout.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      const msg = JSON.parse(buf.subarray(4, 4 + len).toString("utf8"));
      buf = buf.subarray(4 + len);
      const a = msg.args ?? {};
      switch (msg.name) {
        case "register": log.registered.push(a.scripts.map((s) => s.id)); reply(msg.id, { scripts: a.scripts.length }); break;
        case "tabs": reply(msg.id, { tabs: [{ tabId: 77, windowId: 1, active: true, url: PAGE, title: "示例", status: "complete" }] }); break;
        case "goto": log.gotos.push(a); reply(msg.id, {}); break;
        case "exec": {
          log.execs.push(a.code);
          reply(msg.id, {});
          const uid = /const u="([^"]+)"/.exec(a.code)[1];
          if (a.code.includes("exec.act(")) respond(a.tabId, uid, { ok: true, target: { tag: "input", text: "搜索" }, chars: 4, settle: { settled: true, waitedMs: 150 }, url: PAGE, title: "示例" });
          else if (a.code.includes("exec.replay(")) respond(a.tabId, uid, { ok: true, status: 200, ct: "application/json", size: 20, ms: 9, text: JSON.stringify({ name: "x", token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig12345678abcdef" }) });
          else if (a.code.includes("exec.text(")) respond(a.tabId, uid, { url: PAGE, title: "示例", total: 5, text: "你好，世界" });
          else if (a.code.includes("exec.snapshot(")) respond(a.tabId, uid, { url: PAGE, title: "示例", interactiveTotal: 1, interactiveVisible: 1, inViewShown: 1, items: [{ ref: "e1", t: "input", n: "搜索" }] });
          break;
        }
        default: send({ id: msg.id, error: { message: `未知操作 ${msg.name}` } });
      }
    }
  });
  const hello = (extra = {}) => send({ type: "hello", abi: 1, chromeVersion: "Chrome/e2e", extensionVersion: "0.2.0", userScripts, ...extra });
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
assert.equal(ping.abi, 1); assert.equal(ping.userScripts, true);
assert.equal(typeof ping.build, "string");
await waitFor(() => ext.log.registered.length === 1);
assert.deepEqual(ext.log.registered[0], ["tabbot-page", "tabbot-bridge"], "扩展连上后 holder 下发页面脚本");
console.log("ping + register ok");

// 第二个 daemon：扩展通道 socket 活着，应当直接退出，不覆盖
const second = spawn(process.execPath, [path.join(SRC, "holder.ts")], { env, stdio: ["pipe", "pipe", "pipe"], cwd: SRC });
assert.equal(await new Promise((r) => second.on("exit", r)), 0, "已有活的 holder 时，新 holder 应退出");
console.log("singleton ok");

// 页面消息进日志：人的点击撤销租约；agent 的 DOM 事件记成 page；请求带 token，真值只在内存里
const P = (msg) => ext.page(77, msg);
P({ k: "net", via: "fetch", id: 1, rid: "dz:1", method: "GET", url: `${PAGE}api/x?page=1&access_token=${SECRET}`, reqHeaders: { "x-token": SECRET }, status: 200, ct: "application/json", body: "{\"v\":1}", size: 7 });
P({ k: "net", via: "fetch", id: 2, rid: "dz:2", method: "POST", url: `${PAGE}api/save`, reqHeaders: { "content-type": "application/json" }, reqBody: "{\"a\":1}", status: 200, ct: "application/json", body: "{}", size: 2 });
await waitFor(async () => (await run("log")).stdout.includes("/api/save"));
const log = (await run("log")).stdout;
assert.match(log, /GET \/api\/x\?page=1&access_token=⟨secret_[0-9a-f]{12}:\w+⟩ 200/);
assert.ok(!log.includes(SECRET), "日志里没有真值");

// tabs / snapshot / text 经假页面
assert.match((await run("tabs")).stdout, /^1 个标签页\ntab77 win1 前台 https:\/\/example\.com\/ "示例"/);
assert.match((await run("snapshot")).stdout, /@e1 input "搜索"/);
assert.match((await run("text")).stdout, /你好，世界/);

// 租约与动作
let r = await run("act", "click", "@e1");
assert.equal(r.code, 1, r.stdout); assert.match(r.stdout, /没有持有租约的标签页/);
r = await run("act", "click", "@e1", "--tab", "77");
assert.equal(r.code, 1); assert.match(r.stdout, /没有租约/);
r = await run("takeover");
assert.equal(r.code, 0, r.stdout); assert.match(r.stdout, /已获取 tab77 的租约/);
r = await run("act", "fill", "@e1", "你好世界");
assert.equal(r.code, 0, r.stdout); assert.match(r.stdout, /^✓ fill @e1/);
assert.ok(ext.log.execs.at(-1).includes("\"text\":\"你好世界\""), "文字原样交给页面");
// 真人输入：isTrusted 的点击立刻撤销租约；agent 的 DOM 事件（isTrusted 为假）不会
P({ k: "ev", type: "click", trusted: false, target: { tag: "button", text: "提交", sel: "#go" } });
await waitFor(async () => (await run("log", "--src", "page")).stdout.includes("click button[提交]"));
assert.match((await run("act", "click", "@e1")).stdout, /^✓ click @e1/, "DOM 事件不撤销租约");
P({ k: "ev", type: "click", trusted: true, target: { tag: "button", text: "取消", sel: "#no" } });
await waitFor(async () => (await run("act", "click", "@e1", "--tab", "77")).code === 1);
assert.match((await run("log", "--src", "human")).stdout, /human click button\[取消\]/);
assert.match((await run("log", "--all", "-n", "100")).stdout, /human lease revoked \(click\)/);
// 输入的文字不进日志，只有字数
const all = (await run("log", "--all", "-n", "200")).stdout;
assert.ok(!all.includes("你好世界") && /cmd fill/.test(all), "命令记录在，文字不在");
console.log("takeover/act ok");

// 重放：原始内容在 holder 内存里，--set 里可以写别名；页面里发的是真值
const alias = /access_token=(⟨secret_[0-9a-f]{12}:\w+⟩)/.exec(log)[1];
r = await run("replay", "1", "--set", "page=2", "--set", `header.x-token2=${alias}`);
assert.equal(r.code, 0, r.stdout); assert.match(r.stdout, /^✓ 重放 #1/);
const sent = JSON.parse(ext.log.execs.at(-1).match(/exec\.replay\((\{.*\})\)\)\)\.then\(\(v\)/s)[1]);
assert.equal(new URL(sent.url).searchParams.get("page"), "2");
assert.equal(sent.headers["x-token"], SECRET, "原始请求头里的真值原样带上");
assert.equal(sent.headers["x-token2"], SECRET, "别名换成了真值");
assert.match(r.stdout, /JSON 对象，字段：name, token/);
assert.doesNotMatch(r.stdout, /eyJhbGciOiJIUzI1NiJ9\.eyJzdWIiOiIxIn0/, "响应里的 token 在预览里是别名");
r = await run("replay", "2");
assert.equal(r.code, 1); assert.match(r.stdout, /--yes/);
assert.match((await run("req", "find", "\"v\": 1")).stdout, /1 处有/);
console.log("replay ok");

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

// 旧版扩展（没有 ABI）：连上了，但命令告诉用户去刷新；开关没开：告诉用户去打开
const relay2 = spawn(process.execPath, [RELAY], { env, stdio: ["pipe", "pipe", "pipe"], cwd: SRC });
const old = fakeExtension(relay2);
relay2.stdin.write(frame({ type: "hello", protocolVersion: 1, chromeVersion: "Chrome/old" }));
await waitFor(async () => (await rpc("ping")).extension === true);
assert.equal((await rpc("ping")).pid, daemonPid, "重连后 daemon pid 不变");
r = await run("tabs");
assert.equal(r.code, 1); assert.match(r.stdout, /扩展是旧版本.*刷新 TabBot 扩展/);
relay2.stdin.end();
await new Promise((r2) => relay2.on("exit", r2));
await waitFor(async () => (await rpc("ping")).extension === false);
const relay3 = spawn(process.execPath, [RELAY], { env, stdio: ["pipe", "pipe", "pipe"], cwd: SRC });
const noScripts = fakeExtension(relay3, { userScripts: false });
noScripts.hello();
await waitFor(async () => (await rpc("ping")).extension === true);
r = await run("tabs");
assert.equal(r.code, 1); assert.match(r.stdout, /允许用户脚本/);
assert.equal(old.log.registered.length, 0);
console.log("old extension / no user scripts ok");
relay3.stdin.end();
await new Promise((r2) => relay3.on("exit", r2));

// SIGTERM 走 shutdown：退出后 socket 文件被清掉（tabbot daemon restart 就是按 pid 发这个信号）
process.kill(daemonPid, "SIGTERM");
await waitFor(async () => !fs.existsSync(SOCK));
assert.equal(fs.existsSync(path.join(SESSION, "ext.sock")), false, "daemon 退出后扩展 socket 应被删除");
console.log("shutdown ok");
console.log("E2E OK");
conn?.destroy();
fs.rmSync(HOME, { recursive: true, force: true });
