// 真实扩展的端到端：Chrome for Testing + 临时 profile + 真实扩展 + 真实 relay/holder + 夹具站点，走一遍
// 「用户在自己的窗口浏览 → Chef 派 Cook → Cook 在 tabbot agent 窗口里 debug 并写 task → run / compose」。不碰真实的 ~/.tabbot 和用户的 Chrome。
// 用法：node scripts/dev/e2e.mjs（Chrome for Testing 路径不同时用 CHROME 环境变量；有头模式 HEADFUL=1）。不是自检，不在 npm test 里。
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "..", "..", "src");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const base = path.join(os.homedir(), ".cache", "puppeteer", "chrome");
  if (fs.existsSync(base)) {
    for (const v of fs.readdirSync(base).sort().reverse()) {
      for (const sub of fs.readdirSync(path.join(base, v))) {
        const bin = path.join(base, v, sub, "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
        if (fs.existsSync(bin)) return bin;
        const linux = path.join(base, v, sub, "chrome");
        if (fs.existsSync(linux)) return linux;
      }
    }
  }
  throw new Error("找不到 Chrome for Testing：用 CHROME 环境变量指定（npx @puppeteer/browsers install chrome@stable 可以装）");
}

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "tabbot-real-e2e-"));
const PROFILE = path.join(HOME, "profile");
fs.mkdirSync(path.join(PROFILE, "NativeMessagingHosts"), { recursive: true });
const SECRET = "Bearer REAL-E2E-TOKEN-5566778899";

// ---- 夹具站点 ----
const PAGE = `<!doctype html><meta charset=utf-8><title>夹具首页</title>
<h1>夹具</h1><input id=q placeholder="搜索" aria-label="搜索"><button id=go>搜索</button><div id=out></div>
<article><h2>第一条</h2></article><article><h2>第二条</h2></article>
<script>
go.onclick=async()=>{const r=await fetch("/api/search?q="+encodeURIComponent(q.value),{headers:{authorization:${JSON.stringify(SECRET)},"x-csrf-token":"c1"}});out.textContent=JSON.stringify(await r.json())};
fetch("/api/boot",{headers:{authorization:${JSON.stringify(SECRET)},"x-csrf-token":"c1"}});
</script>`;
const seen = [];
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  seen.push({ path: u.pathname + u.search, auth: req.headers.authorization });
  if (u.pathname === "/api/search") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ q: u.searchParams.get("q"), hits: [1, 2, 3], authed: req.headers.authorization === SECRET })); return; }
  if (u.pathname === "/api/boot") { res.writeHead(200, { "content-type": "application/json" }); res.end("{\"ok\":true}"); return; }
  if (u.pathname === "/robots.txt") { res.writeHead(200, { "content-type": "text/plain" }); res.end("User-agent: *\n"); return; }
  res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

// ---- native messaging：临时 profile 里注册，relay 在临时 HOME 下运行 ----
const launcher = path.join(HOME, "nm-host.sh");
fs.writeFileSync(launcher, `#!/bin/sh\nHOME="${HOME}" exec "${process.execPath}" "${path.join(SRC, "native-messaging-host", "relay.ts")}" "$@"\n`, { mode: 0o755 });
const hostManifest = JSON.stringify({ name: "com.tabbot.connect", description: "tabbot e2e", path: launcher, type: "stdio", allowed_origins: ["chrome-extension://dkjmgdhelenchaippejoppbcfbjfgppl/"] });
fs.writeFileSync(path.join(PROFILE, "NativeMessagingHosts", "com.tabbot.connect.json"), hostManifest);
// holder 判断“装没装”看的是 HOME 下的位置（测试用的临时 HOME）
const homeManifest = process.platform === "darwin" ? path.join(HOME, "Library/Application Support/Google/Chrome/NativeMessagingHosts") : path.join(HOME, ".config/google-chrome/NativeMessagingHosts");
fs.mkdirSync(homeManifest, { recursive: true });
fs.writeFileSync(path.join(homeManifest, "com.tabbot.connect.json"), hostManifest);

const env = { ...process.env, HOME };
// 不能用 spawnSync：夹具站点在本进程里，同步等待会把它也卡住，Chrome 就加载不了页面
const cli = (...args) => new Promise((resolve) => {
  const t = Date.now();
  const child = spawn(process.execPath, [path.join(SRC, "cli", "tabbot.ts"), ...args], { env });
  let out = "", err = "";
  child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (err += d));
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  child.on("close", (code, signal) => {
    clearTimeout(timer);
    if (process.env.E2E_DEBUG) console.log(`  [${Date.now() - t}ms] tabbot ${args.join(" ")} → ${code} ${signal ?? ""} ${out.slice(0, 80).replace(/\n/g, " ")} ${err.slice(0, 200)}`);
    resolve({ code, out, err });
  });
});

const chromeArgs = [`--user-data-dir=${PROFILE}`, `--load-extension=${path.join(SRC, "chrome-extension")}`, "--no-first-run", "--no-default-browser-check", "--disable-features=DisableLoadExtensionCommandLineSwitch", ...(process.env.HEADFUL ? [] : ["--headless=new"]), ...(process.env.DEBUG_PORT ? [`--remote-debugging-port=${process.env.DEBUG_PORT}`] : []), ORIGIN + "/"];
const chrome = spawn(findChrome(), chromeArgs, { stdio: "ignore" });
const cleanup = () => { try { chrome.kill(); } catch {} try { spawnSync(process.execPath, [path.join(SRC, "cli", "tabbot.ts"), "daemon", "restart"], { env }); } catch {} server.close(); fs.rmSync(HOME, { recursive: true, force: true }); };
process.on("exit", cleanup);

try {
  // 1. 扩展连上 holder
  let ok = false;
  for (let i = 0; i < 80 && !ok; i++) { await sleep(500); ok = (await cli("tabs")).out.includes("tab"); }
  assert.ok(ok, `扩展没有连上 holder：${(await cli("tabs")).out}`);
  console.log("extension connected ok");

  // 2. 用户自己的页面被录制（页面脚本是扩展里的静态内容脚本，已打开的页面补注入）
  for (let i = 0; i < 20 && !(await cli("log", "--all")).out.includes("/api/boot"); i++) await sleep(500);
  assert.match((await cli("log")).out, /GET \/api\/boot 200/, "用户页面的请求被录制");
  const userTabs = (await cli("tabs")).out;
  assert.match(userTabs, /^1 个标签页/);
  console.log("recording ok");

  // 3. Chef 派 Cook（票据），Cook 在自己的 agent 窗口里调试，不碰用户的页面
  let r = await cli("debug", "open", ORIGIN + "/");
  assert.equal(r.code, 1); assert.match(r.out, /Chef 没有调试权限/);
  r = await cli("learn", "api-search", "--goal", "按关键词搜索", "--site", "127.0.0.1");
  assert.equal(r.code, 0, r.out + r.err);
  const tk = /票据：(t-[0-9a-f]+)/.exec(r.out)[1];
  r = await cli("debug", "--ticket", tk, "open", ORIGIN + "/");
  assert.equal(r.code, 0, r.out + r.err);
  assert.match((await cli("tabs")).out, /^1 个标签页/, "agent 窗口的页面不算用户的标签页");
  r = await cli("debug", "--ticket", tk, "snapshot"); assert.match(r.out, /搜索/, r.out + r.err);
  r = await cli("debug", "--ticket", tk, "act", "fill", "#q", "hello"); assert.equal(r.code, 0, r.out);
  r = await cli("debug", "--ticket", tk, "act", "click", "#go"); assert.equal(r.code, 0, r.out);
  await sleep(800);
  assert.match((await cli("debug", "--ticket", tk, "text")).out, /"q":"hello"/, "页面真的发了请求并渲染");
  assert.match((await cli("log", "--src", "agent")).out, /agent cmd (fill|click)/);
  console.log("learn/debug ok");

  // 4. Cook 把它写成 task（有请求就用请求），Chef 用 run / compose 执行
  r = await cli("task", "new", "api-search", "--summary", "直接用接口搜索");
  assert.equal(r.code, 0, r.out + r.err);
  fs.writeFileSync(path.join(HOME, ".tabbot", "task", "api-search.js"), `/**
 * @summary 直接用接口搜索
 * @status: draft
 * @endpoint GET /api/search
 * @param q 查询词
 */
import { tabbot, request } from "../task/lib/index.js";
await tabbot.run(async ({ page }) => {
  const res = await request(page, { url: "${ORIGIN}/api/search?q=" + encodeURIComponent(tabbot.params.q) });
  if (!res.ok) throw new Error("状态码 " + res.status);
  return res.json();
});
`);
  const t0 = Date.now();
  r = await cli("run", "api-search", "--q", "快", "--ticket", tk);
  assert.equal(r.code, 0, r.out + r.err);
  const res = JSON.parse(r.out);
  assert.equal(res.result.q, "快"); assert.equal(res.result.authed, true, "继承了页面自己的 authorization（真值只在 holder 内存里）");
  console.log(`run via request ok (${Date.now() - t0}ms)`);
  assert.match(fs.readFileSync(path.join(HOME, ".tabbot", "task", "api-search.js"), "utf8"), /@status: verified/, "真跑成功自动晋升");
  assert.match((await cli("debug", "--ticket", tk, "snapshot")).out, /已经交付/, "交付后票据失效");
  r = await cli("run", "api-search", "--q", "再来");
  assert.equal(r.code, 0); console.log("run reuse ok");
  r = await cli("compose", 'const a = await task("api-search", { q: "组合" }); return a.hits.length;');
  assert.deepEqual(JSON.parse(r.out).result, 3);

  // 5. 磁盘上没有 token 真值
  const scan = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) scan(f); else if (e.isFile() && !/profile|\.html$/.test(f)) /* 夹具页面的源码里就写着 token，渲染后的 HTML 按设计原样存 */ assert.ok(!fs.readFileSync(f).includes("REAL-E2E-TOKEN"), `${f} 里不该有真值`); } };
  scan(path.join(HOME, ".tabbot"));
  console.log("no secrets on disk ok");
  console.log("REAL E2E OK");
} catch (error) {
  console.error(error);
  try { console.error("--- holder 日志 ---\n" + fs.readFileSync(path.join(HOME, ".tabbot", "session", "log.jsonl"), "utf8").split("\n").slice(-15).join("\n")); } catch {}
  process.exitCode = 1;
}
