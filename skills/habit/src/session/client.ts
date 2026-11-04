/**
 * 连 daemon 的一方（CLI 和 relay 共用）。plan 第 1、2、4、7 条：
 * - 只有一个 socket，连上后第一行说明角色：`{"role":"cli"}` / `{"role":"relay"}`。
 * - 连不上就拉起一次 daemon，再每 100ms 重试，最多 10 秒。
 * - 这里从不删 socket 文件：超时只说明 daemon 忙，不说明它死了；残留文件由新 daemon 自己判断、自己删。
 * - 停 daemon 只发 SIGTERM，然后等到 connect 不上为止；新的由下一个连接的人拉起。
 */
import { spawn } from "node:child_process";
import * as net from "node:net";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { sleep, timeoutReject } from "../utils/async.ts";
import { SESSION_SOCK } from "../utils/constants.ts";
import type { JsonRpcRequest, JsonRpcResponse, RpcMethod } from "../protocol.ts";
import { connectable } from "./server.ts";

const DAEMON_ENTRY = fileURLToPath(new URL("../daemon.ts", import.meta.url));
const CONNECT_WAIT_MS = 10_000;
const RETRY_MS = 100;

export type Role = "cli" | "relay";

/** daemon 的 ping：只是查信息，不用来判断 daemon 在不在（那个只看 connect）。 */
export type PingResult = {
  pid: number;
  extension: boolean;
  /** daemon 启动时部署目录的 build。 */
  build?: string;
  abi?: number;
};

function connectOnce(sock: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(sock);
    socket.once("connect", () => { socket.off("error", reject); resolve(socket); });
    socket.once("error", reject);
  });
}

/** 连 daemon 并写好角色说明。spawn 为 false 时只试一次，连不上就抛错（查状态的命令不该把 daemon 拉起来）。 */
export async function connectDaemon(role: Role, opts: { spawn?: boolean; sock?: string; waitMs?: number } = {}): Promise<net.Socket> {
  const sock = opts.sock ?? SESSION_SOCK;
  const deadline = Date.now() + (opts.waitMs ?? CONNECT_WAIT_MS);
  let spawned = false;
  for (;;) {
    try {
      const socket = await connectOnce(sock);
      socket.write(`${JSON.stringify({ role })}\n`);
      return socket;
    } catch (error) {
      if (opts.spawn === false || Date.now() > deadline) throw error;
      if (!spawned) {
        spawn(process.execPath, [DAEMON_ENTRY], { detached: true, stdio: "ignore" }).unref();
        spawned = true;
      }
      await sleep(RETRY_MS);
    }
  }
}

/** 一次 JSON-RPC：发一行请求，等 id 对得上的那一行应答。 */
export async function rpc(method: RpcMethod, params: Record<string, unknown> | undefined, ms: number, opts: { spawn?: boolean; sock?: string } = {}): Promise<unknown> {
  const socket = await connectDaemon("cli", opts);
  try {
    return await timeoutReject(new Promise<unknown>((resolve, reject) => {
      const id = crypto.randomUUID();
      const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) };
      // 一个汉字的三个字节可能被拆在两个数据块里，用 StringDecoder 拼
      const decoder = new StringDecoder("utf8");
      let buffer = "";
      socket.on("error", reject);
      socket.on("close", () => reject(new Error("daemon 连接已关闭")));
      socket.on("data", (chunk: Buffer) => {
        buffer += decoder.write(chunk);
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (!line.trim()) continue;
          let message: JsonRpcResponse;
          try { message = JSON.parse(line) as JsonRpcResponse; } catch { reject(new Error("daemon 返回无效 JSON")); return; }
          if (message.id !== id) continue;
          if ("error" in message) reject(new Error(message.error.message));
          else resolve(message.result);
        }
      });
      socket.write(`${JSON.stringify(request)}\n`);
    }), ms, method);
  } finally {
    socket.destroy();
  }
}

/** 查 daemon 的信息；不在或没应答就返回 null。不会拉起 daemon。 */
export async function ping(ms = 2_000): Promise<PingResult | null> {
  try {
    return (await rpc("ping", undefined, ms, { spawn: false })) as PingResult;
  } catch {
    return null;
  }
}

/** 把命令行参数原样交给 daemon 执行（daemon 不在就拉起），返回要打印的文本和退出码。 */
export async function runOnDaemon(argv: string[]): Promise<{ stdout: string; code: number }> {
  return (await rpc("run", { argv }, 10 * 60_000)) as { stdout: string; code: number };
}

export type StopResult = "none" | "stopped" | "timeout";

/** 停掉 daemon：ping 拿 pid，发 SIGTERM，等到 connect 不上为止。不等新的起来。 */
export async function stopDaemon(waitMs = 10_000, sock = SESSION_SOCK): Promise<StopResult> {
  const info = await ping(5_000);
  if (!info) return (await connectable(sock)) ? "timeout" : "none";
  try {
    process.kill(info.pid, "SIGTERM");
  } catch {
    return "none"; // 刚好已经退出
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (!(await connectable(sock))) return "stopped";
    await sleep(RETRY_MS);
  }
  return "timeout";
}
