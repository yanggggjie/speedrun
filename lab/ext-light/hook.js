(() => {
  if (window.__tcrlInstalled) return;
  window.__tcrlInstalled = 1;
  const CAP = 256 * 1024;
  const post = (o) => { try { window.postMessage({ __tcrl: 1, t: Date.now(), ...o }, "*"); } catch {} };
  const TEXTY = /json|text|xml|javascript|html|x-www-form|graphql/i;
  let seq = 0;
  const bodyStr = (b) => {
    if (b == null) return null;
    if (typeof b === "string") return b.slice(0, CAP);
    if (b instanceof URLSearchParams) return b.toString().slice(0, CAP);
    if (b instanceof FormData) return "[FormData]";
    if (b instanceof Blob) return `[Blob ${b.size}]`;
    if (b instanceof ArrayBuffer || ArrayBuffer.isView(b)) return `[Binary ${b.byteLength}]`;
    return "[" + Object.prototype.toString.call(b) + "]";
  };

  const SENSITIVE = /^(cookie|authorization|proxy-authorization|set-cookie)$/i;
  const hdrs = (...srcs) => {
    const o = {};
    for (const h of srcs) {
      if (!h) continue;
      try {
        const it = h instanceof Headers ? [...h.entries()] : Array.isArray(h) ? h : Object.entries(h);
        for (const [k, v] of it) o[String(k).toLowerCase()] = SENSITIVE.test(k) ? "[redacted]" : String(v).slice(0, 500);
      } catch {}
    }
    return Object.keys(o).length ? o : null;
  };

  // ---- fetch ----
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const id = ++seq, t0 = performance.now();
    let url, method, reqBody = null, reqHeaders = null;
    try {
      const r = input instanceof Request ? input : null;
      url = new URL(r ? r.url : String(input), location.href).href;
      reqHeaders = hdrs(r?.headers, init?.headers);
      method = (init?.method || r?.method || "GET").toUpperCase();
      if (init && "body" in init) reqBody = bodyStr(init.body);
      else if (r && method !== "GET" && method !== "HEAD") reqBody = "[Request body not read]";
    } catch {}
    const p = origFetch.apply(this, arguments);
    p.then(async (res) => {
      const rec = { k: "net", via: "fetch", id, url, finalUrl: res.url, method, reqHeaders, reqBody, status: res.status, ct: res.headers.get("content-type"), ms: Math.round(performance.now() - t0) };
      try {
        if (!res.body) { rec.size = 0; rec.body = ""; }
        else if (!TEXTY.test(rec.ct || "")) { rec.bodyKind = "skipped-nontext"; }
        else {
          const rd = res.clone().body.getReader(), dec = new TextDecoder();
          let s = "", n = 0, trunc = false;
          for (;;) {
            const { done, value } = await rd.read();
            if (done) break;
            n += value.byteLength;
            if (s.length < CAP) s += dec.decode(value, { stream: true });
            else { trunc = true; rd.cancel(); break; }
          }
          rec.truncated = trunc || s.length > CAP; rec.body = s.slice(0, CAP); rec.size = n;
        }
      } catch (e) { rec.bodyErr = String(e); }
      post(rec);
    }, (e) => post({ k: "net", via: "fetch", id, url, method, reqHeaders, reqBody, err: String(e) }));
    return p;
  };

  // ---- XHR ----
  const xo = XMLHttpRequest.prototype.open, xs = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) {
    try { this.__t = { method: String(m).toUpperCase(), url: new URL(String(u), location.href).href }; } catch {}
    return xo.apply(this, arguments);
  };
  const xh = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    if (this.__t) (this.__t.reqHeaders ||= {})[String(k).toLowerCase()] = SENSITIVE.test(k) ? "[redacted]" : String(v).slice(0, 500);
    return xh.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (b) {
    const t = this.__t;
    if (t) {
      t.reqBody = bodyStr(b);
      const t0 = performance.now();
      this.addEventListener("loadend", () => {
        const rec = { k: "net", via: "xhr", id: ++seq, ...t, finalUrl: this.responseURL, status: this.status, ct: this.getResponseHeader("content-type"), ms: Math.round(performance.now() - t0) };
        try {
          const rt = this.responseType;
          if (rt === "" || rt === "text") { rec.body = this.responseText.slice(0, CAP); rec.size = this.responseText.length; rec.truncated = this.responseText.length > CAP; }
          else if (rt === "json") { const s = JSON.stringify(this.response) || ""; rec.body = s.slice(0, CAP); rec.size = s.length; rec.truncated = s.length > CAP; }
          else rec.bodyKind = "skipped-" + rt;
        } catch (e) { rec.bodyErr = String(e); }
        post(rec);
      });
    }
    return xs.apply(this, arguments);
  };

  // ---- beacon ----
  const ob = navigator.sendBeacon?.bind(navigator);
  if (ob) navigator.sendBeacon = function (u, d) {
    post({ k: "net", via: "beacon", id: ++seq, url: new URL(String(u), location.href).href, method: "POST", reqBody: bodyStr(d) });
    return ob(u, d);
  };

  // ---- WebSocket ----
  const OW = window.WebSocket;
  window.WebSocket = function (u, p) {
    const ws = p === undefined ? new OW(u) : new OW(u, p);
    const id = ++seq; let tx = 0, rx = 0;
    post({ k: "ws", id, ev: "open", url: String(u) });
    const os = ws.send.bind(ws);
    ws.send = (d) => { tx++; if (tx <= 3) post({ k: "ws", id, ev: "tx", data: bodyStr(d) }); return os(d); };
    ws.addEventListener("message", (e) => { rx++; if (rx <= 3) post({ k: "ws", id, ev: "rx", data: bodyStr(e.data) }); });
    ws.addEventListener("close", () => post({ k: "ws", id, ev: "close", tx, rx }));
    return ws;
  };
  window.WebSocket.prototype = OW.prototype;
  Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });

  // ---- DOM description / snapshot ----
  const cssPath = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 6; n = n.parentElement) {
      if (n.id) { parts.unshift("#" + CSS.escape(n.id)); break; }
      let i = 1; for (let s = n.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === n.tagName) i++;
      parts.unshift(n.tagName.toLowerCase() + (i > 1 ? `:nth-of-type(${i})` : ""));
    }
    return parts.join(">");
  };
  const desc = (el) => {
    if (!el || el.nodeType !== 1) return null;
    const t = (el.getAttribute("aria-label") || el.innerText || el.value || el.getAttribute("placeholder") || el.title || "").trim().replace(/\s+/g, " ").slice(0, 60);
    return { tag: el.tagName.toLowerCase(), role: el.getAttribute("role"), type: el.type || null, name: el.name || null, text: el.type === "password" ? "[redacted]" : t, sel: cssPath(el) };
  };
  const INTERACTIVE = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=switch],[role=combobox],[role=textbox],[contenteditable=""],[contenteditable=true],[onclick],[tabindex]:not([tabindex="-1"])';
  const walk = (root, out, depth) => {
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot && depth < 5) walk(el.shadowRoot, out, depth + 1);
    }
    for (const el of root.querySelectorAll(INTERACTIVE)) out.push(el);
  };
  const visible = (el) => { const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; const cs = getComputedStyle(el); return cs.visibility !== "hidden" && cs.display !== "none"; };
  const MAX_ITEMS = 60;
  const snap = (why, full) => {
    const els = []; walk(document, els, 0);
    const vis = els.filter(visible);
    const vh = innerHeight, vw = innerWidth;
    const inView = (el) => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw; };
    const pick = full ? vis.slice(0, 200) : vis.filter(inView).slice(0, MAX_ITEMS);
    const items = pick.map((el) => {
      const d = desc(el), o = { t: d.role || d.tag };
      if (d.text) o.n = d.text.slice(0, 40);
      if (d.type && d.type !== "submit" && d.type !== "button") o.k = d.type;
      if (d.name) o.nm = d.name;
      if ("value" in el && el.type !== "password" && el.type !== "hidden" && el.value) o.v = String(el.value).slice(0, 40);
      if (el.type === "checkbox" || el.type === "radio") o.c = el.checked;
      if (el.href) { try { const u = new URL(el.href); o.h = u.origin === location.origin ? u.pathname + u.search.slice(0, 40) : u.host + u.pathname.slice(0, 40); } catch {} }
      o.s = d.sel.split(">").slice(-2).join(">");
      if (full) { const r = el.getBoundingClientRect(); o.box = [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; }
      return o;
    });
    const o = {
      k: "snap", why, url: location.href, title: document.title,
      headings: [...document.querySelectorAll("h1,h2,h3")].filter(visible).slice(0, 8).map((h) => h.innerText.trim().slice(0, 60)),
      interactiveTotal: els.length, interactiveVisible: vis.length, inViewShown: items.length, items,
      textChars: (document.body?.innerText || "").length, mutationsSince: mut, iframes: document.querySelectorAll("iframe").length,
      focus: desc(document.activeElement)?.sel || null,
    };
    mut = 0; o.bytes = JSON.stringify(o).length;
    return o;
  };
  let mut = 0, timer = 0;
  const later = (why, ms) => { clearTimeout(timer); timer = setTimeout(() => post(snap(why)), ms); };
  window.__tcrSnap = snap;
  new MutationObserver((l) => { mut += l.length; }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  window.addEventListener("load", () => later("load", 1000));
  for (const m of ["pushState", "replaceState"]) { const o = history[m]; history[m] = function () { const r = o.apply(this, arguments); post({ k: "nav", via: m, url: location.href }); later("spa-nav", 600); return r; }; }
  window.addEventListener("popstate", () => { post({ k: "nav", via: "popstate", url: location.href }); later("popstate", 600); });

  // ---- user events (capture) ----
  for (const type of ["pointerdown", "click", "input", "change", "submit", "keydown", "wheel"]) {
    window.addEventListener(type, (e) => {
      const rec = { k: "ev", type, trusted: e.isTrusted, target: desc(e.target) };
      if (type === "keydown") rec.key = e.key.length === 1 ? "[char]" : e.key;
      if (type === "pointerdown") rec.pressure = e.pressure;
      post(rec);
      if (type === "click" || type === "change" || type === "submit") later("after-" + type, 700);
    }, true);
  }
})();
