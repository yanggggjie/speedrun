import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { computeVersion, readVersion, VERSION_FILE, writeVersion } from "./version.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tabbot-version-"));
try {
  fs.mkdirSync(path.join(root, "page"), { recursive: true });
  fs.mkdirSync(path.join(root, "journal", "fixtures"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(root, "holder.ts"), "daemon\n");
  fs.writeFileSync(path.join(root, "page", "recorder.js"), "recorder\n");
  assert.equal(readVersion(root), null, "没有 .version 时返回 null");

  const first = writeVersion(root);
  assert.match(first.build, /^[0-9a-f]{16}$/);
  assert.deepEqual(readVersion(root), first);
  assert.deepEqual(computeVersion(root), first, ".version 本身不参与哈希");

  // 运行时代码（包括下发给页面的脚本）变了 → build 变
  fs.writeFileSync(path.join(root, "holder.ts"), "daemon v2\n");
  const second = computeVersion(root);
  assert.notEqual(second.build, first.build);
  fs.writeFileSync(path.join(root, "page", "recorder.js"), "recorder v2\n");
  assert.notEqual(computeVersion(root).build, second.build);
  fs.writeFileSync(path.join(root, "page", "recorder.js"), "recorder\n");

  // 自检、夹具、node_modules 的变化不触发 build 变化
  fs.writeFileSync(path.join(root, "journal", "x.selfcheck.ts"), "test\n");
  fs.writeFileSync(path.join(root, "journal", "fixtures", "x.json"), "{}\n");
  fs.writeFileSync(path.join(root, "node_modules", "pkg", "index.js"), "dep\n");
  assert.deepEqual(computeVersion(root), second);

  fs.writeFileSync(path.join(root, VERSION_FILE), "not json");
  assert.equal(readVersion(root), null, "损坏的 .version 当作没有");
  console.log("store version selfcheck ok");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
