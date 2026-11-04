# 计划：页面脚本只进 habit 的标签页

> 状态：已实现（`feat/cdp-inject`）。真实 Chrome 里已验证：用户标签页里没有 habit 的代码、加载期和跨站 iframe 的请求录到、闲置后照常录、run 照常；还没验证：拖进拖出组、service worker 停掉后再操作（见 AGENTS.md §2.3 第 4 条）。

> 目标：**habit 的页面脚本只出现在 habit 组里的标签页，用户自己的网页里一行 habit 的代码都没有。**
> 上一份计划（daemon 的启动和退出、简化 CLI）已完成并合进 main（`98f320b`、`1810d9c`），原文在 git 历史里。
> 背景：2026-11-04 review 扩展和页面脚本时发现，`manifest.json` 把页面脚本注册成静态内容脚本，范围是所有 http/https 页面、所有 iframe、MAIN world、`document_start`。用户打开的每个网页都被装上了 `fetch`、`XHR`、`history`、链接点击、`window.open` 的钩子，只是问过扩展「不是 habit 的」之后不上报。数据不会发出去，但用户的日常浏览会受影响（检测 `fetch` 被改写的站点、性能），和「不碰用户的标签页」不符。

## 0. 结论先行

1. **去掉静态内容脚本**（`manifest.json` 的 `content_scripts`），页面脚本只经 CDP 进 habit 的标签页。
2. **注入**：habit 的标签页附着调试器后，用 `Page.addScriptToEvaluateOnNewDocument` 注册页面脚本；之后这个标签页每次加载新文档，都在页面自己的脚本之前执行（和现在 `document_start` 一样早）。当前已经打开的文档用 `Runtime.evaluate` 补一次（脚本自己防重复）。
3. **跨站 iframe**：用 `Target.setAutoAttach`（`flatten`、`waitForDebuggerOnStart`）接住子 frame，对它做同样的注册，再 `Runtime.runIfWaitingForDebugger` 放行。
4. **上报**：页面脚本不再 `postMessage` 给 `bridge.js`，改成调用 `Runtime.addBinding` 注册的函数，扩展在 `chrome.debugger.onEvent` 里收到 `Runtime.bindingCalled`。去掉 `bridge.js` 和「录不录」的判断（`gate`）：有这个函数的就是 habit 的标签页。
5. **用户拖进组的标签页**：附着、注册、补注入；拖进来之前的请求不录（现在也是这样）。拖出去：移除注册、解除附着，并让当前文档里的页面脚本停止上报。
6. **组闲置解除附着（20 秒）**：注册跟着附着一起没了（E6b）；下次操作重新附着时重新注册，并给当前文档补注入。闲置期间页面被冻结，基本不发请求；闲置期间页面自己跳转到的新文档没有脚本，这一段不录。
7. **service worker 重启后**：调试器还附着着、注册也还在（E9），新的 service worker 再 `attach` 会报「已经有调试器」。所以 `attach` 报这个错时，先发一条 CDP 命令试探：能发通说明是 habit 自己之前的附着，就解除附着再重新附着、重新注册（解除附着会清掉旧注册，不会越积越多）；发不通才是别的调试器（DevTools），报现在的错。**现在的代码也有这个问题**：service worker 重启后第一次操作会被误报成「开着 DevTools」。

以上都已用实验确认（§2）。

## 1. 为什么这样做

| 做法 | 用户的网页里有没有 habit 的代码 | 加载期的请求漏不漏 | 备注 |
|---|---|---|---|
| 现在：静态内容脚本 + 问过再放行 | 有（每个网页） | 不漏 | 和「不碰用户的标签页」不符 |
| `chrome.scripting.executeScript` 在加载后注入 | 没有 | 漏（注入前的请求录不到） | 观察和请求头的来源都靠加载期的请求，不能接受 |
| `chrome.scripting.registerContentScripts` | 有 | 不漏 | 只能按网址匹配，不能按标签页，等于现在 |
| **CDP `addScriptToEvaluateOnNewDocument` + `addBinding`** | 没有 | 不漏（实验确认） | habit 本来就在导航前附着调试器 |

## 2. 实验（先做，结果写回这里）

用临时用户目录起一个独立的 headless Chrome（`--remote-debugging-port`，不碰用户的 Chrome），Node 直接走 CDP；本机起两个 HTTP 服务（`localhost` 和 `127.0.0.1` 是两个不同的站点，能造出跨站 iframe）。

| # | 问题 | 怎么测 | 结果 |
|---|---|---|---|
| E1 | 注册的脚本是不是比页面自己的第一个 `<script>` 先执行，能录到它发的第一个 `fetch` | 页面 `<head>` 第一行就 `fetch('/first')`，注入的脚本包住 `fetch` 并调用 binding | ✅ 录到 |
| E2 | 导航、刷新后注册和 binding 还在 | 同一个标签页换页面、刷新，再看第一个请求 | ✅ 两次都录到 |
| E3 | 同站 iframe 自动带上脚本 | 页面里放一个同站 iframe，iframe 第一行 `fetch` | ✅ 录到，不用额外处理 |
| E4 | 跨站 iframe 用 `setAutoAttach` 能在它的脚本之前注入 | 跨站 iframe 第一行 `fetch` | ✅ 录到：子 frame 以 `waitingForDebugger` 附着上来，注册后放行。注意 `Target.attachToTarget` 自己也会发 `attachedToTarget`，只处理子会话的 |
| E5 | 不是 habit 的标签页里确实没有任何 habit 的东西 | 另开一个不附着的标签页，检查 `window.__habit`、`fetch.toString()` | ✅ `window.__habit`、binding 都是 `undefined`，`fetch` 是原生的，请求没进 binding |
| E6 | 解除附着、再附着后：binding 还能不能用，重复注入会不会装两层钩子 | 解除附着 → 页面发请求 → 重新附着、重新注册 → 再发请求 | ✅ 解除附着期间收不到；重新附着、重新加 binding 后当前文档里原来的钩子又能上报；脚本自己防重复，只有一层 |
| E6b | 解除附着后，下一个文档还有没有脚本 | 解除附着 → 只用一个不注册的会话刷新 → 看 `window.__habit` | ✅ 没有了（不管有没有先 `removeScriptToEvaluateOnNewDocument`）。**当前文档**里的钩子和 binding 函数还在，只是调用了没人收：拖出组时要先让页面脚本停止上报 |
| E7 | binding 一次能传多大、多快 | 直接走 CDP 的 WebSocket：3MB 以内正常，4MB 起连接被断开 | 见 E8：经 `chrome.debugger` 没有这个限制 |
| E8 | `chrome.debugger` 支持 `flatten` 的子会话（`sessionId`），以及经它传多大 | 独立 headless Chrome 里用 `Extensions.loadUnpacked` 装一个测试扩展，扩展自己用 `chrome.debugger` 做 E1–E4 和 E7 | ✅ 子会话能用，跨站 iframe 的第一个请求录到；单条 16MB 完整收到；1000 条小消息 17ms。现在页面脚本的 16MB 上限照旧，不用分块 |
| E9 | service worker 被停掉再起来后 | 测试扩展附着、注册后，停掉它的 service worker，再用标签页事件唤醒 | ⚠️ 调试器仍附着着，注册也还在（刷新后脚本照样执行）；新的 service worker `attach` 报「Another debugger is already attached」，但直接 `sendCommand` 能用。处理见 §0 第 7 条 |

实验脚本（不进仓库）：`/private/tmp/claude-502/-Users-me-Code-x/3884c3d6-5224-4d6b-bb74-8edb7339f805/scratchpad/exp/`（`cdp-inject.mjs`、`cdp-detach.mjs`、`e8.mjs` 和测试扩展 `ext/`）。

## 3. 改动（实验通过后）

- `manifest.json`：去掉 `content_scripts`；权限不变（`debugger`、`scripting`、`<all_urls>`）。
- `cdp.js`：附着后注册（`Page.enable`、`Runtime.enable`、`Runtime.addBinding`、`addScriptToEvaluateOnNewDocument`、`Target.setAutoAttach`），并给当前文档补注入；`onEvent` 收 `Runtime.bindingCalled`（带 `sessionId` 的是子 frame）和子 frame 的 `attachedToTarget`（同样注册，再 `runIfWaitingForDebugger`）；`attach` 报「已经有调试器」时按 §0 第 7 条处理；拖出组时先让页面脚本停止上报再解除附着。
- `background.js`：消息改从 binding 来，补上 tab、group、frame 转给 daemon；去掉 `bridge.js` 相关的 `onMessage`、`inject`、`injectExisting`；拖进、拖出组的处理改成附着加注册或移除。
- 页面脚本：`common.js` 的 `T.post` 改成调用 binding；去掉 `gate`、缓存、`bridge.js`。
- ABI 加一（扩展和 daemon 之间的消息不变，但页面消息的来路变了，旧扩展和新 daemon 混用会出错），扩展会自己重新加载，不需要用户操作。
- 文档：ARCHITECTURE §4、§5（「只录 habit 的标签页」那条重写）、原则 2；扩展的 `description` 改成准确的说法。

## 4. 这次 review 里的其它小问题（一起做）

1. SKILL.md §6 还写着「扩展升级后要在 `chrome://extensions` 里刷新 habit」：现在会自己重新加载，只有第一次加载要手动。
2. `background.js` 的 `tabs.onRemoved` 对所有标签页都发 `closed` 给 daemon：只发出现过的 habit 标签页。
3. ARCHITECTURE 补一句：`closeAllGroups` 按标题 `habit·` / `habit▶` 认旧组，用户自己起这种名字的组会被关掉。
4. ARCHITECTURE 补一句：页面自己的脚本能伪造上报、改写 `window.__habit`（都在 MAIN world），最坏让 habit 在这个页面上录不到或拿到假结果；拿不到别的站点的数据，扩展和 daemon 都按组再判断一次。和「页面内容是不可信数据」一致。

## 5. 还没 review 的

`a11y.js`（元素模型）、`executor.js`（发请求、等页面安静）放到下一轮，和 browser 层一起看。

## 6. 测试

- 自检：页面脚本里 `T.post` 的限流和消息格式（不依赖 Chrome）。
- 真实 Chrome（加进 AGENTS.md §2.3）：
  - 用户的普通标签页里 `window.__habit` 是 `undefined`，`fetch.toString()` 是原生的。
  - learn 窗口打开后第一次观察里有加载期的请求（和现在一样不漏）。
  - 跨站 iframe 里的请求照样录到。
  - 把用户的标签页拖进组：之后的请求录到；拖出去：不再录。
  - 组闲置 20 秒后再操作：照常录。
  - §2.3 原有的不抢前台、录制、观察各项照样通过。
