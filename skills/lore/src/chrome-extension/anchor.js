// anchor 页每次打开都从磁盘读（扩展页不缓存）：拿磁盘上这一版的 build，问正在跑的 background 是哪一版，
// 不一样（或 background 太旧、不会回答）就让扩展从磁盘重新加载。这样从不支持 reload 的旧版升级时，开一个 agent 窗口就会自己换成新版。
import { BUILD } from "./build.js";

if (BUILD) {
  chrome.runtime.sendMessage({ __loreMsg: 3 }, (r) => {
    void chrome.runtime.lastError;
    if (!r || r.build !== BUILD) chrome.runtime.reload();
  });
}
