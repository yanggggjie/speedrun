import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { RpcError, sessionRpc, SessionUnavailableError } from "./rpc.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tabbot-rpc-"));
const sock = path.join(dir, "sock");

type Request = { id: string; method: string };

// 假 holder：ping 回 pong；run 回错误（带 data.status）；utf8 把汉字拆在两个数据块里；overflow / drop 模拟断开。
const server = net.createServer((socket) => {
  let buf = "";
  socket.on("data", (chunk) => {
    buf += chunk;
    const nl = buf.indexOf("\n");
    if (nl < 0) return;
    const req = JSON.parse(buf.slice(0, nl)) as Request;
    buf = buf.slice(nl + 1);
    if (req.method === "utf8") {
      // 一个汉字的三个字节被拆在两个数据块里：按块 toString() 会把它变成替换字符
      const bytes = Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { text: "中文".repeat(10) } })}\n`);
      const cut = bytes.indexOf(Buffer.from("中")) + 1;
      socket.write(bytes.subarray(0, cut));
      setTimeout(() => socket.write(bytes.subarray(cut)), 20);
    } else if (req.method === "overflow") {
      // holder 在断开连接前先写一行没有 id 的错误，说明原因
      socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: "", error: { code: -32603, message: "队列超限" } })}\n`, () => socket.destroy());
    } else if (req.method === "drop") {
      socket.destroy();
    } else if (req.method === "run") {
      socket.end(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, error: { code: -32010, message: "guide", data: { status: "need-extension" } } })}\n`);
    } else {
      socket.end(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { text: "pong", pid: process.pid } })}\n`);
    }
  });
});

await new Promise<void>((resolve, reject) => {
  server.listen(sock, () => resolve());
  server.on("error", reject);
});

try {
  const res = await sessionRpc("ping", undefined, 2_000, sock) as { text: string; pid: number };
  assert.equal(res.text, "pong");
  assert.equal(res.pid, process.pid);

  // 错误回包：保留 code 与 data.status，握手判断依赖它
  await assert.rejects(sessionRpc("run", undefined, 2_000, sock), (error) =>
    error instanceof RpcError && error.code === -32010 && (error.data as { status: string }).status === "need-extension");

  // 汉字被拆在两个数据块里，内容不变
  assert.deepEqual(await sessionRpc("utf8" as never, undefined, 2_000, sock), { text: "中文".repeat(10) });

  // holder 说明了原因再断开：错误带这个原因，而不是笼统的"连接已关闭"
  await assert.rejects(sessionRpc("overflow" as never, undefined, 2_000, sock), /队列超限/);
  // 连接意外断开（没有说明）
  await assert.rejects(sessionRpc("drop" as never, undefined, 2_000, sock), /holder 连接已关闭/);
} finally {
  server.close();
}

// 连不上 holder：统一成 SessionUnavailableError
await assert.rejects(sessionRpc("ping", undefined, 2_000, path.join(dir, "missing.sock")), SessionUnavailableError);

fs.rmSync(dir, { recursive: true, force: true });
console.log("cli rpc selfcheck ok");
