// 升级时旧数据改名保留：不读取、不转换、不覆盖；旧的脱敏盐复制到新位置（权限 0600）。丢数据的地方，必须守住。
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { retireLegacyData } from "./deploy.ts";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "tc-deploy-"));
process.on("exit", () => fs.rmSync(home, { recursive: true, force: true }));
assert.deepEqual(retireLegacyData(home), [], "没有旧数据就什么都不做");

fs.mkdirSync(path.join(home, "journal", "seg-000001"), { recursive: true });
fs.writeFileSync(path.join(home, "journal", "seg-000001", "events.db"), "旧日志");
fs.writeFileSync(path.join(home, "journal", "alias-salt"), "salt-123");
fs.mkdirSync(path.join(home, "task"), { recursive: true });
fs.writeFileSync(path.join(home, "task", "a.js"), "旧 task");
fs.mkdirSync(path.join(home, "sites", "x.com"), { recursive: true });
fs.writeFileSync(path.join(home, "sites", "x.com", "keep.txt"), "新数据");

assert.deepEqual(retireLegacyData(home), [["journal", "journal.old"], ["task", "task.old"]]);
assert.equal(fs.readFileSync(path.join(home, "journal.old", "seg-000001", "events.db"), "utf8"), "旧日志", "内容原样保留");
assert.equal(fs.readFileSync(path.join(home, "task.old", "a.js"), "utf8"), "旧 task");
assert.ok(!fs.existsSync(path.join(home, "journal")) && !fs.existsSync(path.join(home, "task")));
assert.equal(fs.readFileSync(path.join(home, "alias-salt"), "utf8"), "salt-123", "旧盐复制到新位置，别名保持一致");
assert.equal(fs.statSync(path.join(home, "alias-salt")).mode & 0o777, 0o600);
assert.equal(fs.readFileSync(path.join(home, "sites", "x.com", "keep.txt"), "utf8"), "新数据", "新数据不动");
assert.deepEqual(retireLegacyData(home), [], "再跑一次不动");

// 旧目录又出现了（旧版本的 daemon 还在写）：不覆盖已有的 .old，另起一个名字
fs.mkdirSync(path.join(home, "journal"), { recursive: true });
fs.writeFileSync(path.join(home, "journal", "alias-salt"), "salt-other");
assert.deepEqual(retireLegacyData(home), [["journal", "journal.old-2"]]);
assert.equal(fs.readFileSync(path.join(home, "alias-salt"), "utf8"), "salt-123", "已有的新盐不被覆盖");
assert.ok(fs.existsSync(path.join(home, "journal.old", "seg-000001", "events.db")));

console.log("deploy selfcheck ok");
