// 镜像：payload 里删掉的顶层文档不留在本机，本机数据（sites 等）一点不动。丢数据的地方，必须守住。
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { mirrorPayload } from "./deploy.ts";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "lore-deploy-"));
process.on("exit", () => fs.rmSync(home, { recursive: true, force: true }));
fs.mkdirSync(path.join(home, "sites", "x.com"), { recursive: true });
fs.writeFileSync(path.join(home, "sites", "x.com", "keep.txt"), "新数据");

// 镜像：payload 里删掉的顶层文档不留在本机；数据不动
const payload = fs.mkdtempSync(path.join(os.tmpdir(), "lore-payload-"));
process.on("exit", () => fs.rmSync(payload, { recursive: true, force: true }));
fs.writeFileSync(path.join(payload, "SKILL.md"), "新");
fs.writeFileSync(path.join(home, "TROUBLESHOOTING.md"), "payload 里已经没有的文档");
mirrorPayload(payload, home);
assert.equal(fs.readFileSync(path.join(home, "SKILL.md"), "utf8"), "新");
assert.ok(!fs.existsSync(path.join(home, "TROUBLESHOOTING.md")), "payload 里没有的文档删掉");
assert.ok(fs.existsSync(path.join(home, "sites", "x.com", "keep.txt")), "数据不动");

console.log("deploy selfcheck ok");
