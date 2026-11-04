// 内容脚本（隔离世界）里的中转：把页面脚本（common / recorder / executor）通过 postMessage 发出的消息交给扩展。
// 页面自己的脚本也能往 window 发消息，所以这里的内容只当"观察记录"，不能当权限依据。
// 加载时问扩展一次"这个标签页录不录"（只有 habit 组里的标签页录），把答案告诉页面脚本（common.js 的 T.post 据此放行或丢弃）；
// 标签页被拖进、拖出 habit 的组时扩展会再发来一次。
if (!globalThis.__habitBridge) {
  globalThis.__habitBridge = 1;
  const tell = (on) => { try { window.postMessage({ __habitGate: 1, on: !!on }, "*"); } catch {} };
  try { chrome.runtime.sendMessage({ __habitMsg: 2 }, (r) => { void chrome.runtime.lastError; tell(r && r.on); }); } catch { tell(false); }
  try { chrome.runtime.onMessage.addListener((m) => { if (m && m.__habitGate === 1) tell(m.on); }); } catch {}
  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data.__habitMsg !== 1) return;
    try {
      chrome.runtime.sendMessage({ __habitMsg: 1, top: window === window.top, page: location.href, msg: e.data });
    } catch {}
  });
}
