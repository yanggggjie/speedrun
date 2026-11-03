// 页面里（MAIN world）的录制：fetch / XHR 的请求与响应、主文档的渲染结果、用户输入、导航、页面快照。
// 只在 lore agent 窗口里上报（common.js 的 T.post 按扩展的回答放行）；只如实上报发生的事，不改变页面行为。来源只看 isTrusted。
// 不录 WebSocket、sendBeacon、Worker 里的请求。
(() => {
  const T = window.__lore;
  if (!T || T.recorder) return;
  T.recorder = 1;

  // 响应体不设策略上限；技术底线：一次消息要经扩展和 native messaging 送到 daemon（单条上限 64MiB），所以读到 16MiB 就停，并且不读事件流。
  const BODY_MAX = 16 * 1024 * 1024;
  const REQ_BODY_MAX = 256 * 1024;
  const TEXTY = /json|text|xml|javascript|html|x-www-form|graphql/i;
  const SENSITIVE_HEADER = /^(cookie|set-cookie)$/i; // 页面脚本看不到 cookie；其余请求头的真值也交给 daemon（只在内存里，用来给 request() 继承请求头）
  const post = T.post;

  // ---- 同站的粗判断（只决定读不读响应体，最终判断在 daemon）----
  const SLD = /^(com|co|org|net|gov|edu|ac)$/;
  const registrable = (host) => {
    const p = host.split(".");
    if (p.length <= 2) return host;
    const n = p.length;
    return p[n - 1].length === 2 && SLD.test(p[n - 2]) ? p.slice(-3).join(".") : p.slice(-2).join(".");
  };
  const sameSite = (url) => { try { return registrable(new URL(url).hostname) === registrable(location.hostname); } catch { return false; } };
  const readBodyOf = (url, ct) => T.foreground() && sameSite(url) && TEXTY.test(ct || "") && !/event-stream/i.test(ct || "");

  const bodyStr = (b) => {
    if (b == null) return null;
    if (typeof b === "string") return b.slice(0, REQ_BODY_MAX);
    if (b instanceof URLSearchParams) return b.toString().slice(0, REQ_BODY_MAX);
    if (b instanceof FormData) return "[FormData]";
    if (b instanceof Blob) return `[Blob ${b.size}]`;
    if (b instanceof ArrayBuffer || ArrayBuffer.isView(b)) return `[Binary ${b.byteLength}]`;
    return "[" + Object.prototype.toString.call(b) + "]";
  };
  const hdrs = (...srcs) => {
    const o = {};
    for (const h of srcs) {
      if (!h) continue;
      try {
        const it = h instanceof Headers ? [...h.entries()] : Array.isArray(h) ? h : Object.entries(h);
        for (const [k, v] of it) o[String(k).toLowerCase()] = SENSITIVE_HEADER.test(k) ? "[redacted]" : String(v).slice(0, 4000);
      } catch {}
    }
    return Object.keys(o).length ? o : null;
  };

  let seq = 0;
  const docId = Math.random().toString(36).slice(2, 10); // 这个页面文档的编号：rid = docId:请求序号，daemon 靠它找回这个请求的原始内容
  // ---- fetch ----
  const prevFetch = window.fetch;
  window.fetch = function (input, init) {
    const id = ++seq, t0 = performance.now(), fg = T.foreground();
    let url, method, reqBody = null, reqHeaders = null;
    try {
      const r = input instanceof Request ? input : null;
      url = new URL(r ? r.url : String(input), location.href).href;
      method = (init?.method || r?.method || "GET").toUpperCase();
      reqHeaders = hdrs(r?.headers, init?.headers);
      if (init && "body" in init) reqBody = bodyStr(init.body);
      else if (r && method !== "GET" && method !== "HEAD") reqBody = "[Request body not read]";
    } catch {}
    const p = prevFetch.apply(this, arguments);
    if (!fg || !T.recording()) return p;
    p.then(async (res) => {
      const rec = { k: "net", via: "fetch", id, rid: docId + ":" + id, url, finalUrl: res.url, method, reqHeaders, reqBody, status: res.status, ct: res.headers.get("content-type"), ms: Math.round(performance.now() - t0), at: Math.round(t0) };
      try {
        if (!res.body) { rec.size = 0; rec.body = ""; }
        else if (readBodyOf(url, rec.ct)) {
          const rd = res.clone().body.getReader(), dec = new TextDecoder();
          let s = "", n = 0, trunc = false;
          for (;;) {
            const { done, value } = await rd.read();
            if (done) break;
            n += value.byteLength;
            if (s.length < BODY_MAX) s += dec.decode(value, { stream: true });
            else { trunc = true; rd.cancel(); break; }
          }
          rec.truncated = trunc || s.length > BODY_MAX; rec.body = s.slice(0, BODY_MAX); rec.size = n;
        }
      } catch (e) { rec.bodyErr = String(e); }
      post(rec);
    }, (e) => post({ k: "net", via: "fetch", id, rid: docId + ":" + id, url, method, reqHeaders, reqBody, err: String(e), ms: Math.round(performance.now() - t0), at: Math.round(t0) }));
    return p;
  };

  // ---- XHR ----
  const xo = XMLHttpRequest.prototype.open, xs = XMLHttpRequest.prototype.send, xh = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (m, u) {
    try { this.__t = { method: String(m).toUpperCase(), url: new URL(String(u), location.href).href }; } catch {}
    return xo.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    if (this.__t) (this.__t.reqHeaders ||= {})[String(k).toLowerCase()] = SENSITIVE_HEADER.test(k) ? "[redacted]" : String(v).slice(0, 4000);
    return xh.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (b) {
    const t = this.__t;
    if (t) {
      if (T.foreground() && T.recording()) {
        t.reqBody = bodyStr(b);
        const t0 = performance.now();
        this.addEventListener("loadend", () => {
          const xid = ++seq, rec = { k: "net", via: "xhr", id: xid, rid: docId + ":" + xid, ...t, finalUrl: this.responseURL, status: this.status, ct: this.getResponseHeader("content-type"), ms: Math.round(performance.now() - t0), at: Math.round(t0) };
          try {
            if (readBodyOf(t.url, rec.ct)) {
              const rt = this.responseType;
              if (rt === "" || rt === "text") { rec.body = this.responseText.slice(0, BODY_MAX); rec.size = this.responseText.length; rec.truncated = this.responseText.length > BODY_MAX; }
              else if (rt === "json") { const s = JSON.stringify(this.response) || ""; rec.body = s.slice(0, BODY_MAX); rec.size = s.length; rec.truncated = s.length > BODY_MAX; }
            }
          } catch (e) { rec.bodyErr = String(e); }
          post(rec);
        });
      }
    }
    return xs.apply(this, arguments);
  };

  // ---- 页面快照与主文档 ----
  let snapTimer = 0, lastSnap = 0;
  const later = (why, ms) => {
    clearTimeout(snapTimer);
    snapTimer = setTimeout(() => { if (!T.foreground() || Date.now() - lastSnap < 1000) return; lastSnap = Date.now(); post({ k: "snap", snap: T.snap(why) }); }, ms);
  };
  // 主文档：渲染后的 DOM（不是服务器原始源码），原样上报；只记主框架的加载，不记 iframe 和单页应用的路由变化
  const captureDoc = () => {
    if (window !== window.top || !T.foreground()) return;
    try {
      const html = "<!doctype html>\n" + document.documentElement.outerHTML;
      if (html.length <= BODY_MAX) post({ k: "doc", url: location.href, html });
    } catch {}
  };
  window.addEventListener("load", () => { post({ k: "nav", via: "load", url: location.href }); later("load", 1000); setTimeout(captureDoc, 1500); });
  if (document.readyState === "complete") { later("load", 300); setTimeout(captureDoc, 800); } // 注入时页面已经加载完了
  for (const m of ["pushState", "replaceState"]) {
    const o = history[m];
    history[m] = function () { const r = o.apply(this, arguments); post({ k: "nav", via: m, url: location.href }); later("spa-nav", 600); return r; };
  }
  window.addEventListener("popstate", () => { post({ k: "nav", via: "popstate", url: location.href }); later("popstate", 600); });

  // ---- 用户输入：点击、输入、特殊键、滚动。输入只记长度，不记内容 ----
  let inputPending = null, inputTimer = 0, scrollDy = 0, scrollTrusted = false, scrollTimer = 0;
  const flushInput = () => { clearTimeout(inputTimer); if (inputPending) { post({ k: "ev", type: "input", trusted: inputPending.trusted, target: inputPending.target, n: inputPending.n }); inputPending = null; } };
  const flushScroll = () => { clearTimeout(scrollTimer); if (scrollDy) { post({ k: "ev", type: "scroll", trusted: scrollTrusted, dy: Math.round(scrollDy) }); scrollDy = 0; } };
  addEventListener("pointerdown", (e) => { if (!T.foreground()) return; flushInput(); post({ k: "ev", type: "click", trusted: e.isTrusted, target: T.desc(e.target) }); }, true);
  addEventListener("click", (e) => { if (!e.isTrusted && T.foreground()) post({ k: "ev", type: "click", trusted: false, target: T.desc(e.target) }); if (T.foreground()) later("after-click", 700); }, true);
  addEventListener("input", (e) => {
    if (!T.foreground()) return;
    const el = e.target, trusted = e.isTrusted;
    const key = T.cssPath(el);
    if (inputPending && inputPending.key !== key) flushInput();
    inputPending = { key, trusted, target: T.desc(el), n: ((el.value ?? el.textContent) || "").length };
    clearTimeout(inputTimer); inputTimer = setTimeout(flushInput, 600);
  }, true);
  addEventListener("change", (e) => { if (!T.foreground()) return; flushInput(); post({ k: "ev", type: "change", trusted: e.isTrusted, target: T.desc(e.target) }); later("after-change", 700); }, true);
  addEventListener("submit", (e) => { if (!T.foreground()) return; flushInput(); post({ k: "ev", type: "submit", trusted: e.isTrusted, target: T.desc(e.target) }); later("after-submit", 700); }, true);
  addEventListener("keydown", (e) => {
    if (!T.foreground()) return;
    const special = e.key === "Enter" || e.key === "Escape" || e.key === "Tab";
    const combo = (e.ctrlKey || e.metaKey) && e.key.length === 1;
    if (!special && !combo) return;
    flushInput();
    post({ k: "ev", type: "key", trusted: e.isTrusted, key: (combo ? (e.metaKey ? "Cmd+" : "Ctrl+") : "") + e.key, target: T.desc(e.target) });
  }, true);
  addEventListener("wheel", (e) => {
    if (!T.foreground()) return;
    scrollDy += e.deltaY; scrollTrusted = e.isTrusted;
    clearTimeout(scrollTimer); scrollTimer = setTimeout(flushScroll, 500);
  }, { capture: true, passive: true });
})();
