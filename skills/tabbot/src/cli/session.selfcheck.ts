import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

// constants 在加载时按 HOME 计算 ~/.tabbot 路径，先把 HOME 指到临时目录再动态 import，避免碰真实数据。
const home = fs.mkdtempSync(path.join(os.tmpdir(), "tabbot-session-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
const { ensureHolder, restartDaemon, tryPing } = await import("./session.ts");
const { SESSION_DIR, SESSION_SOCK } = await import("../utils/constants.ts");

// 假 holder：只回 ping；pid 必须是一个真实的、可丢弃的子进程，不能是本进程，因为信号是真的会发出去的。
const state: { pid: number; extension: boolean } = { pid: 0, extension: true };
const spawned: ChildProcess[] = [];
const spawnVictim = (): ChildProcess => { const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); spawned.push(child); return child; };
const isAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitDead = async (child: ChildProcess): Promise<boolean> => { for (let i = 0; i < 40; i++) { if (child.exitCode !== null || child.signalCode !== null) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };

fs.mkdirSync(SESSION_DIR, { recursive: true });
const server = net.createServer((socket) => {
  let buf = "";
  socket.on("data", (chunk) => {
    buf += chunk;
    const nl = buf.indexOf("\n");
    if (nl < 0) return;
    const req = JSON.parse(buf.slice(0, nl)) as { id: string };
    socket.end(`${JSON.stringify({ jsonrpc: "2.0", id: req.id, result: { pid: state.pid, extension: state.extension, build: "old" } })}\n`);
  });
});

try {
  // 没有 holder：ping 不通，restartDaemon 什么也不做
  assert.equal(await tryPing(), null);
  assert.deepEqual(await restartDaemon(), { action: "none" });

  await new Promise<void>((resolve, reject) => { server.listen(SESSION_SOCK, () => resolve()); server.on("error", reject); });

  // 判据只有 socket 能不能回 ping；holder 在就直接可用，不会去杀它
  const victim = spawnVictim(); state.pid = victim.pid!; state.extension = false;
  assert.equal((await tryPing())?.pid, victim.pid);
  assert.equal((await ensureHolder()).pid, victim.pid);
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(isAlive(victim.pid!), "ensureHolder 不应杀 holder");

  // restartDaemon：按 ping 里的 pid 发 SIGTERM；扩展没连着就不等新 holder
  const started = Date.now();
  assert.equal((await restartDaemon({ waitMs: 3_000 })).action, "killed");
  assert.ok(await waitDead(victim), "目标进程应被 SIGTERM 杀掉");
  assert.ok(Date.now() - started < 1_000, "扩展没连着时不用等新 holder");

  // 扩展连着：杀掉后，等 ping 里出现不同的 pid（新 holder），返回 restarted
  {
    const old = spawnVictim(); const fresh = spawnVictim();
    state.pid = old.pid!; state.extension = true;
    setTimeout(() => { state.pid = fresh.pid!; }, 300); // 旧的退出后，新 holder 在扩展重连后出现
    const result = await restartDaemon({ waitMs: 3_000 });
    assert.equal(result.action, "restarted");
    assert.equal(result.action === "restarted" && result.ping.pid, fresh.pid);
    assert.ok(await waitDead(old), "旧进程应被杀掉");
    assert.ok(isAlive(fresh.pid!), "新进程不能被误杀");
    fresh.kill();
  }

  // 退出了但新 holder 一直没出现：超时返回 failed
  {
    const child = spawnVictim(); state.pid = child.pid!; state.extension = true; // 假 holder 一直报告同一个 pid，相当于新 holder 没起来
    assert.equal((await restartDaemon({ waitMs: 600 })).action, "failed");
    await waitDead(child);
  }
} finally {
  for (const child of spawned) child.kill(); // 兜底：任何用例中途失败也不留下孤儿进程
  server.close();
  fs.rmSync(home, { recursive: true, force: true });
}

console.log("cli session selfcheck ok");
