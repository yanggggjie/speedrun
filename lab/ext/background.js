// 实验用，非产品代码。只和本机 127.0.0.1:8766 的 hub 通信。
let CFG = { hub: "http://127.0.0.1:8766", token: "" };
try { importScripts("config.js"); CFG = self.TCR; } catch {}
const HUB = CFG.hub;
const H = { "x-tcr-token": CFG.token };
const now = () => performance.timeOrigin + performance.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (path, body) => fetch(HUB + path, { method: "POST", headers: H, body: JSON.stringify(body) }).catch(() => {});
let lease = false, tab = null, waiter = null;
const cdp = (method, params = {}) => chrome.debugger.sendCommand({ tabId: tab }, method, params);

const PAGE_JS = `(()=>{if(window.__tcrInstalled)return;window.__tcrInstalled=1;let lm=0;
const q=[];let iv=0;const flush=()=>{if(typeof __tcr!=='function')return;clearInterval(iv);iv=0;for(const m of q.splice(0))try{__tcr(m)}catch(_){}};const send=(t,e)=>{const m=JSON.stringify({t,w:performance.timeOrigin+e.timeStamp,p:e.pressure,k:e.key});if(typeof __tcr==='function'){try{__tcr(m)}catch(_){}}else{if(q.length<50)q.push(m);if(!iv)iv=setInterval(flush,20)}};
for(const t of['pointerdown','keydown','wheel'])addEventListener(t,e=>send(t,e),{capture:true,passive:true});
addEventListener('pointermove',e=>{if(e.timeStamp-lm>100){lm=e.timeStamp;send('pointermove',e)}},{capture:true,passive:true});
try{const err=new Error();Object.defineProperty(err,'stack',{get(){try{__tcr(JSON.stringify({t:'antidebug-hit',w:performance.timeOrigin+performance.now()}))}catch(_){};return''}});console.debug(err)}catch(_){}})()`;

chrome.debugger.onEvent.addListener((src, method, params) => {
  if (src.tabId !== tab || method !== "Runtime.bindingCalled" || params.name !== "__tcr") return;
  const recvAt = now(); let m; try { m = JSON.parse(params.payload); } catch { return; }
  if (m.t === "antidebug-hit") { post("/ev", { kind: "antidebug-hit", recvAt }); return; }
  if (m.t === "pointerdown" && Math.abs(m.p - 0.123) < 1e-3) return; // agent 自己的点击
  if (lease) { lease = false; const rec = { kind: "human-revoke", type: m.t, pageAt: m.w, recvAt, latencyMs: recvAt - m.w }; post("/ev", rec); waiter?.(rec); waiter = null; }
  else post("/ev", { kind: "human", type: m.t, latencyMs: recvAt - m.w });
});
chrome.debugger.onEvent.addListener((src, method, params) => {
  // E5：跨站导航后 binding 会丢（脚本还在），主框架导航后补一次 addBinding，并记录耗时
  if (src.tabId !== tab || method !== "Page.frameNavigated" || params.frame.parentId) return;
  const t0 = now();
  cdp("Runtime.addBinding", { name: "__tcr" }).then(() => post("/ev", { kind: "rebind", url: params.frame.url.slice(0, 80), ms: now() - t0 }), (e) => post("/ev", { kind: "rebind-fail", err: String(e) }));
});
chrome.debugger.onDetach.addListener((src, reason) => { if (src.tabId === tab) { post("/ev", { kind: "detached", tabId: tab, reason }); tab = null; lease = false; } });

async function attach(tabId) {
  if (tab != null) await chrome.debugger.detach({ tabId: tab }).catch(() => {});
  if (tabId == null) tabId = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id;
  await chrome.debugger.attach({ tabId }, "1.3"); tab = tabId;
  if (!globalThis.__noPageEnable) await cdp("Page.enable");
  await cdp("Runtime.addBinding", { name: "__tcr" });
  await cdp("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_JS });
  await cdp("Runtime.evaluate", { expression: PAGE_JS });
  return { tabId };
}
async function agentClick(x, y) {
  if (!lease) return { rejected: true, at: now() };
  const t0 = now();
  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1, force: 0.123 });
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  return { rejected: false, ms: now() - t0 };
}
const ops = {
  tabs: async () => (await chrome.tabs.query({})).map((t) => ({ id: t.id, win: t.windowId, active: t.active, url: t.url, title: t.title })),
  attach: (a) => attach(a.tabId),
  detach: async () => { if (tab != null) await chrome.debugger.detach({ tabId: tab }); tab = null; return {}; },
  state: async () => ({ tab, lease }),
  ping: async () => (await cdp("Runtime.evaluate", { expression: "1+1", returnByValue: true })).result.value,
  eval: async (a) => (await cdp("Runtime.evaluate", { expression: a.expr, returnByValue: true })).result,
  raw: async (a) => await cdp(a.method, a.params ?? {}),
  runtimeEnable: async () => { await cdp("Runtime.enable"); return {}; },
  grant: async () => { lease = true; return {}; },
  click: (a) => agentClick(a.x, a.y),
  // E4 一轮：给租约，等真人第一次输入把它撤销，再立刻尝试 agent 点击（应被拒绝）。
  e4round: async (a) => {
    lease = true;
    const rec = await new Promise((res) => { waiter = res; setTimeout(() => res(null), a.timeoutMs ?? 30000); });
    if (!rec) { lease = false; return { timeout: true }; }
    const retry = await agentClick(a.x ?? 50, a.y ?? 50);
    return { human: rec, agentAfter: retry, revokeToRetryMs: retry.at ? retry.at - rec.recvAt : null };
  },
};
async function loop() {
  for (;;) {
    try {
      const cmd = await (await fetch(HUB + "/cmd", { headers: H })).json();
      if (!cmd) continue;
      let result; try { result = await ops[cmd.op](cmd); } catch (e) { result = { error: String(e?.message ?? e) }; }
      await post("/res", { id: cmd.id, result });
    } catch { await sleep(1000); }
  }
}
chrome.tabs.onUpdated.addListener((id, info) => { if (id === tab && info.url) post("/ev", { kind: "nav", url: info.url }); });
chrome.alarms.create("k", { periodInMinutes: 0.5 }); chrome.alarms.onAlarm.addListener(() => {});
loop();
