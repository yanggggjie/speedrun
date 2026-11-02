// deft bootstrap：把本 skill 目录整个镜像到 ~/.deft（src、scripts、文档），再在 ~/.deft/src 里 npm install，然后建数据目录。
// 日志在 .deft/learn-windows、run-windows，action 在 .deft/sites、compose，本脚本永不碰；旧版本的数据由 holder 启动时的布局升级处理（run/actions.ts 的 upgradeLayout）。
// 用法：node <此 skill 目录>/setup.js
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { migrateFromTabbot, mirrorPayload } from "./src/store/deploy.ts";
import { writeVersion } from "./src/store/version.ts";
import { restartDaemon, tryPing } from "./src/cli/session.ts";
import { writeShim, BIN_DIR } from "./src/cli/shim.ts";
import { EXTENSION_DIR, installNativeHost, manifestPath } from "./src/native-messaging-host/install.ts";

const major = Number(process.versions.node.split(".")[0]);
if (!Number.isFinite(major) || major < 24) {
  console.error(`Deft 需要 Node >=24，当前 ${process.version}。升级 Node 后重试。`);
  process.exit(1);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME_DIR = path.join(os.homedir(), ".deft");
const DEST = path.join(HOME_DIR, "src");
const DEPS_MARKER = path.join("node_modules", "tldts", "dist", "cjs", "index.js");

// 改名前叫 TabBot（~/.tabbot、native host com.tabbot.connect）：先注销旧 host、停掉旧 daemon（扩展连不回去），再把整个目录挪过来
const OLD_HOME = path.join(os.homedir(), ".tabbot");
if (fs.existsSync(OLD_HOME)) {
  const oldHost = process.platform === "darwin"
    ? path.join(os.homedir(), "Library/Application Support/Google/Chrome/NativeMessagingHosts/com.tabbot.connect.json")
    : path.join(os.homedir(), ".config/google-chrome/NativeMessagingHosts/com.tabbot.connect.json");
  if (process.platform === "win32") spawnSync("reg", ["delete", "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.tabbot.connect", "/f"], { stdio: "ignore" });
  else fs.rmSync(oldHost, { force: true });
  const oldCli = path.join(OLD_HOME, "src", "cli", "tabbot.ts");
  if (fs.existsSync(oldCli)) spawnSync(process.execPath, [oldCli, "daemon", "restart"], { stdio: "ignore", timeout: 15000 });
  const moved = migrateFromTabbot(OLD_HOME, HOME_DIR);
  if (moved === "migrated") console.log(`旧数据 ${OLD_HOME} → ${HOME_DIR}（action 里的 tabbot 已改成 deft）`);
  else if (moved === "both") console.log(`${OLD_HOME} 和 ${HOME_DIR} 都在：没有合并，旧目录确认不要了可以删掉`);
}

mirrorPayload(HERE, HOME_DIR);
console.log(`Deft 源码镜像 → ${HOME_DIR}`);
const lock = path.join(DEST, "package-lock.json");
if (!fs.existsSync(lock)) {
  console.error(`缺少 ${lock}，无法安装依赖`);
  process.exit(1);
}

console.log(`Deft 依赖安装 → ${DEST}`);
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
console.log(`Deft 版本 → ${version.build}`);

installNativeHost(process.execPath);
console.log(`native messaging host 已注册 → ${manifestPath()}`);
console.log(`扩展目录 → ${EXTENSION_DIR}`);

fs.mkdirSync(path.join(HOME_DIR, "session"), { recursive: true });
writeShim(process.execPath);
console.log(`Deft 命令 shim → ${BIN_DIR}`);

// 正在运行的 daemon 还是旧代码：build 不同才请它退出，扩展重连时会拉起新的（代码没变就不动，免得白白断一次扩展链路）。
// 旧 daemon 的 ping 里没有 build，也算不同。
const running = await tryPing();
if (running && running.build !== version.build) {
  const restarted = await restartDaemon();
  if (restarted.action === "restarted") console.log("daemon 已更新为新版本");
  else if (restarted.action === "killed") console.log("旧 daemon 已退出，扩展重连时会启动新的");
  else if (restarted.action === "failed") console.log("旧 daemon 已退出，但新 daemon 还没连上；请稍等，或在 chrome://extensions 刷新 Deft");
}

const doctor = spawnSync(process.execPath, [path.join(DEST, "cli", "deft.ts"), "doctor"], {
  stdio: "inherit",
});
process.exit(doctor.status ?? 0);
