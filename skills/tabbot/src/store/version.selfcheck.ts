import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { computeVersion, readVersion, VERSION_FILE, writeVersion } from "./version.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tabbot-version-"));
try {
  fs.mkdirSync(path.join(root, "chrome-extension"), { recursive: true });
  fs.mkdirSync(path.join(root, "record", "fixtures"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(root, "holder.ts"), "daemon\n");
  fs.writeFileSync(path.join(root, "chrome-extension", "background.js"), "bg\n");
  fs.writeFileSync(path.join(root, "chrome-extension", "manifest.json"), "{}\n");
  fs.mkdirSync(path.join(root, "chrome-extension", "journal"), { recursive: true });
  fs.writeFileSync(path.join(root, "chrome-extension", "journal", "hook.js"), "hook\n");
  fs.writeFileSync(path.join(root, "chrome-extension", "journal", "relay.js"), "relay\n");
  assert.equal(readVersion(root), null, "没有 .version 时返回 null");

  const first = writeVersion(root);
  assert.match(first.build, /^[0-9a-f]{16}$/);
  assert.deepEqual(readVersion(root), first);
  assert.deepEqual(computeVersion(root), first, ".version 本身不参与哈希");

  // 运行时代码变了 → build 变；扩展没变 → extension 不变
  fs.writeFileSync(path.join(root, "holder.ts"), "daemon v2\n");
  const second = computeVersion(root);
  assert.notEqual(second.build, first.build);
  assert.equal(second.extension, first.extension);

  // 自检、夹具、node_modules 的变化不触发 build 变化
  fs.writeFileSync(path.join(root, "record", "dom.selfcheck.ts"), "test\n");
  fs.writeFileSync(path.join(root, "record", "fixtures", "x.json"), "{}\n");
  fs.writeFileSync(path.join(root, "node_modules", "pkg", "index.js"), "dep\n");
  assert.deepEqual(computeVersion(root), second);

  // 扩展文件变了 → extension 变
  fs.writeFileSync(path.join(root, "chrome-extension", "background.js"), "bg v2\n");
  const third = computeVersion(root);
  assert.notEqual(third.extension, second.extension);
  assert.equal(third.build, computeVersion(root).build);
  // 录制脚本变了 → extension 也变（否则 doctor 发现不了页面里还跑着旧 hook）
  fs.writeFileSync(path.join(root, "chrome-extension", "journal", "hook.js"), "hook v2\n");
  assert.notEqual(computeVersion(root).extension, third.extension);

  fs.writeFileSync(path.join(root, VERSION_FILE), "not json");
  assert.equal(readVersion(root), null, "损坏的 .version 当作没有");
  console.log("store version selfcheck ok");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
