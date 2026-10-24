import * as net from "node:net";
import { timeoutReject } from "../utils/async.ts";
import { SESSION_SOCK } from "../utils/constants.ts";
import type { JsonRpcRequest, JsonRpcResponse, RpcMethod } from "../protocol.ts";

export class SessionUnavailableError extends Error {
  constructor(message = "没有可用 session") { super(message); this.name = "SessionUnavailableError"; }
}

export class RpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(code: number, message: string, data?: unknown) { super(message); this.name = "RpcError"; this.code = code; this.data = data; }
}

/** 一次请求：连接 holder 的 socket、发送一行 JSON-RPC、等回包、关闭。连不上 holder 时抛 SessionUnavailableError。 */
export async function sessionRpc(method: RpcMethod, params: Record<string, unknown> | undefined, ms: number, sock = SESSION_SOCK): Promise<unknown> {
  let socket: net.Socket | undefined;
  try {
    return await timeoutReject(new Promise<unknown>((resolve, reject) => {
      socket = net.connect({ path: sock });
      // 按 UTF-8 解码：一个汉字的三个字节可能被拆在两个数据块里，直接 chunk.toString() 会把它变成替换字符
      socket.setEncoding("utf8");
      const id = crypto.randomUUID();
      const request: JsonRpcRequest = { jsonrpc: "2.0", id, method, ...(params ? { params } : {}) };
      let buffer = "";
      socket.once("connect", () => socket!.write(`${JSON.stringify(request)}\n`));
      socket.on("error", reject);
      socket.on("close", () => reject(new Error("holder 连接已关闭")));
      socket.on("data", (chunk) => {
        buffer += String(chunk);
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (!line.trim()) continue;
          let message: JsonRpcResponse;
          try { message = JSON.parse(line) as JsonRpcResponse; } catch { reject(new Error("holder 返回无效 JSON")); return; }
          if (message.id !== id) {
            // 没有 id 的错误：holder 在断开连接前说明原因
            if (message.id === "" && "error" in message) reject(new RpcError(message.error.code, message.error.message, message.error.data));
            continue;
          }
          if ("error" in message) reject(new RpcError(message.error.code, message.error.message, message.error.data));
          else resolve(message.result);
        }
      });
    }), ms, method);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/ENOENT|ECONNREFUSED|EPIPE|not a socket/i.test(msg)) throw new SessionUnavailableError();
    throw err;
  } finally {
    socket?.destroy();
  }
}
