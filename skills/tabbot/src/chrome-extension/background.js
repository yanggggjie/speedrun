// tabbot Chrome 扩展：薄层 CDP 代理。
// 协议与 holder 端的实现见 src/browser/extension.ts。
// 只操作 TabBot 自己创建（或由它打开）的窗口与 tab；其余 id 一律拒绝。

import { applySets, isSafeMethod, redactHeadersForDaemon, replayHeaders, UNREPLAYABLE_BODY } from "./journal/replay-core.js";

// 这份代码支持的常驻录制操作：握手时报给 daemon。扩展的版本哈希是启动时读磁盘文件算的，磁盘更新了但扩展没刷新时哈希会骗人；
// 操作列表是正在运行的代码自己报的，daemon 据此判断扩展是不是旧版本（browser/extension.ts 的 SITE_OPS 必须与它一致）。
const SITE_OPS = ["setSites", "siteTabs", "snapshot", "leaseAcquire", "leaseRelease", "act", "replay"];

const HOST = "com.tabbot.connect";
const PROTOCOL_VERSION = 1;
const RETRY_MAX_MS = 30_000;
const KEEPALIVE_MINUTES = 0.5;

let port = null;
let retryCount = 0;
let retryTimer = null;

// 由 TabBot 拥有的窗口与 tab。
// storage.session：同一浏览器会话内 service worker 重启后 id 可信，但扩展刷新会清空它。
// storage.local：扩展刷新后仍在，但 id 在浏览器重启后会被复用，所以只在窗口里仍有标题为 tabbot 的 tab 时才信任。
const TABBOT_TITLES = new Set(["tabbot run", "tabbot record"]);
// recordWindows：录制窗口。用户在里面自己开的新 tab（没有 opener）也要纳入，run 窗口不放宽。
const owned = { windows: new Set(), tabs: new Set(), recordWindows: new Set() };
const attached = new Set();

const ready = restoreOwned();

async function restoreOwned() {
  const saved = await chrome.storage.session.get(["windows", "tabs", "recordWindows"]);
  for (const id of saved.windows ?? []) owned.windows.add(id);
  for (const id of saved.tabs ?? []) owned.tabs.add(id);
  for (const id of saved.recordWindows ?? []) owned.recordWindows.add(id);

  const persisted = await chrome.storage.local.get(["windows", "tabs", "recordWindows"]);
  const persistedTabs = new Set(persisted.tabs ?? []);
  for (const windowId of persisted.windows ?? []) {
    if (owned.windows.has(windowId)) continue;
    const win = await chrome.windows.get(windowId, { populate: true }).catch(() => null);
    if (!win?.tabs?.some((tab) => TABBOT_TITLES.has(tab.title))) continue;
    owned.windows.add(windowId);
    if ((persisted.recordWindows ?? []).includes(windowId)) owned.recordWindows.add(windowId);
    for (const tab of win.tabs) if (persistedTabs.has(tab.id)) owned.tabs.add(tab.id);
  }
  await saveOwned();
}

async function saveOwned() {
  const value = { windows: [...owned.windows], tabs: [...owned.tabs], recordWindows: [...owned.recordWindows] };
  await Promise.all([chrome.storage.session.set(value), chrome.storage.local.set(value)]);
}

function postToHost(message) {
  if (port) port.postMessage(message);
}

/**
 * 对自己的文件取哈希，随 hello 发给 daemon；算法与 setup.js 写进 .version 的 extension 一致
 * （按 EXTENSION_FILES 的顺序把字节依次拼接，SHA-256 取前 16 位十六进制，列表见 src/store/version.ts）。
 * 读不到就是空串，daemon 一侧只当"版本未知"。
 */
const EXTENSION_FILES = ["background.js", "manifest.json", "journal/hook.js", "journal/relay.js", "journal/replay-core.js"];
const buildId = (async () => {
  try {
    const parts = [];
    for (const name of EXTENSION_FILES) {
      parts.push(new Uint8Array(await (await fetch(chrome.runtime.getURL(name))).arrayBuffer()));
    }
    const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const part of parts) {
      all.set(part, offset);
      offset += part.length;
    }
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", all));
    return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
  } catch {
    return "";
  }
})();

function connect() {
  if (port) return;
  try {
    port = chrome.runtime.connectNative(HOST);
  } catch {
    scheduleRetry();
    return;
  }
  port.onMessage.addListener((msg) => {
    void handleHostMessage(msg);
  });
  port.onDisconnect.addListener(() => {
    port = null;
    scheduleRetry();
  });
  retryCount = 0;
  const current = port;
  void buildId.then((id) => {
    if (port !== current) return; // 等哈希的时候连接已经断了
    current.postMessage({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      chromeVersion: navigator.userAgent,
      extensionVersion: chrome.runtime.getManifest().version,
      buildId: id,
      ops: SITE_OPS,
    });
  });
}

function scheduleRetry() {
  if (retryTimer) return;
  const delay = Math.min(1000 * 2 ** retryCount, RETRY_MAX_MS);
  retryCount++;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, delay);
}

async function handleHostMessage(msg) {
  try {
    await ready;
    const result = msg.op === "cdp" ? await runCdp(msg) : await runTab(msg.name, msg.args ?? {});
    postToHost({ id: msg.id, result: result ?? {} });
  } catch (error) {
    postToHost({ id: msg.id, error: { message: error instanceof Error ? error.message : String(error) } });
  }
}

function requireTab(tabId) {
  if (!owned.tabs.has(tabId)) throw new Error(`tab ${tabId} 不属于 tabbot`);
}

function requireWindow(windowId) {
  if (!owned.windows.has(windowId)) throw new Error(`window ${windowId} 不属于 tabbot`);
}

async function runCdp({ tabId, method, params }) {
  requireTab(tabId);
  if (!attached.has(tabId)) throw new Error(`tab ${tabId} 未 attach`);
  return await chrome.debugger.sendCommand({ tabId }, method, params ?? {});
}

async function runTab(name, args) {
  switch (name) {
    case "openWindow": {
      const win = await chrome.windows.create({ url: "about:blank", focused: !!args.focused, type: "normal" });
      const tab = win.tabs[0];
      owned.windows.add(win.id);
      if (args.kind === "record") owned.recordWindows.add(win.id);
      owned.tabs.add(tab.id);
      await saveOwned();
      return { windowId: win.id, tabId: tab.id };
    }
    case "openTab": {
      requireWindow(args.windowId);
      const tab = await chrome.tabs.create({ windowId: args.windowId, url: args.url || "about:blank", active: !!args.active });
      owned.tabs.add(tab.id);
      await saveOwned();
      return { tabId: tab.id };
    }
    case "closeTab": {
      requireTab(args.tabId);
      await chrome.tabs.remove(args.tabId).catch(() => {});
      owned.tabs.delete(args.tabId);
      await saveOwned();
      return {};
    }
    case "closeWindow": {
      requireWindow(args.windowId);
      await chrome.windows.remove(args.windowId).catch(() => {});
      owned.windows.delete(args.windowId);
      owned.recordWindows.delete(args.windowId);
      await saveOwned();
      return {};
    }
    case "listOwned": {
      const tabs = [];
      for (const tabId of [...owned.tabs]) {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (!tab) {
          owned.tabs.delete(tabId);
          continue;
        }
        tabs.push({ tabId, windowId: tab.windowId, url: tab.url || tab.pendingUrl || "", title: tab.title || "" });
      }
      await saveOwned();
      return { tabs };
    }
    case "windowOf": {
      requireTab(args.tabId);
      const tab = await chrome.tabs.get(args.tabId);
      const win = await chrome.windows.get(tab.windowId);
      return { windowId: win.id, state: win.state };
    }
    case "attach": {
      requireTab(args.tabId);
      if (attached.has(args.tabId)) return {};
      try {
        await chrome.debugger.attach({ tabId: args.tabId }, "1.3");
      } catch (error) {
        // service worker 重启后内存里的 attached 丢了，但 debugger 仍附着：视为已附加。
        if (!String(error?.message ?? error).includes("already attached")) throw error;
      }
      attached.add(args.tabId);
      return {};
    }
    case "detach": {
      requireTab(args.tabId);
      if (attached.has(args.tabId)) {
        await chrome.debugger.detach({ tabId: args.tabId }).catch(() => {});
        attached.delete(args.tabId);
      }
      return {};
    }
    case "setSites": {
      await applySites({ mode: args.mode, sites: Array.isArray(args.sites) ? args.sites.filter((x) => typeof x === "string") : [], exclude: Array.isArray(args.exclude) ? args.exclude.filter((x) => typeof x === "string") : [] });
      return { mode: config.mode, sites: config.sites, exclude: config.exclude };
    }
    case "siteTabs": {
      await sitesReady;
      const out = [];
      for (const tab of await chrome.tabs.query({})) {
        if (tab.id == null || !tab.url || !matchSite(tab.url)) continue;
        out.push({ tabId: tab.id, windowId: tab.windowId, active: tab.active, url: tab.url, title: tab.title || "", lease: lease.has(tab.id), humanIdleMs: humanAt.has(tab.id) ? idleMs(tab.id) : null });
      }
      return { tabs: out };
    }
    case "leaseAcquire": {
      await siteTab(args.tabId);
      if (lease.has(args.tabId)) return { granted: true, already: true };
      const idle = idleMs(args.tabId);
      if (idle < HUMAN_IDLE_MS) return { granted: false, reason: "human-active", idleMs: idle };
      lease.set(args.tabId, { since: Date.now(), used: Date.now() });
      leaseEvent(args.tabId, "acquired");
      return { granted: true };
    }
    case "leaseRelease": {
      const had = lease.delete(args.tabId);
      if (had) leaseEvent(args.tabId, "released", { reason: typeof args.reason === "string" ? args.reason.slice(0, 200) : "" });
      return { released: had };
    }
    case "act": {
      return await runAct(args.tabId, args.cmd ?? {});
    }
    case "replay": {
      return await runReplay(args);
    }
    case "snapshot": {
      const tab = await siteTab(args.tabId);
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: (why, full) => (window.__tcrSnap ? window.__tcrSnap(why, full) : null),
        args: ["live", !!args.full],
      });
      if (!res?.result) throw new Error("页面里没有录制脚本（刷新这个页面后再试）");
      return { snap: res.result };
    }
    default:
      throw new Error(`未知操作 ${name}`);
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId == null || !owned.tabs.has(source.tabId)) return;
  postToHost({ type: "event", tabId: source.tabId, method, params });
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId == null) return;
  attached.delete(source.tabId);
  postToHost({ type: "tab", kind: "detached", tabId: source.tabId, reason });
});

// 自动纳入新 tab：opener 属于 tabbot，或者它开在录制窗口里（用户自己按 Cmd+T 开的 tab 没有 opener）。窗口同样纳入。
chrome.tabs.onCreated.addListener(async (tab) => {
  await ready;
  const byOpener = tab.openerTabId != null && owned.tabs.has(tab.openerTabId);
  if (!byOpener && !owned.recordWindows.has(tab.windowId)) return;
  owned.tabs.add(tab.id);
  owned.windows.add(tab.windowId);
  await saveOwned();
  postToHost({
    type: "tab",
    kind: "created",
    tabId: tab.id,
    windowId: tab.windowId,
    openerTabId: tab.openerTabId,
    url: tab.pendingUrl || tab.url || "",
  });
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  await ready;
  if (!owned.tabs.has(tabId) || changeInfo.url == null) return;
  postToHost({ type: "tab", kind: "updated", tabId, windowId: tab.windowId, url: changeInfo.url });
});

chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  await ready;
  if (!owned.tabs.has(tabId)) return;
  attached.delete(tabId);
  owned.tabs.delete(tabId);
  await saveOwned();
  postToHost({ type: "tab", kind: "removed", tabId, windowId: removeInfo.windowId });
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  await ready;
  if (!owned.windows.has(windowId)) return;
  owned.windows.delete(windowId);
  owned.recordWindows.delete(windowId);
  await saveOwned();
});

// ---- 常驻录制（journal）----
// 在录制范围内的站点注册内容脚本（hook.js 在页面里，relay.js 在隔离世界），把观察到的事件批量交给 daemon。
// 范围由 daemon 经 setSites 下发并存在 storage.local：默认录所有 http/https 站点但排除敏感站点（mode "all" + exclude），
// 或只录点名的站点（mode "only"）。脚本注册是动态的，manifest 不变，改范围不需要重新加载扩展。
// 只读操作（tabs、snapshot）只对范围内站点的 tab 生效，不要求 tab 由 TabBot 创建。
const JOURNAL_SCRIPTS = [
  { id: "tc-hook", js: ["journal/hook.js"], world: "MAIN" },
  { id: "tc-relay", js: ["journal/relay.js"], world: "ISOLATED" },
];
const JOURNAL_BUFFER_MAX = 2000;
const JOURNAL_FLUSH_MS = 300;
// 还没收到 daemon 下发的范围之前，什么都不录（只录点名站点，但一个也没有）。
let config = { mode: "only", sites: [], exclude: [] };
let journalBuffer = [];
let journalTimer = null;
const siteTabs = new Map(); // tabId -> 最近一次的 URL（只放录制范围内的 tab，用来在关闭时记一条 closed）

const sitesReady = chrome.storage.local.get(["journalConfig", "sites"]).then((saved) => {
  if (saved.journalConfig && (saved.journalConfig.mode === "all" || saved.journalConfig.mode === "only")) config = saved.journalConfig;
  else if (Array.isArray(saved.sites)) config = { mode: "only", sites: saved.sites, exclude: [] }; // 旧版存的是只录点名站点的列表
});

const hostMatches = (host, domain) => host === domain || host.endsWith("." + domain);

function matchSite(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (config.mode === "all") return !config.exclude.some((d) => hostMatches(u.hostname, d));
    return config.sites.some((d) => hostMatches(u.hostname, d));
  } catch {
    return false;
  }
}

function pushJournal(event) {
  journalBuffer.push(event);
  if (journalBuffer.length > JOURNAL_BUFFER_MAX) journalBuffer.splice(0, journalBuffer.length - JOURNAL_BUFFER_MAX);
  if (!journalTimer) journalTimer = setTimeout(flushJournal, JOURNAL_FLUSH_MS);
}

function flushJournal() {
  journalTimer = null;
  if (!port || journalBuffer.length === 0) return; // 没连上 daemon 时攒着（有上限），连上后下一次推送带出去
  const events = journalBuffer;
  journalBuffer = [];
  postToHost({ type: "journal", events });
}

async function applySites(next) {
  config = { mode: next.mode === "all" ? "all" : "only", sites: [...new Set(next.sites ?? [])], exclude: [...new Set(next.exclude ?? [])] };
  await chrome.storage.local.set({ journalConfig: config });
  await chrome.scripting.unregisterContentScripts({ ids: JOURNAL_SCRIPTS.map((s) => s.id) }).catch(() => {});
  const domainPatterns = (list) => list.flatMap((d) => [`*://${d}/*`, `*://*.${d}/*`]);
  let matches;
  let excludeMatches = [];
  if (config.mode === "all") {
    matches = ["http://*/*", "https://*/*"];
    excludeMatches = domainPatterns(config.exclude);
  } else {
    if (config.sites.length === 0) return;
    matches = domainPatterns(config.sites);
  }
  await chrome.scripting.registerContentScripts(
    JOURNAL_SCRIPTS.map((s) => ({
      ...s, matches, ...(excludeMatches.length ? { excludeMatches } : {}),
      runAt: "document_start", allFrames: true, matchOriginAsFallback: true, persistAcrossSessions: true,
    })),
  );
  // 已经打开的 tab 不会重新加载，补注入一次（两个脚本都是幂等的）。
  for (const tab of await chrome.tabs.query({})) {
    if (tab.id == null || !tab.url || !matchSite(tab.url)) continue;
    siteTabs.set(tab.id, tab.url);
    for (const s of JOURNAL_SCRIPTS) {
      chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: s.js, world: s.world }).catch(() => {});
    }
  }
}

async function siteTab(tabId) {
  await sitesReady;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !tab.url || !matchSite(tab.url)) throw new Error(`tab ${tabId} 不在录制范围内（站点被排除，或不是 http/https 页面）`);
  return tab;
}

// ---- 租约：agent 能不能在这个 tab 上动手（只管写，读不受影响）----
// 状态在扩展里，人一动手就在这里本地撤销（不经过 daemon，毫秒级）。agent 的动作是页面内的合成事件（页面脚本上报的 trusted 标记为 false），
// 所以 trusted 标记为真的输入一定是人。扩展 service worker 重启会丢租约，这是安全的一侧：agent 要重新 takeover。
const lease = new Map(); // tabId -> { since, used }
const humanAt = new Map(); // tabId -> 最近一次真人输入的时间
const HUMAN_IDLE_MS = 1500; // 真人输入之后这段时间内不能获取租约
const LEASE_IDLE_MS = 10 * 60_000; // 租约超过这么久没有动作就失效，避免忘了交还
const NAVIGATION_ERROR = /frame|removed|navigat|closed|destroyed/i;

function leaseEvent(tabId, state, extra = {}) {
  postToHost({ type: "lease", tab: tabId, state, t: Date.now(), ...extra });
}

/** 真人输入：撤销租约（滚轮、滚动只当"人在场"，不撤销，因为 agent 用元素引用定位，滚动不会让目标失效）。 */
function humanInput(tabId, kind) {
  humanAt.set(tabId, Date.now());
  if (kind === "wheel" || kind === "scroll") return;
  if (lease.delete(tabId)) leaseEvent(tabId, "revoked", { reason: "human", by: kind });
}

const idleMs = (tabId) => Date.now() - (humanAt.get(tabId) ?? 0);

async function waitComplete(tabId, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab || tab.status !== "loading") return tab;
    await new Promise((r) => setTimeout(r, 100));
  }
  return chrome.tabs.get(tabId).catch(() => null);
}

/** 这个 tab 的租约还有效吗（超过 LEASE_IDLE_MS 没有动作就失效）；有效就记一次使用。 */
function leaseHeld(tabId) {
  const held = lease.get(tabId);
  if (held && Date.now() - held.used > LEASE_IDLE_MS) { lease.delete(tabId); leaseEvent(tabId, "expired", { reason: "idle" }); return false; }
  if (!held) return false;
  held.used = Date.now();
  return true;
}

// ---- 原始请求：真值只留在浏览器里 ----
// 页面里发出的每个同站请求，原始内容（含请求头里的 token 真值）存在 chrome.storage.session（浏览器自己的、不落盘的会话存储），
// 浏览器重启就没了；转给 daemon 的那份请求头里，名字像秘密的已经抹掉。重放就用这份原始内容，在页面里发，
// agent 和日志里只有别名。超过上限先丢最旧的。
const RAW_MAX_BYTES = 4 * 1024 * 1024;
const RAW_ITEM_MAX = 64 * 1024;
const RAW_PERSIST_MS = 800;
const rawReqs = new Map(); // `${tabId}:${rid}` -> { m, u, h, b, t, size }
let rawBytes = 0;
let rawTimer = null;
const rawReady = chrome.storage.session.get(["rawReqs"]).then((saved) => {
  for (const [k, v] of Object.entries(saved.rawReqs ?? {})) if (!rawReqs.has(k)) { rawReqs.set(k, v); rawBytes += v.size; }
});

const SLD = /^(com|co|org|net|gov|edu|ac)$/;
const registrable = (host) => {
  const p = host.split(".");
  if (p.length <= 2) return host;
  const n = p.length;
  return p[n - 1].length === 2 && SLD.test(p[n - 2]) ? p.slice(-3).join(".") : p.slice(-2).join(".");
};
const sameSite = (a, b) => { try { return registrable(new URL(a).hostname) === registrable(new URL(b).hostname); } catch { return false; } };

function rememberRaw(tabId, msg, pageUrl) {
  if (msg.k !== "net" || !msg.rid || msg.via === "beacon" || !msg.url || !msg.method) return;
  if (pageUrl && !sameSite(msg.url, pageUrl)) return; // 重放只发给标签页自己的站点，第三方的不存
  const entry = { m: msg.method, u: msg.url, h: msg.reqHeaders ?? {}, b: typeof msg.reqBody === "string" ? msg.reqBody : null, t: msg.t ?? Date.now() };
  entry.size = JSON.stringify(entry).length;
  if (entry.size > RAW_ITEM_MAX) return;
  const key = `${tabId}:${msg.rid}`;
  const old = rawReqs.get(key);
  if (old) rawBytes -= old.size;
  rawReqs.set(key, entry);
  rawBytes += entry.size;
  for (const [k, v] of rawReqs) { if (rawBytes <= RAW_MAX_BYTES) break; rawReqs.delete(k); rawBytes -= v.size; } // Map 按插入顺序，先丢最旧的
  if (!rawTimer) rawTimer = setTimeout(persistRaw, RAW_PERSIST_MS);
}

function persistRaw() {
  rawTimer = null;
  chrome.storage.session.set({ rawReqs: Object.fromEntries(rawReqs) }).catch(() => {});
}

/**
 * 重放：取出这个请求的原始内容，应用 --set，在页面里原样发出（带这个页面的登录态）。
 * 只能发给标签页自己的站点；GET 和 HEAD 不需要租约，其它方法有副作用，和 act 一样要租约（要不要 --yes 由 daemon 先挡）。
 */
async function runReplay(args) {
  const tab = await siteTab(args.tabId);
  await rawReady;
  const entry = rawReqs.get(`${args.rawTab}:${args.rid}`);
  if (!entry) return { ok: false, error: "这个请求的原始内容已经不在浏览器里了（浏览器重启、太旧被清掉，或者是扩展刷新前录的）。在页面上再触发一次这个操作，然后重试" };
  if (typeof entry.b === "string" && UNREPLAYABLE_BODY.test(entry.b)) return { ok: false, error: "这个请求的请求体是文件、二进制或表单数据，没法重放" };
  const applied = applySets({ method: entry.m, url: entry.u, headers: replayHeaders(entry.h), body: entry.b }, Array.isArray(args.sets) ? args.sets : []);
  if (applied.error) return { ok: false, error: applied.error };
  const req = { ...applied.template, method: String(applied.template.method).toUpperCase() };
  let origin, tabOrigin;
  try { origin = new URL(req.url).origin; tabOrigin = new URL(tab.url).origin; } catch { return { ok: false, error: "请求地址不是有效的网址" }; }
  if (origin !== tabOrigin) return { ok: false, error: `请求的站点 ${origin} 和这个标签页（${tabOrigin}）不同源，只能在同源的标签页里重放` };
  if (!isSafeMethod(req.method) && !leaseHeld(args.tabId)) return { ok: false, rejected: "no-lease", humanIdleMs: idleMs(args.tabId) };
  const [res] = await chrome.scripting.executeScript({
    target: { tabId: args.tabId },
    world: "MAIN",
    func: (r) => (window.__tcrReplay ? window.__tcrReplay(r) : { ok: false, error: "页面里没有录制脚本（刷新这个页面后再试）" }),
    args: [req],
  });
  const result = res?.result ?? { ok: false, error: "页面没有返回结果" };
  return { ...result, sentUrl: req.url, sentMethod: req.method };
}

/** 执行 agent 的一个动作：先看租约，再在页面里执行；动作引发页面跳转（点链接、提交表单）算成功。 */
async function runAct(tabId, cmd) {
  await siteTab(tabId);
  if (!leaseHeld(tabId)) return { ok: false, rejected: "no-lease", humanIdleMs: idleMs(tabId) };
  let result;
  if (cmd.kind === "goto") {
    await chrome.tabs.update(tabId, { url: cmd.url });
    result = { ok: true, navigated: true };
  } else {
    try {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: (c) => (window.__tcrAct ? window.__tcrAct(c) : { ok: false, error: "页面里没有录制脚本（刷新这个页面后再试）" }),
        args: [cmd],
      });
      result = res?.result ?? { ok: false, error: "页面没有返回结果" };
    } catch (error) {
      if (!NAVIGATION_ERROR.test(String(error?.message ?? error))) throw error;
      result = { ok: true, navigated: true };
    }
  }
  if (result.navigated) {
    const tab = await waitComplete(tabId, 15_000);
    if (tab) { result.url = tab.url; result.title = tab.title; }
  }
  if (!lease.has(tabId)) result.revokedDuring = true; // 动作执行期间，人动手了
  return result;
}

chrome.runtime.onMessage.addListener((m, sender) => {
  if (!m || m.__tcrl !== 1 || sender.id !== chrome.runtime.id || !sender.tab) return;
  const { __tcrl, ...msg } = m.msg ?? {};
  void __tcrl;
  const tabId = sender.tab.id;
  if (msg.k === "presence") { humanInput(tabId, msg.kind); return; } // 在场信号只给租约用，不进日志
  if (msg.k === "ev" && msg.trusted === true) humanInput(tabId, msg.type);
  rememberRaw(tabId, msg, m.page);
  const forwarded = msg.k === "net" && msg.reqHeaders ? { ...msg, reqHeaders: redactHeadersForDaemon(msg.reqHeaders) } : msg;
  pushJournal({ ...forwarded, tab: tabId, frame: sender.frameId ?? 0, top: m.top, page: m.page });
});

function tabEvent(ev, tabId, url) {
  pushJournal({ k: "tab", t: Date.now(), ev, tab: tabId, frame: 0, url });
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  await sitesReady;
  if (changeInfo.url == null) return;
  const was = siteTabs.has(tabId);
  const now = matchSite(changeInfo.url);
  if (now) {
    siteTabs.set(tabId, changeInfo.url);
    tabEvent(was ? "url" : "opened", tabId, changeInfo.url);
  } else if (was) {
    siteTabs.delete(tabId);
    tabEvent("left", tabId, "");
  }
  void tab;
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await sitesReady;
  lease.delete(tabId);
  humanAt.delete(tabId);
  const url = siteTabs.get(tabId);
  if (url === undefined) return;
  siteTabs.delete(tabId);
  tabEvent("closed", tabId, url);
});


// service worker 每次启动都尝试连接；onStartup / onInstalled 显式触发，alarm 兜底。
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "tabbot-keepalive" && !port) connect();
});
// 点击工具栏图标：唤醒 service worker 并立即尝试连接（need-extension 的提示让用户点一下它）。
chrome.action.onClicked.addListener(connect);
chrome.alarms.create("tabbot-keepalive", { periodInMinutes: KEEPALIVE_MINUTES });
connect();
