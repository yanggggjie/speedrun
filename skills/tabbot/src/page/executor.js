// 页面里（MAIN world）的执行：holder 下发的动作（点击、填写、选择、勾选、按键、滚动）、实时快照、读文字、重放请求。
// 动作都是 DOM 事件（dispatchEvent、原生 setter），不是真实输入。只管执行，不写日志，不依赖录制端；
// 自己监听真人的设备事件，动作进行中一旦看到真人输入就停止等待、告诉 holder。
(() => {
  const T = window.__tcr;
  if (!T || T.executor) return;
  T.executor = 1;
  const TEXTY = /json|text|xml|javascript|html|x-www-form|graphql/i;

  // ---- 真人输入：isTrusted 为真的设备事件。agent 的动作全是 DOM 事件，isTrusted 一定是 false ----
  let lastHuman = 0;
  for (const type of ["pointerdown", "keydown", "wheel"]) {
    addEventListener(type, (e) => { if (e.isTrusted) lastHuman = Date.now(); }, { capture: true, passive: true });
  }

  // ---- 在途请求数：等页面稳定要用（自己数，不依赖录制端）----
  let inflight = 0;
  const done = () => { inflight--; };
  const prevFetch = window.fetch;
  window.fetch = function () { inflight++; const p = prevFetch.apply(this, arguments); p.then(done, done); return p; };
  const prevSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () { inflight++; this.addEventListener("loadend", done, { once: true }); return prevSend.apply(this, arguments); };

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
  // 等页面稳定：没有在途的 fetch / XHR，并且 DOM 静默一小段时间；等的时候真人动了手就停
  const settle = (since, timeoutMs = 4000, quietMs = 400) => new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      if (lastHuman >= since) return resolve({ settled: false, aborted: true, waitedMs: Date.now() - t0, inflight });
      const quiet = inflight === 0 && Date.now() - T.lastMut >= quietMs;
      if (quiet || Date.now() - t0 >= timeoutMs) return resolve({ settled: quiet, waitedMs: Date.now() - t0, inflight });
      setTimeout(tick, 50);
    };
    setTimeout(tick, 120); // 先给动作引发的请求一点时间发出来
  });

  T.exec.act = async (cmd) => {
    const since = Date.now();
    try {
      const out = { ok: true };
      const el = cmd.ref ? T.resolveRef(cmd.ref) : null;
      switch (cmd.kind) {
        case "click": if (!el) throw new Error("click 需要元素引用，如 @e12"); out.target = T.desc(el); clickEl(el); break;
        case "fill": if (!el) throw new Error("fill 需要元素引用，如 @e12"); out.target = T.desc(el); setValue(el, String(cmd.text ?? "")); out.chars = String(cmd.text ?? "").length; break;
        case "select": if (!el) throw new Error("select 需要元素引用，如 @e12"); out.target = T.desc(el); selectOption(el, String(cmd.text ?? "")); break;
        case "check": {
          if (!el) throw new Error("check 需要元素引用，如 @e12");
          if (!(el instanceof HTMLInputElement) || !/^(checkbox|radio)$/i.test(el.type)) throw new Error("这个元素不是复选框或单选框");
          out.target = T.desc(el);
          if (el.checked !== (cmd.checked !== false)) clickEl(el);
          out.checked = el.checked;
          break;
        }
        case "press": out.target = T.desc(el || document.activeElement); pressKey(el, cmd.key); break;
        case "scroll": out.target = el ? T.desc(el) : "page"; scrollTarget(el, cmd.dx, cmd.dy, cmd.to); break;
        default: throw new Error(`未知动作 ${cmd.kind}`);
      }
      out.settle = await settle(since);
      if (out.settle.aborted) out.revokedDuring = true;
      out.url = location.href;
      out.title = document.title;
      return out;
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e), url: location.href };
    }
  };

  T.exec.snapshot = (full) => T.snap("live", !!full);

  T.exec.text = (max) => {
    const text = (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n").trim();
    return { url: location.href, title: document.title, total: text.length, text: text.slice(0, max) };
  };

  // ---- 重放：在页面里原样发一个请求（带这个页面的登录态）。用保存下来的原始 fetch，所以不会被录制端当成页面自己发的请求 ----
  T.exec.replay = async (req) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
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
      return { ok: false, error: e && e.name === "AbortError" ? "请求超时（20 秒）" : String((e && e.message) || e) };
    } finally {
      clearTimeout(timer);
    }
  };
})();
