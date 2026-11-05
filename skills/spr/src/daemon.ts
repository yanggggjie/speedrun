import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import { StringDecoder } from "node:string_decoder";
import { ABI, ExtensionLink, frame, parseFrames, type TabInfo } from "./browser/extension.ts";
import { NeedExtensionError, handshakeError, missingStatus } from "./browser/connect.ts";
import { loadAdblockEngine } from "./record/filter.ts";
import { EndpointIndex } from "./record/endpoints.ts";
import { enforce } from "./record/retention.ts";
import { WindowLog } from "./record/windowlog.ts";
import { runCommand, type Ctx } from "./commands/index.ts";
import { RunHost } from "./browser/host.ts";
import { LearnWindows } from "./learn/windows.ts";
import { ActionRunner, runWindowsOf } from "./run/runner.ts";
import { coveredEndpoints, syncActionLib } from "./run/actions.ts";
import { AgentWindows, type GroupLabel } from "./browser/window.ts";
import { Ingestor, type PageMsg } from "./record/ingest.ts";
import { RawStore } from "./record/raw.ts";
import type { FiltersEngine } from "@ghostery/adblocker";
import { readVersion } from "./store/version.ts";
import { HANDSHAKE_GUIDES, RPC_ERRORS, handshakeStatusFromError, type JsonRpcRequest, type JsonRpcResponse } from "./protocol.ts";
import { ALIAS_SALT_FILE, DAEMON_IDLE_EXIT_MS, DAEMON_READY_MS, SESSION_DIR, DATA_HOME, SESSION_LOG, SESSION_SOCK } from "./utils/constants.ts";
import { GROUP_TITLE } from "./browser/window.ts";
import { OWNER_CHECK_MS, listenOwned, routeByRole, type Owned } from "./session/server.ts";
import { createLogger, setLogFile } from "./utils/logger.ts";

/**
 * daemon：本机常驻 daemon，唯一的大脑。收扩展推来的页面消息写日志，执行命令行发来的命令（agent 窗口、action 运行、查询都在这里）。
 * 扩展只是管道，CLI 只是把参数发过来、把文本打印出去。
 */
const logger = createLogger("daemon");
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

let shuttingDown = false;
/** 等后台关 run 窗口；build() 里接上 runner。 */
let drainRuns: () => Promise<void> = async () => {};
let owned: Owned | null = null;
let extSocket: net.Socket | null = null;
let lastActivity = Date.now();
/** 本 daemon 启动时部署目录的 build；doctor 拿它和磁盘上的对比，不一致时提示重启（spr daemon restart）。 */
const startupBuild = readVersion()?.build ?? "";
// 工作目录放在 ~/.speedrun：拉起 daemon 的 relay 在 ~/.speedrun/src 里，setup.js 重装时会清空重建 src，
// build 没变时 daemon 不重启，留在被删掉的目录里，之后 action 的 worker 取 cwd 会失败（ENOENT uv_cwd）
try { process.chdir(DATA_HOME); } catch { /* 目录不在：照旧 */ }

const link = new ExtensionLink();

function aliasSalt(): string {
  try { return fs.readFileSync(ALIAS_SALT_FILE, "utf8").trim(); } catch { /* 第一次 */ }
  const salt = randomBytes(24).toString("hex");
  fs.mkdirSync(DATA_HOME, { recursive: true });
  fs.writeFileSync(ALIAS_SALT_FILE, salt, { mode: 0o600 });
  return salt;
}
function warnCatch(label: string): (error: unknown) => void { return (error) => logger.warn(label, { err: error instanceof Error ? error.message : String(error) }); }

/** speedrun 组的标题都是「speedrun」：learn 组蓝色，run 组灰色。 */
function groupLabel(kind: string | undefined): GroupLabel {
  return { title: GROUP_TITLE, color: kind === "run" ? "grey" : "blue" };
}

/** daemon 的全部部件，启动时按依赖顺序一次建好（构造函数都不碰磁盘，除了别名的盐）。 */
function build() {
  const raw = new RawStore();
  const log = new WindowLog();
  const win = new AgentWindows(link, { label: (key) => groupLabel(log.kindOf(key)) });
  const index = new EndpointIndex({ coverage: (site) => coveredEndpoints(log.dir, site) });
  let adblock: FiltersEngine | undefined;
  const ingest = new Ingestor(log, { engine: () => adblock, aliasKey: aliasSalt(), raw, winOf: (tab) => win.winOf(tab), index });
  const host = new RunHost({ link, win, ingest, raw });
  const runner = new ActionRunner(host, {}, runWindowsOf(log, win));
  drainRuns = () => runner.drain();
  const learn = new LearnWindows({ log, host, win });
  const ctx: Ctx = {
    ensureExtension,
    tabs: async () => ((await link.request("tabs")) as { tabs: TabInfo[] }).tabs,
    host, runner, win, learn, log, index, ingest, raw,
    daemon: () => ({ extension: extSocket !== null, pid: process.pid }),
  };
  return { ctx, setAdblock: (engine: FiltersEngine) => { adblock = engine; } };
}
const { ctx, setAdblock } = build();
const { ingest, index, log, learn, win } = ctx;

/** 页面消息：写日志。speedrun 组里的标签页记为那个窗口的（Ingestor 按 win.winOf 判断是哪个窗口）。扩展是旧版本时一条都不收。 */
link.on("page", (m) => {
  if (!link.compatible()) return;
  const inner = (m.msg ?? {}) as Record<string, unknown>;
  const msg = { ...inner, k: String(inner.k ?? ""), t: typeof inner.t === "number" ? inner.t : Date.now(), tab: Number(m.tab), frame: Number(m.frame ?? 0), top: m.top === true, page: typeof m.page === "string" ? m.page : undefined } as PageMsg;
  win.adopt(msg.tab, typeof m.group === "number" ? m.group : undefined); // 页面自己开的（扩展替它开在同一个组里）、用户拖进组的标签页也属于那个窗口
  lastActivity = Date.now();
  ingest.push(msg);
});

function pingBody() {
  return { pid: process.pid, extension: extSocket !== null, build: startupBuild, abi: link.abi };
}

async function ensureExtension(): Promise<void> {
  if (!extSocket) {
    const status = missingStatus();
    if (status !== "need-extension") throw handshakeError(status);
    // Chrome 在运行且 host 已注册：扩展可能正在（重新）连接，等一会
    const deadline = Date.now() + DAEMON_READY_MS;
    while (!extSocket && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    if (!extSocket) throw new NeedExtensionError();
  }
  // 和磁盘上的版本比（不是 daemon 启动时的）：daemon 自己旧了也不会让扩展来回重新加载
  const disk = readVersion()?.build ?? "";
  if (link.outdated(disk)) {
    // 握手时已经发过 reload：等它带着新版本重连
    const deadline = Date.now() + DAEMON_READY_MS * 2;
    while (link.outdated(disk) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  }
  if (!link.compatible()) throw new Error(`Chrome 里的 speedrun 扩展是旧版本（ABI ${link.abi ?? "无"}，需要 ${ABI}）：请在 chrome://extensions 里刷新 speedrun 扩展`);
}

async function dispatch(req: JsonRpcRequest): Promise<unknown> {
  lastActivity = Date.now();
  if (req.method === "ping") return pingBody();
  if (req.method === "run") {
    const argv = req.params?.argv;
    if (!Array.isArray(argv) || !argv.every((x) => typeof x === "string")) throw Object.assign(new Error("run 需要字符串数组 argv"), { code: RPC_ERRORS.INVALID_PARAMS });
    ingest.flush();
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

/** 新连接：第一行是角色说明，按它分给 CLI 或 relay。 */
function onConnection(socket: net.Socket): void {
  routeByRole(socket, { cli: onCli, relay: onRelay });
}

/** CLI：一行一个 JSON-RPC 请求，一行一个应答。 */
function onCli(socket: net.Socket, rest: Buffer): void {
  const decoder = new StringDecoder("utf8"); // 一个汉字的字节可能被拆在两个数据块里，按字节拼接会变成替换字符
  let buffer = "";
  const write = (message: JsonRpcResponse): void => {
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES) { write({ jsonrpc: "2.0", id: message.id, error: { code: RPC_ERRORS.INTERNAL, message: "应答超过上限，缩小查询范围" } }); return; }
    if (!socket.destroyed) socket.write(line);
  };
  const feed = (chunk: Buffer): void => {
    buffer += decoder.write(chunk);
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
  };
  socket.on("data", feed);
  if (rest.length) feed(rest);
}

async function shutdown(code: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("daemon exit", { code });
  // 结果返回后 run 窗口在后台关：等它们关完，最多 2 秒，别留下 speedrun 的组
  await Promise.race([drainRuns().catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
  try { ingest.flush(); index.flush(); log.close(); } catch (error) { warnCatch("flush on exit")(error); }
  extSocket?.destroy();
  owned?.release(); // 只删 inode 还是自己的 socket 文件
  process.exit(code);
}

/** relay 连上来：同一时间只保留一个扩展链路，新的合法 hello 替换旧连接。 */
function onRelay(sock: net.Socket, rest: Buffer): void {
  let buffer: Buffer = Buffer.alloc(0);
  let helloDone = false;
  const feed = (chunk: Buffer): void => {
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
          logger.info("extension connected", { abi: link.abi, build: link.build });
          // 扩展是旧的（安装目录更新过）：让它从磁盘重新加载自己，重连后就是新的（不用用户去 chrome://extensions 点刷新）
          const disk = readVersion()?.build ?? "";
          if (link.outdated(disk)) { logger.info("extension outdated, reloading", { have: link.build, want: disk }); void link.request("reload").catch(() => {}); }
          return;
        }
        link.receive(msg);
      });
    } catch (error) {
      logger.error("扩展消息处理失败", error);
      sock.destroy();
    }
  };
  sock.on("data", feed);
  sock.on("close", () => {
    if (extSocket !== sock) return;
    extSocket = null;
    link.detach();
    win.forget();
    lastActivity = Date.now();
    logger.info("extension link closed");
  });
  sock.on("error", () => {});
  if (rest.length) feed(rest);
}

export async function runDaemon(): Promise<void> {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  setLogFile(SESSION_LOG);
  owned = await listenOwned(SESSION_SOCK, onConnection);
  if (!owned) { logger.warn("已有 daemon 在运行，本进程退出"); process.exit(0); }
  // socket 文件没了或被换掉：出现了另一个 daemon（或被手动删了），本进程退出（plan 第 5 条）
  owned.watch(() => { logger.warn("socket 文件不是自己的了，退出"); void shutdown(0); });
  log.open();
  try { syncActionLib(); } catch (error) { warnCatch("sync action lib")(error); }
  loadAdblockEngine().then(setAdblock).catch(warnCatch("adblock engine"));
  // 没有扩展连接、也没有命令请求超过 DAEMON_IDLE_EXIT_MS 就退出；下次需要时由 relay 或 CLI 重新拉起
  // 日志按窗口目录淘汰（run 窗口只留最近的；learn 窗口先只删响应体、页面和截图的旧文件，再删整个旧窗口；开着的和 endpoint 样本不动）
  // 这些定时任务等第一次 inode 检查通过后才开始：极端竞争下两个 daemon 可能并存最多 OWNER_CHECK_MS，
  // 被换掉的那个不能把另一个正开着的 learn 窗口当成已关，删掉里面的文件
  const retain = (): void => { try { enforce(log, { protect: () => index.protect(), isOpen: (w) => learn.get(w)?.open === true, changed: () => index.touchAll() }); } catch (error) { warnCatch("retention")(error); } };
  setTimeout(() => {
    if (!owned?.stillMine()) return;
    retain();
    setInterval(retain, 10_000).unref();
    // 空闲太久的 learn 窗口关掉 Chrome 窗口（句柄和目录保留）
    setInterval(() => { for (const w of learn.idle()) void learn.close(w).catch(warnCatch("close learn window")); }, 60_000).unref();
  }, OWNER_CHECK_MS + 100).unref();
  setInterval(() => { if (!extSocket && Date.now() - lastActivity > DAEMON_IDLE_EXIT_MS) void shutdown(0); }, 60_000).unref();
  process.on("SIGINT", () => void shutdown(0));
  process.on("SIGTERM", () => void shutdown(0));
  process.on("uncaughtException", (error) => { logger.error("uncaughtException", error); void shutdown(1); });
  process.on("unhandledRejection", (error) => { logger.error("unhandledRejection", error); void shutdown(1); });
  logger.info("daemon start", { pid: process.pid });
  await new Promise(() => {});
}

runDaemon().catch((error) => { logger.error("daemon start failed", error); process.exit(1); });
