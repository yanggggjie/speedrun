// 端到端：relay 作为 native host 运行（拉起 daemon），模拟扩展经 stdio 应答；CLI 侧经 Unix socket 发 RPC。
// 在临时 HOME 下运行，不碰真实 ~/.tabbot。由 npm test 调用。
import { spawn } from "node:child_process";
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

function frame(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

/** 模拟扩展：tab 状态 + 页面级 CDP 应答。 */
function fakeExtension(child) {
  const owned = new Map(); // tabId -> windowId
  const attached = new Set();
  const cdpLog = [];
  const held = new Set(); // 持有租约的 tab
  const acts = [];
  let nextId = 10;
  let buf = Buffer.alloc(0);
  const reply = (id, result) => child.stdin.write(frame({ id, result }));
  const fail = (id, message) => child.stdin.write(frame({ id, error: { message } }));
  child.stdout.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      const msg = JSON.parse(buf.subarray(4, 4 + len).toString("utf8"));
      buf = buf.subarray(4 + len);
      if (msg.op === "tab") {
        const a = msg.args ?? {};
        switch (msg.name) {
          case "openWindow": { const w = nextId++; const t = nextId++; owned.set(t, w); reply(msg.id, { windowId: w, tabId: t }); break; }
          case "openTab": { const t = nextId++; owned.set(t, a.windowId); reply(msg.id, { tabId: t }); break; }
          case "closeTab": owned.delete(a.tabId); reply(msg.id, {}); break;
          case "closeWindow": for (const [t, w] of owned) if (w === a.windowId) owned.delete(t); reply(msg.id, {}); break;
          case "listOwned": reply(msg.id, { tabs: [...owned].map(([tabId, windowId]) => ({ tabId, windowId, url: "about:blank" })) }); break;
          case "windowOf": owned.has(a.tabId) ? reply(msg.id, { windowId: owned.get(a.tabId), state: "normal" }) : fail(msg.id, "tab 不属于 tabbot"); break;
          case "attach": owned.has(a.tabId) ? (attached.add(a.tabId), reply(msg.id, {})) : fail(msg.id, "tab 不属于 tabbot"); break;
          case "detach": attached.delete(a.tabId); reply(msg.id, {}); break;
          // 常驻录制：范围、租约、在原页面上的动作（不要求 tab 由 tabbot 创建）
          case "setSites": reply(msg.id, { mode: a.mode, sites: a.sites, exclude: a.exclude }); break;
          case "siteTabs": reply(msg.id, { tabs: [{ tabId: 77, windowId: 1, active: true, url: "https://example.com/", title: "示例", lease: held.has(77), humanIdleMs: null }] }); break;
          case "leaseAcquire": held.add(a.tabId); child.stdin.write(frame({ type: "lease", tab: a.tabId, state: "acquired", t: Date.now() })); reply(msg.id, { granted: true }); break;
          case "leaseRelease": held.delete(a.tabId); child.stdin.write(frame({ type: "lease", tab: a.tabId, state: "released", reason: a.reason, t: Date.now() })); reply(msg.id, { released: true }); break;
          case "act":
            if (!held.has(a.tabId)) { reply(msg.id, { ok: false, rejected: "no-lease", humanIdleMs: 99999 }); break; }
            acts.push(a.cmd);
            reply(msg.id, { ok: true, target: { tag: "input", text: "搜索" }, chars: String(a.cmd.text ?? "").length, settle: { settled: true, waitedMs: 150 } });
            break;
          default: fail(msg.id, `未知操作 ${msg.name}`);
        }
      } else if (msg.op === "cdp") {
        cdpLog.push(msg.method);
        if (!owned.has(msg.tabId) || !attached.has(msg.tabId)) { fail(msg.id, `tab ${msg.tabId} 未 attach`); continue; }
        if (msg.method === "Runtime.evaluate") reply(msg.id, { result: { type: "number", value: 2 } });
        else if (msg.method === "Page.navigate") reply(msg.id, { frameId: "f1" });
        else reply(msg.id, {});
      }
    }
  });
  return { cdpLog, acts };
}

/** 一条长连接承载整个会话（run 状态绑定在连接上）。 */
let conn = null;
const pending = new Map();
const pushed = [];
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
        if (!r.id && r.method === "cdp.event") { pushed.push(r.params); continue; }
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
function closeRpc() { conn?.end(); conn = null; }

const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; for (;;) { try { if (await fn()) return; } catch {} if (Date.now() > end) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 50)); } };

const child = spawn(process.execPath, [RELAY], { env, stdio: ["pipe", "pipe", "pipe"], cwd: SRC });
child.stderr.on("data", (d) => { if (process.env.E2E_DEBUG) process.stderr.write(d); });
const ext = fakeExtension(child);
child.stdin.write(frame({ type: "hello", protocolVersion: 1, chromeVersion: "Chrome/e2e", buildId: "ext-build-1" }));

await waitFor(() => fs.existsSync(SOCK));
await waitFor(async () => (await rpc("ping")).chrome === "Chrome/e2e");
const ping = await rpc("ping");
assert.equal(ping.chrome, "Chrome/e2e", "hello 里的 chromeVersion 应回传到 ping");
assert.equal(ping.extension, true, "扩展链路接着时 ping.extension 为 true");
assert.equal(ping.mode, "idle", "空闲时 ping.mode 为 idle");
assert.equal(typeof ping.build, "string", "ping 带 daemon 的 build（开发时没有 .version，为空串）");
assert.equal(ping.extensionBuild, "ext-build-1", "hello 里的 buildId 回传到 ping.extensionBuild");
console.log("ping ok:", ping.chrome);

// 第二个 daemon：扩展通道 socket 活着，应当直接退出，不覆盖
const second = spawn(process.execPath, [path.join(SRC, "holder.ts")], { env, stdio: ["pipe", "pipe", "pipe"], cwd: SRC });
const code = await new Promise((r) => second.on("exit", r));
assert.equal(code, 0, "已有活的 holder 时，新 holder 应退出");
console.log("singleton ok");

const page = await rpc("run.begin");
assert.ok(page.pageId, "run.begin 返回 pageId");
console.log("run.begin ok, pageId=", page.pageId);
assert.equal((await rpc("ping")).mode, "run", "run 进行中 ping.mode 为 run");

// 页面事件推送：扩展上报的 tab 事件应按 pageId 推给当前 run
child.stdin.write(frame({ type: "event", tabId: Number(page.pageId), method: "Page.loadEventFired", params: { timestamp: 1 } }));
await waitFor(() => pushed.some((e) => e.sessionId === page.pageId && e.method === "Page.loadEventFired"));
console.log("page event pushed ok");

const value = await rpc("cdp.send", { pageId: page.pageId, method: "Runtime.evaluate", params: { expression: "1+1", returnByValue: true } });
assert.equal(value.result.value, 2);
console.log("page-level cdp ok");

await assert.rejects(
  rpc("cdp.send", { pageId: "nope", method: "Runtime.evaluate", params: {} }),
  /page 不存在/,
  "未知 page 应被拒绝",
);
console.log("unknown page refusal ok");

await rpc("run.end");
console.log("run.end ok");
closeRpc();

const rec = await rpc("record.start", { name: "e2e" });
console.log("record.start:", String(rec).slice(0, 120).replace(/\n/g, " "));
assert.equal((await rpc("ping")).mode, "record", "录制进行中 ping.mode 为 record");
await assert.rejects(rpc("run.begin"), (e) => e.data?.reason === "record", "录制进行中 run.begin 的 reason 是 record，SDK 不会等");
const stopped = await rpc("record.stop");
console.log("record.stop:", String(stopped).slice(0, 160).replace(/\n/g, " "));
const recordFiles = fs.existsSync(path.join(HOME, ".tabbot", "record")) ? fs.readdirSync(path.join(HOME, ".tabbot", "record")) : [];
console.log("record dir entries:", recordFiles);
closeRpc();

// abort 后进行中的录制目录应被清掉，不能留到 daemon 下次启动
await rpc("record.start", { name: "e2e-abort" });
await rpc("record.abort");
const recordingLeft = fs.existsSync(path.join(SESSION, "recording")) ? fs.readdirSync(path.join(SESSION, "recording")) : [];
assert.deepEqual(recordingLeft, [], "abort 后进行中的录制目录应被清掉");
console.log("record.abort cleanup ok");
closeRpc();

// 在原页面上操作：journal.lease / journal.act 经 holder 到扩展；动作写进日志（来源 agent），输入的文字不进日志
const noLease = await rpc("journal.act", { tabId: 77, cmd: { kind: "click", ref: "@e1" } });
assert.equal(noLease.rejected, "no-lease", "没有租约，扩展拒绝动作");
assert.equal((await rpc("journal.lease", { op: "acquire", tabId: 77 })).granted, true);
const acted = await rpc("journal.act", { tabId: 77, cmd: { kind: "fill", ref: "@e5", text: "你好世界" } });
assert.equal(acted.ok, true);
assert.equal(typeof acted.actSeq, "number", "返回动作那一行的 seq，CLI 用它找引发的请求");
assert.equal(ext.acts.at(-1).text, "你好世界", "文字原样交给扩展");
assert.equal((await rpc("journal.lease", { op: "release", tabId: 77, reason: "做完了" })).released, true);
const { readEvents } = await import(path.join(SRC, "journal", "query.ts"));
const journalDir = path.join(HOME, ".tabbot", "journal");
let rows;
await waitFor(async () => (rows = await readEvents({ dir: journalDir, all: true, limit: 50 })).some((r) => r.kind === "lease" && r.verb === "released"));
const kinds = rows.map((r) => `${r.src}:${r.kind}:${r.verb}`);
assert.ok(kinds.includes("agent:lease:acquired") && kinds.includes("agent:lease:released"), kinds.join(" "));
const fillRow = rows.find((r) => r.src === "agent" && r.verb === "fill" && r.target === "input[搜索]");
assert.ok(fillRow, "agent 的 fill 动作写进了日志，元素描述来自页面：" + JSON.stringify(rows));
assert.equal(fillRow.size, 4, "只记字数");
assert.ok(!JSON.stringify(rows).includes("你好世界"), "输入的文字不进日志");
assert.ok(rows.some((r) => r.src === "agent" && r.verb === "click" && JSON.parse(r.detail).rejected === "no-lease"), "被拒绝的动作也有记录");
console.log("journal lease/act ok");
closeRpc();

const daemonPid = ping.pid;
child.stdin.end(); // Chrome 退出 = relay stdin 关闭
await new Promise((r) => child.on("exit", r));
await new Promise((r) => setTimeout(r, 300));
assert.equal(fs.existsSync(SOCK), true, "relay 退出后 daemon 应仍在运行");
assert.equal((await rpc("ping")).extension, false, "relay 断开后 daemon 还在，但 ping.extension 为 false");
closeRpc();
console.log("relay exit keeps daemon ok; cdp methods seen:", ext.cdpLog.length);

// 扩展重连：新 relay 接入同一个 daemon，pid 不变，状态仍在
const relay2 = spawn(process.execPath, [RELAY], { env, stdio: ["pipe", "pipe", "pipe"], cwd: SRC });
fakeExtension(relay2);
relay2.stdin.write(frame({ type: "hello", protocolVersion: 1, chromeVersion: "Chrome/e2e2" }));
await waitFor(async () => (await rpc("ping")).chrome === "Chrome/e2e2");
assert.equal((await rpc("ping")).pid, daemonPid, "重连后 daemon pid 不变");
assert.equal((await rpc("ping")).extension, true, "重连后 ping.extension 恢复为 true");
console.log("reconnect keeps daemon ok");
relay2.stdin.end();
await new Promise((r) => relay2.on("exit", r));
closeRpc();

// SIGTERM 走 shutdown：退出后 socket 文件被清掉（tabbot daemon restart 就是按 pid 发这个信号）
process.kill(daemonPid, "SIGTERM");
await waitFor(async () => !fs.existsSync(SOCK));
assert.equal(fs.existsSync(path.join(SESSION, "ext.sock")), false, "daemon 退出后扩展 socket 应被删除");
console.log("shutdown ok");
console.log("E2E OK");
fs.rmSync(HOME, { recursive: true, force: true });
