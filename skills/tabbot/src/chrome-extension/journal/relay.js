// 隔离世界里的中转：把 hook.js 通过 postMessage 发出的消息交给扩展 service worker。
// 页面脚本也能往 window 发消息，所以这里的内容只当"观察记录"，不能当权限依据。
if (!window.__tcrRelay) {
  window.__tcrRelay = 1;
  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data.__tcrl !== 1) return;
    try {
      chrome.runtime.sendMessage({ __tcrl: 1, top: window === window.top, page: location.href, msg: e.data });
    } catch {}
  });
}
