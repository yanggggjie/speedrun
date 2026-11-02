// 镜像：新版本删掉的顶层文档不留在本机，本机数据（sites 等）一点不动。丢数据的地方，必须守住。
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { migrateFromTabbot, mirrorPayload } from "./deploy.ts";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "tc-deploy-"));
process.on("exit", () => fs.rmSync(home, { recursive: true, force: true }));
fs.mkdirSync(path.join(home, "sites", "x.com"), { recursive: true });
fs.writeFileSync(path.join(home, "sites", "x.com", "keep.txt"), "新数据");

// 镜像：新版本删掉的顶层文档不留在本机；数据不动
const payload = fs.mkdtempSync(path.join(os.tmpdir(), "tc-payload-"));
process.on("exit", () => fs.rmSync(payload, { recursive: true, force: true }));
fs.writeFileSync(path.join(payload, "SKILL.md"), "新");
fs.writeFileSync(path.join(home, "TROUBLESHOOTING.md"), "旧版本的文档");
mirrorPayload(payload, home);
assert.equal(fs.readFileSync(path.join(home, "SKILL.md"), "utf8"), "新");
assert.ok(!fs.existsSync(path.join(home, "TROUBLESHOOTING.md")), "旧文档删掉");
assert.ok(fs.existsSync(path.join(home, "sites", "x.com", "keep.txt")), "数据不动");

// 改名升级：~/.tabbot 整个挪到 ~/.deft，学会的 action 一个不丢，里面对 SDK 的引用改成 deft；新目录已有数据时不动
const old = fs.mkdtempSync(path.join(os.tmpdir(), "tc-old-"));
const neu = path.join(os.tmpdir(), `tc-new-${process.pid}`);
process.on("exit", () => { fs.rmSync(old, { recursive: true, force: true }); fs.rmSync(neu, { recursive: true, force: true }); });
fs.mkdirSync(path.join(old, "sites", "a.com", "actions"), { recursive: true });
fs.mkdirSync(path.join(old, "compose")); fs.mkdirSync(path.join(old, "bin"));
fs.writeFileSync(path.join(old, "sites", "a.com", "actions", "x.js"), 'import { tabbot, request } from "../../../lib/index.js";\nawait tabbot.run(async () => tabbot.params.q);\n');
fs.writeFileSync(path.join(old, "compose", "c.js"), 'return await action("x", { q: tabbot.params.q });\n');
fs.writeFileSync(path.join(old, "bin", "tabbot"), "#!/bin/sh");
assert.equal(migrateFromTabbot(old, neu), "migrated");
assert.ok(!fs.existsSync(old));
assert.equal(fs.readFileSync(path.join(neu, "sites", "a.com", "actions", "x.js"), "utf8"), 'import { deft, request } from "../../../lib/index.js";\nawait deft.run(async () => deft.params.q);\n');
assert.match(fs.readFileSync(path.join(neu, "compose", "c.js"), "utf8"), /deft\.params\.q/);
assert.ok(!fs.existsSync(path.join(neu, "bin", "tabbot")), "旧命令 shim 删掉");
fs.mkdirSync(old);
assert.equal(migrateFromTabbot(old, neu), "both", "新目录已有数据时不覆盖");

console.log("deploy selfcheck ok");
