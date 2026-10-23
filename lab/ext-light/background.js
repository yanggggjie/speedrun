importScripts("config.js");
const HUB = self.TCR.hub + "/ev";
let buf = [];
chrome.runtime.onMessage.addListener((m, s) => { buf.push({ ...m, tab: s.tab?.id, frame: s.frameId }); });
const wr = (d, extra) => buf.push({ k: "wr", t: Date.now(), type: d.type, url: d.url, method: d.method, status: d.statusCode, tab: d.tabId, frame: d.frameId, cache: d.fromCache, initiator: d.initiator, ...extra });
chrome.webRequest.onCompleted.addListener((d) => wr(d), { urls: ["<all_urls>"] });
chrome.webRequest.onErrorOccurred.addListener((d) => wr(d, { err: d.error }), { urls: ["<all_urls>"] });
setInterval(async () => {
  if (!buf.length) return;
  const out = buf; buf = [];
  try { await fetch(HUB, { method: "POST", headers: { "x-tcr-token": self.TCR.token }, body: out.map((x) => JSON.stringify(x)).join("\n") }); } catch { buf = out.concat(buf); }
}, 300);
