// 页面的原生弹窗（离开确认、alert、confirm、prompt）是 Chrome 的系统弹窗：会把 Chrome 拉到前台，并阻塞页面和 speedrun 的操作。
// 只在 speedrun 的标签页里拦（T.isAgent()），用户的标签页不动：页面自己的 beforeunload 处理照常跑（可能在保存），只是不再弹确认。
// alert 直接过，confirm 选取消，prompt 返回 null（不替用户同意任何事），都上报给 daemon，agent 看得到。漏掉的由 cdp.js 的 Page.javascriptDialogOpening 兜底。
(() => {
  const T = window.__spr;
  if (!T || T.dialogs) return;
  T.dialogs = 1;
  const report = (kind, message) => T.post({ k: "dialog", kind, message: String(message ?? "").slice(0, 200), t: Date.now() });

  const native = { alert: window.alert, confirm: window.confirm, prompt: window.prompt };
  const hook = (name, result) => {
    window[name] = function (message) {
      if (!T.isAgent()) return native[name].apply(this, arguments);
      report(name, message);
      return result;
    };
  };
  hook("alert", undefined);
  hook("confirm", false);
  hook("prompt", null);

  // ---- 离开确认：页面想弹确认的三种写法都接住，当下就上报（页面卸载时发的消息会丢），一次离开只报一条 ----
  let told = false;
  const wantsConfirm = () => {
    if (told) return;
    told = true;
    report("beforeunload", "离开时页面还有没保存的改动");
    setTimeout(() => { told = false; }, 1000); // 没真的离开时，下次还要报
  };
  const proto = window.BeforeUnloadEvent?.prototype;
  if (proto) {
    const prevent = Event.prototype.preventDefault;
    const value = Object.getOwnPropertyDescriptor(proto, "returnValue");
    proto.preventDefault = function () { if (T.isAgent()) wantsConfirm(); else prevent.call(this); };
    Object.defineProperty(proto, "returnValue", {
      configurable: true,
      get() { return value?.get?.call(this) ?? ""; },
      set(v) { if (T.isAgent()) { if (v) wantsConfirm(); } else value?.set?.call(this, v); },
    });
  }
  let handler = null;
  Object.defineProperty(window, "onbeforeunload", { configurable: true, get: () => handler, set: (fn) => { handler = typeof fn === "function" ? fn : null; } });
  window.addEventListener("beforeunload", function (e) {
    if (!handler) return;
    const r = handler.call(window, e);
    if (r === undefined || r === null) return;
    if (T.isAgent()) wantsConfirm(); else e.returnValue = r;
  });
})();
