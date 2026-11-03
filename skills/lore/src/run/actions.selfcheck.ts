// compose 按代码哈希存进 compose/；--compose 的前缀只认唯一的、至少 4 位的（对错了会静默跑别的 compose）；
// 哈希 compose 的淘汰不能删掉被复用过的。
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { composeTarget, pruneUnnamed, resolveCompose, saveComposed } from "./actions.ts";

const composeDir = fs.mkdtempSync(path.join(os.tmpdir(), "lore-actions-"));
process.on("exit", () => fs.rmSync(composeDir, { recursive: true, force: true }));

assert.match(composeTarget(composeDir, "return 1"), /[0-9a-f]{12}\.js$/);
for (const h of ["a937ac321cda", "a99ba286310e"]) fs.writeFileSync(path.join(composeDir, `${h}.js`), "return 1;\n");
assert.deepEqual(resolveCompose(composeDir, "a99b"), { name: "a99ba286310e" });
assert.deepEqual(resolveCompose(composeDir, "a937ac321cda"), { name: "a937ac321cda" });
assert.match((resolveCompose(composeDir, "a9") as { error: string }).error, /至少写 4 位.*a937ac321cda.*a99ba286310e/);
assert.equal(resolveCompose(composeDir, "ffff"), undefined);

// 哈希 compose 的淘汰：被复用过的（@ok ≥2）不删、不占名额；只跑过一次的超龄删、超额删最旧的
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lore-prune-"));
  const mk = (h: string, runs: number, ageDays: number): string => {
    const f = path.join(dir, `${h.repeat(12)}.js`);
    for (let i = 0; i < runs; i++) saveComposed(f, `return action("a-${h}");`, "d");
    const t = (Date.now() - ageDays * 86400_000) / 1000;
    fs.utimesSync(f, t, t);
    return f;
  };
  const reused = mk("a", 2, 90), old = mk("b", 1, 40), newer = mk("c", 1, 1), newest = mk("d", 1, 0);
  pruneUnnamed(dir, 1);
  assert.ok(fs.existsSync(reused) && fs.existsSync(newest));
  assert.ok(!fs.existsSync(old) && !fs.existsSync(newer));
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log("actions.selfcheck ok");
