// 在真实 Chrome 里验证 journal/hook.js 的动作：点击、填写、选择、勾选、按键、滚动、等页面稳定。
// 用法：node scripts/dev/hook-e2e.mjs（本机要装 Chrome；路径不同时用 CHROME 环境变量指定）。不是自检，不在 npm test 里。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = fs.readFileSync(path.join(HERE, "../../src/chrome-extension/journal/hook.js"), "utf8");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE = `<!doctype html><meta charset=utf-8><title>fixture</title><style>#box{height:80px;overflow:auto;border:1px solid}#box div{height:400px}</style>
<button id=b>点我</button><a id=a href="/next">下一页</a><input id=q name=q placeholder="搜索"><textarea id=t placeholder="备注"></textarea>
<select id=s><option value=a>苹果</option><option value=b>香蕉</option></select><label><input id=c type=checkbox>同意</label>
<div id=ce contenteditable=true>可编辑</div><form id=f action="/submit"><input id=fq name=fq placeholder="表单"></form>
<button id=slow>慢请求</button><div id=box><div>滚动区</div></div><div style="height:2000px"></div>
<script>
window.__log=[];const L=(t,e)=>__log.push({t,trusted:e.isTrusted,target:e.target.id||e.target.tagName});
for(const t of ["click","input","change","keydown","keyup","submit"])addEventListener(t,e=>L(t,e),true);
b.onclick=()=>{b.dataset.n=(+b.dataset.n||0)+1};
slow.onclick=()=>{fetch("/slow").then(r=>r.text()).then(x=>{slow.textContent="完成:"+x})};
// 模拟 React：只认 input 事件里读到的值
q.addEventListener("input",()=>{window.__q=q.value});
</script>`;
const server = http.createServer((req, res) => {
  if (req.url === "/slow") { setTimeout(() => { res.end("ok"); }, 700); return; }
  if (req.url.split("?")[0] === "/echo") { let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ method: req.method, headers: req.headers, body })); }); return; }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(req.url.startsWith("/submit") ? "<title>submitted</title>已提交" : req.url === "/next" ? "<title>next</title>下一页" : PAGE);
}).listen(8793, "127.0.0.1");

const udd = fs.mkdtempSync(path.join(os.tmpdir(), "tabbot-hook-e2e-"));
const chrome = spawn(CHROME, ["--headless=new", `--user-data-dir=${udd}`, "--remote-debugging-port=9677", "--no-first-run", "about:blank"], { stdio: "ignore" });
process.on("exit", () => { try { chrome.kill(); } catch {} }); // 脚本被打断时兜底
async function cleanup() {
  server.close();
  if (chrome.exitCode === null) { chrome.kill(); await once(chrome, "exit"); } // 等 Chrome 退出再删它的配置目录
  fs.rmSync(udd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
try {
  let ver; for (let i = 0; i < 60 && !ver; i++) { try { ver = await (await fetch("http://127.0.0.1:9677/json/version")).json(); } catch { await sleep(200); } }
  const ws = new WebSocket(ver.webSocketDebuggerUrl); await new Promise((r) => (ws.onopen = r));
  let id = 0; const pend = new Map(); ws.onmessage = (m) => { const d = JSON.parse(m.data); pend.get(d.id)?.(d); };
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => { const i = ++id; pend.set(i, (d) => (d.error ? rej(new Error(d.error.message)) : res(d.result))); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId: S } = await send("Target.attachToTarget", { targetId, flatten: true });
  const ev = async (e) => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }, S); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result?.value; };
  await send("Page.enable", {}, S);
  await send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__msgs=[];addEventListener("message",(e)=>{if(e.data&&e.data.__tcrl===1)window.__msgs.push(e.data)});` + HOOK }, S);
  const open = async (p) => { await send("Page.navigate", { url: `http://127.0.0.1:8793${p}` }, S); await sleep(700); };
  const snapRefs = async () => { const s = await ev("JSON.stringify(__tcrSnap('live', true))"); const snap = JSON.parse(s); const byId = {}; for (const i of snap.items) byId[i.s.split(">").pop()] = i.ref; return { snap, byId }; };
  // 动作引发页面跳转时，页面里等"稳定"的脚本会被打断（Inspected target navigated）：这是成功，扩展里也按同样方式处理
  const act = (cmd) => ev(`__tcrAct(${JSON.stringify(cmd)}).then(JSON.stringify)`).then(JSON.parse, (e) => {
    if (/navigated|closed|destroyed/i.test(String(e.message))) return { ok: true, navigated: true };
    throw e;
  });
  const logOf = async () => JSON.parse(await ev("JSON.stringify(__log.splice(0))"));

  await open("/");
  const { snap, byId } = await snapRefs();
  const ref = (sel) => { const r = Object.entries(byId).find(([k]) => k.includes(sel))?.[1]; assert.ok(r, `快照里找不到 ${sel}：${Object.keys(byId).join(" ")}`); return `@${r}`; };
  assert.ok(snap.items.every((i) => /^e\d+$/.test(i.ref)), "元素引用是 e+数字");
  const again = await snapRefs(); assert.deepEqual(again.byId, byId, "页面不变时，重新取快照引用不变（稳定）");

  // click：触发页面的 click 处理，事件不可信（isTrusted 为 false）
  let r = await act({ kind: "click", ref: ref("#b") }); assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(await ev("b.dataset.n"), "1");
  let log = await logOf(); assert.ok(log.some((l) => l.t === "click" && l.target === "b"));
  assert.ok(log.every((l) => l.trusted === false), "agent 的事件 isTrusted 一定是 false：" + JSON.stringify(log));

  // fill：框架读到的值要对（走 input 事件），有 change；输入框和 textarea、contenteditable 都行
  r = await act({ kind: "fill", ref: ref("#q"), text: "你好 tabbot" }); assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(await ev("window.__q"), "你好 tabbot"); assert.equal(r.chars, 9);
  r = await act({ kind: "fill", ref: ref("#t"), text: "line" }); assert.equal(await ev("t.value"), "line");
  r = await act({ kind: "fill", ref: ref("#ce"), text: "新内容" }); assert.equal(await ev("ce.textContent"), "新内容");
  r = await act({ kind: "fill", ref: ref("#b"), text: "x" }); assert.equal(r.ok, false); assert.match(r.error, /不是输入框/);

  // select / check
  r = await act({ kind: "select", ref: ref("#s"), text: "香蕉" }); assert.equal(await ev("s.value"), "b");
  r = await act({ kind: "select", ref: ref("#s"), text: "西瓜" }); assert.equal(r.ok, false); assert.match(r.error, /没有选项/);
  r = await act({ kind: "check", ref: ref("#c") }); assert.equal(r.checked, true);
  r = await act({ kind: "check", ref: ref("#c"), checked: false }); assert.equal(r.checked, false);

  // press：Enter 提交表单；键盘事件在目标上
  await logOf();
  await act({ kind: "fill", ref: ref("#fq"), text: "abc" });
  r = await act({ kind: "press", ref: ref("#fq"), key: "Enter" }); assert.equal(r.ok, true, JSON.stringify(r));
  await sleep(600); assert.match(await ev("document.title"), /submitted/, "Enter 触发了表单提交");

  // 点链接：合成的 click 也会触发导航
  await open("/"); const second = await snapRefs();
  r = await act({ kind: "click", ref: "@" + second.byId["#a"] }); await sleep(600);
  assert.match(await ev("document.title"), /next/, "点链接导航到了下一页");

  // scroll
  await open("/"); const third = await snapRefs();
  r = await act({ kind: "scroll", dy: 300 }); assert.ok((await ev("scrollY")) >= 290, "页面滚动了");
  r = await act({ kind: "scroll", to: "top" }); assert.equal(await ev("scrollY"), 0);
  r = await act({ kind: "scroll", ref: "@" + third.byId["#box"], dy: 120 }); assert.ok((await ev("box.scrollTop")) >= 100, "容器里滚动了");

  // 等页面稳定：点慢请求按钮，动作返回时请求已经完成
  r = await act({ kind: "click", ref: "@" + third.byId["#slow"] });
  assert.equal(r.settle.settled, true, JSON.stringify(r)); assert.ok(r.settle.waitedMs >= 600, "等到了 700ms 的请求完成");
  assert.equal(await ev("slow.textContent"), "完成:ok");

  // 引用失效：元素被页面移除
  await ev("b.remove()"); r = await act({ kind: "click", ref: ref("#b") }); assert.equal(r.ok, false); assert.match(r.error, /已不在页面上/);
  r = await act({ kind: "click", ref: "@e99999" }); assert.equal(r.ok, false);

  // 重放：在页面里原样发请求（带这个页面的登录态和请求头），不会被当成页面自己发的请求记进日志
  await open("/");
  await ev(`document.cookie = "sid=abc123; path=/"`);
  const replay = (req) => ev(`__tcrReplay(${JSON.stringify(req)}).then(JSON.stringify)`).then(JSON.parse);
  r = await replay({ method: "POST", url: "http://127.0.0.1:8793/echo", headers: { "x-token": "RAW-VALUE", "content-type": "application/json" }, body: "{\"a\":1}" });
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.status, 200);
  const echoed = JSON.parse(r.text);
  assert.equal(echoed.method, "POST"); assert.equal(echoed.body, "{\"a\":1}");
  assert.equal(echoed.headers["x-token"], "RAW-VALUE", "自定义请求头原样带上");
  assert.match(echoed.headers.cookie, /sid=abc123/, "带着这个页面的登录态（cookie）");
  r = await replay({ method: "GET", url: "http://127.0.0.1:8793/echo?x=1", headers: {} });
  assert.equal(JSON.parse(r.text).method, "GET");
  r = await replay({ method: "GET", url: "http://127.0.0.1:8793/missing", headers: {} });
  assert.equal(r.ok, true); assert.equal(r.status, 200, "夹具对未知路径返回页面，状态码原样返回");
  r = await replay({ method: "GET", url: "http://127.0.0.1:1/", headers: {} });
  assert.equal(r.ok, false); assert.ok(r.error, "连不上：返回错误，不抛异常");
  await sleep(400);
  const nets = JSON.parse(await ev("JSON.stringify(__msgs.filter((m) => m.k === 'net' && /\\/echo/.test(m.url)))"));
  assert.equal(nets.length, 0, "重放用的是原始 fetch，不会被当成页面自己发的请求：" + JSON.stringify(nets));
  // 页面自己发的请求带 rid（docId:序号），扩展靠它找回原始内容
  await ev(`fetch("/echo", { method: "POST", headers: { authorization: "Bearer PAGE-RAW" }, body: JSON.stringify({ z: 1 }) }).then((x) => x.text())`);
  await sleep(500);
  const own = JSON.parse(await ev("JSON.stringify(__msgs.filter((m) => m.k === 'net' && /\\/echo/.test(m.url)))"));
  assert.equal(own.length, 1); assert.match(own[0].rid, /^[a-z0-9]{1,8}:\d+$/);
  assert.equal(own[0].reqHeaders.authorization, "Bearer PAGE-RAW", "页面脚本把请求头的真值交给扩展（扩展转给 daemon 前会抹掉）");
  assert.equal(own[0].reqBody, "{\"z\":1}");

  console.log("hook e2e ok");
} finally {
  await cleanup();
}
