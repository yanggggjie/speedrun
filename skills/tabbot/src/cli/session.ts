import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { sleep } from "../utils/async.ts";
import { SESSION_DIR, SESSION_SOCK, SESSION_SOCK_IS_FILE } from "../utils/constants.ts";
import { sessionRpc } from "./rpc.ts";

// holder 是本机常驻 daemon：relay（Chrome 拉起的 native host）或 CLI 在它不在时拉起它。
// 存活判据只有一条：socket 能不能回 ping。pid 文件只是 holder 自己留下的展示信息，不参与判断。

const HOLDER_ENTRY = fileURLToPath(new URL("../holder.ts", import.meta.url));
const SPAWN_WAIT_MS = 8_000;

/** extension：扩展链路是否接着。abi 来自扩展握手。 */
export type PingResult = {
  pid: number;
  extension: boolean;
  /** daemon 启动时部署目录的 build。 */
  build?: string;
  abi?: number;
};

/** 发一次 ping。连不上就返回 null——判据是 socket 本身，pid 文件丢了不影响。 */
export async function tryPing(): Promise<PingResult | null> {
  try {
    return (await sessionRpc("ping", undefined, 2_000)) as PingResult;
  } catch {
    return null;
  }
}

/** daemon 重启后等新 daemon 连上的最长时间：扩展按 1 秒起的指数退避重连，再加 relay 拉起 daemon 的时间。 */
const RESTART_WAIT_MS = 15_000;

export type RestartResult =
  | { action: "none" }
  | { action: "killed" }
  | { action: "restarted"; ping: PingResult }
  | { action: "failed" };

/**
 * 重启 holder：按 ping 里的 pid 发 SIGTERM（holder 收到后走 shutdown 再退出），不请求它自己退出。
 * 这样新旧 daemon 走同一条路，不依赖对方实现了哪个 RPC。
 * - 没有 holder：返回 none。
 * - 扩展没连着时新 daemon 要等扩展下次连接才会出现，只返回 killed，不等。
 */
export async function restartDaemon(options: { waitMs?: number } = {}): Promise<RestartResult> {
  const existing = await tryPing();
  if (!existing) return { action: "none" };
  try {
    process.kill(existing.pid, "SIGTERM");
  } catch {
    return { action: "none" }; // 刚好已经退出
  }
  if (!existing.extension) return { action: "killed" };
  const deadline = Date.now() + (options.waitMs ?? RESTART_WAIT_MS);
  while (Date.now() < deadline) {
    await sleep(200);
    const found = await tryPing();
    if (found && found.pid !== existing.pid && found.extension) return { action: "restarted", ping: found };
  }
  return { action: "failed" };
}

/** 确认 holder 在运行；不在就拉起它（读历史日志不应该依赖 Chrome 开着）。拉不起来抛错。 */
export async function ensureHolder(): Promise<PingResult> {
  const existing = await tryPing();
  if (existing) return existing;
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  if (SESSION_SOCK_IS_FILE && fs.existsSync(SESSION_SOCK)) fs.rmSync(SESSION_SOCK, { force: true }); // ping 不通的残留文件
  spawn(process.execPath, [HOLDER_ENTRY], { detached: true, stdio: "ignore" }).unref();
  const deadline = Date.now() + SPAWN_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(100);
    const found = await tryPing();
    if (found) return found;
  }
  throw new Error("holder 没有起来：看 ~/.tabbot/session/log.jsonl");
}

/** 把命令行参数原样交给 holder 执行，返回要打印的文本和退出码。 */
export async function runOnHolder(argv: string[]): Promise<{ stdout: string; code: number }> {
  await ensureHolder();
  return (await sessionRpc("run", { argv }, 10 * 60_000)) as { stdout: string; code: number };
}
