# 计划：按 open-claude-in-chrome 重做 lore 的页面探索和输入

> 目标：learn 窗口里的**探索**全部换成 open-claude-in-chrome（下称 OCIC）的做法（a11y 树 + ref），**输入**只保留 CDP 一条路径（learn 和 action 回放共用），**学习**仍是 lore 的做法（观察请求、写 action、`lore run` 交付）。
> 参考仓库：`noemica-io/open-claude-in-chrome`，本机 `~/Code/x/open-claude-in-chrome`（`extension/content.js`、`extension/background.js`、`host/tool-definitions.js`、`test/`）。

## 0. 已定的决定

1. **输入只走 CDP**：learn 的 `computer` 和 action 的 `click` / `key` / `scroll` / `form_input` 都用 `chrome.debugger` 发 `Input.*`。删掉页面里合成 DOM 事件的整套代码。
2. **只支持 Chrome**：不做 Brave / Edge / Arc 的适配（OCIC 里 Brave 的确认延迟、丢事件、`sleep(50)` 这些兼容代码都不迁）。
3. **不再判断「谁在操作」**：删掉 `isTrusted` 区分 agent 和真人、真人输入时停止等待的全部逻辑。agent 窗口里发生的事都算 agent 的。
4. **不写兼容代码**（AGENTS.md 2.5）：旧命令、旧 SDK 写法直接删，本机 `~/.lore` 里的 action 一起改。

## 1. 为什么要做

一次 IT之家任务（搜索 → 第 10 篇 → 第 3 条评论）的实测拆分，195 秒：

| 类别 | 用时 | 占比 |
|---|---|---|
| 模型思考、写代码、读输出 | 114 秒 | 59% |
| 命令执行 | 81 秒 | 41% |

探索每一步都是「截图 → 看图 → 猜坐标 → 点」，图片 token 多、轮次多。OCIC 用文本形式的 a11y 树和 `find` 直接拿到元素和 ref，不用看图、不用猜坐标；它的基准里，上下文每多 10 万 token 每轮多 1.9 秒。

输入改成 CDP：一条路径代码最少；learn 和回放走同一条输入路径，learn 里点得动的，回放也点得动；和 Claude in Chrome / OCIC 行为完全对齐。

## 2. 两边现状

| | OCIC | lore 现在 |
|---|---|---|
| 看页面 | `read_page` a11y 树（`role "name" [ref_N]`）、`find`、`get_page_text`、截图（CDP `Page.captureScreenshot`） | 只有截图（`captureVisibleTab`，要先把标签页切到前台） |
| 指元素 | `ref_N`（WeakRef 表）或坐标 | 只有坐标 |
| 回放 | 没有（不学 action） | 持久定位 `{role,name,nth}` / CSS |
| 输入 | 全部 CDP：`Input.dispatchMouseEvent` / `dispatchKeyEvent` / `insertText`；`form_input` 用 DOM setter | 页面里 `dispatchEvent` 合成（`isTrusted` 为假） |
| 点完核对 | 落点描述（`bare`、`deadLabel`）、ref 点击前查遮挡（`covering`） | 落点描述已有（`hitAt`），没有遮挡检测 |
| 执行 JS | CDP `Runtime.evaluate`（不受页面 CSP 限制） | 页面里 `eval`，严格 CSP 的页面会被拒 |
| 网络 | `read_network_requests`（简单列表） | 完整录制、endpoint、依赖、请求头信号（比 OCIC 强） |

## 3. 迁什么、删什么、不迁什么

### 3.1 迁

| 迁什么 | 来源 | 理由 |
|---|---|---|
| a11y 树 `read_page`（`filter` / `depth` / `ref_id` / `max_chars`，进 shadow DOM） | `content.js` `generateAccessibilityTree` | 不截图就能看清页面结构 |
| ref 表（`ref_N → WeakRef`，反向 WeakMap） | `getOrAssignRef` / `resolveRef` | 探索时指元素不靠坐标 |
| `find <query>`（最多 20 个，带 ref、坐标、`offViewport`） | `findElements` | 一步找到目标元素 |
| ref → 坐标：滚进视口中央、遮挡检测 `covering` | `getRefCoordinates` | ref 操作和回放的定位操作都靠它把元素变成坐标 |
| 名字算法的修正：`aria-labelledby`、`<label for>`、只对叶子类标签取文字（<200 字）、`typeof` 守卫 | `getAccessibleName` | lore 的 `nameOfEl` 对所有元素取 `innerText`，名字长且不稳 |
| `form_input`（文本、下拉、复选） | `setFormValue` | 填表少两步 |
| `get_page_text` 正文优先 | `getPageText` | 读文章更准 |
| **CDP 输入**：attach 管理（并发共享、`onDetach`）、`setFocusEmulationEnabled`、每条命令 20 秒超时、鼠标 move→press→release、键盘 `dispatchKeyEvent` + `insertText`、滚轮 `mouseWheel` | `background.js` `ensureAttached` / `cdp` / `mouseClick` / 键盘部分 | 唯一的输入路径 |
| **CDP 截图** `Page.captureScreenshot`（按 CSS 像素 clip） | `takeScreenshot` | 不用把标签页切到前台，后台窗口也能截 |
| **CDP 执行 JS** `Runtime.evaluate` | — | SDK 的 `evaluate` 不再受页面 CSP 限制 |

### 3.2 删（lore 现有代码）

| 删什么 | 位置 |
|---|---|
| 页面里的合成输入：`mouseClick`、`hoverTo`、`dragPath`、`pressKeys` / `pressKey`、合成 `type`、`wheel` 事件、`T.exec.pointer`、`T.exec.act` 里的事件合成 | `chrome-extension/page/executor.js` |
| 录制端的用户输入事件：`pointerdown` / `click` / `input` / `change` / `submit` / `keydown` / `wheel` 的 `post({ k: "ev", trusted … })`、`flushInput`、`flushScroll`（保留 `later("after-click")` 这类触发页面快照的监听） | `chrome-extension/page/recorder.js` |
| `input()` 里按 `msg.trusted` 定 `user` / `page`、真人输入改写 `lastAction`；`Src` 去掉 `"user"`；`k: "ev"` 消息的处理整个删掉（agent 的操作已经由 daemon 记成 `cmd` 行） | `record/ingest.ts`、`record/types.ts` |
| 「真人输入就停止等待」的说明 | `executor.js` 文件头 |
| 对应的自检用例（`trusted: true` → `user`、真人点击作为 cause） | `record/ingest.selfcheck.ts` |
| `screenshot` 前 `chrome.tabs.update({ active: true })` 和 `captureVisibleTab` | `chrome-extension/background.js` |
| 文档里关于真人输入、`src: user` 的描述 | `ARCHITECTURE.md`、`record/types.ts` 注释 |

注意区分：`USER_WIN = "user"` 是「用户自己的窗口（不录）」，和这里删的「真人输入」不是一回事，保留。

### 3.3 不迁

| 不迁什么 | 理由 |
|---|---|
| MCP server、tab group、`tabs_*`、`switch_browser`、`set_tab_focus` | lore 有自己的 learn / run 窗口和句柄 |
| `read_network_requests`、CDP `Network` 域 | lore 页面脚本的录制更完整；以后要补 Worker / sendBeacon 时再评估 |
| `javascript_tool` | learn 里随手跑 JS 会绕开「观察 → 写 action」；action 里有 `evaluate` |
| `read_console_messages` | 价值低，需要时再加 |
| humanize、gif、rrweb、audit、codemode、`resize_window`、`shortcuts_*`、`update_plan`、debug 工具、Brave 兼容 | 和 lore 无关 |
| `file_upload` | 暂不需要；有了 CDP 之后加它只是一条 `DOM.setFileInputFiles`，需要时再加 |

## 4. 怎么结合：四条规则

1. **一条输入路径。** 不管指元素用的是坐标、ref 还是持久定位，最后都换成视口坐标，交给 background 用 CDP 发。learn 里点得动的，回放一定点得动。
2. **ref 只活在探索里，写进 action 的永远是持久定位。** 用 ref 的每一步都输出「定位：」（不唯一补 `nth`，再不行用 CSS）。
3. **role / name 算法只有一份。** `read_page` 显示的名字、`find` 的匹配、回放时解析 `{role,name}` 用同一个 `roleOf` / `nameOf`，learn 里看到什么名字，action 里就写什么名字。
4. **观察的规则不变。** 改变页面的操作照旧自动附带请求观察、依赖、请求头信号；只看不动的（`read_page`、`find`、`get_page_text`、`screenshot`、`zoom`）不计次数、不要 `--description`、不附带观察。请求的 `cause` 只来自 daemon 记的 `cmd` 行。

## 5. 输入怎么走（learn 和回放共用）

```
learn:  computer left_click --ref ref_41         action:  click({ role: "link", name: "评论" })
              │                                                 │
              ▼                                                 ▼
        页面脚本 refPoint(ref_41)                        页面脚本 locPoint(loc)
              └──────────────┬──────────────────────────────────┘
                             ▼
              滚进视口中央 → 坐标 (x,y)、是否被遮挡、落点元素、持久定位
                             ▼
              background：CDP Input.dispatchMouseEvent  moved → pressed → released
                             ▼
              daemon：等页面安静 → 记 cmd 行 → （learn）附带观察
```

| 操作 | CDP |
|---|---|
| 点击 / 右键 / 双击 / 三击 | `mouseMoved` → `mousePressed` → `mouseReleased`（`clickCount` 1/2/3，`button` left/right） |
| 悬停 | `mouseMoved` |
| 拖拽 | `mousePressed` → 分步 `mouseMoved` → `mouseReleased` |
| 滚动 | `mouseWheel`（`deltaX` / `deltaY`） |
| 按键 | `dispatchKeyEvent`（`rawKeyDown` / `char` / `keyUp`，带 `modifiers`、`windowsVirtualKeyCode`、`code`） |
| 输入文字 | 每个字：可打印 ASCII 发 `keyDown` + `insertText` + `keyUp`；中文、emoji 只发 `insertText` |
| `form_input` 文本框 | 点一下获得焦点 → `cmd+a`（mac）/ `ctrl+a` → `insertText` |
| `form_input` 复选框 / 单选框 | 状态不对就点一下 |
| `form_input` 下拉框 | **例外，走 DOM**：原生 `<select>` 的弹出菜单不在页面里，CDP 点不到选项；和 OCIC 一样用原生 setter + `input` / `change` 事件 |
| 截图 / zoom | `Page.captureScreenshot`（`clip` 按 CSS 像素） |
| `evaluate` | `Runtime.evaluate` |

attach 的生命周期：
- agent 标签页第一次要输入、截图、执行 JS 时 attach，之后复用；并发调用共享同一个进行中的 attach。
- attach 后开 `Emulation.setFocusEmulationEnabled`，后台窗口里的输入也不会丢。
- 标签页关闭时 detach；`onDetach`（用户点掉提示条、或打开了 DevTools）时清掉状态，下一次操作自动重新 attach；重新 attach 失败就报 `fail`，说清是 DevTools 占用还是被用户取消。
- 每条 CDP 命令 20 秒超时。
- 用户自己的窗口永远不 attach。

## 6. API 全貌

### 6.1 命令行总表

```
lore learn new --url <链接|tab号> --description "…"      开 learn 窗口，返回句柄
lore learn list                                           列出 learn 窗口
lore learn close <句柄>                                   关掉 Chrome 窗口，句柄和目录保留
lore learn <句柄> <工具> …                               在 learn 窗口里探索（见 6.2）
lore run --action <名> | --compose <名> | --compose-code '…' [--参数 值] --description "…"
lore run --resume <编号> --answer '<json>'
lore tabs | status | doctor | daemon restart
```

### 6.2 learn 工具（探索，ref 或坐标）

```
# 看（不计次数、不要 --description、不附带观察）
read_page [--filter interactive|all] [--depth 15] [--ref ref_N] [--max-chars 50000]
find "<查询>"
get_page_text [--max 20000]
computer screenshot [--scale 0.5]
computer zoom <x0> <y0> <x1> <y1>

# 动（计次数、要 --description、自动附带观察）
computer left_click | right_click | double_click | triple_click | hover  (<x> <y> | --ref ref_N) [--modifiers cmd+shift]
computer left_click_drag  (<sx> <sy> <x> <y> | --ref ref_A --to ref_B)
computer scroll_to        (<x> <y> | --ref ref_N)
computer scroll <x> <y> <up|down|left|right> [格数]
computer type "文字"
computer key "<键 键…>" [--repeat n]
form_input <ref_N> <值>                 文本、下拉（选项值或文字）、复选（true/false）
navigate <网址|back|forward>

# 等（不计次数、不要 --description，附带观察：等晚到的请求就用它）
computer wait <秒>

# lore 自有（在当前页面试跑 action，不变成 verified）
try_action <名> [--参数 值]
```

和现在相比，lore 自有的三个工具这样改：

| 现在 | 改成 | 理由 |
|---|---|---|
| `observe` | **删掉**，用 `computer wait <秒>` | 每次操作已经自动附带观察；`observe` 唯一的用途是「等一会儿看晚到的请求」，而 `computer wait` 本来就是等完再附带一次观察（现在的代码就是这样），两者重复。等待也是 Claude in Chrome 的原生动作，agent 不用学一个 lore 专有命令 |
| `observe --all` | **删掉**，读文件 | 「列出所有 endpoint（包括出现过的）」是读日志，按 lore 的原则日志是文件：`rg` / `node -e` 读 `timeline.jsonl` 和 `endpoints.json`，不需要命令 |
| `run --action <名>` | **`try_action <名>`** | 和顶层 `lore run` 同名但意思不同（这里在当前页面试跑、不变成 verified，那里开新 run 窗口交付），容易混。改名后一眼能区分「试」和「交付」；用 `snake_case` 和 `read_page`、`form_input`、`get_page_text` 同一种写法，融进工具列表 |
| `close` | **移到 `lore learn close <句柄>`** | 它是窗口的生命周期，不是窗口里的工具。和 `lore learn new`、`lore learn list` 放在一起：`new / list / close` 管窗口，`<句柄> <工具>` 在窗口里干活 |

这样 `lore learn <句柄>` 下面只剩两类东西：Claude in Chrome 的工具（名字、参数、语义完全对齐），加一个 lore 自有的 `try_action`。

输出示例：

```
$ lore learn ithome.com-… read_page --filter interactive
ok read_page 交互元素 86 个（全文：pages/000120-a11y.txt）
页面：https://www.ithome.com/1/021/825.htm "价格不低！…- IT之家"
navigation
  link "首页" [ref_3] href="https://www.ithome.com/"
  textbox "搜索" [ref_9] type="text"
  button "搜索" [ref_10]
…
link "评论" [ref_41] href="#ifcomment"

$ lore learn ithome.com-… find "评论"
ok find 3 个
  ref_41 link "评论" (1182,380)  定位：{"role":"link","name":"评论"}
  ref_57 heading "热门评论" (203,598) 视口外  定位：{"role":"heading","name":"热门评论"}
  ref_58 heading "最新评论" (203,1460) 视口外  定位：{"role":"heading","name":"最新评论"}

$ lore learn ithome.com-… computer left_click --ref ref_41 --description "点评论，打开文章评论区"
ok computer left_click
落在：<a#gocomm> "评论"
定位：{"role":"link","name":"评论"}（写 action 时放进 click(定位)）
稳定：页面已安静，等了 1.0s
观察：#55 → #59
请求：
  #58 GET /api/webcomment/getnewscomment → 200 application/json，有响应体，requests/000058-…json

$ lore learn ithome.com-… form_input ref_9 华为 --description "搜索框填华为"
ok form_input
落在：<input.search> "搜索"
定位：{"role":"textbox","name":"搜索"}（写 action 时放进 form_input(定位, 值)）
值：华为
```

被遮挡、ref 失效、CDP 连不上时：

```
ok computer left_click
落在：<div.mask>
被遮挡：ref_41 link "评论" 被 <div.mask> "登录后查看更多" 盖住，点击落在了它上面

fail ref_41 找不到了：页面变了，重新 read_page 或 find

fail 连不上这个标签页的调试接口：这个 agent 窗口开着 DevTools，关掉后重试
```

### 6.3 action SDK（回放，只用持久定位）

```javascript
import {
  lore,                                   // lore.params、lore.ask（compose）
  navigate,                               // navigate(url | "back" | "forward", { settle? })
  request, waitRequest,                   // 发请求 / 等页面自己发
  click,                                  // click(loc, { button?, count?, modifiers?, settle? })   ← CDP
  hover,                                  // hover(loc)                                           ← 新增，CDP
  key,                                    // key("cmd+a", { loc?, repeat? })                      ← CDP
  scroll, scroll_to,                      // scroll({ direction, amount, loc? })、scroll_to(loc)  ← CDP
  form_input,                             // form_input(loc, 值)        ← 取代 fill / select / check
  waitFor,                                // waitFor(loc, { timeout?, gone? })
  get_page_text,                          // get_page_text({ max })     ← 取代 text
  query,                                  // query({ css, fields, limit })
  evaluate,                               // evaluate(fn, ...参数)       ← 改走 CDP Runtime.evaluate，不再受 CSP 限制
  sleep,
} from "../../../lib/index.js";
```

定位 `loc` 的写法不变：`"CSS"` | `{ css }` | `{ role, name, exact?, nth? }` | `{ text, nth? }`。

### 6.4 三层对应

| learn（探索） | 输出的定位 | action（回放） |
|---|---|---|
| `computer left_click --ref ref_41` | `{"role":"link","name":"评论"}` | `click({ role: "link", name: "评论" })` |
| `computer hover --ref ref_12` | `{"role":"button","name":"更多"}` | `hover({ role: "button", name: "更多" })` |
| `form_input ref_9 华为` | `{"role":"textbox","name":"搜索"}` | `form_input({ role: "textbox", name: "搜索" }, lore.params.q)` |
| `computer scroll_to --ref ref_57` | `{"role":"heading","name":"热门评论"}` | `scroll_to({ role: "heading", name: "热门评论" })` |
| `computer key "Enter"` | — | `key("Enter")` |
| `get_page_text` | 正文 | `get_page_text({ max })` |

### 6.5 扩展内部的分工（实际实现）

| 位置 | 职责 | 对外 |
|---|---|---|
| `page/common.js` | 命名空间、发消息、元素描述、唯一的 ref 表（`ref_N`，`refOf` / `byRef`） | — |
| `page/a11y.js`（新，合并了计划里的 `elements.js`） | 唯一的 `roleOf` / `nameOf`；持久定位的生成（`locOf`）和解析（`find`、`resolveLoc`）；a11y 树、find、正文；目标 → 视口坐标（滚进视口、遮挡检测、落点提醒）；`form_input` 的准备和核对 | `readPage`、`findElements`、`pageText`、`point`、`scrollTo`、`focus`、`viewport`、`formTarget`、`checked`、`valueOf` |
| `page/executor.js`（变薄，438 → 108 行） | 在途请求计数、`quiet`、`waitFor`、auth 读取、`query`、`fetch`、`ping` | 同左 |
| `page/recorder.js`（变薄） | 请求、导航、文档、页面快照；不再记输入事件 | — |
| `cdp.js`（新） | attach 管理、`input`、`screenshot`、`evaluate` | — |
| `keys.js`（新，纯函数） | 键名 → `dispatchKeyEvent` / `insertText` 参数，扩展和自检共用 | — |
| `anchor.js`（新） | anchor 页发现 background 不是磁盘上这一版就 `chrome.runtime.reload()` | — |
| `build.js`（`setup.js` 写入） | 这一版扩展的 build，握手时报给 daemon | — |

页面脚本加载顺序：`common.js` → `a11y.js` → `recorder.js` → `executor.js`。`manifest.json` 加了 `"debugger"` 权限，ABI 12 → 13（新增 `input`、`evaluate`、`reload`）。

## 7. 测试

OCIC 怎么测：
- `test/` 下是纯 Node、无框架、无依赖的单测，`for t in test/*.test.mjs; do node "$t"; done` 全部跑完。
- `_extract.mjs` 用括号匹配把要测的函数从 `background.js` 里原样抠出来（service worker 没有 export），测的是发布的源码，不是副本。
- `humanize-executor.test.mjs`：把「计划 → CDP 调用」这一层接到一个假的 CDP 上，断言发出的 CDP 调用和顺序（每个字 `keydown → insertText → keyup`）。这层测试抓到过数字键上档符号漏映射的 bug。
- `handlers.test.mjs`：假的 `chrome.*` 上测工具处理函数（新建标签页不抢焦点等）。
- 端到端靠 `benchmark/`：REAL 基准的 12 个任务，和官方扩展对比步数、用时、正确率。

lore 怎么测（守 AGENTS.md：不模拟扩展、不桩 `chrome.*`，只留守住静默出错的自检）：
1. **键名表 → CDP 参数是纯函数**，放进 `cdp.js` 外的独立模块，selfcheck 断言：`Enter`、`cmd+a`、`shift+1`（上档符号）、方向键、中文字符各自生成的 `dispatchKeyEvent` / `insertText` 序列。键映射错了会静默打错字，值得守。
2. **名字算法一致性**：`read_page` 给出的每个 `role "name"` 用 `{role,name}` 都能解析回同一个元素。selfcheck 不依赖 Chrome、Node 里没有 DOM，所以放进真实 Chrome 验证：在三类站点上各跑一次 `read_page --filter interactive`，逐个用定位解析回去比对。
3. **ingest 自检**改掉 `trusted` 相关用例，只保留「请求的 cause 来自 cmd 行」。
4. **真实 Chrome 验证**（AGENTS.md 2.3 补充）：
   - 后台 agent 窗口（不在前台）里点击、输入、滚动都生效；截图不会把窗口切到前台。
   - 打开 DevTools 后再操作：报清楚的 `fail`；关掉后自动恢复。
   - 点掉调试提示条后再操作：自动重新 attach。
   - learn 和两个 run 窗口并行：各自 attach，互不干扰。
   - 严格 CSP 的页面上 `evaluate` 能跑。
   - 用户自己的窗口里浏览：不 attach、不产生记录。

## 8. 分阶段步骤

### 第一阶段：CDP 输入和删除真人判断
1. `background.js` 拆出 `cdp.js`：attach 管理、`input`、`screenshot`、`evaluate`；`manifest.json` 加 `debugger`。
2. daemon 的 `computer` 坐标操作改走 `cdp.input`；截图改走 `cdp.screenshot`。
3. 删 `executor.js` 的合成输入、`recorder.js` 的输入事件、`ingest.ts` / `types.ts` 的 `user` 来源和 `trusted` 处理，改自检。
4. 用真实 Chrome 把现有 `computer` 13 个 action 走一遍（AGENTS.md 2.3 第 3 条），确认行为不变。

### 第二阶段：a11y 树、ref、元素查找
1. 新建 `elements.js`（合并 role / name 算法）、`a11y.js`（ref 表、`readPage`、`findElements`、`refPoint`、`locPoint`、`describePoint`）。
2. `commands/learn.ts`：加 `read_page`、`find`、`get_page_text`、`form_input`；点击类、`hover`、`scroll_to`、`left_click_drag` 接受 `--ref`；`LOOK_ONLY` 加三个只看命令；删 `observe`（`--all` 一起删）；`run` 改名 `try_action`；`close` 移到 `lore learn close <句柄>`。
3. 输出里所有「等一会儿再 observe」「下次 observe 出现」的提示改成 `computer wait <秒>`；「lore learn <句柄> run --action」改成 `try_action`。
4. `record/windowlog.ts`：a11y 快照落盘到 `pages/<编号>-a11y.txt`，timeline 记 `type: "snap", kind: "a11y"`。

### 第三阶段：SDK 和文档
1. SDK 的 `click` / `key` / `scroll` / `scroll_to` 改成 `locPoint` + `cdp.input`；新增 `hover`；`form_input` 取代 `fill` / `select` / `check`；`text` 改名 `get_page_text`；`evaluate` 走 `Runtime.evaluate`。
2. 改本机 `~/.lore/sites/*/actions` 里的旧写法。
3. `learn/guide.ts`：「怎么做」改成 `find` / `read_page --filter interactive` → ref 操作，截图只用来确认视觉效果；示范全程不截图。
4. `SKILL.md`、`ARCHITECTURE.md`、`install.md`（扩展要重新加载、调试提示条是正常现象）同步更新。

## 9. 验收

1. **省时**：重跑 IT之家任务，全程不截图学会；按 transcript 时间戳统计，和 195 秒对比。
2. **回放**：用 ref 学出的 action 在新开的 run 窗口里跑通。
3. **三类站点**（AGENTS.md 2.3）：公共站点、GraphQL 站点、公司内部多子域站点各走一遍 learn → run。
4. 第 7 节第 4 条的真实 Chrome 验证全部通过。

## 10. 剩下的成本（已接受）

- 用户要重新加载一次扩展（新增 `debugger` 权限）。
- agent 窗口顶部会一直显示「lore 正在调试此浏览器」提示条。
- agent 窗口里不能同时开 DevTools；要看页面就去用户自己的窗口，或先 `lore learn <句柄> close`。

## 11. 待定

- SDK 是否加 `find(query)` 做回放兜底？建议第二阶段跑完、看几个站点的回放失败率再定。

## 12. 实施结果（2026-11-04）

三个阶段都已完成，`npm run check` 通过，17 个自检通过（新增 `browser/keys.selfcheck.mjs`）。

**扩展更新不用手动点**：升级后 daemon 发现扩展不是磁盘上这一版就发 `reload`（ABI 13 起）；从 ABI 12 升级时，`ensureExtension` 开一个 anchor 页，新版 `anchor.js` 让扩展自己重新加载。本机实测：从 ABI 12 升级、之后 5 次重装，扩展都自动换成新版，没有手动操作。

**真实 Chrome 验证**（本机 Chrome，agent 窗口不在前台）：

| 项 | 结果 |
|---|---|
| `find` / `read_page --filter interactive` / `get_page_text` | 通过：隐藏的菜单项不列，下拉框选项、复选框状态列出 |
| `computer left_click --ref`（IT之家搜索按钮）、`form_input`（搜索框） | 通过，跳到搜索结果页 |
| 双击、三击、右键、悬停、悬停菜单里点击、拖拽（HTML5 dragstart / drop）、容器滚动、`scroll_to`、视口外元素先滚进来 | 通过，页面收到的都是 `isTrusted` 为真的事件 |
| `type`（每个字 keydown）、`key "cmd+a"`（全选 0-5）、`key "Enter"`（提交表单，输出「跳转：」） | 通过 |
| 被遮挡的按钮 | 输出「被遮挡：目标被 <div#mask> 盖住」，点击落在遮罩上 |
| CDP 截图、`zoom` | 通过，不把窗口切到前台 |
| SDK：`form_input`、`click`（`count: 2`、`button: "right"`）、`hover`、`key`、`get_page_text`、严格 CSP 页面上的 `evaluate` | learn 窗口 `try_action` 和 run 窗口 `lore run` 都通过，变成 verified |
| 用户自己的窗口（Claude in Chrome 浏览、双击） | `~/.lore` 下没有新文件 |
| IT之家原任务（华为、第 10 篇、第 3 条评论）用 CDP 版 SDK 重跑 | 4 秒，结果和之前一致；`ithome-comments` 改成 `scroll` + `click` 后变成 verified |
| GraphQL 站点（AniList：页面在 anilist.co，搜索框是无名输入框） | `find` 找到搜索框（没有名字的给出 CSS 定位），`form_input` 改搜索词后页面结果更新；页面加载的 `POST /graphql` 录到，带 `x-csrf-token` 的请求头信号。搜索请求在 Web Worker 里发（Claude in Chrome 的网络记录里也只看到 `…worker.js`），lore 按设计录不到，按指引退回 DOM：`anilist-search`（`navigate` + `waitFor` + `query`）在 learn 窗口试跑、run 窗口交付都通过，变成 verified |
| 不截图从零学一个新 action（IT之家日榜前 5） | 24 秒（开窗 → find → 看结构 → 写 action → try_action → close → lore run），对比第一次截图学评论的 195 秒 |

| 同一个标签页同时发三次输入（扩展刚重新加载、还没附着） | 都成功：共用一次附着 |

测试中修掉的问题：点击引发跳转时页面调用返回空（改成按跳转处理）；回车提交这类跳转让 `quiet` 卡到超时（当作跳转重试）；滚轮滚动后马上读滚动位置读到 0（等位置稳定再读）；同站跳转没有「跳转：」（改成比较地址）；`setup.js` 重装会清空重建 `~/.lore/src`，build 没变时 daemon 不重启、留在被删的工作目录里，之后 action 报 `ENOENT uv_cwd`（原有问题，daemon 启动时改到 `~/.lore` 工作）。

**没验证的**：在 agent 窗口里开 DevTools 时的报错、用户点掉「正在调试此浏览器」提示条后自动重新附着，这两项要点 Chrome 自己的界面：Claude in Chrome 和 lore 都点不到，computer-use 在这个会话里不可用，macOS 的界面脚本没有辅助功能权限；公司内部多子域站点（AGENTS.md 2.3 第 3 条）没跑（本机没有可用的内部站点）。`npm run verify:pack` 通过（修了一处：扩展的 `build.js` 是安装时生成的，镜像比对时跳过它，并检查它和 `.version` 一致）。

## 13. 这次做了什么（总结）

**起因**：一次 IT之家任务（搜华为 → 第 10 篇 → 第 3 条评论）学了 195 秒，59% 是模型在看截图、猜坐标。参考 open-claude-in-chrome（`noemica-io/open-claude-in-chrome`，Claude in Chrome 的开源复刻）的实现，把探索换成 a11y 树 + ref，输入换成 CDP。

**做了什么**

1. **输入只走 CDP**：新增 `chrome-extension/cdp.js`（附着管理、`Input.*`、`Page.captureScreenshot`、`Runtime.evaluate`）和 `keys.js`（键名 → 按键事件，纯函数，扩展和自检共用）。learn 的 `computer` / `form_input` 和 action 的 `click` / `hover` / `key` / `scroll` / `form_input` 走同一条路径（`RunHost.input`：页面里把目标换成坐标，扩展用 CDP 发）。删掉页面里合成鼠标、键盘、滚轮、拖拽事件的代码（`executor.js` 438 → 108 行）。只支持 Chrome，扩展加 `debugger` 权限，ABI 12 → 13。
2. **不再判断「谁在操作」**：删掉录制端的输入事件、`isTrusted`、`src: user`、`input` 行和相关自检、文档。agent 窗口里的一切都记为 agent，请求的 `cause` 只来自 cmd 行。
3. **a11y 树和 ref**：新增 `page/a11y.js`，唯一的 role / name 算法（吸收 open-claude-in-chrome 的 `getAccessibleName` 修正），`read_page`、`find`、`get_page_text`、持久定位的生成和解析、目标 → 坐标（滚进视口、遮挡检测、落点提醒）。`common.js` 的 ref 表改成 `ref_N`。learn 里看到的 `role "name"` 和回放时解析 `{ role, name }` 是同一套算法。
4. **learn 命令对齐 Claude in Chrome**：`lore learn <句柄>` 下是 `read_page`、`find`、`get_page_text`、`computer`（坐标或 `--ref`）、`form_input`、`navigate`，加一个 lore 自有的 `try_action`（原来的 `run --action`）。删掉 `observe`（晚到的请求用 `computer wait`），`close` 改成 `lore learn close <句柄>`。
5. **SDK**：`fill` / `select` / `check` 合成 `form_input(定位, 值)`，`text` 改名 `get_page_text`，新增 `hover`，`click` 支持右键、双击、三击；`evaluate` 改走 CDP，不受页面 CSP 限制。
6. **扩展自己重新加载**：`setup.js` 把 build 写进 `chrome-extension/build.js`，扩展握手时报给 daemon；不是磁盘上这一版就发 `reload`。从不支持 `reload` 的旧版升级时，daemon 开一个 anchor 页，`anchor.js` 发现版本不对就让扩展重新加载；新代码跑在没有 `debugger` 权限的旧 manifest 上也会自己重新加载。
7. **修掉的原有问题**：重装后 build 没变、daemon 没重启时，daemon 留在被删的工作目录里，action 报 `ENOENT uv_cwd`；daemon 启动时改到 `~/.lore` 工作。
8. **文档**：learn 指引（`learn/guide.ts`）改成先 `find` / `read_page` 再用 ref 操作、截图只确认视觉；`SKILL.md`、`ARCHITECTURE.md`、`AGENTS.md`（2.3 真实 Chrome 验证清单）、`install.md`、`CHANGELOG.md` 同步更新。`tools/verify-pack.mjs` 跳过安装时生成的 `build.js`，并检查它和 `.version` 一致。

**测试**：类型检查通过，17 个自检通过（新增 `browser/keys.selfcheck.mjs`），`verify:pack` 通过；真实 Chrome 里的结果见第 12 节。

**性能**

| 项 | 之前 | 之后 |
|---|---|---|
| 点击、悬停（含等页面安静和观察） | 约 1.2 秒 | 约 0.35 秒 |
| 滚动（含附截图） | 0.9～2.2 秒 | 约 0.7 秒 |
| 看页面 | 截图后看图猜坐标 | `find` 约 0.25 秒、`read_page` 约 0.2 秒，返回文字 |
| 学一个 action | 195 秒（截图学 IT之家评论） | 24 秒（不截图学 IT之家日榜，任务更简单，不是严格对比） |
| `lore run` 交付 | 3.4 秒 | 4 秒（时间主要在打开页面和接口，基本持平） |

**遗留**：开着 DevTools 时操作 agent 窗口，用户手动跑了一次 `computer hover`，返回 `ok`（是否开着 DevTools 时跑的没确认）；点掉调试提示条后的自动重新附着没有确认；公司内部多子域站点没跑；新旧两种方式在同一个复杂任务上从零学的严格对比没做。
