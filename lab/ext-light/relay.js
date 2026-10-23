window.addEventListener("message", (e) => {
  if (e.source === window && e.data && e.data.__tcrl) {
    try { chrome.runtime.sendMessage({ ...e.data, top: window === window.top, page: location.href }); } catch {}
  }
});
