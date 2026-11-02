// 把 skills/deft 里 git 认的文件（已跟踪 + 未跟踪但没被忽略）导出到 <dest>/skills/deft。
// 用它代替直接复制工作区：node_modules、.DS_Store 这些杂物不会进 skill，verify:pack 里的内容与在线安装一致。
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export function exportPayload(repo, dest) {
  const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "skills/deft"], { cwd: repo }).toString();
  const root = path.join(dest, "skills", "deft");
  for (const rel of out.split("\0").filter(Boolean)) {
    const from = path.join(repo, rel);
    if (!fs.existsSync(from)) continue; // 已跟踪但工作区里删了
    fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true });
    fs.copyFileSync(from, path.join(dest, rel));
  }
  return root;
}
