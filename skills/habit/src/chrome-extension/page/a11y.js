// 页面里（MAIN world）的元素模型：唯一的 role / name 算法、a11y 树（read_page）、find、持久定位的生成和解析、元素 → 视口坐标。
// learn 里看到的 `role "name"`（read_page、find）和 action 回放时解析 { role, name } 用的是同一套算法：learn 里看到什么名字，action 里就写什么名字。
// 做法来自 open-claude-in-chrome 的 content.js（getRole / getAccessibleName / generateAccessibilityTree / findElements / getRefCoordinates）。
// 这里只找元素、算坐标，不发输入：输入都由扩展用 CDP 发（cdp.js）。
(() => {
  const T = window.__habit;
  if (!T || T.a11y) return;
  T.a11y = 1;

  // ---- role ----
  const TAG_ROLE = {
    a: "link", button: "button", textarea: "textbox", select: "combobox", img: "img",
    h1: "heading", h2: "heading", h3: "heading", h4: "heading", h5: "heading", h6: "heading",
    nav: "navigation", main: "main", header: "banner", footer: "contentinfo", aside: "complementary", form: "form",
    table: "table", tr: "row", th: "columnheader", td: "cell", ul: "list", ol: "list", li: "listitem",
    dialog: "dialog", details: "group", summary: "button", progress: "progressbar", meter: "meter",
    video: "video", audio: "audio", section: "region", article: "article", option: "option",
  };
  const INPUT_ROLE = { checkbox: "checkbox", radio: "radio", range: "slider", button: "button", submit: "button", reset: "button", image: "button", search: "searchbox", number: "spinbutton" };
  const roleOf = (el) => {
    const r = el.getAttribute("role");
    if (r) return r.trim().split(/\s+/)[0];
    const tag = el.tagName.toLowerCase();
    if (tag === "a" && !el.hasAttribute("href")) return "";
    if (tag === "input") return INPUT_ROLE[(el.type || "text").toLowerCase()] || "textbox";
    return TAG_ROLE[tag] || "";
  };

  // ---- name：aria-label > aria-labelledby > placeholder > title > alt > label > 内容（只对按内容命名的元素，<200 字）----
  const NAME_FROM_CONTENT_TAGS = new Set(["a", "button", "h1", "h2", "h3", "h4", "h5", "h6", "li", "summary", "label", "th", "td", "option", "span", "legend", "caption"]);
  const NAME_FROM_CONTENT_ROLES = new Set(["button", "link", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "checkbox", "radio", "switch", "treeitem", "heading", "cell", "columnheader", "rowheader", "listitem", "tooltip"]);
  const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  const nameOf = (el) => {
    const aria = el.getAttribute("aria-label");
    if (aria && clean(aria)) return clean(aria);
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent).filter(Boolean).map(clean).join(" ");
      if (t) return t;
    }
    // typeof：表单里的命名控件会把 form.title、form.placeholder 这类属性遮成元素（<input name="title">），不是字符串
    if (typeof el.placeholder === "string" && el.placeholder.trim()) return clean(el.placeholder);
    if (typeof el.title === "string" && el.title.trim()) return clean(el.title);
    if (typeof el.alt === "string" && el.alt.trim()) return clean(el.alt);
    if (el.labels && el.labels.length) { const t = clean(el.labels[0].textContent); if (t) return t; }
    const tag = el.tagName.toLowerCase();
    if (tag === "input" && /^(button|submit|reset)$/i.test(el.type) && el.value) return clean(el.value);
    if (NAME_FROM_CONTENT_TAGS.has(tag) || NAME_FROM_CONTENT_ROLES.has(roleOf(el))) {
      const t = clean(el.textContent);
      if (t && t.length < 200) return t;
    }
    return "";
  };
  T.roleOf = roleOf;
  T.nameOf = nameOf;

  const INTERACTIVE_ROLES = new Set(["button", "link", "textbox", "searchbox", "checkbox", "radio", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "switch", "combobox", "slider", "spinbutton", "option", "treeitem"]);
  const interactive = (el) => {
    const tag = el.tagName.toLowerCase();
    if (/^(button|input|textarea|select|summary|details)$/.test(tag) || (tag === "a" && el.hasAttribute("href"))) return true;
    if (INTERACTIVE_ROLES.has(roleOf(el))) return true;
    if (el.tabIndex >= 0 && el.hasAttribute("tabindex")) return true;
    if (el.hasAttribute("onclick") || el.isContentEditable) return true;
    return false;
  };

  // ---- 持久定位 loc（写进 action 的）：CSS 字符串 | { css } | { role, name, exact?, nth? } | { text, nth? } ----
  // 所有元素，包括 shadow DOM 里的
  const allElements = (root = document, out = []) => {
    for (const el of root.querySelectorAll("*")) { out.push(el); if (el.shadowRoot) allElements(el.shadowRoot, out); }
    return out;
  };
  T.find = (loc) => {
    if (typeof loc === "string") loc = { css: loc };
    if (!loc || typeof loc !== "object") throw new Error(`定位要是 CSS 字符串或 { role, name } / { text } / { css }，收到：${JSON.stringify(loc)}`);
    if (loc.role || loc.name !== undefined || loc.text !== undefined) {
      const pool = (loc.css ? [...document.querySelectorAll(loc.css)] : allElements()).filter((el) => T.visible(el));
      const byRole = loc.role ? pool.filter((el) => roleOf(el) === loc.role) : pool;
      const want = clean(loc.name ?? loc.text ?? "");
      const got = (el) => (loc.text !== undefined ? clean(el.innerText ?? el.textContent) : nameOf(el));
      let list = want ? byRole.filter((el) => got(el) === want) : byRole;
      if (!list.length && want && !loc.exact) list = byRole.filter((el) => got(el).includes(want));
      if (loc.text !== undefined && list.length > 1) list = list.filter((el) => !list.some((o) => o !== el && el.contains(o))); // 只留最里面的
      return list;
    }
    return [...document.querySelectorAll(loc.css)].filter((el) => T.visible(el));
  };
  T.resolveLoc = async (loc, timeoutMs = 10000) => {
    const t0 = Date.now();
    const nth = loc && typeof loc === "object" ? loc.nth : undefined;
    for (;;) {
      const list = T.find(loc);
      if (nth !== undefined && list[nth]) return list[nth];
      if (nth === undefined && list.length === 1) return list[0];
      if (nth === undefined && list.length > 1) {
        if (typeof loc === "string" || (loc.css && !loc.role && loc.name === undefined && loc.text === undefined)) return list[0];
        throw new Error(`定位 ${JSON.stringify(loc)} 命中 ${list.length} 个元素：改用更具体的 name，或加 nth`);
      }
      if (Date.now() - t0 >= timeoutMs) throw new Error(`${Math.round(timeoutMs / 1000)} 秒内页面上没有出现 ${JSON.stringify(loc)}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  // 元素的持久定位：有 role 和名字就用 { role, name }（不唯一补 nth），否则用 CSS 路径
  T.locOf = (el) => {
    const role = roleOf(el), name = nameOf(el).slice(0, 80);
    if (role && name) {
      const loc = { role, name };
      const list = T.find(loc);
      if (list.length === 1 && list[0] === el) return loc;
      const i = list.indexOf(el);
      if (i >= 0) return { ...loc, nth: i };
    }
    return { css: T.cssPath(el) };
  };

  // ---- 目标：ref | loc | 坐标 → 元素 ----
  const elementOf = async (t) => {
    if (t.ref) { const el = T.byRef(t.ref); if (!el || !el.isConnected) throw new Error(`${t.ref} 找不到了：页面变了，重新 read_page 或 find`); return el; }
    if (t.loc !== undefined) return T.resolveLoc(t.loc, t.timeout ?? 10000);
    return null;
  };
  // 坐标处真正收到事件的元素（穿进 shadow DOM）
  const deepFromPoint = (x, y) => {
    let el = document.elementFromPoint(x, y);
    while (el && el.shadowRoot) { const inner = el.shadowRoot.elementFromPoint(x, y); if (!inner || inner === el) break; el = inner; }
    return el;
  };
  const brief = (el) => `<${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ""}${typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\s+/)[0] : ""}>${clean(el.textContent).slice(0, 40) ? ` "${clean(el.textContent).slice(0, 40)}"` : ""}`;
  const inViewport = (x, y) => x >= 0 && y >= 0 && x < innerWidth && y < innerHeight;
  // 落点提醒：落在页面背景上、或落在没有可用控件的 <label> 上（不自动纠正：用户点那里也会点到同一个东西）
  const warningAt = (el) => {
    if (el === document.body || el === document.documentElement) return "落在页面背景上，没有点到任何控件：重新 find 或截图对一下";
    const label = el.closest && el.closest("label");
    if (label && (!label.control || label.control.matches(":disabled")) && !el.closest("a[href],button:enabled,input:enabled,select:enabled,textarea:enabled,[role=button],[role=link],[onclick]")) return "落在一个 <label> 上，它没有关联的可用控件，点击可能不会作用到它标注的那个控件";
    return undefined;
  };

  /**
   * 把目标变成视口坐标（输入由扩展用 CDP 在这个坐标上发）。目标是 { ref } | { loc } | { x, y }。
   * 元素在视口外就先滚到视口中央；报告这一点上真正收到点击的元素（被遮挡时写出是谁）、它的持久定位和落点提醒。
   */
  T.exec.point = async (t) => {
    if (t.center) { const x = Math.round(innerWidth / 2), y = Math.round(innerHeight / 2); return { x, y, target: "page" }; }
    const el = await elementOf(t);
    if (!el) {
      const x = Number(t.x), y = Number(t.y);
      if (!inViewport(x, y)) throw new Error(`坐标 (${x}, ${y}) 在视口之外（视口 ${innerWidth}×${innerHeight}）`);
      const hit = deepFromPoint(x, y);
      if (!hit) throw new Error(`坐标 (${x}, ${y}) 上没有元素`);
      return { x, y, target: T.desc(hit), loc: T.locOf(hit), warning: warningAt(hit) };
    }
    let r = el.getBoundingClientRect();
    let scrolled = false;
    if (t.scroll !== false && (r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight)) {
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      r = el.getBoundingClientRect();
      scrolled = true;
    }
    const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
    if (!inViewport(x, y)) throw new Error(`${t.ref ?? JSON.stringify(t.loc)} 滚动后还在视口之外：可能在要单独滚动的容器里，或被隐藏了`);
    const hit = deepFromPoint(x, y);
    const covered = hit && hit !== el && !el.contains(hit) && !hit.contains(el) ? brief(hit) : undefined;
    return { x, y, target: T.desc(el), loc: T.locOf(el), ...(covered ? { covered } : {}), ...(scrolled ? { scrolled: true } : {}), warning: covered ? undefined : warningAt(el) };
  };

  /** 视口大小和滚动位置。 */
  T.exec.viewport = () => ({ w: innerWidth, h: innerHeight, scrollX: Math.round(window.scrollX), scrollY: Math.round(window.scrollY) });

  /** 把目标滚到视口中央（scroll_to）：{ ref } | { loc } | { x, y }（坐标处的元素）。 */
  T.exec.scrollTo = async (t) => {
    const el = (await elementOf(t)) ?? deepFromPoint(Number(t.x), Number(t.y));
    if (!el) throw new Error("scroll_to 没有找到元素");
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    return { target: T.desc(el), loc: T.locOf(el), scrollY: Math.round(window.scrollY) };
  };

  /** 让目标获得焦点（key 带 loc 时用）。 */
  T.exec.focus = async (t) => {
    const el = await elementOf(t);
    if (el && el.focus) el.focus({ preventScroll: false });
    return { target: T.desc(el || document.activeElement), ...(el ? { loc: T.locOf(el) } : {}) };
  };

  /**
   * form_input 的准备：找到真正的控件（可能在 shadow DOM 里），说清它是什么，给出点击坐标。
   * kind：text（输入框、文本域、可编辑区域）| select | check（复选、单选）。select 直接在这里设值（原生下拉的选项不在页面里，CDP 点不到）。
   */
  T.exec.formTarget = async (t) => {
    const outer = await elementOf(t);
    if (!outer) throw new Error("form_input 要给 ref 或定位");
    const inner = /^(input|textarea|select)$/i.test(outer.tagName) || outer.isContentEditable ? outer
      : (outer.shadowRoot || outer).querySelector("input, textarea, select, [contenteditable=''], [contenteditable=true]") || outer;
    const el = inner;
    if (el.disabled || el.readOnly) throw new Error("这个控件是禁用或只读的");
    const base = { target: T.desc(el), loc: T.locOf(outer) };
    if (el instanceof HTMLSelectElement) {
      const want = String(t.value ?? "");
      const opt = [...el.options].find((o) => o.value === want || clean(o.text) === want);
      if (!opt) throw new Error(`下拉框里没有选项「${want}」，可选：${[...el.options].map((o) => clean(o.text)).slice(0, 12).join(" | ")}`);
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(el, opt.value);
      el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      return { ...base, kind: "select", value: clean(opt.text) };
    }
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const r = el.getBoundingClientRect();
    const at = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    if (el instanceof HTMLInputElement && /^(checkbox|radio)$/i.test(el.type)) return { ...base, ...at, kind: "check", checked: el.checked };
    if (el.isContentEditable || el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !/^(button|submit|reset|image|file|hidden|color|range)$/i.test(el.type))) {
      if (el.focus) el.focus({ preventScroll: true });
      return { ...base, ...at, kind: "text" };
    }
    throw new Error(`form_input 不支持 <${el.tagName.toLowerCase()}${el.type ? ` type=${el.type}` : ""}>：用 computer left_click 点它`);
  };
  /** 复选框现在勾没勾（form_input 点完核对）。 */
  T.exec.checked = async (t) => { const el = await elementOf(t); const box = el && (el.matches("input") ? el : el.querySelector("input")); return { checked: !!box?.checked }; };
  /** 输入框现在的值（form_input 填完核对；密码框不回值）。 */
  T.exec.valueOf = async (t) => {
    const outer = await elementOf(t);
    const el = outer && (/^(input|textarea)$/i.test(outer.tagName) || outer.isContentEditable ? outer : (outer.shadowRoot || outer).querySelector("input, textarea, [contenteditable]")) || outer;
    if (!el) return { value: null };
    if (el.type === "password") return { value: null, password: true };
    return { value: el.isContentEditable ? clean(el.textContent) : String(el.value ?? "") };
  };

  // ---- a11y 树（read_page）----
  const visible = (el) => T.visible(el) || getComputedStyle(el).position === "fixed" && el.getClientRects().length > 0;
  T.exec.readPage = ({ filter = "all", depth = 15, ref, maxChars = 50000 } = {}) => {
    let out = "", truncated = false, count = 0;
    const append = (line) => {
      if (truncated) return;
      if (out.length + line.length > maxChars) { truncated = true; return; }
      out += line; count++;
    };
    const walk = (el, d, indent) => {
      if (truncated || d > depth || !el || el.nodeType !== 1) return;
      const tag = el.tagName.toLowerCase();
      if (/^(script|style|noscript|template|svg|head|meta|link)$/.test(tag)) return;
      const st = getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden") return;
      const role = roleOf(el), name = nameOf(el), inter = interactive(el);
      const show = (filter === "interactive" ? inter : !!(role || name)) && visible(el);
      if (show) {
        let line = `${indent}${role || tag}`;
        if (name) line += ` "${name.slice(0, 100)}"`;
        line += ` [${T.refOf(el)}]`;
        if (tag === "a" && el.href) line += ` href="${el.href.slice(0, 200)}"`;
        if (tag === "img" && el.src) line += ` src="${el.src.slice(0, 100)}"`;
        if (tag === "input") line += ` type="${el.type || "text"}"`;
        if (/^(input|textarea)$/.test(tag) && el.value && el.type !== "password" && el.type !== "hidden") line += ` value="${String(el.value).slice(0, 100)}"`;
        if (el instanceof HTMLInputElement && /^(checkbox|radio)$/i.test(el.type)) line += ` checked=${el.checked}`;
        for (const a of ["aria-expanded", "aria-checked", "aria-selected", "aria-pressed"]) { const v = el.getAttribute(a); if (v) line += ` ${a.slice(5)}=${v}`; }
        if (el.disabled) line += " disabled";
        if (tag === "select") line += ` options=[${[...el.options].slice(0, 30).map((o) => `${o.selected ? "*" : ""}"${clean(o.text)}"`).join(", ")}]`;
        append(line + "\n");
      }
      const next = show ? indent + "  " : indent;
      if (el.shadowRoot) for (const c of el.shadowRoot.children) walk(c, d + 1, next);
      for (const c of el.children) walk(c, d + 1, next);
    };
    let root = document.body;
    if (ref) { root = T.byRef(ref); if (!root || !root.isConnected) throw new Error(`${ref} 找不到了：页面变了，重新 read_page 或 find`); }
    walk(root, 0, "");
    return { url: location.href, title: document.title, text: out, count, truncated, viewport: [innerWidth, innerHeight] };
  };

  // ---- find：按目的或文字找元素（最多 20 个），带 ref、坐标、在不在视口里、持久定位 ----
  T.exec.findElements = ({ query, limit = 20 }) => {
    const q = clean(query).toLowerCase();
    if (!q) throw new Error("find 要写查询，如 \"搜索框\"、\"评论\"");
    const words = q.split(" ").filter(Boolean);
    const hits = [];
    let more = 0;
    for (const el of allElements()) {
      const tag = el.tagName.toLowerCase();
      if (/^(script|style|noscript|template|html|body|head)$/.test(tag) || !T.visible(el)) continue;
      const role = roleOf(el), name = nameOf(el);
      const own = clean(el.textContent).slice(0, 200);
      const hay = `${role} ${name} ${own} ${typeof el.placeholder === "string" ? el.placeholder : ""} ${el.getAttribute("aria-label") || ""} ${typeof el.title === "string" ? el.title : ""} ${typeof el.type === "string" ? el.type : ""} ${tag} ${el.id || ""}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) continue;
      // 只留最里面的：外层容器的文字包含了里面的元素，只报里面那个（除非外层本身可交互、里面的不可交互）
      hits.push(el);
    }
    const inner = hits.filter((el) => !hits.some((o) => o !== el && el.contains(o) && (interactive(o) || !interactive(el))));
    // 可交互的排前面
    inner.sort((a, b) => Number(interactive(b)) - Number(interactive(a)));
    if (inner.length > limit) more = inner.length - limit;
    return {
      more,
      items: inner.slice(0, limit).map((el) => {
        const r = el.getBoundingClientRect();
        const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
        return { ref: T.refOf(el), role: roleOf(el) || el.tagName.toLowerCase(), name: (nameOf(el) || clean(el.textContent)).slice(0, 80), x, y, offViewport: !inViewport(x, y), loc: T.locOf(el) };
      }),
    };
  };

  // ---- get_page_text：正文优先（article、main …），没有就整页 ----
  T.exec.pageText = ({ max = 20000 } = {}) => {
    const sel = ["article", "main", "[role=main]", '[class*="articleBody"]', '[class*="post-content"]', '[class*="entry-content"]', "#content", ".content"];
    let src = null;
    for (const s of sel) { const el = document.querySelector(s); if (el && T.visible(el) && clean(el.innerText).length > 200) { src = el; break; } }
    const from = src ?? document.body;
    const text = String(from?.innerText ?? "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    return { url: location.href, title: document.title, source: src ? src.tagName.toLowerCase() + (src.id ? `#${src.id}` : "") : "body", total: text.length, text: text.slice(0, max) };
  };
})();
