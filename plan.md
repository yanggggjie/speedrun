# 计划：lore 不再开窗口，在用户窗口里用标签组，页面的新开标签页由 lore 接管

> 目标：**任何情况下都不抢用户的前台，也不多开窗口**。现在每个 learn 句柄、每次 run 各开一个 Chrome 窗口；改成在用户窗口里，每个句柄或 run 一个折叠的标签组。
> 上一份计划（a11y 树 + CDP 输入）已完成并合进 main（`442568e`），原文在 git 历史里。
> 参考：OCIC（`~/Code/x/open-claude-in-chrome/extension/background.js`）和本机的 Claude in Chrome 扩展（1.0.104）。实验和调研结果在 §7、§8、§9。

## 0. 结论先行

1. **不开窗口**：一个 lore 窗口（learn 句柄 / run 名字）= 用户窗口里的一个标签组。组建在用户最近用的普通窗口里，干活时也保持折叠。命令行里的「窗口」「句柄」、`~/.lore/learn-windows/` 目录都不变，只换底下的实现。只有一个普通窗口都没有时（mac 上 Chrome 开着但没有窗口），才开一个 `focused:false` 的窗口（和 Claude in Chrome 一样）。
2. **抢前台的三个来源，逐个堵住**：
   - **Chrome 自己**：页面在用户手势下新开标签页（点 `target=_blank`、cmd/中键点击、`window.open`），Chrome 会选中新标签页、显示它的窗口，用户在别的应用里也会把 Chrome 拉到前台（§9.2）。→ **在页面里拦下，交给 lore 开**（§3.3）。
   - **别的扩展**：Tab Activate 这类扩展会把新标签页切到前台，只跳过 `chrome://newtab/`（§7.2）。→ lore 开标签页时**先开成 `chrome://newtab/`**，进组后再导航。
   - **lore 自己**：现在操作前要 `activate`。→ **删掉**，渲染靠调试器（第 4 条）。
3. **归属看组**（学 OCIC）：标签页的 `groupId` 是 lore 的组，它就是 lore 的标签页。扩展只记「哪些组是 lore 的」；组属于哪个句柄或 run（key）只记在 daemon 内存里。用户把标签页拖进组 = 交给 lore，拖出去 = 收回。
4. **渲染靠调试器 + focus emulation**（§7.1 实测）：标签页一建好就附着，折叠组里的后台页面照常渲染，懒加载、IntersectionObserver、截图、CDP 输入都正常。
5. **闲置就收起**（学 Claude in Chrome）：一个组 20 秒没有操作就解除附着（页面被 Chrome 冻结，不吃 CPU）；下次操作前再附着（解冻 26 ms）。所有组都闲置时，调试横幅也会消失。
6. **调试横幅挡不住**：「…已开始调试此浏览器」是浏览器级别的提示，附着期间所有窗口都显示（§9.4 用户确认）。只能靠第 5 条缩短它出现的时间。
7. **daemon 重启不找回**：连上扩展后关掉全部 lore 组；learn 句柄下次操作时从上次的 URL 重开，和现在一样。
8. **先不管**：带窗口参数的 `window.open` 开出的弹出窗口。拦截时放过它，保留 OAuth 登录这类弹窗的正常行为。

## 1. 三种做法的对比

| 方面 | OCIC | Claude in Chrome | lore（本计划） |
|---|---|---|---|
| 组放在哪 | 自己开一个 `focused:false` 的窗口 | 用户最近用的窗口，没有普通窗口时才开 `focused:false` 的窗口 | 同 Claude in Chrome |
| 组的数量 | 全局一个 "MCP" 组 | 每个会话一个组 | 每个句柄或 run 一个组 |
| lore 开的新标签页 | `tabs.create({active:false})` | 先开 `chrome://newtab`、`active:false`，再导航 | 同 Claude in Chrome |
| 页面开的新标签页 | 不处理（在自己的窗口里） | 不拦，事后按 opener 收进组 → **会抢前台**（§8.2 实测） | **在页面里拦下，由 lore 开** |
| 归属判断 | 实时查 `tab.groupId` | 组和元数据 | 实时查 `tab.groupId` 是否在 `loreGroups` 里 |
| 渲染 | 调试器 + focus emulation | 调试器 + focus emulation | 调试器 + focus emulation |
| 闲置 | 不处理 | 20 秒后折叠、解除附着 | 20 秒后解除附着（组一直折叠） |
| 抢焦点 | 只有显式的 `set_tab_focus` | 只有用户点按钮时；页面新开标签页时会 | 永远不会 |

## 2. lore 现在是怎么做的

- **`browser/window.ts` 里的 `AgentWindows`**：
  - 每个 key 一个 Chrome 窗口，第一个标签页是 anchor 页。
  - 窗口内按 origin 池化标签页：暖页面用 `robots.txt`，空闲的回收。
  - daemon 重启后第一次用到时，把所有带 anchor 页的窗口当孤儿关掉。
- **`browser/host.ts`**：因为「浏览器不渲染后台标签页」，有 8 处在操作前先 `win.activate(tab)`，把标签页切到所在窗口的前台。
- **扩展 `background.js`**：
  - 录不录、能不能操作，由 `agentTabs` 集合（存在 `storage.session`）加 `openerTabId` 继承决定。
  - ops 有 `openWindow` / `openTab` / `activateTab` / `closeTab` / `closeWindow` / `tabs`；`tabs` 会标出 anchor 页。
- **`anchor.html` / `anchor.js`**：作用一是标记 agent 窗口，二是在 ABI ≤ 12 的扩展上触发自动重载（`daemon.ts` 的 `anchorReloadTried`）。
- **按窗口号认领**：`learn/observe.ts` 按 `windowId` 过滤 learn 窗口的标签页；`daemon.ts` 的 `win.adopt(tab, windowId)` 按窗口号认领页面开出来的标签页。
- **`learn/windows.ts`**：daemon 重启后 learn 窗口当作已关，下次操作从上次的 URL 重开，页面状态丢失。
- **页面脚本**：`page/*.js` 在 `document_start`、所有 frame、MAIN world 注入，只在 lore 标签页里上报。
- **cdp.js**：第一次输入或执行 JS 时附着，之后一直附着，直到标签页关闭或用户点掉横幅。

## 3. 设计

### 3.1 组放在哪、长什么样

- **放在哪个窗口**：`chrome.windows.getLastFocused({windowTypes:["normal"]})`，排除隐身窗口。一个普通窗口都没有时，`chrome.windows.create({url:"chrome://newtab/", focused:false})`。
- **标题和颜色**：learn 组叫 `lore·<站点>`（蓝色），run 组叫 `lore▶<action 名>`（灰色）。始终折叠，只占标签栏上一个小标签。
- **后续标签页**：同一个 key 后面开的标签页都放进同一个组，也就是组所在的窗口，不管用户这时在哪个窗口。
- **用户关掉了组**（或组所在的整个窗口）：和现在「窗口被用户关了」一样，下次用到时重建；learn 组从上次的 URL 重开。

### 3.2 归属（扩展）

- **判断方法**：
  - `storage.session` 里存 `loreGroups: groupId[]`，替代 `agentTabs`（防止 service worker 重启后丢失）。扩展不知道 key。
  - `isAgentTab(tabId)` 就是看 `chrome.tabs.get(tabId).groupId` 在不在 `loreGroups` 里。每次实时查，学 OCIC 的 `isInGroup`。
- **上报带 groupId**：
  - 页面消息、地址变化上报时带上标签页当前的 `groupId`。
  - daemon 用内存里的 `groupId → key` 查出该写进哪个窗口的日志（§3.5）。
  - 删掉 daemon 里按窗口号认领的 `AgentWindows.adopt`。
- **清理**：
  - `tabGroups.onRemoved` 时从 `loreGroups` 里删掉这个组。
  - `tabs.onRemoved` 时学 OCIC，把这个标签页按 tab 存的状态（调试器附着等）都清干净。
- **拖进拖出**：用户拖进 lore 组的标签页算 lore 的（会录、可以操作），拖出去就不算了。这一点写进 SKILL.md。
- **用户在组里按 Cmd+T**：开出的 `chrome://newtab` 不录；之后用户在里面打开网址，它就算 lore 的（在组里）。和拖进组同一个规则。

### 3.3 拦截页面的新开标签页

只在 lore 标签页里生效（页面脚本已经是 `document_start`、所有 frame、MAIN world；还要加上 `match_about_blank`，让 `about:blank`、`srcdoc` 的 iframe 也有拦截）。

| 页面的做法 | 拦法 |
|---|---|
| 点链接：`target` 不是 `_self`/`_parent`/`_top`，或带 cmd/ctrl/shift，或中键 | window 上捕获阶段的 `click`、`auxclick`：找到 `a[href]` / `area[href]`，`preventDefault()` |
| 脚本 `a.click()` 一个没放进页面的链接（常见的「程序化新开」写法，事件不会冒泡到 window） | 改 `HTMLAnchorElement.prototype.click`：链接不在文档里且要新开，就拦下 |
| `window.open(url)` | 不调原函数，返回一个假的窗口对象（`closed`、`close()`、`focus()`） |
| `window.open()` 后再 `w.location.href = url`（为躲弹窗拦截的写法） | 假对象的 `location` 接住地址（`href`、`assign`、`replace`） |
| `window.open(url, name, features)`（弹出窗口） | 放过（§0.8） |
| 表单 `target=_blank` 提交（包括脚本调 `form.submit()`） | `submit` 事件和 `HTMLFormElement.prototype.submit`：把 `target` 改成 `_self`，在当前标签页提交 |
| 不拦的 | `download` 链接、`mailto:`、`tel:`、`javascript:` 这类非 http(s) 地址 |

- 拦下的地址经 bridge 交给扩展，扩展按 §3.4 的 `openTab` 开进同一个组（先 `chrome://newtab/`、`active:false`），附着调试器，并上报「页面打开了新标签页 <地址>」，记进时间线，learn 的观察里能看到。
- **兜底**：拦截漏掉、Chrome 自己开出来的新标签页（`onCreated` 里 `openerTabId` 是 lore 的标签页）：
  - 收进 opener 的组；
  - 如果它在用户窗口里被选中了，把选中状态还给用户之前选中的标签页（扩展用 `tabs.onActivated` 记着用户窗口里「上一个选中的非 lore 标签页」）；
  - 写一条「拦截漏掉」的日志，发现了就补拦截。这种情况用户会看到闪一下。

### 3.4 扩展 ops

ABI 从 13 升到 14，manifest 加 `"tabGroups"` 权限，内容脚本加 `match_about_blank`。

| 旧 | 新 |
|---|---|
| `openWindow { anchor }` | 删掉 |
| `openTab { windowId, url, active }` | `openTab { groupId?, title, color, url }`：<br>1. 给了 `groupId` 且组还在：在组所在的窗口里建；否则在用户最近用的普通窗口里建，并新建组（记进 `loreGroups`）；<br>2. `tabs.create({url:"chrome://newtab/", active:false})`，放进组，组保持折叠；<br>3. 设 `autoDiscardable:false`；<br>4. 先导航到 `about:blank`，再附着调试器（调试器附着不上 `chrome://` 页面），最后导航到 `url`。<br>返回 `{ tabId, groupId }` |
| `activateTab` | 删掉 |
| `closeWindow { windowId }` | `closeGroup { groupId }`：`tabs.remove` 组里的标签页（实测关掉的组不会被保存），然后从 `loreGroups` 删掉 |
| `tabs`（会标出 anchor 页） | `tabs`：每个标签页带 `groupId`，lore 的再带 `lore: true`；不再有 anchor 页 |
| 无 | `idleGroup { groupId }`：解除组里所有标签页的调试器附着 |
| 无 | `closeAllGroups`：关掉全部 lore 组（daemon 连上扩展后调一次，清掉上一个 daemon 留下的） |

- **anchor 页整个删掉**（`anchor.html`、`anchor.js`、`daemon.ts` 里的 `anchorReloadTried`）。ABI 13 的扩展已经能靠 `reload` op 自己重新加载，AGENTS.md 也写了「不写兼容代码」。
- **附着要早于 `chrome.scripting`**：lore 的 `call` op 走 `chrome.scripting.executeScript`，在冻结的标签页里会一直挂着（§7.1）。cdp.js 提供 `ensureAttached(tabId)`，`call`、`input`、`evaluate`、`screenshot` 开头都调用它（闲置解除附着后，下次操作自动重新附着）。

### 3.5 daemon：`AgentWindows` → `AgentGroups`

- **保留**：按 key 管理、按 origin 池化、暖页面、空闲回收、`dispose(key)`、`release`。
- **两张内存表**替代 `windows`（key → 窗口号）和 `adopted`：
  - `key → groupId`：开标签页时传给扩展，让同一个句柄的标签页进同一个组；
  - `groupId → key`：扩展上报页面消息时按 groupId 查 key，`winOf(tab)` 用它。
- **删除**：`windows`、`adopted`、`activeTab`、`activate()`、anchor 页、`ensureWindow` 和 `opening`。
- **建组时机**：第一次 `openTab` 不传 `groupId`，扩展新建组并返回 `groupId`，daemon 记进两张表。之后同一个 key 都传这个 `groupId`；组已经没了（用户关掉了组或窗口），扩展就新建一个，daemon 用返回的新 `groupId` 更新表。
- **闲置**：每个 key 记最后一次操作的时间，20 秒没有操作就调 `idleGroup`。run 组跑完就关，不走闲置。
- **daemon 重启不找回**：两张表在内存里，重启后为空。连上扩展后调一次 `closeAllGroups`（替代现在的 `cleaned` 关孤儿窗口）。learn 句柄下次操作时从上次的 URL 重开。
- **`host.ts`**：删掉 8 处 `activate`，`failureShot` 里的也删掉。
- **跟着改的地方**：
  - `learn/observe.ts` 改成按 key 过滤标签页。
  - `learn/windows.ts` 的 `page()` 判断「开着」改成「组还在」。
  - `record/ingest.ts` 的 `winOf` 改成按 groupId 查；多一种时间线事件「页面打开了新标签页」。

### 3.6 不变的

- 命令行：`lore learn new|list|close|<句柄> …`、`lore run`。
- 句柄格式和日志目录。
- 录制、action SDK、CDP 输入。
- `lore learn new --url <tab 号>`：仍然只是打开那个标签页的 URL。

## 4. 实施步骤

### 第 1 步：补测（已完成，结果见 §9）

- 页面在用户手势下新开标签页，Chrome 会选中它、显示窗口、把 Chrome 拉到前台 → §3.3 的拦截。
- 拦下后由 lore 开标签页，不抢前台；在用户窗口和单独窗口里都实测过（§9.5）。
- 调试横幅出现在所有窗口。
- 关掉的组不会被保存，`closeGroup` 不必先 `ungroup`。

### 第 2 步：扩展

- `background.js`：
  - `loreGroups`，用组判断归属；
  - 实现 §3.4 的新 ops；
  - 接收页面脚本拦下的地址并开标签页；
  - `onCreated` 兜底、`onActivated` 记住用户上一个选中的标签页；
  - 处理 `tabGroups.onRemoved`，补全 `tabs.onRemoved` 的清理；
  - 页面消息带上 groupId。
- 页面脚本：新增 `page/newtab.js`（§3.3 的拦截），加进 `PAGE_FILES` 和 manifest。
- `cdp.js`：`ensureAttached`、按标签页解除附着（给 `idleGroup` 用）。
- `manifest.json`：加 `tabGroups` 权限、`match_about_blank`；ABI 改成 14。
- 删掉 `anchor.html` 和 `anchor.js`。

### 第 3 步：daemon

- `browser/window.ts` 重写成 `AgentGroups`，文件改名为 `browser/groups.ts`。
- `browser/extension.ts`：ABI 改成 14。
- `browser/host.ts`：删掉 `activate`。
- `daemon.ts`：连上扩展后调一次 `closeAllGroups`；页面消息按 groupId 交给 `AgentGroups` 查 key；删掉 `adopt` 和 anchor 重载。
- 跟着改的地方：`learn/observe.ts`、`learn/windows.ts`、`record/ingest.ts`。

### 第 4 步：自检和真实 Chrome 测试

**selfcheck**：
- `window.selfcheck.ts` 改成测组：建组、同一个 key 进同一个组、池化、回收、按 groupId 查 key、组被关了能重建并更新映射、闲置 20 秒调 `idleGroup`、重连时关掉全部旧组。
- `extension.selfcheck.ts` 改 ABI。
- 拦截的判断逻辑（哪些链接、哪些 `window.open` 要拦）抽成纯函数，加一个自检：拦错了会静默改变网站行为，拦漏了会抢前台。

**真实 Chrome**：每一项都要同时检查：**前台应用、用户窗口里选中的标签页、焦点窗口在每一步前后都没变；没有出现新窗口**（每 100 ms 记录一次，§9.5 的办法；测试期间用户切到别的应用、不碰 Chrome）。

1. `lore learn new` 之后，用户窗口里出现一个折叠的 `lore·ithome.com` 组；
2. learn 的全部工具都能用：find / read_page / computer / form_input / navigate / try_action；
3. IT之家「搜索 → 第 N 篇 → 第 K 条评论」的 compose，以及 `ithome-comments`（懒加载）；
4. 拦截：在 lore 标签页里点 `target=_blank`、cmd+点击、中键点击、`window.open(url)`、`window.open()` 后设地址、程序化 `a.click()`、`target=_blank` 表单——都不抢前台，新标签页进同一个组并被录，时间线里有「页面打开了新标签页」；带窗口参数的 `window.open` 照常弹出；
5. 用户自己的标签页里点 `target=_blank` 行为不变（拦截只在 lore 标签页里）；
6. 拖进拖出：把一个用户标签页拖进组后会被录，拖出去后不录；
7. 闲置 20 秒后解除附着、调试横幅消失；再操作时正常；
8. `lore run` 期间出现 run 组，结束后组消失；
9. daemon 重启后旧的 lore 组全部被关掉；对同一个 learn 句柄再操作，新建组并从上次的 URL 重开，日志接着写进同一个目录；
10. 用户手动关掉 learn 组后，再操作时会重建；
11. 同时跑两个 run 和一个 learn，互不干扰；
12. 性能：对比 run 的交付时间（之前约 4 s，省掉开窗口应该会更快）。

### 第 5 步：文档

- SKILL.md：标签组、拖进拖出是什么意思、lore 不会抢焦点、页面的新开标签页由 lore 接管、调试横幅什么时候出现。
- ARCHITECTURE.md：窗口那一节。
- AGENTS.md：§2.3 的验证清单改成上面第 4 步的检查。
- CHANGELOG.md。
- 本文件末尾补上实施和测试结果。

## 5. 拦截的代价

| 代价 | 影响 | 应对 |
|---|---|---|
| 新标签页没有 `window.opener`，原页面拿到的是假窗口对象 | 依赖两边通信的页面会变：新页面通过 `window.opener` 回传结果、原页面往新窗口里 `document.write`（导出、打印预览这类） | 少见。遇到了单独处理；lore 学的是请求，影响有限 |
| 新标签页的请求头和真实打开时不一样：没有 `Referer`，`Sec-Fetch-Site` 是 `none` | 少数站点检查 Referer（防盗链、风控）时，新标签页的首个请求可能被拒或走不同分支 | 以后可以让扩展用原页面地址作 referrer 打开（CDP `Page.navigate` 带 `referrer`） |
| `sessionStorage` 不会从原页面带过去 | 靠 sessionStorage 传状态的新开页面行为会变 | 少见；遇到了再处理 |
| `target=_blank` 表单改成在当前标签页提交 | 原页面被替换，不再保留 | 可以接受；时间线里看得出 |
| 改写了 `window.open`、`HTMLAnchorElement.prototype.click`、`HTMLFormElement.prototype.submit` | 页面可能检测到这些原生函数被改过（少数反爬会查） | 改写后的函数 `toString()` 仍返回原生的样子；只在 lore 标签页里改 |
| 拦漏了 | Chrome 选中新标签页、把 Chrome 拉到前台，用户会看到闪一下 | §3.3 的兜底：收进组、选中状态还给用户、写日志，再补拦截 |
| 带窗口参数的弹出窗口不拦 | 可能抢焦点 | 用户决定先不管 |

## 6. 其他风险

| 风险 | 应对 |
|---|---|
| 调试横幅出现在所有窗口 | 浏览器级别的提示，挡不住；闲置 20 秒就解除附着 |
| 用户点开组、点了 lore 的标签页 | 不处理（「谁在操作」已经去掉了）；lore 照常操作 |
| 用户把 lore 的标签页拖出组 | 它就不再归 lore：操作时报「不是 lore 的标签页」，learn 下次操作时重建组 |
| 用户关掉了组所在的窗口 | 下次用到时在用户最近用的窗口里重建 |
| 省内存模式丢弃后台标签页 | 设 `autoDiscardable:false`；万一还是被丢弃，`callTab` 遇到「No tab with id」会重新拿一个标签页再试 |
| 附着了调试器的标签页按约 120 帧/秒渲染，吃 CPU | 闲置 20 秒解除附着 |
| 没选中的标签页在窗口 resize 后不重新布局（OCIC 记录的现象） | lore 不提供 resize，只影响截图尺寸；截图按 CDP `Page.getLayoutMetrics` 取真实视口 |

## 6.1 以后可选

- **组名前缀显示状态**（学 Claude in Chrome）：⌛ 工作中、🔔 需要用户处理（比如登录）、✅ 完成。
- **`lore learn new --tab <号>`**：把用户已经打开的标签页移进 lore 组接着学；`learn close` 时只 `ungroup`，不关。
- **「给用户看」**：需要用户登录或确认时，把 lore 的标签页选中。只在 lore 明确需要用户时做，类似 OCIC 的 `set_tab_focus`。

## 7. 实验结果（2026-11-04，真实 Chrome，macOS）

实验代码只在 `exp/tab-groups` 分支上临时加过（扩展里的 `exp*` 操作、daemon 的 `ext` 透传），已经还原，分支已删。测试页是本地页面，带 rAF 计数、100 ms 定时器、IntersectionObserver（触发时发 `/lazy` 请求）。标签页都开在用户当前窗口里一个折叠的 `lore·exp` 组中，从不选中。

### 7.1 后台标签页的渲染

| 条件 | visibilityState / hasFocus | rAF / 秒 | 100 ms 定时器 / 秒 | IntersectionObserver | 冻结 |
|---|---|---|---|---|---|
| 不附着调试器，**折叠组** | hidden / false | 0 | 1 | 不触发 | **约 3 秒后被 Chrome 冻结**（`frozen: true`），`chrome.scripting.executeScript` 一直挂着不返回 |
| 不附着调试器，展开的组 | hidden / false | 0 | 1 | 不触发（`scrollTo` 能滚，但不渲染） | 8 秒内没冻结 |
| 附着调试器、关掉 focus emulation，折叠组 | — | — | — | — | CDP 鼠标事件 20 秒没响应 |
| **附着调试器 + focus emulation**（lore 现在的附着方式），折叠或展开 | visible / true | 约 120 | 10 | 正常触发 | 不冻结 |
| 再加 `Page.setWebLifecycleState active` | 同上 | 同上 | 同上 | 正常 | 不冻结 |
| 再加 `Page.startScreencast` | 同上 | 同上 | 同上 | 正常 | 不冻结 |

其他：
- **冻结后再附着**：附着 26 ms 就解冻，rAF 立刻恢复到约 120/秒。
- **附着后闲置**：10、30、90 秒时都没有冻结，rAF 一直约 120/秒。
- **截图**：CDP `Page.captureScreenshot` 在后台标签页里约 50 ms，画面完整。
- **IT之家真实页面**（`1/021/825.htm`，折叠组、后台）：滚动两次后点右侧「评论」，`getnewscomment?…&isInit=true` 发出，评论区完整渲染（后台截图里能看到热门评论）；全程用户选中的标签页没变。

**结论**：
- 只要附着调试器、开 focus emulation（`cdp.js` 的 `attach` 已经这样做），就足够了，lifecycle 和 screencast 都不需要。
- 标签页建好就附着；之后所有操作（包括 `chrome.scripting`）都在附着状态下进行，不会撞上冻结。
- `host.ts` 里的 8 处 `activate` 可以直接删掉。

### 7.2 Tab Activate：新标签页被强行切到前台

- **现象**：`chrome.tabs.create({active:false})` 建出来的标签页，马上就变成了选中的标签页（页面里 `visibilityState` 一开始就是 `visible`）。
- **原因**：用户装了扩展 **Tab Activate**（`jlmadbnp…`，「New tabs open immediately instead of in the background」）。它在 `tabs.onCreated` 里把所有新标签页 `tabs.update({active:true})`，只跳过固定标签页和 `chrome://newtab/`。
- **lore 自己开的标签页**：先 `tabs.create({url:"chrome://newtab/", active:false})` 再导航，就能躲开（实测页面从加载起就是 `hidden`）。
- **页面自己开的标签页**（`target=_blank`）：躲不开。这是放弃「组放在用户窗口里」、改用单独 lore 窗口的原因（§8.2）。

### 7.3 还没验证

见 §4 第 1 步。

## 8. Claude in Chrome 的做法（读源码 + 实测）

### 8.1 源码（1.0.104）

- **组放在哪**：`chrome.windows.getLastFocused({windowTypes:["normal"]})`，即用户最近用的窗口；没有普通窗口时 `chrome.windows.create({url:"chrome://newtab/", focused:false})`。
- **新标签页**：`chrome.tabs.create({windowId, url:"chrome://newtab", active:false})`，进组后再导航。
- **每个会话一个组**：组名用会话名（默认 "Claude"），颜色轮换。
- **闲置 20 秒**（代码里的 `"idle-20s"`）：组里没有选中的标签页时 `tabGroups.update({collapsed:true})`，再 `detachDebugger`；下次调用工具时先 `collapsed:false` 展开，再 `attachDebugger`。
- **focus emulation**：开启时先给标签页静音（`muteForFocusEmulation`），之后再取消静音。
- **组名前缀**：⌛ 🔔 ✅。
- **页面开出的标签页**：`findOrphanedTabs` 找出不在组里、但 `openerTabId` 在组里的标签页，再收进组。没有找到纠正选中状态的代码。
- **切到前台**：只在用户点按钮时（如「回到主标签页」）调用 `tabs.update({active:true})`、`windows.update({focused:true})`。

### 8.2 实测会不会抢前台

后台每 0.3 秒用 `lore tabs` 记录用户窗口里选中的标签页。

| 步骤 | 用户选中的标签页 |
|---|---|
| `tabs_context_mcp({createIfEmpty:true})`：在用户窗口里建组 | 没变 |
| `navigate` 到 IT之家首页 | 没变 |
| `tabs_create_mcp`：再开一个空白页 | 没变 |
| 在 IT之家首页点第一篇文章（`target=_blank`） | **变了**：用户窗口切到了新开的文章页，之后一直停在那里；这个标签页也没进 Claude 的组 |

**结论**：只要组放在用户的窗口里，页面自己开的新标签页就会抢用户的前台。用户的要求是「不接受任何形式的抢前台」，所以 lore 用单独的窗口。

## 9. 补测结果（2026-11-04，真实 Chrome，macOS）

方法：临时分支上给扩展加实验用的操作（已还原、分支已删）；用 `lsappinfo` 看前台应用，用 `CGWindowListCopyWindowInfo` 看窗口的前后顺序，用 `chrome.windows.getLastFocused` 看 Chrome 里的焦点窗口。用户的窗口和选中的标签页每一步前后都记录。

### 9.1 lore 窗口本身

- `chrome.windows.create({url:"about:blank", focused:false})`：新窗口排在所有窗口的最底下（z12），前台应用、用户窗口、选中的标签页都没变。
- 初始标签页不能用 `chrome://newtab/`：调试器附着不上 `chrome://` 页面。用 `about:blank`。
- 在 lore 窗口里：rAF 约 121/秒，`visibilityState` 是 visible，IntersectionObserver 正常触发，截图正常。
- 普通点击（CDP 鼠标事件）不会抬起窗口。

### 9.2 什么会抬起 lore 窗口

每种方式都在一个新开的 lore 窗口里试，开始时 lore 窗口在最底下：

| 新标签页怎么来的 | lore 窗口被抬到最前、Chrome 被拉到前台 |
|---|---|
| lore 自己 `tabs.create({active:false})`（Tab Activate 会把它切成 lore 窗口里的选中标签页） | **否** |
| 页面 `window.open(url)`，没有用户手势 | 被弹窗拦截挡掉，没有开出标签页 |
| 页面 `window.open(url)`，有用户手势 | **是** |
| CDP 点击 `target=_blank` 链接 | **是**（用户当时在 Claude 应用里，Chrome 被拉到了前台） |
| CDP cmd+点击（本该是后台标签页） | **是** |
| 窗口最小化后，页面有手势地新开标签页 | **是**：窗口被还原，并放到最前 |

结论：页面在用户手势下新开标签页时，Chrome 会显示那个窗口。这和 Tab Activate 无关，单独的窗口挡不住。

### 9.3 页面脚本拦截

在 lore 标签页里注入一段脚本（相当于 §3.2 的拦截），然后：

| 操作 | 结果 |
|---|---|
| 点 `target=_blank` | 拦下，没开标签页，窗口没动 |
| cmd+点击 | 拦下，窗口没动 |
| 有手势的 `window.open(url)` | 拦下，窗口没动 |
| 有手势的 `window.open()` 后 `w.location.href = url` | 拦下（假对象接住了地址），窗口没动 |
| lore 用 `tabs.create` 把拦下的 4 个地址开进同一个组 | 4 个标签页都开出来了，窗口没动，前台应用没变 |

### 9.4 需要用户看的两项

- **调试横幅**：只有 lore 窗口里的一个标签页附着了调试器时，用户自己的窗口顶部也显示「…已开始调试此浏览器」。确认是浏览器级别的提示。
- **已保存的标签组**：关掉的两个组，lore-A（先 `ungroup` 再关）和 lore-B（直接关），都没有出现在已保存的标签组里。

### 9.5 复测：两种方案都加上页面拦截，在 IT之家首页上跑

做法：页面脚本用 `Page.addScriptToEvaluateOnNewDocument` 在页面加载前注入，相当于 §3.2 的拦截。依次做这几步：
1. 点文章链接（`target=_blank`）；
2. 有手势的 `window.open`；
3. lore 把拦下的地址开成同组的新标签页；
4. 在新开的文章页里滚动、点「评论」。

每 100 ms 记录一次前台应用、用户窗口里选中的标签页、焦点窗口。

| 方案 | 结果 |
|---|---|
| 单独的 lore 窗口 | 前台应用全程是 Claude，用户选中的标签页没变；两次新开都被拦下，lore 开出 2 个标签页，评论请求正常发出 |
| 用户窗口里的折叠组（lore 开标签页时先开成 `chrome://newtab/`） | 同样拦下 2 次、lore 开出 2 个标签页、评论正常；记录里出现过 Chrome 变成前台、用户窗口选中的标签页换成了用户自己的 Google 搜索页。lore 不会碰那个标签页，那是用户当时自己在操作 Chrome；用户也确认没有被抢前台 |

结论：加上页面拦截后，两种方案在这些操作里都不会抢前台。cmd+点击这一项因为测试脚本取的点不在链接上，没有测到，实现后补测。

## 10. 实施结果（2026-11-04，分支 `feat/tab-groups`）

### 10.1 改了什么

- **扩展**（ABI 14，加 `tabGroups` 权限，内容脚本加 `match_about_blank`）：
  - `background.js`：用 `loreGroups` 判断归属；新增 `openTab`（先开 newtab → 进组 → 到 about:blank 附着调试器 → 打开目标地址）、`closeGroup`、`closeAllGroups`（也按标题认出浏览器重启后恢复的组）、`idleGroup`；页面消息带 `group`；页面要新开标签页时 `openForPage`；`onCreated` 兜底；`onActivated` 记住用户上一个选中的标签页，lore 刚开的标签页 3 秒内被选中就还回去；`call`、`goto`、`history` 之前先附着（防冻结）；拖进、拖出组时通知页面脚本开始或停止上报。删掉 `openWindow`、`activateTab`、`closeWindow` 和 anchor 页。
  - `cdp.js`：导出 `attach`，新增 `detach`。
  - `page/newtab.js`（新）：§3.3 的拦截。判断逻辑是纯函数，`browser/newtab.selfcheck.mjs` 自检。
  - `page/common.js`、`bridge.js`：录不录的答案可以在加载后改变（拖进、拖出组）。
- **daemon**：
  - `browser/window.ts`：类名还是 `AgentWindows`（命令行里的「窗口」概念没变，没有改名成 `groups.ts`）。内部改成按组：`key ↔ groupId` 两张内存表、`adopt` 按组号、`busy()` 记录进行中的操作、`idle()` 每 5 秒检查一次，闲置 20 秒（`GROUP_IDLE_MS`）调 `idleGroup`；第一次用时 `closeAllGroups`。
  - `browser/host.ts`：删掉 8 处 `activate`；`log()`、`callTab()`、`waitEnd()` 期间标记进行中；learn 的 `computer wait` 也一样。
  - `daemon.ts`：组标题 `lore·站点`（learn，蓝）、`lore▶名字`（run，灰）；页面消息按 `group` 认领；删掉 anchor 重载。
  - `learn/observe.ts`：页面列表按组过滤；新增一行「新标签页：页面打开了…」。
  - `lore tabs`、`learn new --url <tab 号>`：用 `lore` 标记排除 lore 的标签页。
- **文档**：SKILL.md、ARCHITECTURE.md、AGENTS.md（§2.3 加了「不抢前台」的检查方法）、install.md、CHANGELOG.md。

### 10.2 测试

- `npm run check`、`npm test`（18 个自检）通过。新增和重写的：`window.selfcheck.ts`（同 key 进同组、按组号归属、组被关后映射更新、闲置判断、只关一次旧组）、`newtab.selfcheck.mjs`（哪些链接、`window.open`、表单要拦）。
- 真实 Chrome（`setup.js` 重装后扩展自动重新加载到 ABI 14）。后台每 0.2 秒记录前台应用和用户选中的标签页，用户在 Claude 应用里：

| 步骤 | 结果 |
|---|---|
| `lore learn new --url https://www.ithome.com/` | 用户窗口里出现 lore 组，没有新窗口 |
| `computer left_click --ref`（`target=_blank` 文章链接） | 被拦下，lore 开进同一个组；观察里有「新标签页：页面打开了 #7018 …/1/021/346.htm」 |
| `computer left_click --ref … --modifiers cmd` | 同上 |
| `navigate` 文章 → `scroll` ×2 → 点「评论」 | `GET /api/webcomment/getnewscomment` 发出（后台组里懒加载正常） |
| `lore run --compose`（搜索 → 第 n 篇 → 第 k 条评论） | 跑通（q=小米 n=5 k=3）。另外两次失败落在 1/021/817 和 1/021/800：817 是 action 文件里早就记着的「连试 3 次超时」那篇，800 在 learn 组里 `try_action` 同样不发评论请求；同一 action 在 346、602 上 `try_action` 都通过，所以这两篇是文章本身的问题，和这次改动无关 |
| 闲置超过 20 秒 | 用户确认「正在调试此浏览器」的横幅消失 |
| 闲置后再操作（`find`） | 0.12 秒返回，自动重新附着 |
| `lore learn close` | 组关掉 |

- 记录里前台应用两次变成 Chrome（04:37:34、04:38:29），用户确认是自己切的；第一次发生在 lore 开始操作之前。用户不在 Chrome 里的那段（04:37:48–04:38:29）覆盖了点 `target=_blank`、cmd+点击、懒加载评论、run 的开始：前台应用一直是 Claude，用户选中的标签页一直没变。

### 10.3 还没在真实 Chrome 里测的

- 中键点击、`window.open(url)`、`window.open()` 后设地址、`target=_blank` 表单、程序化 `a.click()` 走真实的 `newtab.js`（§9.3 用等价的注入脚本测过前三种）。
- 拖进、拖出组。
- `lore daemon restart` 后旧组被关掉、句柄从上次的 URL 重开。
- 用户手动关掉组后重建；两个 run 和一个 learn 同时跑。
- 漏拦兜底（`onCreated` 收进组、把选中还给用户）。
