// 生成 lab/out/ext-light-local：ext-light 的副本，manifest 的 matches 只含指定站点，并带 hub token。
// 用法：node lab/light-setup.mjs github.com example.com   （不给域名则 <all_urls>，仅限 headless 测试用）
import fs from "node:fs"; import path from "node:path"; import crypto from "node:crypto";
const DIR = path.dirname(new URL(import.meta.url).pathname), OUT = path.join(DIR, "out");
export function build(hosts = [], port = 8769) {
  fs.mkdirSync(OUT, { recursive: true });
  const tokenFile = path.join(OUT, "hub-token");
  if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, crypto.randomBytes(16).toString("hex"), { mode: 0o600 });
  const token = fs.readFileSync(tokenFile, "utf8").trim();
  const dst = path.join(OUT, "ext-light-local"); fs.cpSync(path.join(DIR, "ext-light"), dst, { recursive: true }); // 原地覆盖，不删目录：用户已在 Chrome 里加载过，路径要保持稳定
  const pats = hosts.length ? hosts.flatMap((h) => [`*://${h}/*`, `*://*.${h}/*`]) : ["<all_urls>"];
  const mf = JSON.parse(fs.readFileSync(path.join(dst, "manifest.json"), "utf8"));
  mf.host_permissions = [...pats, `http://127.0.0.1:${port}/*`];
  for (const cs of mf.content_scripts) cs.matches = pats;
  fs.writeFileSync(path.join(dst, "manifest.json"), JSON.stringify(mf, null, 2));
  fs.writeFileSync(path.join(dst, "config.js"), `self.TCR = ${JSON.stringify({ token, hub: `http://127.0.0.1:${port}`, hosts })};\n`);
  return { dir: dst, token };
}
if (process.argv[1] === new URL(import.meta.url).pathname && process.argv[2] === "e5") { console.log("E5 扩展目录:", buildDebug()); } else if (process.argv[1] === new URL(import.meta.url).pathname) { const r = build(process.argv.slice(2)); console.log("扩展目录:", r.dir, "\n允许站点:", process.argv.slice(2).join(", ") || "<all_urls>"); }

// E5 用的 debugger 扩展（lab/ext）：只带 hub 地址和 token，权限不变。
export function buildDebug(port = 8769) {
  const { token } = build(["__none__"], port);
  const dst = path.join(OUT, "ext-e5-local"); fs.cpSync(path.join(DIR, "ext"), dst, { recursive: true });
  const mf = JSON.parse(fs.readFileSync(path.join(dst, "manifest.json"), "utf8")); mf.host_permissions = [`http://127.0.0.1:${port}/*`];
  fs.writeFileSync(path.join(dst, "manifest.json"), JSON.stringify(mf, null, 2));
  fs.writeFileSync(path.join(dst, "config.js"), `self.TCR = ${JSON.stringify({ token, hub: `http://127.0.0.1:${port}` })};\n`);
  return dst;
}
if (process.argv[1] === new URL(import.meta.url).pathname && process.argv[2] === "e5") { /* handled below */ }
