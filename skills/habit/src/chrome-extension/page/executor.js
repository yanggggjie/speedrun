// 页面里（MAIN world）的执行端：等页面安静、等元素出现、读 auth 头的来源、声明式取数、替 action 的 request() 发请求。
// 不发输入：点击、按键、滚动、输入文字都由扩展用 CDP 发（cdp.js）；找元素、算坐标在 a11y.js。只管执行，不写日志，不依赖录制端。
(() => {
  const T = window.__habit;
  if (!T || T.executor) return;
  T.executor = 1;
  const TEXTY = /json|text|xml|javascript|html|x-www-form|graphql/i;

  // ---- 在途请求数：等页面稳定要用（自己数，不依赖录制端）----
  let inflight = 0;
  const done = () => { inflight--; };
  const prevFetch = window.fetch;
  window.fetch = function () { inflight++; const p = prevFetch.apply(this, arguments); p.then(done, done); return p; };
  const prevSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () { inflight++; this.addEventListener("loadend", done, { once: true }); return prevSend.apply(this, arguments); };

  // 等页面稳定：没有在途的 fetch / XHR，并且 DOM 静默一小段时间；
  const settle = (timeoutMs, quietMs = 400) => new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      const quiet = inflight === 0 && Date.now() - T.lastMut >= quietMs;
      if (quiet || Date.now() - t0 >= timeoutMs) return resolve({ settled: quiet, waitedMs: Date.now() - t0, inflight });
      setTimeout(tick, 50);
    };
    setTimeout(tick, 120); // 先给动作引发的请求一点时间发出来
  });

  T.exec.waitFor = async ({ loc, timeout = 10000, gone = false }) => {
    const t0 = Date.now();
    for (;;) {
      const n = T.find(loc).length;
      if (gone ? n === 0 : n > 0) return { ok: true, count: n, ms: Date.now() - t0 };
      if (Date.now() - t0 >= timeout) return { ok: false, count: n, error: `${Math.round(timeout / 1000)} 秒内${gone ? "没有消失" : "没有出现"}：${JSON.stringify(loc)}` };
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  // 声明式取数：{ css, fields: { 名字: "子选择器@属性" }, limit }；子选择器为空取元素自己，没有 @属性取文字。不需要 eval，严格 CSP 的页面也能用。
  // ---- auth 头的来源：只回给 daemon（比对、发送），不进日志 ----
  const STORE_MAX = 8 * 1024;
  const cookieMap = () => Object.fromEntries(document.cookie.split(/;\s*/).filter(Boolean).map((c) => { const i = c.indexOf("="); const k = c.slice(0, i); let v = c.slice(i + 1); try { v = decodeURIComponent(v); } catch {} return [k, v]; }));
  const storeMap = (st) => { const out = {}; try { for (let i = 0; i < st.length; i++) { const k = st.key(i); const v = st.getItem(k); if (v != null && v.length <= STORE_MAX) out[k] = v; } } catch {} return out; };
  const metaMap = () => Object.fromEntries([...document.querySelectorAll("meta[name],meta[property]")].map((m) => [m.getAttribute("name") || m.getAttribute("property"), m.getAttribute("content") || ""]));
  // 页面此刻的 cookie（document.cookie 能读到的）、localStorage、sessionStorage、meta：daemon 拿它和请求头的真值比对，判断来源
  T.exec.authSnapshot = () => ({ cookie: cookieMap(), local: storeMap(window.localStorage), session: storeMap(window.sessionStorage), meta: metaMap() });
  // 按来源取值：{ 头: "cookie:_xsrf" | "local:key[.路径]" | "session:key[.路径]" | "meta:名字"，可加 "Bearer " 前缀 } → { 头: 值 }；取不到的值是 null
  T.exec.authRead = (specs) => {
    const out = {};
    for (const [h, raw] of Object.entries(specs || {})) {
      const bearer = /^Bearer\s+/i.test(raw);
      const spec = raw.replace(/^Bearer\s+/i, "");
      const i = spec.indexOf(":");
      const kind = spec.slice(0, i), ref = spec.slice(i + 1);
      let v = null;
      if (kind === "cookie") v = cookieMap()[ref] ?? null;
      else if (kind === "meta") v = metaMap()[ref] ?? null;
      else if (kind === "local" || kind === "session") {
        const st = kind === "local" ? window.localStorage : window.sessionStorage;
        let key = ref, path = [];
        try { if (st.getItem(ref) == null && ref.includes(".")) { key = ref.slice(0, ref.indexOf(".")); path = ref.slice(key.length + 1).split("."); } } catch {}
        try { v = st.getItem(key); } catch { v = null; }
        if (v != null && path.length) { try { let o = JSON.parse(v); for (const p of path) o = o == null ? undefined : o[p]; v = o == null ? null : String(o); } catch { v = null; } }
      }
      out[h] = v == null ? null : bearer ? `Bearer ${v}` : v;
    }
    return out;
  };

  T.exec.query = ({ css, fields, limit = 100 }) => {
    const read = (el, spec) => {
      const [sel, attr] = String(spec).split("@");
      const node = sel ? el.querySelector(sel) : el;
      if (!node) return null;
      return attr ? node.getAttribute(attr) ?? node[attr] ?? null : String(node.innerText ?? node.textContent ?? "").trim();
    };
    const spec = fields || { text: "" };
    return [...document.querySelectorAll(css)].slice(0, limit).map((el) => Object.fromEntries(Object.entries(spec).map(([k, f]) => [k, read(el, f)])));
  };

  T.exec.ping = () => true; // 页面脚本就位的探针

  // 页面安静（没有在途请求、DOM 一小段时间没变，最多 maxMs），然后报告这次页面加载最后发出的消息序号：daemon 等它到了，就知道记录都收齐了
  T.exec.quiet = async (maxMs) => ({ ...(await settle(maxMs)), d: T.doc, n: T.n });

  // ---- 发请求（action 的 request()）：在页面里原样发一个请求（带这个页面的登录态）。用保存下来的原始 fetch，所以不会被录制端当成页面自己发的请求 ----
  T.exec.fetch = async (req) => {
    const ctl = new AbortController();
    const limit = Number(req.timeout) > 0 ? Number(req.timeout) : 20000;
    const timer = setTimeout(() => ctl.abort(), limit);
    const t0 = performance.now();
    try {
      const init = { method: req.method, headers: req.headers || {}, credentials: "include", redirect: "follow", signal: ctl.signal };
      if (req.body != null && req.method !== "GET" && req.method !== "HEAD") init.body = req.body;
      const res = await T.origFetch.call(window, req.url, init);
      const ct = res.headers.get("content-type") || "";
      const buf = await res.arrayBuffer();
      const textual = !ct || TEXTY.test(ct);
      return {
        ok: true, status: res.status, ct, size: buf.byteLength, finalUrl: res.url, ms: Math.round(performance.now() - t0),
        text: textual ? new TextDecoder().decode(buf.slice(0, 1000000)) : "", truncated: textual && buf.byteLength > 1000000,
      };
    } catch (e) {
      return { ok: false, error: e && e.name === "AbortError" ? `请求超时（${Math.round(limit / 1000)} 秒）` : String((e && e.message) || e) };
    } finally {
      clearTimeout(timer);
    }
  };
})();
