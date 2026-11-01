// 内容脚本（隔离世界）里的中转：把页面脚本（common / recorder / executor）通过 postMessage 发出的消息交给扩展。
// 页面自己的脚本也能往 window 发消息，所以这里的内容只当"观察记录"，不能当权限依据。
// 加载时问扩展一次"这个标签页录不录"（只有 TabBot 开的、以及被它们打开的标签页录），把答案告诉页面脚本（common.js 的 T.post 据此放行或丢弃）。
if (!globalThis.__tcrBridge) {
  globalThis.__tcrBridge = 1;
  const tell = (on) => { try { window.postMessage({ __tcrg: 1, on: !!on }, "*"); } catch {} };
  try { chrome.runtime.sendMessage({ __tcrl: 2 }, (r) => { void chrome.runtime.lastError; tell(r && r.on); }); } catch { tell(false); }
  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data.__tcrl !== 1) return;
    try {
      chrome.runtime.sendMessage({ __tcrl: 1, top: window === window.top, page: location.href, msg: e.data });
    } catch {}
  });
}
