// speedrun bootstrap：把本 skill 目录整个镜像到 ~/.speedrun（src、文档），再在 ~/.speedrun/src 里 npm install，然后建数据目录。
// 日志在 .speedrun/debug-windows、run-windows，action 在 .speedrun/action、compose，本脚本永不碰。
// 用法：node <此 skill 目录>/setup.js
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mirrorPayload } from "./src/store/deploy.ts";
import { computeVersion, writeVersion } from "./src/store/version.ts";
import { ping, stopDaemon } from "./src/session/client.ts";
import { writeShim, BIN_DIR } from "./src/cli/shim.ts";
import { EXTENSION_DIR, installNativeHost, manifestPath } from "./src/native-messaging-host/install.ts";

const major = Number(process.versions.node.split(".")[0]);
if (!Number.isFinite(major) || major < 24) {
  console.error(`speedrun 需要 Node >=24，当前 ${process.version}。升级 Node 后重试。`);
  process.exit(1);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME_DIR = path.join(os.homedir(), ".speedrun");
const DEST = path.join(HOME_DIR, "src");
const DEPS_MARKER = path.join("node_modules", "tldts", "dist", "cjs", "index.js");

// 先让旧代码的 daemon 退出，再换代码：换代码的这几秒里旧 daemon 还在接命令，会从磁盘上拉起新代码的 worker（或者文件正好不在）。
// 版本号只看运行时代码，拷过去之后算出来是同一个；代码没变就不动，免得白白断一次扩展链路。旧 daemon 的 ping 里没有 build，也算不同。
// 不等新的起来：扩展重连时 relay 会拉起新代码的 daemon（最后的 doctor 不会拉起 daemon）。
const nextBuild = computeVersion(path.join(HERE, "src")).build;
const running = await ping();
if (running && running.build !== nextBuild) {
  const stopped = await stopDaemon();
  if (stopped === "stopped") console.log("旧 daemon 已退出，扩展重连时会启动新版本");
  else if (stopped === "timeout") console.log("旧 daemon 10 秒内没有退出：看 ~/.speedrun/session/log.jsonl");
}

mirrorPayload(HERE, HOME_DIR);
console.log(`speedrun 源码镜像 → ${HOME_DIR}`);
const lock = path.join(DEST, "package-lock.json");
if (!fs.existsSync(lock)) {
  console.error(`缺少 ${lock}，无法安装依赖`);
  process.exit(1);
}

console.log(`speedrun 依赖安装 → ${DEST}`);
const install = spawnSync("npm", ["install", "--omit=dev", "--omit=optional"], {
  cwd: DEST,
  stdio: "inherit",
  env: process.env,
  shell: process.platform === "win32",
});
if (install.error) {
  console.error(`无法启动 npm：${install.error.message}`);
}
if (install.status !== 0) {
  console.error("npm install 失败");
  process.exit(install.status ?? 1);
}
if (!fs.existsSync(path.join(DEST, DEPS_MARKER))) {
  console.error(`npm install 后仍缺 ${DEPS_MARKER}`);
  process.exit(1);
}

const version = writeVersion(DEST);
console.log(`speedrun 版本 → ${version.build}`);

installNativeHost(process.execPath);
console.log(`native messaging host 已注册 → ${manifestPath()}`);
console.log(`扩展目录 → ${EXTENSION_DIR}`);

fs.mkdirSync(path.join(HOME_DIR, "session"), { recursive: true });
writeShim(process.execPath);
console.log(`spr 命令 shim → ${BIN_DIR}`);

const doctor = spawnSync(process.execPath, [path.join(DEST, "cli", "spr.ts"), "doctor"], {
  stdio: "inherit",
});
process.exit(doctor.status ?? 0);
