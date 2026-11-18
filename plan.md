# 单一品牌色分组与按窗口作用域重构计划（2026-11-18）

依据：2026-11-17 线上残留 19 个灰色 `speedrun` 分组事故排查（[invocations.jsonl](file:///Users/youshiyitian/.speedrun/session/invocations.jsonl)、[run-windows](file:///Users/youshiyitian/.speedrun/run-windows)）及后续机制简化收敛。

## 一、问题根因

1. **按窗口建组 + 并发竞态覆盖**：`spr run -e` 用 `Promise.all` 并发调用多个 `action()`（共用同一个 `key`）时，在首个 `openTab` 返回前 `groups.get(key)` 均为 `undefined`，并发请求各自新建灰色组并在返回时互相覆写 `groups.set(key, groupId)`，导致前面的组失联、`dispose(key)` 只关最后一个。
2. **嵌套 `Session.tab` 覆写导致 `busy` 永久泄漏**：[runner.ts](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/run/runner.ts) 把 `nested.tab` 传给并发子 `action()` 并互相覆写，外层只对最后一个 `tab` 调 `release`，其余 `tab` 永远 `busy: true`，30 分钟空闲 `reap()` 也收不掉。
3. **跨层状态同步与事后补救过多**：`AgentWindows`、`RunHost`、`DebugWindows`、扩展四处各自缓存 `groupId` / `tab` / `cleaned` / `open` 状态，彼此靠 `clean()`、`isOpen()`、`robots.txt` 重跳兜底去追平，既复杂又容易在超时、取消、关闭时出现竞态。
4. **概念过耦合**：旧设计把 Chrome 标签组（`groupId`）同时绑成了 **UI 收纳容器 + 录制归属边界（含手动拖入识别）+ 生命周期与闲置单位**。

---

## 二、核心机制简化

**把标签组降级为扩展内纯 UI 收纳盒；daemon 只围绕 `WindowScope` 与 `tabId` 管理生命周期。**

1. **扩展侧自治单一黄色组 + 握手自清场**：
   - 全局最多只存在 **1 个**折叠的 `speedrun` 分组，统一使用品牌色 `"yellow"`（对应 [icon.md](file:///Users/youshiyitian/Code/x/speedrun/brand/icon.md) 闪电黄 `#FFD60A`），`debug` 与 `run` 共用，**daemon 完全不知道 `groupId` 的存在**。
   - 抽单一串行原语 `parkInGroup(tabId)`：优先复用内存 `speedrunGroupId`，失效或缺失时直接用 `chrome.tabGroups.query({ title: "speedrun" })` 兜底查找，找不到才新建，物理上杜绝产生第二个 `speedrun` 组。
   - 扩展在每次新建 native `port` 连接时自己单飞清掉上一次遗留的 `speedrun` 组（断连时 daemon 本来就会 `win.forget()` + `debug.forgetAll("restart")`），彻底砍掉 daemon 的 `clean()` 并发锁与 `closeAllGroups` 协议，也砍掉 `chrome.storage.session` 持久化。
2. **`WindowScope` + `AbortSignal` 取代散落状态与事后封口**：
   - 每次 `run` 或每个 `debug` 窗口持有一个 `WindowScope` 实例，内聚 `key`、`closed`、`AbortController`、所属 `tabs` 集合与空闲池。
   - 调用 `scope.close()` 时立即 `abort` 信号并关闭名下全部 `tab`；所有在途 `acquire` 与 `RunHost` 操作绑定同一 `signal`，一旦窗口关闭立即中止，不再等 60 秒扩展超时，也杜绝超时/取消后在途 `openTab` 诈尸。
   - `run` 作用域结束即销毁；`debug` 作用域由 [windows.ts](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/debug/windows.ts) 自己的 30 分钟空闲关窗控制——彻底砍掉 `AgentWindows` 里冗余的 30 分钟 `reaper` 定时器，仅保留「单 tab 闲置 20 秒发 `idleTab` 解除 CDP 附着」。
3. **`openTab` 默认停在 `about:blank`，`robots.txt` 退居 `request()` 懒暖页**：
   - `openTab({ url? })` 支持只开到已附着好 CDP 脚本的 `about:blank`（不发网络请求）。
   - `navigate(url)` 拿到空白 tab 后直接一次 `goto(url)`，消除 `robots.txt` 占位页把正式 `goto` 覆盖掉的竞态（删掉 [host.ts](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/browser/host.ts) 的重跳兜底），也省掉 `waitScript` 轮询与多余网络请求。
   - 只有未调 `navigate()` 而直接调 `request()`（需要同源环境绕 CORS / 带 cookie）时，才按需打开 `${origin}/robots.txt` 暖页（不改用网站首页，避免首页 302 跨站跳转破坏 CORS、加载耗时与污染 `pageSent`）；同时砍掉 [run.ts](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/commands/run.ts) 的 `isWarm(url)` 正则，改为 `RunContext` 显式记录 `hasNavigated`。
4. **`RunContext`（窗口级）与 `CallSession`（单次调用级）分离**：
   - 去掉 `ActionRunner.runAction` 的 `nested?: Session` 参数和 `Session.draftsOk`。
   - `RunContext` 管窗口级数据：`WindowScope`、`calls`、`drafts`、`stacks`、`firstFailurePage`（抢占式只截第一张失败现场图）；`CallSession` 每次 `action()` 独立新建、只借还一张同源 tab，`finally` 必归还到当前 `RunContext` 池中（串行复用、并发隔离）。
5. **`ev: "closed"` 事件实时驱动回收 + 清理关联历史遗留**：
   - 扩展 `tabs.onRemoved` 上报 `ev: "closed"` 时，daemon 即时从 `WindowScope` 移除该 `tabId`；若是 `debug` 窗口的主 tab，直接触发 `debug.close(w, "tab-closed")`，`isOpen()` 不再每次全量查询浏览器 `tabs`。
   - 一并清理全量注入时代的历史遗留：砍掉“拖进/拖出组开始/停止录制”和 `T.stop()` / `T.isAgent()` / `T.recording()`，同时移除 `common.js` / `recorder.js` 里导致后台折叠页误判停录的 `T.foreground()`；修复 `DebugWindows` 首跳 `navigate` 失败时留存 `open: false` 僵尸窗口的问题。

---

## 三、改动清单

### 1. 扩展侧：单一黄色组、`parkInGroup` 与自清场（ABI 16 → 17）
**文件**：
- [background.js](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/chrome-extension/background.js)
- [manifest.json](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/chrome-extension/manifest.json)
- [cdp.js](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/chrome-extension/cdp.js)
- [common.js](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/chrome-extension/page/common.js)（及 [dialogs.js](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/chrome-extension/page/dialogs.js)、[newtab.js](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/chrome-extension/page/newtab.js)、[recorder.js](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/chrome-extension/page/recorder.js)）
- [extension.ts](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/browser/extension.ts)

- **协议精简（ABI 17）**：去掉 `closeGroup`、`idleGroup`、`closeAllGroups`，新增 `idleTab { tabId }`（直接调 `detach(tabId)`）；`openTab({ url? })` 去掉 `groupId` / `title` / `color` 参数，只返回 `{ tabId }`；`url` 为空时停在已附着好 CDP 的 `about:blank`。
- **自治唯一黄色组 `parkInGroup(tabId)`**：
  - 使用单飞串行队列维护唯一 `speedrun` 组（`GROUP_TITLE = "speedrun"`，`color: "yellow"`，`collapsed: true`）：先查内存 `speedrunGroupId` 所在窗口并入组，失效或不存在时用 `chrome.tabGroups.query({ title: GROUP_TITLE })` 找现存组，仍没有才新建并设标题颜色；`openTab`、`openForPage`、`tabs.onCreated` 全部复用 `parkInGroup(tabId)`。
  - `connect()` 建立新连接时设置单飞清理 Promise：清掉旧生命周期留下的 `speedrun` 组，首次 `openTab` / `tabs` 等命令先 `await` 它完成再执行，取代 daemon 端 `clean()`。
- **纯内存 `agentTabs` 取代 `chrome.storage.session` 与 `groupOfTab`**：
  - 删掉 `agentGroups`、`groupOfTab`、`loaded`、`rememberAgentTabs()` 及 [manifest.json](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/chrome-extension/manifest.json) 的 `"storage"` 权限。
  - `mustBeAgent(tabId)`、`onActivated`、`seedUserTab`、`view(tab)`、`onPageMessage`、`openForPage`、`tabs.onCreated` 全部直接同步查 `agentTabs.has(tabId)`。
  - `openForPage` 在 `openTab` 返回 `tabId` 后、导航目标 `url` 之前先发 `{ k: "tab", ev: "opened", opener }`（`tabs.onCreated` 同步带 `opener` 发 `ev: "leaked"`），保证子 tab 先归属再出事件。
- **删掉拖进/拖出组、`T.foreground()` 与收拢 URL 导航监听**：
  - 删掉 `background.js` `tabs.onUpdated` 监听器（不再需要拖组分支；`ev: "url"` 统一由 [cdp.js](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/chrome-extension/cdp.js) 的 `Page.frameNavigated` 在主 frame 且为 `http(s)` 时上报）、[cdp.js](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/chrome-extension/cdp.js) 的 `release(tabId)`。
  - 删掉 `common.js` 的 `stopped` / `T.stop()` / `T.recording()` / `T.isAgent()` / `T.foreground()` 及 `dialogs.js`、`newtab.js`、`recorder.js` 对应判断（仅经 CDP 注入的页面脚本只在 speedrun 标签页存在，无需二次开关）。

---

### 2. `AgentWindows` + `WindowScope`：去 `groupId`、统一生命周期与实时关闭
**文件**：
- [window.ts](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/browser/window.ts)
- [constants.ts](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/utils/constants.ts)
- [daemon.ts](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/daemon.ts)
- [windows.ts](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/debug/windows.ts)
- [observe.ts](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/debug/observe.ts)
- [debug.ts](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/commands/debug.ts)

- **删除所有 group 状态与冗余定时器**：
  - 删掉 `groups`、`keyOfGroup`、`groupLabel`、`GroupLabel`、`groupOf()`、`clean()`、`cleaned`、以及 30 分钟 `reaper` 定时器；[constants.ts](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/utils/constants.ts) 的 `GROUP_IDLE_MS` 改名为 `TAB_IDLE_MS`。
  - [daemon.ts](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/daemon.ts) 去掉 `groupLabel` 与 `group` 参数传递，收到页面消息时把 `inner.opener` 传给 `win.adopt(msg.tab, opener)`；收到 `ev === "closed"` 时通知 `win.onTabRemoved(msg.tab)`（及驱动对应的 `DebugWindows` 收尾）。
- **引入 `WindowScope` 与单张 `tabs` 状态表**：
  - 每个窗口通过 `win.open(key)`（或按需创建）持有一个 `WindowScope`（含 `closed`、`AbortController`、所属 `tabId` 集合）。
  - `tabs` Map 按 `tabId` 记录 `{ scope, origin?, leased, ops, lastActive, detached }`，单定时器每 5 秒对 `ops === 0 && !detached && now - lastActive >= tabIdleMs` 的 tab 调 `idleTab({ tabId })`。
  - `acquire(origin, key)` 在 `origin === undefined`（空白页）时开 `about:blank`；需要 `origin` 时复用同 `scope` 同源空闲 tab 或按需开 `${origin}/robots.txt`；整个过程传入 `scope.signal`，在关键 `await` 前后校验 `scope.closed`，若已关则立刻 `closeTab` 并抛中止错误。
  - `dispose(key)` 标记 `scope.closed = true`、`scope.abort()`、派发 `closedListeners` 并关闭该 `scope` 名下所有 `tab`。
- **`DebugWindows` 与 `observe`**：
  - [debug.ts](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/commands/debug.ts) + [windows.ts](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/debug/windows.ts) 修复首跳 `navigate` 失败残留：首跳失败时回滚清理 `map` / `names` / `sessions` 并 `dispose`。
  - `win.isOpen(key, tabId?)` 直接读内存 `WindowScope` 存活状态（主 `tabId` 被 `ev: "closed"` 移除即判定关闭），不再发全量 `tabs` RPC；提示文案从「标签组被关掉」改为「标签页被关掉」。
  - [observe.ts](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/debug/observe.ts) 去掉 `groupOf()` 与 `t.groupId === group` 过滤，改用 `win.winOf(t.tabId) === w.id`。

---

### 3. `RunHost` + `ActionRunner`：`RunContext` 与 `CallSession` 分离
**文件**：
- [host.ts](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/browser/host.ts)
- [runner.ts](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/run/runner.ts)
- [run.ts](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/commands/run.ts)

- **`RunHost` 拆分 `releaseTab` 与 `end`、去掉 `robots.txt` 重跳兜底**：
  - `bind(s, origin)` 切站释放旧 tab 时同步清理 `byTab`；`navigate` 首次开页调用 `acquire(undefined, s.key)` 开空白页再一次 `goto`，删掉 `/robots.txt` 重跳补丁。
  - `releaseTab(session)` 仅归还当前调用持有的 `session.tab` 并按 `byTab.get(tab) === session` 安全删除；`end(key)` 仅在最外层收尾调用，清理 `waits`、`messageWaits`、`raw`、`rejected` 等窗口级状态。
  - 全部 `link.request` / 等待支持绑定 `WindowScope.signal`，窗口关闭时立即 abort。
- **`ActionRunner` 用 `RunContext` 取代 `nested?: Session`、`run.ts` 用 `hasNavigated` 取代 `isWarm`**：
  - `runAction(name, params, opts)` 去掉 `nested?: Session` 位置参数，改用 `opts.parentKey?: string`；`earlyFail` 按 `opts.parentKey` 记录 `trace.code` 与 `failedAction`。
  - `RunContext` 持有 `calls`、`drafts`、`stacks`、`code`、`signal`、`hasNavigated` 与 `pageCaptured` / `failurePage`；每次 `runAction` 使用独立 `CallSession`，失败当层在 `releaseTab` 前抢占式拍一次 `failureShot` 写入 `runCtx.failurePage`，外层 `decorateFailure` 直接读取 `out.page ??= runCtx.failurePage`。
  - [run.ts](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/commands/run.ts) 去掉 `isWarm(url)` 正则，改按 `outcome.hasNavigated === false`（未调过 `navigate()`）走 `requestEvidence` 展示最后出错请求并跳过截图。

---

### 4. 文档与自检更新
**文件**：
- [window.selfcheck.ts](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/browser/window.selfcheck.ts)：移除 `groupId` / `closeGroup` / `idleGroup` / `clean()` 断言，新增「`WindowScope` 关闭 abort 在途 `acquire` 且新 tab 立即关闭不泄漏」、「`opener` 跨窗口隔离」、「单 tab `idleTab` 解除附着」、「`onTabRemoved` 实时清理」用例。
- [runner.selfcheck.ts](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/run/runner.selfcheck.ts)、[host.selfcheck.ts](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/browser/host.selfcheck.ts)、[index.selfcheck.ts](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/commands/index.selfcheck.ts)：补充 `Promise.all` 并发嵌套 `action()` 各自租还 tab、串行复用、抢占式保留首个失败截图，更新 mock `win` 接口。
- [ARCHITECTURE.md](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/ARCHITECTURE.md)、[AGENTS.md](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/AGENTS.md)（[AGENTS.md](file:///Users/youshiyitian/Code/x/speedrun/AGENTS.md) 为其 symlink）、[guide.ts](file:///Users/youshiyitian/Code/x/speedrun/skills/spr/src/debug/guide.ts)：更新为全局唯一黄色收纳组、ABI 17、按 `tabId` / `WindowScope` 归属、空白页直跳与去掉拖组/后台停录说明。

---

## 四、验收标准

1. `npm run check` 与全部 `npm test` 通过。
2. `node /Users/youshiyitian/Code/x/speedrun/skills/spr/setup.js` 部署并重启 daemon（扩展自动重载至 ABI 17）后：
   - 开启 `debug` 与同时运行多路 `spr run -e 'Promise.all(...)'` 时，Chrome 顶部永远最多只有 **1 个黄色折叠 `speedrun` 分组**；
   - `spr run` 首次 `navigate` 无 `robots.txt` 跳转；`debug` 在后台折叠组停放超过 8 秒仍正常录请求；
   - 任何 `run` 结束、超时或 Ctrl+C 取消后对应 tab 立即关掉，全部任务完成后分组自动消失，`spr doctor` 正常。

---

## 附：历史计划归档

### 2026-11-16：机制收归与双 Agent 调优（分支 `feat/action-only-distill`，已完成）

- 完成四刀减法（砍掉 `compose`、`ask()`、`spr resume`、`link.ts`，收归为单层 `action` + `spr run -e`）、前后台双 Agent 结构（`SKILL.md` + `agents/distiller.md`）、`spr/helpers/*` 导出、`invocations.jsonl` 与 `meta.json` 闭环及 `tools/stats.mjs`。

### 2026-11-12：run 记录与取消（分支 `feat/logging-run-records`，已完成）

- 完成窗口关闭同步收尾与未知窗口拒写、CLI 退出即取消 `run`、`invocations.jsonl` 初版与 `result.json` / `error.txt` / 暖页面请求证据 / 用户帧裁剪。
