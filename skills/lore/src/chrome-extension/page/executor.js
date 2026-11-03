// 页面里（MAIN world）的执行：daemon 下发的动作（点击、填写、选择、勾选、按键、滚动）、按屏幕坐标操作（截图 learn 用）、读文字、替 action 的 request() 发请求。
// 动作都是 DOM 事件（dispatchEvent、原生 setter），不是真实输入。只管执行，不写日志，不依赖录制端；
// 自己监听真人的设备事件，动作进行中一旦看到真人输入就停止等待、告诉 daemon。
(() => {
  const T = window.__lore;
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

  const toView = (el) => {
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
  const fire = (el, Ctor, type, init) => el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true, view: window, ...init }));
  // ---- 鼠标：和 computer 工具一样的顺序（移过去 → 按下 → 松开 → click），只是用 DOM 事件合成 ----
  const modsOf = (m) => ({ ctrlKey: !!m?.ctrl, metaKey: !!m?.cmd, altKey: !!m?.alt, shiftKey: !!m?.shift });
  const pointerInit = (x, y, mods, extra) => ({ clientX: x, clientY: y, ...modsOf(mods), ...extra });
  // 悬停：记住上一个元素，离开时补移出事件，进入新元素补进入事件，再发一次移动
  const hoverTo = (el, x, y, mods) => {
    const m = pointerInit(x, y, mods), pm = { ...m, pointerId: 1, pointerType: "mouse", isPrimary: true };
    const prev = T.hovered;
    if (prev && prev !== el && prev.isConnected) {
      fire(prev, PointerEvent, "pointerout", pm); fire(prev, MouseEvent, "mouseout", m);
      fire(prev, PointerEvent, "pointerleave", { ...pm, bubbles: false }); fire(prev, MouseEvent, "mouseleave", { ...m, bubbles: false });
    }
    if (prev !== el) {
      fire(el, PointerEvent, "pointerover", pm); fire(el, MouseEvent, "mouseover", m);
      fire(el, PointerEvent, "pointerenter", { ...pm, bubbles: false }); fire(el, MouseEvent, "mouseenter", { ...m, bubbles: false });
    }
    fire(el, PointerEvent, "pointermove", pm); fire(el, MouseEvent, "mousemove", m);
    T.hovered = el;
  };
  // 三击：输入框里全选，正文里选中这个元素的内容
  const selectAround = (el) => {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) { el.select(); return; }
    const sel = window.getSelection(), range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges(); sel.addRange(range);
  };
  // 点 count 下：button 0 左键（click，count ≥ 2 补 dblclick，3 选中），2 右键（contextmenu）
  const mouseClick = (el, x, y, { button = 0, count = 1, mods } = {}) => {
    const buttons = button === 2 ? 2 : 1;
    const m = pointerInit(x, y, mods, { button }), pm = { ...m, pointerId: 1, pointerType: "mouse", isPrimary: true };
    if (el.focus) el.focus({ preventScroll: true }); // 真实的 mousedown 会让元素获得焦点，合成的不会
    hoverTo(el, x, y, mods);
    for (let i = 1; i <= count; i++) {
      fire(el, PointerEvent, "pointerdown", { ...pm, buttons }); fire(el, MouseEvent, "mousedown", { ...m, buttons, detail: i });
      fire(el, PointerEvent, "pointerup", pm); fire(el, MouseEvent, "mouseup", { ...m, detail: i });
      fire(el, MouseEvent, button === 2 ? "contextmenu" : "click", { ...m, detail: i });
    }
    if (button === 0 && count >= 2) fire(el, MouseEvent, "dblclick", { ...m, detail: 2 });
    if (button === 0 && count >= 3) selectAround(el);
  };
  const clickEl = (el, at) => {
    const { x, y } = at || toView(el); // 给了坐标（截图里看到的位置）就不滚动
    mouseClick(el, x, y);
  };
  // 拖动：按下 → 分 10 步移动 → 松开；起点能拖（draggable）时补 HTML5 拖放事件
  const dragPath = (sx, sy, ex, ey, mods) => {
    const start = deepFromPoint(sx, sy);
    if (!start) throw new Error(`起点 (${sx}, ${sy}) 没有元素`);
    hoverTo(start, sx, sy, mods);
    const m0 = pointerInit(sx, sy, mods, { button: 0 });
    fire(start, PointerEvent, "pointerdown", { ...m0, pointerId: 1, pointerType: "mouse", isPrimary: true, buttons: 1 }); fire(start, MouseEvent, "mousedown", { ...m0, buttons: 1, detail: 1 });
    const source = start.closest('[draggable="true"]');
    const dt = source ? new DataTransfer() : null;
    if (source) fire(source, DragEvent, "dragstart", { ...m0, dataTransfer: dt });
    let over = null, at = start;
    for (let i = 1; i <= 10; i++) {
      const x = sx + ((ex - sx) * i) / 10, y = sy + ((ey - sy) * i) / 10;
      at = deepFromPoint(x, y) || at;
      const m = pointerInit(x, y, mods, { buttons: 1 });
      fire(at, PointerEvent, "pointermove", { ...m, pointerId: 1, pointerType: "mouse", isPrimary: true }); fire(at, MouseEvent, "mousemove", m);
      if (source) { if (at !== over) { fire(at, DragEvent, "dragenter", { ...m, dataTransfer: dt }); over = at; } fire(at, DragEvent, "dragover", { ...m, dataTransfer: dt }); }
    }
    const m1 = pointerInit(ex, ey, mods, { button: 0 });
    if (source) { fire(at, DragEvent, "drop", { ...m1, dataTransfer: dt }); fire(source, DragEvent, "dragend", { ...m1, dataTransfer: dt }); }
    fire(at, PointerEvent, "pointerup", { ...m1, pointerId: 1, pointerType: "mouse", isPrimary: true }); fire(at, MouseEvent, "mouseup", { ...m1, detail: 1 });
    T.hovered = at;
    return { start, end: at };
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
  // 很多页面看 keyCode / which（如 Enter 是 13）：合成的按键要带上，否则「回车搜索」这类监听收不到
  const KEY_CODES = { Enter: 13, Backspace: 8, Tab: 9, Escape: 27, " ": 32, PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46 };
  const keyCodeOf = (key) => KEY_CODES[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
  const keyInit = (key) => { const c = keyCodeOf(key); return { key, code: codeOf(key), keyCode: c, which: c }; };
  const codeOf = (key) => (key.length === 1 ? (/[a-z]/i.test(key) ? "Key" + key.toUpperCase() : /\d/.test(key) ? "Digit" + key : key === " " ? "Space" : key) : key);
  const TEXTUAL = /^(text|search|email|url|tel|password|number)$/i;
  // ---- 按键：和 computer 的 key 同一种写法：空格分隔多个，`+` 组合，修饰键 cmd / ctrl / alt / shift 不分大小写（learn 的 computer key 和 SDK 的 key 共用）----
  const MOD_NAMES = { cmd: "cmd", command: "cmd", meta: "cmd", super: "cmd", ctrl: "ctrl", control: "ctrl", alt: "alt", option: "alt", opt: "alt", shift: "shift" };
  const KEY_NAMES = { enter: "Enter", return: "Enter", backspace: "Backspace", delete: "Delete", del: "Delete", tab: "Tab", escape: "Escape", esc: "Escape", space: " ", up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", arrowup: "ArrowUp", arrowdown: "ArrowDown", arrowleft: "ArrowLeft", arrowright: "ArrowRight", home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown" };
  const parseKeys = (spec) => String(spec).trim().split(/\s+/).filter(Boolean).map((combo) => {
    const parts = combo.split("+").filter(Boolean), last = parts.pop() ?? "";
    const mods = {};
    for (const p of parts) { const m = MOD_NAMES[p.toLowerCase()]; if (!m) throw new Error(`不认识的修饰键「${p}」：用 cmd、ctrl、alt、shift`); mods[m] = true; }
    const key = last.length === 1 ? last : KEY_NAMES[last.toLowerCase()] ?? last;
    return { key, mods };
  });
  const pressKeys = (el, spec, repeat = 1) => {
    const keys = parseKeys(spec);
    if (!keys.length) throw new Error("key 要写按键，如 Enter、cmd+a、Backspace Backspace");
    for (let r = 0; r < Math.min(Math.max(1, repeat), 100); r++) for (const k of keys) pressKey(el, k);
  };
  const pressKey = (el, { key, mods: m }) => {
    const mods = modsOf(m);
    const target = el || document.activeElement || document.body;
    const init = { ...keyInit(key), ...mods };
    const proceed = fire(target, KeyboardEvent, "keydown", init); // false = 页面自己处理了（preventDefault）
    if (key.length === 1) fire(target, KeyboardEvent, "keypress", init);
    const textField = target.isContentEditable || target.tagName === "TEXTAREA" || (target.tagName === "INPUT" && TEXTUAL.test(target.type));
    if (proceed && (mods.metaKey || mods.ctrlKey) && key.toLowerCase() === "a") {
      // 全选：输入框里选中内容，否则选中整页
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) target.select(); else document.execCommand("selectAll");
    } else if (proceed && textField && (key === "Backspace" || key === "Delete") && !mods.metaKey && !mods.ctrlKey) {
      document.execCommand(key === "Backspace" ? "delete" : "forwardDelete");
    } else if (proceed && !mods.ctrlKey && !mods.metaKey && !mods.altKey) {
      // 合成的按键没有默认行为，常用的几个自己补上
      const tag = target.tagName;
      const clickable = tag === "A" || tag === "BUTTON" || tag === "SUMMARY" || (tag === "INPUT" && /^(button|submit|reset|checkbox|radio)$/i.test(target.type));
      if (key === "Enter" && clickable) clickEl(target);
      else if (key === "Enter" && tag === "INPUT" && TEXTUAL.test(target.type) && target.form) target.form.requestSubmit();
      else if (key === " " && (tag === "BUTTON" || (tag === "INPUT" && /^(checkbox|radio)$/i.test(target.type)))) clickEl(target);
      else if (key.length === 1 && textField) document.execCommand("insertText", false, key);
    }
    fire(target, KeyboardEvent, "keyup", init);
  };
  const scrollTarget = (el, dx, dy) => {
    const t = el && el !== document.body && el !== document.documentElement ? el : window;
    t.scrollBy({ left: dx || 0, top: dy || 0, behavior: "instant" });
  };
  // 和 computer 的 scroll 一样：方向加格数，一格 100 像素，最多 10 格
  const wheelDelta = (direction, amount) => {
    const n = Math.min(Math.max(1, Number(amount) || 3), 10) * 100;
    switch (direction) {
      case "up": return [0, -n]; case "down": return [0, n]; case "left": return [-n, 0]; case "right": return [n, 0];
      default: throw new Error(`scroll 的方向要是 up、down、left、right，收到：${direction}`);
    }
  };
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

  // ---- 持久定位 loc（写进 action 的）：CSS 字符串 | { css } | { role, name, exact?, nth? } | { text, nth? } ----
  const IMPLICIT_ROLE = { a: "link", button: "button", select: "combobox", textarea: "textbox", summary: "button", img: "img", nav: "navigation", main: "main", li: "listitem", article: "article" };
  const roleOf = (el) => {
    const r = el.getAttribute("role");
    if (r) return r;
    const tag = el.tagName.toLowerCase();
    if (tag === "input") { const t = (el.type || "text").toLowerCase(); return /^(button|submit|reset|image)$/.test(t) ? "button" : t === "checkbox" ? "checkbox" : t === "radio" ? "radio" : t === "range" ? "slider" : t === "search" ? "searchbox" : "textbox"; }
    if (/^h[1-6]$/.test(tag)) return "heading";
    return IMPLICIT_ROLE[tag] || "";
  };
  const nameOfEl = (el) => String(el.getAttribute("aria-label") || el.getAttribute("placeholder") || (el.labels && el.labels[0] && el.labels[0].innerText) || el.title || el.innerText || el.value || "").trim().replace(/\s+/g, " ");
  const matchName = (got, want, exact) => (exact ? got === want : got === want || got.includes(want));
  T.find = (loc) => {
    if (typeof loc === "string") loc = { css: loc };
    let list;
    if (loc.role || loc.name || loc.text) {
      const all = [...(loc.css ? document.querySelectorAll(loc.css) : document.querySelectorAll("*"))].filter((el) => T.visible(el));
      const byRole = loc.role ? all.filter((el) => roleOf(el) === loc.role) : all;
      const want = String(loc.name ?? loc.text ?? "");
      const pick = (exact) => (want ? byRole.filter((el) => matchName(loc.text !== undefined ? String(el.innerText || "").trim().replace(/\s+/g, " ") : nameOfEl(el), want, exact)) : byRole);
      list = pick(true);
      if (!list.length) list = pick(false);
      if (loc.text !== undefined && list.length > 1) list = list.filter((el) => !list.some((o) => o !== el && el.contains(o))); // 只留最里面的
    } else list = [...document.querySelectorAll(loc.css)].filter((el) => T.visible(el));
    return list;
  };
  const resolveLoc = async (loc, timeoutMs) => {
    const t0 = Date.now();
    const nth = typeof loc === "object" && loc !== null ? loc.nth : undefined;
    for (;;) {
      const list = T.find(loc);
      if (nth !== undefined && list[nth]) return list[nth];
      if (nth === undefined && list.length === 1) return list[0];
      if (nth === undefined && list.length > 1) {
        if (typeof loc === "string" || (loc && loc.css && !loc.role && !loc.name && !loc.text)) return list[0];
        throw new Error(`定位 ${JSON.stringify(loc)} 命中 ${list.length} 个元素：改用更具体的 name，或加 nth`);
      }
      if (Date.now() - t0 >= timeoutMs) throw new Error(`${Math.round(timeoutMs / 1000)} 秒内页面上没有出现 ${JSON.stringify(loc)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };

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

  // 兜底：任意函数。严格 CSP 的页面里 new Function 会被拒，那时用 query 或 request
  T.exec.eval = async ({ src, args = [] }) => {
    let fn;
    try { fn = (0, eval)(`(${src})`); } catch (e) { throw new Error(`这个页面不允许执行任意代码（CSP）：${String((e && e.message) || e)}；改用 query / request / 定位操作`); }
    return await fn(...args);
  };

  // 元素的持久定位（写进 action 用）：有 role 和名字就用 {role,name}，否则用 CSS 路径
  const durable = (el) => { const role = roleOf(el), name = nameOfEl(el).slice(0, 60); return role && name ? { role, name } : { css: T.cssPath(el) }; };

  T.exec.act = async (cmd) => {
    try {
      const out = { ok: true };
      const el = cmd.loc !== undefined ? await resolveLoc(cmd.loc, cmd.timeout ?? 10000) : null;
      switch (cmd.kind) {
        case "click": if (!el) throw new Error("click 需要 loc"); out.target = T.desc(el); clickEl(el); break;
        case "fill": if (!el) throw new Error("fill 需要 loc"); out.target = T.desc(el); setValue(el, String(cmd.text ?? "")); out.chars = String(cmd.text ?? "").length; break;
        case "select": if (!el) throw new Error("select 需要 loc"); out.target = T.desc(el); selectOption(el, String(cmd.text ?? "")); break;
        case "check": {
          if (!el) throw new Error("check 需要 loc");
          if (!(el instanceof HTMLInputElement) || !/^(checkbox|radio)$/i.test(el.type)) throw new Error("这个元素不是复选框或单选框");
          out.target = T.desc(el);
          if (el.checked !== (cmd.checked !== false)) clickEl(el);
          out.checked = el.checked;
          break;
        }
        case "key": if (el?.focus) el.focus({ preventScroll: true }); out.target = T.desc(el || document.activeElement); pressKeys(el, cmd.keys, cmd.repeat); break;
        case "scroll": {
          const box = el ? scrollableAt(el) : null;
          const [dx, dy] = wheelDelta(cmd.direction, cmd.amount);
          out.target = box ? T.desc(box) : "page"; scrollTarget(box, dx, dy);
          out.scrollY = box ? Math.round(box.scrollTop) : Math.round(window.scrollY);
          break;
        }
        case "scroll_to": if (!el) throw new Error("scroll_to 需要 loc"); out.target = T.desc(el); el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); break;
        default: throw new Error(`未知动作 ${cmd.kind}`);
      }
      out.url = location.href;
      out.title = document.title;
      if (el) out.loc = durable(el);
      return out;
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e), url: location.href };
    }
  };

  // ---- 按屏幕坐标操作：给截图 learn 用。坐标是视口里的 CSS 像素（截图就是按这个尺寸缩的），左上角 (0,0)。
  // 返回元素的持久定位 loc，写 action 时直接用；定位不唯一时补 nth，保证回放时命中同一个元素。----
  const deepFromPoint = (x, y) => {
    let el = document.elementFromPoint(x, y);
    while (el && el.shadowRoot) { const inner = el.shadowRoot.elementFromPoint(x, y); if (!inner || inner === el) break; el = inner; }
    return el;
  };
  const uniqueLoc = (el) => {
    const loc = durable(el);
    const list = T.find(loc);
    if (list.length === 1 && list[0] === el) return loc;
    const i = list.indexOf(el);
    if (i >= 0) return { ...loc, nth: i };
    return { css: T.cssPath(el) };
  };
  const scrollableAt = (el) => {
    for (let n = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      const o = getComputedStyle(n).overflowY;
      if (/(auto|scroll)/.test(o) && n.scrollHeight > n.clientHeight + 1) return n;
    }
    return null;
  };
  // 坐标落在了什么上：没有元素报错；落在页面背景、没有可用控件的 <label> 上写提醒（不自动纠正：真人点那里也会点到同一个东西）
  const hitAt = (x, y, out) => {
    const el = deepFromPoint(x, y);
    if (!el) throw new Error(`坐标 (${x}, ${y}) 在页面之外，或没有元素`);
    out.target = T.desc(el); out.loc = uniqueLoc(el);
    if (el === document.body || el === document.documentElement) out.warning = "落在页面背景上，没有点到任何控件：重新截图对一下坐标";
    else if (el instanceof HTMLLabelElement && (!el.control || el.control.disabled)) out.warning = "落在一个 <label> 上，它没有关联的可用控件，点击可能不会作用到它标注的那个控件";
    return el;
  };
  // computer 工具的页面动作（learn 用）：坐标是视口里的 CSS 像素（截图就是按这个尺寸缩的），左上角 (0,0)；mods 是 { cmd, ctrl, alt, shift }
  T.exec.pointer = async (cmd) => {
    try {
      const out = { ok: true };
      const mods = cmd.mods;
      switch (cmd.action) {
        case "left_click": mouseClick(hitAt(cmd.x, cmd.y, out), cmd.x, cmd.y, { mods }); break;
        case "right_click": mouseClick(hitAt(cmd.x, cmd.y, out), cmd.x, cmd.y, { button: 2, mods }); break;
        case "double_click": mouseClick(hitAt(cmd.x, cmd.y, out), cmd.x, cmd.y, { count: 2, mods }); break;
        case "triple_click": mouseClick(hitAt(cmd.x, cmd.y, out), cmd.x, cmd.y, { count: 3, mods }); break;
        case "hover": hoverTo(hitAt(cmd.x, cmd.y, out), cmd.x, cmd.y, mods); break;
        case "left_click_drag": {
          hitAt(cmd.sx, cmd.sy, out);
          const { end } = dragPath(cmd.sx, cmd.sy, cmd.x, cmd.y, mods);
          out.dropTarget = T.desc(end);
          break;
        }
        case "type": {
          const el = document.activeElement;
          if (!el || el === document.body || el === document.documentElement) throw new Error("没有获得焦点的输入框：先 computer left_click 输入框再 type");
          if (!(el.isContentEditable || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) throw new Error("焦点不在输入框上：先 computer left_click 输入框再 type");
          const text = String(cmd.text ?? "");
          out.target = T.desc(el); out.loc = uniqueLoc(el); out.chars = text.length;
          // 逐个字符：keydown → 插入 → keyup（只插入文字、没有按键事件的话，监听 keydown 的页面看不到输入）；中文、emoji 这类没有按键的只插入
          for (const ch of text) {
            const keyed = /^[\x20-\x7e]$/.test(ch);
            const init = keyInit(ch);
            if (keyed) fire(el, KeyboardEvent, "keydown", init);
            if (!document.execCommand("insertText", false, ch)) setValue(el, String(el.value ?? el.textContent ?? "") + ch);
            if (keyed) fire(el, KeyboardEvent, "keyup", init);
          }
          break;
        }
        case "key": out.target = T.desc(document.activeElement); pressKeys(document.activeElement, cmd.keys, cmd.repeat); break;
        case "scroll": {
          const at = hitAt(cmd.x, cmd.y, out);
          const box = scrollableAt(at);
          const [dx, dy] = wheelDelta(cmd.direction, cmd.amount);
          fire(at, WheelEvent, "wheel", { clientX: cmd.x, clientY: cmd.y, deltaX: dx, deltaY: dy, deltaMode: 0, ...modsOf(mods) }); // 监听滚轮的页面（地图、画布）收得到
          scrollTarget(box, dx, dy);
          out.target = box ? T.desc(box) : "page";
          out.scrollY = box ? Math.round(box.scrollTop) : Math.round(window.scrollY);
          break;
        }
        case "scroll_to": window.scrollTo({ left: cmd.x, top: cmd.y, behavior: "instant" }); out.scrollY = Math.round(window.scrollY); break;
        default: throw new Error(`未知动作 ${cmd.action}`);
      }
      out.url = location.href; out.title = document.title;
      return out;
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e), url: location.href };
    }
  };

  T.exec.ping = () => true; // 页面脚本就位的探针

  // 页面安静（没有在途请求、DOM 一小段时间没变，最多 maxMs），然后报告这次页面加载最后发出的消息序号：daemon 等它到了，就知道记录都收齐了
  T.exec.quiet = async (maxMs) => ({ ...(await settle(maxMs)), d: T.doc, n: T.n });

  T.exec.text = (max) => {
    const text = (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n").trim();
    return { url: location.href, title: document.title, total: text.length, text: text.slice(0, max) };
  };

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
