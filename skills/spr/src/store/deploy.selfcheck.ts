// 镜像：payload 里删掉的顶层文档不留在本机，本机数据（sites 等）和不是拷过去的文件一点不动。丢数据的地方，必须守住。
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mirrorPayload } from "./deploy.ts";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "speedrun-deploy-"));
process.on("exit", () => fs.rmSync(home, { recursive: true, force: true }));
fs.mkdirSync(path.join(home, "sites", "x.com"), { recursive: true });
fs.writeFileSync(path.join(home, "sites", "x.com", "keep.txt"), "新数据");

// 镜像：数据不动
const payload = fs.mkdtempSync(path.join(os.tmpdir(), "speedrun-payload-"));
process.on("exit", () => fs.rmSync(payload, { recursive: true, force: true }));
fs.writeFileSync(path.join(payload, "SKILL.md"), "新");
mirrorPayload(payload, home);
assert.equal(fs.readFileSync(path.join(home, "SKILL.md"), "utf8"), "新");
assert.ok(fs.existsSync(path.join(home, "sites", "x.com", "keep.txt")), "数据不动");

// 顶层文件：只删上次拷过去、这次 payload 里没有的；speedrun 自己生成的、用户放的不删
{
  const payload = fs.mkdtempSync(path.join(os.tmpdir(), "speedrun-payload-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "speedrun-home-"));
  fs.writeFileSync(path.join(payload, "SKILL.md"), "s");
  fs.writeFileSync(path.join(payload, "OLD.md"), "o");
  mirrorPayload(payload, home);
  fs.writeFileSync(path.join(home, "learn-guide.md"), "g");
  fs.writeFileSync(path.join(home, "my-notes.md"), "n");
  fs.rmSync(path.join(payload, "OLD.md"));
  mirrorPayload(payload, home);
  assert.equal(fs.existsSync(path.join(home, "OLD.md")), false, "新版本删掉的文档不留在本机");
  assert.ok(fs.existsSync(path.join(home, "SKILL.md")));
  assert.ok(fs.existsSync(path.join(home, "learn-guide.md")) && fs.existsSync(path.join(home, "my-notes.md")), "不是拷过去的顶层文件不删");
  fs.rmSync(payload, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
}

// 启动脚本的引号：路径里有空格、单引号、$ 也能原样传给 sh
{
  const { shQuote } = await import("../utils/shell.ts");
  const weird = "/tmp/a b/it's $HOME `x`";
  const r = spawnSync("sh", ["-c", `printf %s ${shQuote(weird)}`]);
  assert.equal(r.stdout.toString(), weird);
}

console.log("deploy selfcheck ok");
