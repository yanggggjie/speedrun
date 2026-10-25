import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import { ABI, ExtensionLink, frame, parseFrames } from "./browser/extension.ts";
import { NeedExtensionError, handshakeError, missingStatus } from "./browser/connect.ts";
import { loadAdblockEngine } from "./journal/filter.ts";
import { runCommand, type Ctx, type TabInfo } from "./journal/commands.ts";
import { RunHost, Session } from "./run/host.ts";
import { Tickets } from "./run/tickets.ts";
import { TaskRunner } from "./run/runner.ts";
import { syncTaskLib } from "./run/tasks.ts";
import { AgentWindows } from "./run/window.ts";
import { Ingestor, type PageMsg } from "./journal/ingest.ts";
import { RawStore } from "./journal/raw.ts";
import { JournalStore } from "./journal/store.ts";
import type { FiltersEngine } from "@ghostery/adblocker";
import { readVersion } from "./store/version.ts";
import { HANDSHAKE_GUIDES, RPC_ERRORS, handshakeStatusFromError, type JsonRpcRequest, type JsonRpcResponse } from "./protocol.ts";
import { HOLDER_IDLE_EXIT_MS, HOLDER_READY_MS, JOURNAL_ALIAS_SALT_FILE, JOURNAL_DIR, SESSION_DIR, SESSION_EXT_SOCK, SESSION_LOG, SESSION_SOCK, SESSION_SOCK_IS_FILE } from "./utils/constants.ts";
import { createLogger, setLogFile } from "./utils/logger.ts";

/**
 * holder：本机常驻 daemon，唯一的大脑。收扩展推来的页面消息写日志，执行命令行发来的命令（agent 窗口、task 运行、重放、查询都在这里）。
 * 扩展只是管道，CLI 只是把参数发过来、把文本打印出去。
 */
const logger = createLogger("holder");
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

let shuttingDown = false;
let server: net.Server | null = null;
let extServer: net.Server | null = null;
let extSocket: net.Socket | null = null;
let lastActivity = Date.now();
/** 本 daemon 启动时部署目录的 build；doctor 拿它和磁盘上的对比，不一致时提示重启（tabbot daemon restart）。 */
const startupBuild = readVersion()?.build ?? "";

const link = new ExtensionLink();
const win = new AgentWindows(link);
const raw = new RawStore();
let ingest: Ingestor | undefined;
let adblock: FiltersEngine | undefined;
let host: RunHost | undefined;
let runner: TaskRunner | undefined;
const tickets = new Tickets();
const sessions = new Map<string, Session>();

function aliasSalt(): string {
  try { return fs.readFileSync(JOURNAL_ALIAS_SALT_FILE, "utf8").trim(); } catch { /* 第一次 */ }
  const salt = randomBytes(24).toString("hex");
  fs.mkdirSync(JOURNAL_DIR, { recursive: true });
  fs.writeFileSync(JOURNAL_ALIAS_SALT_FILE, salt, { mode: 0o600 });
  return salt;
}
function warnCatch(label: string): (error: unknown) => void { return (error) => logger.warn(label, { err: error instanceof Error ? error.message : String(error) }); }

/** 页面消息：写日志。tabbot agent 窗口里的标签页记为 agent 的（Ingestor 按 win.isAgentTab 判断）。 */
link.on("page", (m) => {
  const inner = (m.msg ?? {}) as Record<string, unknown>;
  const msg = { ...inner, k: String(inner.k ?? ""), t: typeof inner.t === "number" ? inner.t : Date.now(), tab: Number(m.tab), frame: Number(m.frame ?? 0), top: m.top === true, page: typeof m.page === "string" ? m.page : undefined } as PageMsg;
  lastActivity = Date.now();
  ingest?.push(msg);
});

function pingBody() {
  return { pid: process.pid, extension: extSocket !== null, build: startupBuild, abi: link.abi };
}

async function ensureExtension(): Promise<void> {
  if (!extSocket) {
    const status = missingStatus();
    if (status !== "need-extension") throw handshakeError(status);
    // Chrome 在运行且 host 已注册：扩展可能正在（重新）连接，等一会
    const deadline = Date.now() + HOLDER_READY_MS;
    while (!extSocket && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    if (!extSocket) throw new NeedExtensionError();
  }
  if (!link.compatible()) throw new Error(`Chrome 里的 TabBot 扩展是旧版本（ABI ${link.abi ?? "无"}，需要 ${ABI}）：请在 chrome://extensions 里刷新 TabBot 扩展`);
}

async function listTabs(): Promise<TabInfo[]> {
  return ((await link.request("tabs")) as { tabs: TabInfo[] }).tabs;
}

const ctx: Ctx = {
  ensureExtension,
  tabs: listTabs,
  get host() { return host!; },
  get runner() { return runner!; },
  win,
  tickets,
  sessions,
  get ingest() { return ingest!; },
  get raw() { return raw; },
  daemon: () => ({ extension: extSocket !== null, pid: process.pid }),
};

async function dispatch(req: JsonRpcRequest): Promise<unknown> {
  lastActivity = Date.now();
  if (req.method === "ping") return pingBody();
  if (req.method === "run") {
    const argv = req.params?.argv;
    if (!Array.isArray(argv) || !argv.every((x) => typeof x === "string")) throw Object.assign(new Error("run 需要字符串数组 argv"), { code: RPC_ERRORS.INVALID_PARAMS });
    ingest?.flush();
    return runCommand(argv as string[], ctx);
  }
  throw Object.assign(new Error(`未知 method：${String(req.method)}`), { code: RPC_ERRORS.METHOD_NOT_FOUND });
}

function responseError(id: string, error: unknown): JsonRpcResponse {
  const status = handshakeStatusFromError(error);
  if (status) return { jsonrpc: "2.0", id, error: { code: RPC_ERRORS.HANDSHAKE, message: HANDSHAKE_GUIDES[status], data: { status } } };
  const value = error as { code?: number; data?: unknown };
  return { jsonrpc: "2.0", id, error: { code: typeof value?.code === "number" ? value.code : RPC_ERRORS.INTERNAL, message: error instanceof Error ? error.message : String(error), ...(value?.data === undefined ? {} : { data: value.data }) } };
}

/** CLI 连上来：一行一个 JSON-RPC 请求，一行一个应答。 */
function onConnection(socket: net.Socket): void {
  socket.setEncoding("utf8"); // 一个汉字的字节可能被拆在两个数据块里，按字节拼接会变成替换字符
  let buffer = "";
  const write = (message: JsonRpcResponse): void => {
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES) { write({ jsonrpc: "2.0", id: message.id, error: { code: RPC_ERRORS.INTERNAL, message: "应答超过上限，缩小查询范围" } }); return; }
    if (!socket.destroyed) socket.write(line);
  };
  socket.on("data", (chunk) => {
    buffer += chunk.toString();
    if (Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES) { write({ jsonrpc: "2.0", id: "", error: { code: RPC_ERRORS.INVALID_REQUEST, message: "RPC message too large" } }); socket.end(); return; }
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let req: JsonRpcRequest;
      try { req = JSON.parse(line) as JsonRpcRequest; } catch { write({ jsonrpc: "2.0", id: "", error: { code: RPC_ERRORS.PARSE, message: "Parse error" } }); continue; }
      if (req.jsonrpc !== "2.0" || typeof req.id !== "string" || typeof req.method !== "string") { write({ jsonrpc: "2.0", id: typeof req.id === "string" ? req.id : "", error: { code: RPC_ERRORS.INVALID_REQUEST, message: "Invalid Request" } }); continue; }
      void dispatch(req).then((result) => write({ jsonrpc: "2.0", id: req.id, result }), (error) => write(responseError(req.id, error)));
    }
  });
  socket.on("error", () => {});
}

async function shutdown(code: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("holder exit", { code });
  try { ingest?.flush(); } catch (error) { warnCatch("flush on exit")(error); }
  server?.close();
  extServer?.close();
  extSocket?.destroy();
  if (SESSION_SOCK_IS_FILE) { fs.rmSync(SESSION_SOCK, { force: true }); fs.rmSync(SESSION_EXT_SOCK, { force: true }); }
  process.exit(code);
}

/** 已有活的 daemon 在监听时返回 true：新 daemon 不应覆盖它。 */
function socketAlive(sock: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (SESSION_SOCK_IS_FILE && !fs.existsSync(sock)) { resolve(false); return; }
    const probe = net.connect(sock);
    const done = (ok: boolean): void => { probe.destroy(); resolve(ok); };
    probe.once("connect", () => done(true));
    probe.once("error", () => done(false));
    probe.setTimeout(500, () => done(false));
  });
}

/** 抢占 socket：EADDRINUSE 且对方还活着时返回 null，本进程应退出；残留文件则删掉后重试。 */
async function listenUnique(sock: string, onConn: (socket: net.Socket) => void): Promise<net.Server | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const srv = net.createServer(onConn);
    try {
      await new Promise<void>((resolve, reject) => { srv.once("error", reject); srv.listen(sock, () => { srv.off("error", reject); resolve(); }); });
      if (SESSION_SOCK_IS_FILE) fs.chmodSync(sock, 0o600);
      return srv;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || (await socketAlive(sock))) return null;
      if (SESSION_SOCK_IS_FILE) fs.rmSync(sock, { force: true });
    }
  }
  return null;
}

/** relay 连上来：同一时间只保留一个扩展链路，新连接替换旧连接。 */
function onRelay(sock: net.Socket): void {
  let buffer: Buffer = Buffer.alloc(0);
  let helloDone = false;
  sock.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    try {
      buffer = parseFrames(buffer, (msg) => {
        if (!helloDone) {
          if (msg.type !== "hello") return;
          // 只有合法 hello 才替换旧连接：单例探测等无效连接不能把正在用的扩展踢掉。
          const previous = extSocket;
          extSocket = sock;
          previous?.destroy();
          link.hello(msg);
          link.attach((out) => sock.write(frame(out)));
          helloDone = true;
          lastActivity = Date.now();
          logger.info("extension connected", { abi: link.abi });
          return;
        }
        link.receive(msg);
      });
    } catch (error) {
      logger.error("扩展消息处理失败", error);
      sock.destroy();
    }
  });
  sock.on("close", () => {
    if (extSocket !== sock) return;
    extSocket = null;
    link.detach();
    win.forget();
    lastActivity = Date.now();
    logger.info("extension link closed");
  });
  sock.on("error", () => {});
}

export async function runHolder(): Promise<void> {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  setLogFile(SESSION_LOG);
  extServer = await listenUnique(SESSION_EXT_SOCK, onRelay);
  if (!extServer) { logger.warn("已有 holder 在运行，本进程退出"); process.exit(0); }
  server = await listenUnique(SESSION_SOCK, onConnection);
  if (!server) { logger.warn("CLI socket 被占用，本进程退出"); extServer.close(); if (SESSION_SOCK_IS_FILE) fs.rmSync(SESSION_EXT_SOCK, { force: true }); process.exit(0); }
  const store = new JournalStore();
  await store.open();
  store.enforceCap();
  ingest = new Ingestor(store, { engine: () => adblock, aliasKey: aliasSalt(), raw, isAgentTab: (tab) => win.isAgentTab(tab) });
  host = new RunHost({ link, win, ingest, raw });
  runner = new TaskRunner(host);
  try { syncTaskLib(); } catch (error) { warnCatch("sync task lib")(error); }
  loadAdblockEngine().then((engine) => { adblock = engine; }).catch(warnCatch("adblock engine"));
  // 没有扩展连接、也没有命令请求超过 HOLDER_IDLE_EXIT_MS 就退出；下次需要时由 relay 或 CLI 重新拉起
  setInterval(() => { if (!extSocket && Date.now() - lastActivity > HOLDER_IDLE_EXIT_MS) void shutdown(0); }, 60_000).unref();
  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));
  process.on("uncaughtException", (error) => { logger.error("uncaughtException", error); void shutdown(1); });
  process.on("unhandledRejection", (error) => { logger.error("unhandledRejection", error); void shutdown(1); });
  logger.info("daemon start", { pid: process.pid });
  await new Promise(() => {});
}

runHolder().catch((error) => { logger.error("holder start failed", error); process.exit(1); });
