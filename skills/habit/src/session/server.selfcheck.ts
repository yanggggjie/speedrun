// socket 的所有权：残留文件能接管、活的 owner 不被抢、文件被换掉能发现、退出时不碰别人的文件、
// 客户端在对方卡住时不删文件、角色说明和后面的二进制数据在同一个数据块里时一个字节都不丢。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { connectable, listenOwned, routeByRole, OWNER_CHECK_MS } from "./server.ts";
import { rpc } from "./client.ts";

if (process.platform === "win32") process.exit(0); // named pipe 没有文件，这些都不适用

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hb-"));
process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const ino = (p: string): number => fs.statSync(p).ino;
const listenRaw = (p: string, onConn: (s: net.Socket) => void = () => {}): Promise<net.Server> =>
  new Promise((resolve, reject) => { const s = net.createServer(onConn); s.once("error", reject); s.listen(p, () => resolve(s)); });

// 残留文件：一个进程 listen 后被 kill -9，留下的 socket 文件 connect 不上；listenOwned 删掉它并接管
{
  const sock = path.join(dir, "stale");
  const child = spawn(process.execPath, ["-e", `require("net").createServer().listen(${JSON.stringify(sock)})`], { stdio: "ignore" });
  while (!fs.existsSync(sock)) await sleep(20);
  child.kill("SIGKILL");
  await new Promise((r) => child.once("exit", r));
  assert.equal(fs.existsSync(sock), true, "kill -9 后文件还在");
  assert.equal(await connectable(sock), false);
  const owned = await listenOwned(sock, () => {});
  assert.ok(owned, "残留文件被接管");
  assert.equal(await connectable(sock), true);
  owned.release();
  assert.equal(fs.existsSync(sock), false, "自己的文件退出时删掉");
}

// 已经有活的 owner：第二个让出，第一个的文件原样不动
{
  const sock = path.join(dir, "live");
  const first = await listenOwned(sock, () => {});
  assert.ok(first);
  const before = ino(sock);
  assert.equal(await listenOwned(sock, () => {}), null, "活的 owner 不被抢");
  assert.equal(ino(sock), before);
  assert.equal(first.stillMine(), true);
  first.release();
}

// 文件被换成另一个 socket：watch 发现并回调；release 不碰新的那个文件
{
  const sock = path.join(dir, "replaced");
  const owned = await listenOwned(sock, () => {});
  assert.ok(owned);
  let lost = false;
  owned.watch(() => { lost = true; });
  fs.rmSync(sock);
  const other = await listenRaw(sock);
  const deadline = Date.now() + OWNER_CHECK_MS + 1_000;
  while (!lost && Date.now() < deadline) await sleep(50);
  assert.equal(lost, true, "文件被换掉后能发现");
  assert.equal(owned.stillMine(), false);
  const otherIno = ino(sock);
  owned.release();
  assert.equal(fs.existsSync(sock), true, "不删别人的文件");
  assert.equal(ino(sock), otherIno);
  assert.equal(await connectable(sock), true, "别人的 socket 照常能连");
  other.close();
}

// 对方卡住（接受连接但从不回复）：客户端超时报错，但不删文件、不拉起新 daemon
{
  const sock = path.join(dir, "stuck");
  const stuck = await listenRaw(sock);
  await assert.rejects(rpc("ping", undefined, 300, { sock }));
  assert.equal(fs.existsSync(sock), true, "超时不删 socket 文件");
  stuck.close();
}

// 角色说明后面紧跟着二进制数据、在同一个数据块里：剩下的字节原样交给对应的处理函数
{
  const sock = path.join(dir, "route");
  const payload = Buffer.from([0x05, 0x00, 0x00, 0x00, 0x0a, 0xff, 0x00, 0x0a]); // 含 \n 和非 UTF-8 字节
  const got = new Promise<Buffer>((resolve) => {
    void listenRaw(sock, (s) => routeByRole(s, {
      cli: () => resolve(Buffer.from("wrong")),
      relay: (sk, rest) => { let all = rest; sk.on("data", (c: Buffer) => { all = Buffer.concat([all, c]); if (all.length >= payload.length) resolve(all); }); if (all.length >= payload.length) resolve(all); },
    }));
  });
  while (!fs.existsSync(sock)) await sleep(10);
  const c = net.connect(sock);
  await new Promise((r) => c.once("connect", r));
  c.write(Buffer.concat([Buffer.from('{"role":"relay"}\n'), payload]));
  assert.deepEqual(await got, payload);
  c.destroy();

  // 不是合法角色：连接被断开
  const bad = net.connect(sock);
  const closed = new Promise((r) => bad.once("close", r));
  bad.on("error", () => {});
  bad.write('{"role":"x"}\n');
  await closed;
}

console.log("server.selfcheck ok");
process.exit(0);
