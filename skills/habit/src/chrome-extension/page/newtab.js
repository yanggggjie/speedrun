// 页面要新开标签页时拦下来，交给扩展在同一个 habit 组里开（扩展的 openForPage）。
// 原因：页面在用户手势下自己新开标签页（点 target=_blank、cmd/中键点击、window.open），Chrome 会选中新标签页、显示它的窗口，
// 用户在别的应用里也会被拉回 Chrome——这就是抢前台。habit 自己开的标签页不会。只在 habit 的标签页里拦（T.isHabit()），用户的标签页不动。
// 不拦：带窗口参数的 window.open（弹出窗口，如 OAuth 登录）、download 链接、非 http(s) 地址、指向页面里已有 frame 的 target。
// 代价：新标签页没有 window.opener，原页面拿到的是假的窗口对象；target=_blank 的表单改在当前标签页提交。
(() => {
  const SAME = new Set(["", "_self", "_parent", "_top"]);
  const web = (u) => /^https?:$/i.test(u.protocol);

  // ---- 判断（纯函数，自检 newtab.selfcheck.mjs 用）----
  const N = {
    /** 点链接会不会新开标签页：l = { href（已解析的绝对地址）, target, download, frameNamed }，e = { button, meta, ctrl, shift, alt } */
    link(l, e) {
      let u; try { u = new URL(l.href); } catch { return false; }
      if (!web(u) || l.download || e.alt) return false;
      const t = String(l.target || "").toLowerCase();
      const byTarget = !SAME.has(t) && !l.frameNamed;
      return byTarget || e.button === 1 || !!e.meta || !!e.ctrl || !!e.shift;
    },
    /** window.open(url, target, features) 会不会新开标签页（带 features 的是弹出窗口，放过） */
    open(url, target, features, frameNamed) {
      if (features) return false;
      const t = String(target ?? "").toLowerCase();
      if (t === "_self" || t === "_parent" || t === "_top" || frameNamed) return false;
      if (url === undefined || url === null || url === "" || url === "about:blank") return true; // 先开空窗口、后设地址
      try { return web(new URL(String(url), "http://x/")); } catch { return false; }
    },
    /** 表单提交会不会新开标签页 */
    form(target, frameNamed) {
      const t = String(target || "").toLowerCase();
      return !SAME.has(t) && !frameNamed;
    },
  };
  if (typeof window !== "undefined") window.__habitNewTab = N;
  if (typeof document === "undefined") return;
  const T = window.__habit;
  if (!T || T.newTabHooked) return;
  T.newTabHooked = true;

  // target 是页面里某个 iframe 的名字：在那个 frame 里打开，不是新标签页（window[name] 还会命中同 id 的元素，所以按 name 找 frame）
  const frameNamed = (name) => { try { return !!name && !SAME.has(String(name).toLowerCase()) && [...document.querySelectorAll("iframe,frame")].some((f) => f.name === name); } catch { return false; } };
  let last = { url: "", t: 0 };
  const want = (raw) => {
    let url; try { url = new URL(String(raw), location.href).href; } catch { return; }
    const now = Date.now();
    if (url === last.url && now - last.t < 1000) return; // 链接的默认行为和页面自己的 window.open 可能是同一次
    last = { url, t: now };
    T.post({ k: "newtab", url });
  };
  const linkOf = (e) => {
    for (const n of e.composedPath ? e.composedPath() : []) if (n instanceof Element && (n.localName === "a" || n.localName === "area") && n.hasAttribute("href")) return n;
    return null;
  };
  const ev = (e) => ({ button: e.button, meta: e.metaKey, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey });
  const linkInfo = (a) => ({ href: a.href, target: a.target, download: a.hasAttribute("download"), frameNamed: frameNamed(a.target) });

  // 点链接（包括中键 auxclick）：只拦默认行为，不挡页面自己的处理
  const onClick = (e) => {
    if (!T.isHabit() || e.defaultPrevented) return;
    const a = linkOf(e);
    if (!a || !N.link(linkInfo(a), ev(e))) return;
    e.preventDefault();
    want(a.href);
  };
  window.addEventListener("click", onClick, true);
  window.addEventListener("auxclick", onClick, true);

  // 原生函数换成 Proxy：toString() 还是原生的样子
  const wrap = (obj, key, apply) => { try { obj[key] = new Proxy(obj[key], { apply }); } catch {} };

  // 脚本 a.click() 一个没放进页面的链接（事件到不了 window）
  wrap(HTMLAnchorElement.prototype, "click", (fn, self, args) => {
    if (T.isHabit() && self && !self.isConnected && N.link(linkInfo(self), {})) { want(self.href); return; }
    return Reflect.apply(fn, self, args);
  });

  // window.open：返回一个假的窗口对象，能接住之后设的地址
  const fakeWindow = (pending) => {
    let closed = false;
    const loc = {
      get href() { return "about:blank"; }, set href(v) { if (pending) want(v); },
      assign(v) { if (pending) want(v); }, replace(v) { if (pending) want(v); }, toString() { return "about:blank"; },
    };
    const w = { get closed() { return closed; }, close() { closed = true; }, focus() {}, blur() {}, postMessage() {}, opener: null, document: { write() {}, writeln() {}, open() {}, close() {} } };
    Object.defineProperty(w, "location", { get: () => loc, set: (v) => { if (pending) want(v); } });
    return w;
  };
  wrap(window, "open", (fn, self, args) => {
    const [url, target, features] = args;
    if (!T.isHabit() || !N.open(url, target, features, frameNamed(target))) return Reflect.apply(fn, self, args);
    const blank = url === undefined || url === null || url === "" || url === "about:blank";
    if (!blank) want(url);
    return fakeWindow(blank);
  });

  // 表单：target 指向新标签页的改在当前标签页提交
  const fixForm = (form, submitter) => {
    if (!T.isHabit() || !form) return;
    if (submitter && submitter.hasAttribute && submitter.hasAttribute("formtarget") && N.form(submitter.getAttribute("formtarget"), frameNamed(submitter.getAttribute("formtarget")))) submitter.setAttribute("formtarget", "_self");
    if (N.form(form.getAttribute("target"), frameNamed(form.getAttribute("target")))) form.setAttribute("target", "_self");
  };
  window.addEventListener("submit", (e) => fixForm(e.target, e.submitter), true);
  wrap(HTMLFormElement.prototype, "submit", (fn, self, args) => { fixForm(self, null); return Reflect.apply(fn, self, args); });
})();
