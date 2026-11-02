import * as fs from "node:fs";
import * as path from "node:path";

/** 安全移除路径：symlink 只删链接（不顺链删 target）；真目录 rm -rf；不存在跳过。 */
export function safeRemove(p: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) fs.unlinkSync(p);
  else fs.rmSync(p, { recursive: true, force: true });
}

/**
 * 哪些路径算运行时代码：排除 node_modules、自检（*.selfcheck.*）和夹具（fixtures/）。
 * 只用于版本哈希：整个 skill 目录都会镜像到本机，但改自检、夹具不该触发重启 daemon。
 */
export function isRuntimePath(root: string, p: string): boolean {
  const rel = path.relative(root, p);
  if (!rel || rel.startsWith("..")) return true;
  const parts = rel.split(path.sep);
  if (parts.includes("node_modules") || parts.includes("fixtures")) return false;
  return !/\.selfcheck\./.test(parts[parts.length - 1]!);
}

/** 镜像时跳过的路径：依赖在本机安装，.DS_Store 是系统杂物。 */
export function isMirrorPath(root: string, p: string): boolean {
  const parts = path.relative(root, p).split(path.sep);
  return !parts.includes("node_modules") && parts[parts.length - 1] !== ".DS_Store";
}

/**
 * 把 skill 的整个目录镜像到 homeAbs（~/.deft）：顶层文件直接覆盖，顶层目录（src、scripts）先清空再拷。
 * 只动 payload 里有的名字，不碰 sites、learn-windows、run-windows、compose、lib、session、bin、alias-salt 这些本机数据。
 */
export function mirrorPayload(payloadAbs: string, homeAbs: string): void {
  fs.mkdirSync(homeAbs, { recursive: true });
  for (const entry of fs.readdirSync(payloadAbs, { withFileTypes: true })) {
    const from = path.join(payloadAbs, entry.name);
    const to = path.join(homeAbs, entry.name);
    if (!isMirrorPath(payloadAbs, from)) continue;
    if (entry.isDirectory()) {
      safeRemove(to);
      fs.cpSync(from, to, { recursive: true, filter: (p) => isMirrorPath(payloadAbs, p) });
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
    }
  }
  // 新版本删掉的文档（如 TROUBLESHOOTING.md）不留在本机：顶层的 .md 只保留 payload 里有的。数据目录和文件不动
  for (const name of fs.readdirSync(homeAbs)) if (name.endsWith(".md") && !fs.existsSync(path.join(payloadAbs, name))) safeRemove(path.join(homeAbs, name));
}

/**
 * 从改名前的 ~/.tabbot 升级到 ~/.deft：整个目录挪过来（学会的 action、接口知识、日志都在里面），
 * 再把 action 和组合里对 SDK 的引用（import { tabbot }、tabbot.run、tabbot.params、tabbot.ask）改成 deft，旧的命令 shim 删掉。
 * 新目录已经有数据时不动（返回 "both"，由调用方提示），没有旧目录返回 "none"。
 */
export function migrateFromTabbot(oldHome: string, newHome: string): "migrated" | "both" | "none" {
  if (!fs.existsSync(oldHome)) return "none";
  if (fs.existsSync(newHome)) return "both";
  fs.renameSync(oldHome, newHome);
  const files: string[] = [];
  const sites = path.join(newHome, "sites");
  if (fs.existsSync(sites)) for (const site of fs.readdirSync(sites)) {
    const dir = path.join(sites, site, "actions");
    if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) if (f.endsWith(".js")) files.push(path.join(dir, f));
  }
  const compose = path.join(newHome, "compose");
  if (fs.existsSync(compose)) for (const f of fs.readdirSync(compose)) if (f.endsWith(".js")) files.push(path.join(compose, f));
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    const next = text.replace(/\btabbot\b/g, "deft");
    if (next !== text) fs.writeFileSync(f, next);
  }
  for (const name of ["tabbot", "tabbot.cmd"]) safeRemove(path.join(newHome, "bin", name));
  return "migrated";
}
