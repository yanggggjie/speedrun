// 分发烟测：导出 git 认的 skill 文件，用 `skills add --copy` 装进隔离 HOME，再从安装位跑 setup（镜像 + npm install）+ doctor，
// 断言 ~/.lore 是 skill 目录的逐字节镜像、本机数据没被碰。
// 用法：npm run verify:pack
import * as assert from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { exportPayload } from "./export-payload.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "lore-pack-"));
const env = { ...process.env, HOME, USERPROFILE: HOME };

function findSkillDir() {
  const hits = [];
  const walk = (d, depth) => {
    if (depth > 5) return;
    let ents;
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      const p = path.join(d, e.name);
      if (e.name === "lore" && path.basename(d) === "skills") hits.push(p);
      else walk(p, depth + 1);
    }
  };
  walk(HOME, 0);
  return hits[0];
}

try {
  console.log(`[verify:pack] HOME=${HOME}`);
  const exported = path.join(HOME, "export");
  exportPayload(REPO, exported);
  execFileSync(
    "npx",
    ["-y", "skills@latest", "add", exported, "-s", "lore", "--copy", "-g", "-a", "*", "-y"],
    { env, stdio: "ignore" },
  );

  const skillDir = findSkillDir();
  assert.ok(skillDir, "skills add 后未找到已安装的 lore skill 目录");

  for (const rel of [
    "SKILL.md",
    "LICENSE",
    "setup.js",
    "src/daemon.ts",
    "src/cli/lore.ts",
    "src/cli/shim.ts",
    "src/store/deploy.ts",
    "src/record/ingest.ts",
    "src/record/windowlog.ts",
    "src/record/auth.ts",
    "src/learn/windows.ts",
    "src/chrome-extension/background.js",
    "src/chrome-extension/page/recorder.js",
    "src/chrome-extension/page/executor.js",
    "AGENTS.md",
    "ARCHITECTURE.md",
    "scripts/dev/make-icons.mjs",
    "src/package.json",
    "src/package-lock.json",
  ]) {
    assert.ok(fs.existsSync(path.join(skillDir, rel)), `payload 缺 ${rel}`);
  }

  // 本机数据：镜像不能碰
  const keep = path.join(HOME, ".lore", "sites", "x.com", "keep.txt");
  fs.mkdirSync(path.dirname(keep), { recursive: true });
  fs.writeFileSync(keep, "用户的日志\n");

  const setup = spawnSync(process.execPath, [path.join(skillDir, "setup.js")], {
    env,
    encoding: "utf8",
  });
  assert.equal(setup.status, 0, `setup 失败：${setup.stderr || setup.stdout}`);
  const dest = path.join(HOME, ".lore", "src");
  assert.ok(fs.existsSync(path.join(dest, "daemon.ts")), "~/.lore/src 未建好");
  assert.equal(fs.readFileSync(keep, "utf8"), "用户的日志\n", "setup 不应动 ~/.lore/sites");
  // ~/.lore 是 skill 目录的镜像：除 node_modules、.version 和扩展的 build.js（本机生成）外，每个文件内容都相同；自检、夹具、scripts、文档都在
  const GENERATED = new Set([path.join("src", "chrome-extension", "build.js")]);
  const listFiles = (dir, rel = "") => fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((e) => {
    const r = path.join(rel, e.name);
    if (e.name === "node_modules") return [];
    return e.isDirectory() ? listFiles(dir, r) : [r];
  });
  for (const rel of listFiles(skillDir)) {
    if (GENERATED.has(rel)) continue;
    const mirrored = path.join(HOME, ".lore", rel);
    assert.ok(fs.existsSync(mirrored), `~/.lore 缺 ${rel}`);
    assert.ok(fs.readFileSync(mirrored).equals(fs.readFileSync(path.join(skillDir, rel))), `~/.lore/${rel} 与 skill 目录不同`);
  }
  assert.ok(fs.existsSync(path.join(dest, "record", "auth.selfcheck.ts")), "自检应随源码分发");
  const version = JSON.parse(fs.readFileSync(path.join(dest, ".version"), "utf8"));
  assert.match(version.build, /^[0-9a-f]{16}$/, ".version 缺 build");
  // 扩展握手时报这个 build，daemon 据此判断扩展要不要从磁盘重新加载：必须和 .version 一致
  assert.ok(fs.readFileSync(path.join(dest, "chrome-extension", "build.js"), "utf8").includes(JSON.stringify(version.build)), "扩展的 build.js 和 .version 不一致");
  assert.ok(
    fs.existsSync(path.join(dest, "node_modules", "tldts", "dist", "cjs", "index.js")),
    "setup 后缺 tldts",
  );

  const smoke = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", 'import { getDomain } from "tldts"; getDomain("https://www.zhihu.com");'],
    { cwd: dest, env, encoding: "utf8" },
  );
  assert.equal(smoke.status, 0, `import tldts 失败：${smoke.stderr}`);

  const doctor = spawnSync(
    process.execPath,
    [path.join(dest, "cli", "lore.ts"), "doctor"],
    { env, encoding: "utf8" },
  );
  assert.equal(doctor.status, 0, `doctor 失败：${doctor.stderr || doctor.stdout}`);

  console.log("[verify:pack] ok — payload 完整，~/.lore 是它的镜像，setup + npm install 可运行");
} finally {
  fs.rmSync(HOME, { recursive: true, force: true });
}
