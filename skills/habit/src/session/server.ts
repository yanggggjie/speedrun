/**
 * daemon 对 socket 的所有权（plan 第 3、5、6 条）：
 * - listen 成功的就是唯一的 daemon；EADDRINUSE 时 connect 一下：连得上说明对方活着，自己让出；被拒绝说明是残留文件，删掉再 listen 一次。
 * - 只有 daemon 自己删 socket 文件，并且只删 inode 还是自己的那个。
 * - socket 文件没了或被换掉（inode 变了），说明出现了另一个 daemon，或者有人手动删了：调用方应当退出。
 * Windows 的 named pipe 不是文件，跟着进程消失，不需要 inode 检查。
 */
import * as fs from "node:fs";
import * as net from "node:net";

const IS_FILE = process.platform !== "win32";
export const OWNER_CHECK_MS = 2_000;

/** 能不能 connect 上：只看内核层的连接，对方事件循环卡住也连得上，所以不会把忙误判成死。 */
export function connectable(sock: string, ms = 500): Promise<boolean> {
  return new Promise((resolve) => {
    if (IS_FILE && !fs.existsSync(sock)) { resolve(false); return; }
    const probe = net.connect(sock);
    const done = (ok: boolean): void => { probe.destroy(); resolve(ok); };
    probe.once("connect", () => done(true));
    probe.once("error", () => done(false));
    probe.setTimeout(ms, () => done(false));
  });
}

export interface Owned {
  server: net.Server;
  /** socket 文件还在，并且还是自己 listen 出来的那个。 */
  stillMine(): boolean;
  /** 每 OWNER_CHECK_MS 检查一次 stillMine，不是自己的了就调 onLost（只调一次）。 */
  watch(onLost: () => void): void;
  /** 关掉 server；文件还是自己的才删。 */
  release(): void;
}

function inodeOf(sock: string): number | undefined {
  try { return fs.statSync(sock).ino; } catch { return undefined; }
}

/** 抢占 socket。返回 null 表示已经有活的 daemon。 */
export async function listenOwned(sock: string, onConn: (socket: net.Socket) => void): Promise<Owned | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const server = net.createServer(onConn);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(sock, () => { server.off("error", reject); resolve(); });
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
      if (await connectable(sock)) return null;
      if (IS_FILE) fs.rmSync(sock, { force: true }); // connect 被拒绝：残留文件
      continue;
    }
    if (IS_FILE) fs.chmodSync(sock, 0o600);
    return owned(sock, server, IS_FILE ? inodeOf(sock) : undefined);
  }
  return null;
}

function owned(sock: string, server: net.Server, ino: number | undefined): Owned {
  let timer: NodeJS.Timeout | undefined;
  const stillMine = (): boolean => !IS_FILE || (ino !== undefined && inodeOf(sock) === ino);
  return {
    server,
    stillMine,
    watch(onLost) {
      if (!IS_FILE || timer) return;
      timer = setInterval(() => {
        if (stillMine()) return;
        clearInterval(timer);
        onLost();
      }, OWNER_CHECK_MS);
      timer.unref();
    },
    release() {
      if (timer) clearInterval(timer);
      // Node 的 server.close() 会按路径删 socket 文件，不管那个文件现在是谁的：不是自己的就不 close，进程退出时自然释放
      if (!stillMine()) return;
      server.close();
      if (IS_FILE) fs.rmSync(sock, { force: true });
    },
  };
}

const ROLE_LINE_MAX = 1024;
const ROLE_LINE_MS = 2_000;

/**
 * 新连接的第一行是角色说明 `{"role":"cli"|"relay"}`（plan 第 1 条），按它把连接交给对应的处理函数。
 * 按 Buffer 收、不先解码：relay 的角色说明后面紧跟着二进制长度帧，可能在同一个数据块里，剩下的字节原样交下去。
 * 超时、太长、不是合法角色的连接直接断开。
 */
export function routeByRole(socket: net.Socket, handlers: Record<"cli" | "relay", (socket: net.Socket, rest: Buffer) => void>, ms = ROLE_LINE_MS): void {
  let head: Buffer = Buffer.alloc(0);
  const timer = setTimeout(() => socket.destroy(), ms);
  const onFirst = (chunk: Buffer): void => {
    head = Buffer.concat([head, chunk]);
    const nl = head.indexOf(0x0a);
    if (nl < 0) {
      if (head.length > ROLE_LINE_MAX) { clearTimeout(timer); socket.destroy(); }
      return;
    }
    socket.off("data", onFirst);
    clearTimeout(timer);
    let role: unknown;
    try { role = (JSON.parse(head.subarray(0, nl).toString("utf8")) as { role?: unknown }).role; } catch { /* 不是角色说明 */ }
    if (role === "cli" || role === "relay") handlers[role](socket, head.subarray(nl + 1));
    else socket.destroy();
  };
  socket.on("data", onFirst);
  socket.on("error", () => {});
}
