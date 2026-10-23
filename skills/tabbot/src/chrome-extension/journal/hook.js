// 页面里（MAIN world）的常驻录制：fetch / XHR / beacon / WebSocket 的请求与响应，用户输入，导航，DOM 快照。
// 只发观察记录，不改变页面行为；过滤规则与 src/journal/filter.ts 保持一致（selfcheck 校验）。
(() => {
  if (window.__tcrlInstalled) return;
  window.__tcrlInstalled = 1;

  const BODY_MAX = 256 * 1024;
  const GRACE_MS = 8000;
  const TELEMETRY_HOST = /(analytics|telemetry|apm|datahub|track|metrics|sentry|beacon|collector)/i;
  const TELEMETRY_PATH = /(^|[/._-])(collect|collector|track|tracking|beacon|analytics|telemetry|metrics|pixel|apm|sentry|logs?|stats?|events?|monitor|heartbeat|profiler|za)([/._?-]|$)/i;
  const TEXTY = /json|text|xml|javascript|html|x-www-form|graphql/i;
  const SENSITIVE_FIELD = /pass|pwd|card|cvv|cvc|ssn|token|secret|otp|verif|code/i;
  const SENSITIVE_AUTOCOMPLETE = /cc-|password|one-time/i;
  const SENSITIVE_HEADER = /^(cookie|authorization|proxy-authorization|set-cookie)$/i;

  // ---- 发送：限流，防止异常页面把日志刷爆 ----
  let sent = 0, windowStart = Date.now();
  const post = (o) => {
    const now = Date.now();
    if (now - windowStart > 60000) { windowStart = now; sent = 0; }
    if (++sent > 3000) return;
    try { window.postMessage({ __tcrl: 1, t: now, ...o }, "*"); } catch {}
  };

  // ---- 前台判断：页面可见，或刚离开前台不久（点击触发的请求可能还在路上）----
  let hiddenAt = 0;
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") hiddenAt = Date.now(); });
  const foreground = () => document.visibilityState === "visible" || Date.now() - hiddenAt < GRACE_MS;
  let bg = 0;
  const flushBg = () => { if (bg) { post({ k: "bg", n: bg }); bg = 0; } };
  setInterval(flushBg, 30000);
  addEventListener("pagehide", flushBg);

  // ---- 同站与埋点的粗判断（只决定读不读响应体，最终判断在 daemon）----
  const SLD = /^(com|co|org|net|gov|edu|ac)$/;
  const registrable = (host) => {
    const p = host.split(".");
    if (p.length <= 2) return host;
    const n = p.length;
    return p[n - 1].length === 2 && SLD.test(p[n - 2]) ? p.slice(-3).join(".") : p.slice(-2).join(".");
  };
  const sameSite = (url) => { try { return registrable(new URL(url).hostname) === registrable(location.hostname); } catch { return false; } };
  const telemetry = (url, method) => {
    if (method === "GET") return false;
    try { const u = new URL(url); return TELEMETRY_HOST.test(u.hostname) || TELEMETRY_PATH.test(u.pathname); } catch { return false; }
  };
  const readBodyOf = (url, method, ct) => foreground() && sameSite(url) && !telemetry(url, method) && TEXTY.test(ct || "");

  const bodyStr = (b) => {
    if (b == null) return null;
    if (typeof b === "string") return b.slice(0, BODY_MAX);
    if (b instanceof URLSearchParams) return b.toString().slice(0, BODY_MAX);
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
        for (const [k, v] of it) o[String(k).toLowerCase()] = SENSITIVE_HEADER.test(k) ? "[redacted]" : String(v).slice(0, 500);
      } catch {}
    }
    return Object.keys(o).length ? o : null;
  };

  let seq = 0;
  let inflight = 0; // 在途的 fetch / XHR 数，agent 动作之后等页面稳定要用
  // ---- fetch ----
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const id = ++seq, t0 = performance.now(), fg = foreground();
    let url, method, reqBody = null, reqHeaders = null;
    try {
      const r = input instanceof Request ? input : null;
      url = new URL(r ? r.url : String(input), location.href).href;
      method = (init?.method || r?.method || "GET").toUpperCase();
      reqHeaders = hdrs(r?.headers, init?.headers);
      if (init && "body" in init) reqBody = bodyStr(init.body);
      else if (r && method !== "GET" && method !== "HEAD") reqBody = "[Request body not read]";
    } catch {}
    const p = origFetch.apply(this, arguments);
    inflight++;
    p.then(() => { inflight--; }, () => { inflight--; });
    if (!fg) { bg++; return p; }
    p.then(async (res) => {
      const rec = { k: "net", via: "fetch", id, url, finalUrl: res.url, method, reqHeaders, reqBody, status: res.status, ct: res.headers.get("content-type"), ms: Math.round(performance.now() - t0) };
      try {
        if (!res.body) { rec.size = 0; rec.body = ""; }
        else if (readBodyOf(url, method, rec.ct)) {
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
    }, (e) => post({ k: "net", via: "fetch", id, url, method, reqHeaders, reqBody, err: String(e) }));
    return p;
  };

  // ---- XHR ----
  const xo = XMLHttpRequest.prototype.open, xs = XMLHttpRequest.prototype.send, xh = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (m, u) {
    try { this.__t = { method: String(m).toUpperCase(), url: new URL(String(u), location.href).href }; } catch {}
    return xo.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
    if (this.__t) (this.__t.reqHeaders ||= {})[String(k).toLowerCase()] = SENSITIVE_HEADER.test(k) ? "[redacted]" : String(v).slice(0, 500);
    return xh.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (b) {
    const t = this.__t;
    inflight++;
    this.addEventListener("loadend", () => { inflight--; }, { once: true });
    if (t) {
      if (!foreground()) bg++;
      else {
        t.reqBody = bodyStr(b);
        const t0 = performance.now();
        this.addEventListener("loadend", () => {
          const rec = { k: "net", via: "xhr", id: ++seq, ...t, finalUrl: this.responseURL, status: this.status, ct: this.getResponseHeader("content-type"), ms: Math.round(performance.now() - t0) };
          try {
            if (readBodyOf(t.url, t.method, rec.ct)) {
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

  // ---- beacon ----
  const ob = navigator.sendBeacon && navigator.sendBeacon.bind(navigator);
  if (ob) navigator.sendBeacon = function (u, d) {
    if (foreground()) post({ k: "net", via: "beacon", id: ++seq, url: new URL(String(u), location.href).href, method: "POST", reqBody: bodyStr(d) });
    return ob(u, d);
  };

  // ---- WebSocket：只记打开、前 3 帧、关闭和帧数 ----
  const OW = window.WebSocket;
  window.WebSocket = function (u, p) {
    const ws = p === undefined ? new OW(u) : new OW(u, p);
    const id = ++seq; let tx = 0, rx = 0;
    if (foreground()) post({ k: "ws", id, ev: "open", url: String(u) });
    const os = ws.send.bind(ws);
    ws.send = (d) => { tx++; if (tx <= 3 && foreground()) post({ k: "ws", id, ev: "tx", url: String(u), data: bodyStr(d) }); return os(d); };
    ws.addEventListener("message", (e) => { rx++; if (rx <= 3 && foreground()) post({ k: "ws", id, ev: "rx", url: String(u), data: bodyStr(e.data) }); });
    ws.addEventListener("close", () => { if (foreground()) post({ k: "ws", id, ev: "close", url: String(u), data: `tx=${tx} rx=${rx}` }); });
    return ws;
  };
  window.WebSocket.prototype = OW.prototype;
  Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });

  // ---- 元素描述与快照 ----
  const cssPath = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 6; n = n.parentElement) {
      if (n.id) { parts.unshift("#" + CSS.escape(n.id)); break; }
      let i = 1; for (let s = n.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === n.tagName) i++;
      parts.unshift(n.tagName.toLowerCase() + (i > 1 ? `:nth-of-type(${i})` : ""));
    }
    return parts.join(">");
  };
  const isField = (el) => /^(input|textarea|select)$/i.test(el.tagName) || el.isContentEditable;
  const sensitiveField = (el) => el.type === "password" || el.type === "hidden" || SENSITIVE_AUTOCOMPLETE.test(el.autocomplete || "") || SENSITIVE_FIELD.test((el.name || "") + " " + (el.id || ""));
  // 输入框的"文字"只取标签类信息，不取已经输入的值
  const label = (el) => {
    const t = el.getAttribute("aria-label") || el.getAttribute("placeholder") || (el.labels && el.labels[0] && el.labels[0].innerText) || el.title || el.name || "";
    return String(t).trim().replace(/\s+/g, " ").slice(0, 60);
  };
  const desc = (el) => {
    if (!el || el.nodeType !== 1) return null;
    const text = isField(el) ? label(el) : String(el.getAttribute("aria-label") || el.innerText || el.title || "").trim().replace(/\s+/g, " ").slice(0, 60);
    return { tag: el.tagName.toLowerCase(), role: el.getAttribute("role"), type: el.type || null, name: el.name || null, text, sel: cssPath(el) };
  };
  const INTERACTIVE = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=switch],[role=combobox],[role=textbox],[contenteditable=""],[contenteditable=true],[onclick],[tabindex]:not([tabindex="-1"])';
  const walk = (root, out, depth) => {
    for (const el of root.querySelectorAll("*")) if (el.shadowRoot && depth < 5) walk(el.shadowRoot, out, depth + 1);
    for (const el of root.querySelectorAll(INTERACTIVE)) out.push(el);
  };
  const visible = (el) => { const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; const cs = getComputedStyle(el); return cs.visibility !== "hidden" && cs.display !== "none"; };
  // ---- 元素引用：元素第一次出现在快照里时得到一个稳定编号（e12），agent 用 @e12 指它；页面不刷新就不变，元素被页面移除后引用失效 ----
  const ids = new WeakMap(), byRef = new Map();
  let nextRef = 1;
  const refOf = (el) => {
    let r = ids.get(el);
    if (!r) {
      r = "e" + nextRef++; ids.set(el, r); byRef.set(r, new WeakRef(el));
      if (byRef.size > 3000) for (const [k, w] of byRef) if (!w.deref()) byRef.delete(k);
    }
    return r;
  };
  let mut = 0, lastMut = Date.now();
  const MAX_ITEMS = 60;
  const snap = (why, full) => {
    const els = []; walk(document, els, 0);
    const vis = els.filter(visible);
    const vh = innerHeight, vw = innerWidth;
    const inView = (el) => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw; };
    const pick = full ? vis.slice(0, 200) : vis.filter(inView).slice(0, MAX_ITEMS);
    const items = pick.map((el) => {
      const d = desc(el), o = { ref: refOf(el), t: d.role || d.tag };
      if (d.text) o.n = d.text.slice(0, 40);
      if (d.type && d.type !== "submit" && d.type !== "button") o.k = d.type;
      if (d.name) o.nm = d.name;
      if ("value" in el && el.value && !sensitiveField(el)) o.v = String(el.value).slice(0, 40);
      if (el.type === "checkbox" || el.type === "radio") o.c = el.checked;
      if (el.href) { try { const u = new URL(el.href); o.h = u.origin === location.origin ? u.pathname + u.search.slice(0, 40) : u.host + u.pathname.slice(0, 40); } catch {} }
      o.s = d.sel.split(">").slice(-2).join(">");
      if (full) { const r = el.getBoundingClientRect(); o.box = [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; }
      return o;
    });
    // 实时快照（agent 主动取的）再列出可滚动的区域（聊天窗口、侧边栏等），agent 才能指定在哪里滚动
    if (why === "live") {
      let n = 0;
      for (const el of document.querySelectorAll("*")) {
        if (n >= 8 || el === document.body || el === document.documentElement) continue;
        if (el.scrollHeight <= el.clientHeight + 20 || el.clientHeight < 60 || el.clientWidth < 100) continue;
        const ov = getComputedStyle(el).overflowY;
        if (ov !== "auto" && ov !== "scroll") continue;
        if (!visible(el) || !inView(el)) continue;
        const d = desc(el);
        const o = { ref: refOf(el), t: "scroll", s: d.sel.split(">").slice(-2).join(">") };
        const label = el.getAttribute("aria-label") || el.id || "";
        if (label) o.n = String(label).slice(0, 40);
        items.push(o); n++;
      }
    }
    const o = {
      why, url: location.href, title: document.title,
      headings: [...document.querySelectorAll("h1,h2,h3")].filter(visible).slice(0, 8).map((h) => h.innerText.trim().slice(0, 60)),
      interactiveTotal: els.length, interactiveVisible: vis.length, inViewShown: pick.length, items,
      textChars: (document.body?.innerText || "").length, mutationsSince: mut, iframes: document.querySelectorAll("iframe").length,
      focus: (desc(document.activeElement) || {}).sel || null,
    };
    mut = 0;
    return o;
  };
  window.__tcrSnap = snap;

  let snapTimer = 0, lastSnap = 0;
  const later = (why, ms) => {
    clearTimeout(snapTimer);
    snapTimer = setTimeout(() => { if (!foreground() || Date.now() - lastSnap < 1000) return; lastSnap = Date.now(); post({ k: "snap", snap: snap(why) }); }, ms);
  };
  try { new MutationObserver((l) => { mut += l.length; lastMut = Date.now(); }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true }); } catch {}
  window.addEventListener("load", () => { post({ k: "nav", via: "load", url: location.href }); later("load", 1000); });
  for (const m of ["pushState", "replaceState"]) {
    const o = history[m];
    history[m] = function () { const r = o.apply(this, arguments); post({ k: "nav", via: m, url: location.href }); later("spa-nav", 600); return r; };
  }
  window.addEventListener("popstate", () => { post({ k: "nav", via: "popstate", url: location.href }); later("popstate", 600); });

  // ---- 在场信号：只给扩展用（撤销租约），不进日志。真人的任意按键、滚轮，每 250ms 最多一条 ----
  const lastPresence = {};
  const presence = (e, kind) => {
    if (!e.isTrusted || !foreground()) return;
    const now = Date.now();
    if (now - (lastPresence[kind] || 0) < 250) return;
    lastPresence[kind] = now;
    post({ k: "presence", kind });
  };
  // ---- 用户输入：点击、输入、特殊键、滚动。输入只记长度，不记内容 ----
  let inputPending = null, inputTimer = 0, scrollDy = 0, scrollTrusted = false, scrollTimer = 0;
  const flushInput = () => { clearTimeout(inputTimer); if (inputPending) { post({ k: "ev", type: "input", trusted: inputPending.trusted, target: inputPending.target, n: inputPending.n }); inputPending = null; } };
  const flushScroll = () => { clearTimeout(scrollTimer); if (scrollDy) { post({ k: "ev", type: "scroll", trusted: scrollTrusted, dy: Math.round(scrollDy) }); scrollDy = 0; } };
  addEventListener("pointerdown", (e) => { if (!foreground()) return; flushInput(); post({ k: "ev", type: "click", trusted: e.isTrusted, pressure: e.pressure, target: desc(e.target) }); }, true);
  addEventListener("click", (e) => { if (!e.isTrusted && foreground()) post({ k: "ev", type: "click", trusted: false, target: desc(e.target) }); if (foreground()) later("after-click", 700); }, true);
  addEventListener("input", (e) => {
    if (!foreground()) return;
    const el = e.target, trusted = e.isTrusted;
    const key = cssPath(el);
    if (inputPending && inputPending.key !== key) flushInput();
    inputPending = { key, trusted, target: desc(el), n: ((el.value ?? el.textContent) || "").length };
    clearTimeout(inputTimer); inputTimer = setTimeout(flushInput, 600);
  }, true);
  addEventListener("change", (e) => { if (!foreground()) return; flushInput(); post({ k: "ev", type: "change", trusted: e.isTrusted, target: desc(e.target) }); later("after-change", 700); }, true);
  addEventListener("submit", (e) => { if (!foreground()) return; flushInput(); post({ k: "ev", type: "submit", trusted: e.isTrusted, target: desc(e.target) }); later("after-submit", 700); }, true);
  addEventListener("keydown", (e) => {
    presence(e, "key");
    if (!foreground()) return;
    const special = e.key === "Enter" || e.key === "Escape" || e.key === "Tab";
    const combo = (e.ctrlKey || e.metaKey) && e.key.length === 1;
    if (!special && !combo) return;
    flushInput();
    post({ k: "ev", type: "key", trusted: e.isTrusted, key: (combo ? (e.metaKey ? "Cmd+" : "Ctrl+") : "") + e.key, target: desc(e.target) });
  }, true);
  addEventListener("wheel", (e) => {
    presence(e, "wheel");
    if (!foreground()) return;
    scrollDy += e.deltaY; scrollTrusted = e.isTrusted;
    clearTimeout(scrollTimer); scrollTimer = setTimeout(flushScroll, 500);
  }, { capture: true, passive: true });
  // ---- agent 的动作：页面内的合成事件，由扩展经 executeScript 调用 window.__tcrAct。----
  // 合成事件的 isTrusted 一定是 false，所以页面里 isTrusted 为真的输入一定是人；这样判人不需要猜。
  const resolveRef = (ref) => {
    const el = byRef.get(String(ref).replace(/^@/, ""))?.deref();
    if (!el || !el.isConnected) throw new Error(`元素 ${ref} 已不在页面上，请重新 snapshot`);
    return el;
  };
  const toView = (el) => {
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
  const fire = (el, Ctor, type, init) => el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true, view: window, ...init }));
  const clickEl = (el) => {
    const { x, y } = toView(el);
    const m = { clientX: x, clientY: y, button: 0 };
    const pm = { ...m, pointerId: 1, pointerType: "mouse", isPrimary: true };
    if (el.focus) el.focus({ preventScroll: true }); // 真实的 mousedown 会让元素获得焦点，合成的不会
    fire(el, PointerEvent, "pointerover", pm); fire(el, MouseEvent, "mouseover", m);
    fire(el, PointerEvent, "pointerdown", { ...pm, buttons: 1 }); fire(el, MouseEvent, "mousedown", { ...m, buttons: 1 });
    fire(el, PointerEvent, "pointerup", pm); fire(el, MouseEvent, "mouseup", m);
    fire(el, MouseEvent, "click", { ...m, detail: 1 });
  };
  // 用原生的 value setter 写值，React 等框架才会认；再补 input / change 事件
  const nativeSet = (el, value) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
  };
  const setValue = (el, text) => {
    if (el.isContentEditable) { el.focus(); document.execCommand("selectAll"); document.execCommand("insertText", false, text); return; }
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) throw new Error("这个元素不是输入框");
    if (el.disabled || el.readOnly) throw new Error("输入框是禁用或只读的");
    el.focus({ preventScroll: true });
    nativeSet(el, text);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text, composed: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const selectOption = (el, want) => {
    if (!(el instanceof HTMLSelectElement)) throw new Error("这个元素不是下拉框");
    const opt = [...el.options].find((o) => o.value === want || o.text.trim() === want);
    if (!opt) throw new Error(`下拉框里没有选项「${want}」，可选：${[...el.options].map((o) => o.text.trim()).slice(0, 12).join(" | ")}`);
    nativeSet(el, opt.value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const codeOf = (key) => (key.length === 1 ? (/[a-z]/i.test(key) ? "Key" + key.toUpperCase() : /\d/.test(key) ? "Digit" + key : key === " " ? "Space" : key) : key);
  const TEXTUAL = /^(text|search|email|url|tel|password|number)$/i;
  const pressKey = (el, spec) => {
    const parts = String(spec).split("+"), last = parts.pop(), key = last === "Space" ? " " : last; // "Ctrl+K" → 修饰键 + 键名
    const mods = { ctrlKey: parts.includes("Ctrl"), metaKey: parts.includes("Cmd"), altKey: parts.includes("Alt"), shiftKey: parts.includes("Shift") };
    const target = el || document.activeElement || document.body;
    const init = { key, code: codeOf(key), ...mods };
    const proceed = fire(target, KeyboardEvent, "keydown", init); // false = 页面自己处理了（preventDefault）
    if (key.length === 1) fire(target, KeyboardEvent, "keypress", init);
    if (proceed && !mods.ctrlKey && !mods.metaKey && !mods.altKey) {
      // 合成的按键没有默认行为，常用的几个自己补上
      const tag = target.tagName;
      const clickable = tag === "A" || tag === "BUTTON" || tag === "SUMMARY" || (tag === "INPUT" && /^(button|submit|reset|checkbox|radio)$/i.test(target.type));
      if (key === "Enter" && clickable) clickEl(target);
      else if (key === "Enter" && tag === "INPUT" && TEXTUAL.test(target.type) && target.form) target.form.requestSubmit();
      else if (key === " " && (tag === "BUTTON" || (tag === "INPUT" && /^(checkbox|radio)$/i.test(target.type)))) clickEl(target);
      else if (key.length === 1 && (target.isContentEditable || tag === "TEXTAREA" || (tag === "INPUT" && TEXTUAL.test(target.type)))) document.execCommand("insertText", false, key);
    }
    fire(target, KeyboardEvent, "keyup", init);
  };
  const scrollTarget = (el, dx, dy, to) => {
    const t = el && el !== document.body && el !== document.documentElement ? el : window;
    if (to === "top") t.scrollTo({ top: 0, behavior: "instant" });
    else if (to === "bottom") t.scrollTo({ top: t === window ? document.documentElement.scrollHeight : t.scrollHeight, behavior: "instant" });
    else t.scrollBy({ left: dx || 0, top: dy || 0, behavior: "instant" });
  };
  // 等页面稳定：没有在途的 fetch / XHR，并且 DOM 静默一小段时间
  const settle = (timeoutMs = 4000, quietMs = 400) => new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      const quiet = inflight === 0 && Date.now() - lastMut >= quietMs;
      if (quiet || Date.now() - t0 >= timeoutMs) return resolve({ settled: quiet, waitedMs: Date.now() - t0, inflight });
      setTimeout(tick, 50);
    };
    setTimeout(tick, 120); // 先给动作引发的请求一点时间发出来
  });
  window.__tcrAct = async (cmd) => {
    try {
      const out = { ok: true };
      const el = cmd.ref ? resolveRef(cmd.ref) : null;
      switch (cmd.kind) {
        case "click": if (!el) throw new Error("click 需要元素引用，如 @e12"); out.target = desc(el); clickEl(el); break;
        case "fill": if (!el) throw new Error("fill 需要元素引用，如 @e12"); out.target = desc(el); setValue(el, String(cmd.text ?? "")); out.chars = String(cmd.text ?? "").length; break;
        case "select": if (!el) throw new Error("select 需要元素引用，如 @e12"); out.target = desc(el); selectOption(el, String(cmd.text ?? "")); break;
        case "check": {
          if (!el) throw new Error("check 需要元素引用，如 @e12");
          if (!(el instanceof HTMLInputElement) || !/^(checkbox|radio)$/i.test(el.type)) throw new Error("这个元素不是复选框或单选框");
          out.target = desc(el);
          if (el.checked !== (cmd.checked !== false)) clickEl(el);
          out.checked = el.checked;
          break;
        }
        case "press": out.target = desc(el || document.activeElement); pressKey(el, cmd.key); break;
        case "scroll": out.target = el ? desc(el) : "page"; scrollTarget(el, cmd.dx, cmd.dy, cmd.to); break;
        default: throw new Error(`未知动作 ${cmd.kind}`);
      }
      out.settle = await settle();
      out.url = location.href;
      out.title = document.title;
      return out;
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e), url: location.href };
    }
  };
})();
