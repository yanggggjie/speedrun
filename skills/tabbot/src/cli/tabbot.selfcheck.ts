import assert from "node:assert/strict";
import * as child_process from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// 用隔离的 HOME 真实运行命令行：不碰真实的 ~/.tabbot，也不需要 Chrome。命令本身的行为在 journal/commands.selfcheck.ts 和 holder 的端到端里测。
const home = fs.mkdtempSync(path.join(os.tmpdir(), "tabbot-cli-"));
const entry = path.join(import.meta.dirname, "tabbot.ts");

function tabbot(...args: string[]): { code: number; out: string; json: any } {
  const run = child_process.spawnSync(process.execPath, [entry, ...args], { encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home } });
  let json: unknown;
  try { json = JSON.parse(run.stdout); } catch { json = undefined; }
  return { code: run.status ?? -1, out: run.stdout, json };
}

try {
  // 没有参数、daemon 的子命令不对：统一的 failure 形状
  for (const args of [[], ["daemon"], ["daemon", "stop"]]) {
    const r = tabbot(...args);
    assert.equal(r.code, 1, args.join(" "));
    assert.equal(r.json.status, "failure");
    assert.match(r.json.error, /用法/);
  }

  // 没有 holder：daemon restart 不报错
  assert.equal(tabbot("daemon", "restart").json.status, "success");

  // doctor --json：可解析，带 ok 与 checks
  const doctor = tabbot("doctor", "--json");
  assert.equal(typeof doctor.json.ok, "boolean");
  assert.ok(doctor.json.checks.some((c: { name: string }) => c.name === "node"));
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}

console.log("cli tabbot selfcheck ok");
