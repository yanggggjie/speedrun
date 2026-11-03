// 页面里（MAIN world）的共用部分：命名空间 window.__tcr、发消息、前台判断、元素描述与快照、DOM 变化计数。
// 录制（recorder.js）和执行（executor.js）都建立在它上面，但互相不依赖。由 daemon 在扩展连接时下发，不放在扩展里。
(() => {
  if (window.__tcr) return;
  const T = (window.__tcr = { exec: {} });
  T.origFetch = window.fetch; // 原始 fetch：重放用它发请求，不会被录制端当成页面自己发的请求

  // ---- 发消息：经 bridge.js 交给扩展，再到 daemon。限流，防止异常页面把日志刷爆 ----
  // 只有 Lore 开的（以及被它们打开的）标签页才上报：bridge 问过扩展之前先缓存（有上限，加载期的请求不能漏），
  // 答"录"就发出缓存并放行，答"不录"（用户的窗口）就清空缓存，之后一条都不发。
  const PENDING_MAX = 500;
  let sent = 0, windowStart = Date.now(), gate = "ask", pending = [];
  const send = (m) => { try { window.postMessage(m, "*"); } catch {} };
  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data.__tcrg !== 1 || gate !== "ask") return;
    gate = e.data.on ? "on" : "off";
    const queued = pending; pending = [];
    if (gate === "on") for (const m of queued) send(m);
  });
  T.recording = () => gate !== "off";
  T.post = (o) => {
    if (gate === "off") return;
    const now = Date.now();
    if (now - windowStart > 60000) { windowStart = now; sent = 0; }
    if (o.k !== "res" && ++sent > 3000) return;
    const m = { __tcrl: 1, t: now, ...o };
    if (gate === "on") send(m);
    else if (pending.length < PENDING_MAX) pending.push(m);
  };

  // ---- 前台判断：页面可见，或刚离开前台不久（点击触发的请求可能还在路上）----
  const GRACE_MS = 8000;
  let hiddenAt = 0;
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") hiddenAt = Date.now(); });
  T.foreground = () => document.visibilityState === "visible" || Date.now() - hiddenAt < GRACE_MS;

  // ---- 元素描述 ----
  const SENSITIVE_AUTOCOMPLETE = /cc-|password|one-time/i;
  T.cssPath = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && parts.length < 6; n = n.parentElement) {
      if (n.id) { parts.unshift("#" + CSS.escape(n.id)); break; }
      let i = 1; for (let s = n.previousElementSibling; s; s = s.previousElementSibling) if (s.tagName === n.tagName) i++;
      parts.unshift(n.tagName.toLowerCase() + (i > 1 ? `:nth-of-type(${i})` : ""));
    }
    return parts.join(">");
  };
  const isField = (el) => /^(input|textarea|select)$/i.test(el.tagName) || el.isContentEditable;
  // 密码框、隐藏框、信用卡一次性验证码这类字段的值不取
  const sensitiveField = (el) => el.type === "password" || el.type === "hidden" || SENSITIVE_AUTOCOMPLETE.test(el.autocomplete || "");
  // 输入框的"文字"只取标签类信息，不取已经输入的值
  const label = (el) => {
    const t = el.getAttribute("aria-label") || el.getAttribute("placeholder") || (el.labels && el.labels[0] && el.labels[0].innerText) || el.title || el.name || "";
    return String(t).trim().replace(/\s+/g, " ").slice(0, 60);
  };
  T.desc = (el) => {
    if (!el || el.nodeType !== 1) return null;
    const text = isField(el) ? label(el) : String(el.getAttribute("aria-label") || el.innerText || el.title || "").trim().replace(/\s+/g, " ").slice(0, 60);
    return { tag: el.tagName.toLowerCase(), role: el.getAttribute("role"), type: el.type || null, name: el.name || null, text, sel: T.cssPath(el) };
  };
  const INTERACTIVE = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=switch],[role=combobox],[role=textbox],[contenteditable=""],[contenteditable=true],[onclick],[tabindex]:not([tabindex="-1"])';
  const walk = (root, out, depth) => {
    for (const el of root.querySelectorAll("*")) if (el.shadowRoot && depth < 5) walk(el.shadowRoot, out, depth + 1);
    for (const el of root.querySelectorAll(INTERACTIVE)) out.push(el);
  };
  T.visible = (el) => { const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; const cs = getComputedStyle(el); return cs.visibility !== "hidden" && cs.display !== "none"; };

  // ---- 元素引用：元素第一次出现在快照里时得到一个稳定编号（e12），agent 用 @e12 指它；页面不刷新就不变，元素被页面移除后引用失效 ----
  const ids = new WeakMap(), byRef = new Map();
  let nextRef = 1;
  T.refOf = (el) => {
    let r = ids.get(el);
    if (!r) {
      r = "e" + nextRef++; ids.set(el, r); byRef.set(r, new WeakRef(el));
      if (byRef.size > 3000) for (const [k, w] of byRef) if (!w.deref()) byRef.delete(k);
    }
    return r;
  };

  // ---- DOM 变化：录制的快照带"自上次以来的变化数"，执行端等页面稳定要看最近一次变化的时间 ----
  T.mut = 0;
  T.lastMut = Date.now();
  try { new MutationObserver((l) => { T.mut += l.length; T.lastMut = Date.now(); }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true }); } catch {}

  // ---- 快照：可交互元素（默认只列视图内最多 60 个），实时快照再列出可滚动区域 ----
  const MAX_ITEMS = 60;
  T.snap = (why, full) => {
    const els = []; walk(document, els, 0);
    const vis = els.filter(T.visible);
    const vh = innerHeight, vw = innerWidth;
    const inView = (el) => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw; };
    const pick = full ? vis.slice(0, 200) : vis.filter(inView).slice(0, MAX_ITEMS);
    const items = pick.map((el) => {
      const d = T.desc(el), o = { ref: T.refOf(el), t: d.role || d.tag };
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
    if (why === "live") {
      let n = 0;
      for (const el of document.querySelectorAll("*")) {
        if (n >= 8 || el === document.body || el === document.documentElement) continue;
        if (el.scrollHeight <= el.clientHeight + 20 || el.clientHeight < 60 || el.clientWidth < 100) continue;
        const ov = getComputedStyle(el).overflowY;
        if (ov !== "auto" && ov !== "scroll") continue;
        if (!T.visible(el) || !inView(el)) continue;
        const d = T.desc(el);
        const o = { ref: T.refOf(el), t: "scroll", s: d.sel.split(">").slice(-2).join(">") };
        const name = el.getAttribute("aria-label") || el.id || "";
        if (name) o.n = String(name).slice(0, 40);
        items.push(o); n++;
      }
    }
    const o = {
      why, url: location.href, title: document.title,
      headings: [...document.querySelectorAll("h1,h2,h3")].filter(T.visible).slice(0, 8).map((h) => h.innerText.trim().slice(0, 60)),
      interactiveTotal: els.length, interactiveVisible: vis.length, inViewShown: pick.length, items,
      textChars: (document.body?.innerText || "").length, mutationsSince: T.mut, iframes: document.querySelectorAll("iframe").length,
      focus: (T.desc(document.activeElement) || {}).sel || null,
    };
    T.mut = 0;
    return o;
  };
})();
