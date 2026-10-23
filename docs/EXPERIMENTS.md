# 实验记录

环境：macOS、Chrome 151–155。实验代码（原 `lab/`）已随产品落地删除，需要时用 `git log --stat -- lab` 找回；结论保留在这里，已转入设计的部分见 `docs/DESIGN.md`。样本量都很小（单人、单机），结论是方向性的。

## E1 指纹对比（人 vs CDP vs DOM）
| 来源 | isTrusted | pressure（pointerdown） | 其它字段 |
|---|---|---|---|
| 真人 | true | 0.5 | 与 CDP 基本相同 |
| CDP `Input.dispatch*` | true | 0（默认） | 屏幕坐标正常，ptype=mouse |
| DOM `.click()` / dispatchEvent | **false** | - | screenX/Y 异常（-80,-80），pointerId=-1 |

- `isTrusted` 不能区分 CDP 与真人。DOM 方法触发可直接区分。
- 屏幕坐标偏移的假设**不成立**（CDP 的屏幕坐标与真人一致）。
- 键盘：真人与 CDP 的 `keydown` 字段无差异。
- 滚轮：真人是一串小增量（1,4,9,23,40…），CDP 是单个整数增量，可作辅助信号。
- 真人在页面里产生密集 `pointermove`（~400 次/25s）；agent 不发就没有。
- **水印可行**：`Input.dispatchMouseEvent` 带 `force: 0.123`，页面读到 `pressure≈0.123`（float32，比较要留容差）。因为 agent 是我们自己的代码，鼠标事件可直接打水印，不必猜指纹。键盘没有对应字段。

## E2 人与 agent 同时操作（25s，agent 67 条指令，随机间隔）
用独立真值（鼠标=水印，键盘=agent 只打 Q/7，滚轮=deltaX=7）评估"对账法"（事件落在 ledger 指令窗口内，且事件类型与指令类型一致）：

| 事件 | 真人数 | agent 数 | 真人→误判 agent | agent→误判真人 |
|---|---|---|---|---|
| pointerdown | 13 | 30 | 0 | 0 |
| keydown | 98 | 34 | 1–2（窗口 [-5,+30]ms 为 2，[-5,+10] 及更窄为 1） | 0 |
| wheel | 0（没测到真人滚轮） | 20 | - | 0 |

- 指令耗时 p50 3.5ms，p95 14.4ms，最大 31.7ms；指令发出到首个页面事件 ≈0.3ms（最大 1.6ms）。窗口可以开得很窄。
- agent 事件**零漏判**。唯一的误判是真人按键恰好落在 agent 按键窗口内（~1–2%）。进一步可按"键值是否在指令预期里"收窄（未实测）。
- 局限：真人滚轮没测到；鼠标真人样本只有 13；只测了同一元素区域附近的操作。
- 注意：`e2.mjs` 里即时汇总的数字有 bug（pressure 用了精确相等、没按类型匹配），以 `e2-analyze.mjs` 的重算为准。

## E3 `Input.setIgnoreInputEvents`
- 开启后 **CDP 派发的点击也被忽略**（点击计数 0），关闭后恢复。
- 因此不能用它实现"挡人不挡 agent"。
- 真人是否被挡未测到（脚本运行时人看不到提示）；对结论无影响。
- 替代方案待验证：页面内遮罩层、或 agent 动作期间由扩展在页面 capture 阶段 `preventDefault` 非水印事件。

## E1–E3 的结论（E2 的后续已作废）
1. 鼠标：水印可确定性区分，无需对账。
2. 键盘/滚轮：对账法可用，但会把约 1–2% 的真人按键误判成 agent（真人按键恰好落在 agent 指令窗口内）。这个方向**不安全**：真人输入被当成 agent，就不会触发抢占。所以判定要偏向"是人"：窗口内出现与指令预期不符的事件（键值、坐标、目标元素对不上）一律当人。
3. `setIgnoreInputEvents` 不能用于屏蔽人。

## E4 接管延迟（扩展 `chrome.debugger`，真实 Chrome，12 轮）
通道：`Runtime.addBinding` + 页面 capture 监听 → `Runtime.bindingCalled` → 扩展撤销租约。**全程未启用 Runtime 域。**

- 真人输入发生 → 扩展收到：中位数 4.5ms，p90 8.7ms，最大 42.2ms（偶发离群，未深究）。
- 租约撤销 → agent 紧接着的点击：12/12 被拒绝，间隔 0.1–1ms。
- 观察：`pointermove` 经常是第一个触发撤销的事件。设计结论：**只有 `pointerdown`/`keydown`/`wheel` 触发撤销，`pointermove` 只当"人在场"信号**，否则鼠标悬停就会打断 agent。
- 水印 `force: 0.123` 在扩展里同样有效（agent 自己的点击不会撤销租约）。

## E5 附着到用户已有的普通标签页（首次测试，复测见文末）
已测（Chrome 155，一个普通站点标签页，单次）：
- 附着成功，CDP 命令正常；人的输入实时收到（2–4ms）。横幅是否出现、观感如何：**未记录**。
- **DevTools 共存**：附着期间用户打开 DevTools，没有断开事件，CDP 照常返回。这个版本里不会被挤掉（只测一次，别的版本未知）。
- `chrome://` 页面不能附着（"Cannot access a chrome:// URL"），属浏览器限制；受限页面都要在设计里处理。
- **发现的问题**：用户跳转 + 刷新后，页面里的监听脚本和 `__tcr` 绑定都没了（`typeof __tcr === "undefined"`），附着本身没断。当时的写法是未先启用 `Page` 域就 `Page.addScriptToEvaluateOnNewDocument`；**推测**是这个导致没生效，尚未验证。已在 `lab/ext/background.js` 改成附着时先 `Page.enable`，并加了 `raw` 调试操作；**改后的版本还没有完成"跳转+刷新"复测**。
- 因同一原因，早先在探针页上的反调试对照（Runtime 开/关，均 0 命中）**作废**：刷新后脚本根本没运行。

## E6 轻量层（无 `chrome.debugger`）能抓到多少
环境：Chrome for Testing 151 headless，`lab/ext-light` 扩展，`node lab/light.mjs fixture|sites`。同一页面同时用 CDP `Network` 记 ground truth 做对比（CDP 只用于评估，扩展里没有 debugger）。扩展含：`world: "MAIN"` 的 `document_start` 脚本包住 `fetch`/XHR/`sendBeacon`/WebSocket，DOM 快照（含 open shadow root）和用户事件监听，加 `webRequest` 元数据。样本量小，未登录、headless，结论是方向性的。

**请求（fetch/XHR/beacon）**
- 本地 fixture（16 个数据请求，覆盖 `Request` 对象、POST、流式、1MB、二进制、重定向、404、shadow DOM 按钮、同源 iframe、SPA `pushState`）：抓到 15 个。响应体 11 个与 CDP 完全一致，1MB 的按 256KB 截断，二进制只记大小，POST 请求体都在。重定向记成原始 URL，附带 `finalUrl`。
- 跨源 iframe 里的 fetch 也抓到了（`all_frames`）。
- **漏的：Worker 里发的请求**（fixture 的 Worker fetch，npm 页 Cloudflare 的 Worker）。主页面的 content script 管不到 Worker，需要另想办法或接受这个盲区。
- GitHub 仓库页 + 点进 issues：16/16 抓到，有响应体的 8 个与 CDP 完全一致。
- 真实站点的另一个漏：HN 上 Cloudflare challenge iframe 里的一个 XHR 没抓到（原因没查，测试环境是 headless 被判成机器人，npm/HN/reddit 都停在 challenge 页，参考价值有限）。
- `webRequest` 能看到全部资源类型的元数据（脚本、图片、样式、字体），但**没有响应体和请求体**，数量比 CDP 少一些（GitHub 252 vs 348）。

**DOM**
- 快照列出可见的可交互元素（tag/role/文字/选择器/坐标/输入值，密码打码），并走 open shadow root。
- 和 CDP Accessibility 树的可交互节点数对比：Wikipedia 269=269，HN 229=229，fixture 17=17，GitHub 74 vs 70（多出的是无障碍树里被忽略的元素）。
- 动作后（click/change/submit/SPA 跳转）和 load 后自动出快照，抓到了 SPA 跳转和 JS 延迟插入的按钮。
- **体积偏大**：Wikipedia 首页 40KB（200 条上限已触顶），HN 43KB。交接包要的是 2–4k token，这里要裁剪（只留视口内、按相关性取前几十条、去掉坐标）。
- 未覆盖：closed shadow root、跨源 iframe 内部的 DOM（该 frame 自己的 content script 会各自出快照，但没合并）。

**用户事件**：click/input/keydown/wheel/submit 的 capture 监听能看到并记录目标元素，CDP 驱动的事件 `isTrusted` 也是 true（与 E1 一致）。

**结论**
1. 对"人在页面里做了什么、页面发了哪些接口、返回了什么"，轻量层基本够用，不弹横幅。
2. 盲区：Worker/Service Worker 请求、部分 challenge iframe、非文本响应体、超过上限的响应体。
3. 要重放请求需要的 header（cookie 之外的自定义头、签名）轻量层**没记**，这点上 CDP 更完整；目前 fetch 层可以记 `init.headers`，未做。
4. 没测：页面是否能检测到被改写的 `fetch`（`toString()` 非 native）；已登录的复杂 SPA（GraphQL、WebSocket 密集）；有 CSP 的站点（manifest 注入的 MAIN-world 脚本理论上不受页面 CSP 限制，未实测）。

**注意**：本机 8766 被一个无关的 python 服务占用，`lab/hub.mjs` 已支持 `HUB_PORT` 环境变量，轻量层用 8769（`HUB_PORT=8769 node lab/hub.mjs`）。

## E6b 日常 Chrome + 已登录站点（知乎、IT之家）
环境：用户日常 Chrome，手动加载 `lab/out/ext-light-local`（只对 zhihu.com、ithome.com 生效，由 `node lab/light-setup.mjs zhihu.com ithome.com` 生成），操作由 Claude in Chrome 完成（导航、滚动、点击、新标签页打开文章、SPA 跳转）。对照基准用扩展自己的 `webRequest`（没有 debugger）：Claude in Chrome 的 `read_network_requests` 在首次调用前的请求看不到，不适合当 ground truth。样本很小，每站点一次会话。

| 站点 | webRequest 里的 XHR/fetch | hook 抓到 | 没抓到 |
|---|---|---|---|
| IT之家（首页→翻页→新标签打开文章） | 9 | 8 | 1 个 CORS 预检 `OPTIONS`（浏览器自己发的） |
| 知乎（首页、展开回答、滚动、切到专栏 SPA 跳转） | 82 | 78 | 4 个，同样是 `OPTIONS` 预检 |

- 除预检外没有发现漏抓。fetch/XHR 响应体都在，最大的是知乎推荐流 67KB，没触顶 256KB。
- 请求头里能看到知乎的签名头 `x-zse-93`/`x-zse-96`/`x-zst-81`、`x-api-version`、`x-app-za` 等，说明请求头记录对重放有用；同时也说明**重放不能原样发旧签名**，签名是按请求算的，要靠页面自己的 JS 重新生成（在页面里调用站点自己的请求函数，或 DOM 降级）。`Cookie`/`Authorization` 只记 `[redacted]`。
- WebSocket：知乎有 7 条 ws 事件被记录（open + 前几帧）。
- 快照：默认只列视口内最多 60 条可交互元素，3.9–4.8KB（知乎页面里可见元素 178–307 个）；SPA 跳转后自动出新快照（34 条，2.7KB）。比 E6 的 40KB 小一个数量级，但离"2–4k token"仍有差距（约 1–1.6k token 的纯数据，还没算交接包的其他部分），可接受。
- 用户事件：Claude in Chrome 发出的点击/滚轮 `isTrusted` 是 true，和真人无法用 `isTrusted` 区分（与 E1 一致）；有 1 个事件 `isTrusted=false`，来源未查（可能是 `ref` 点击走了 DOM）。
- 小问题：知乎首次加载没出 `load` 快照（只有点击后的快照），原因没查；多标签页（新标签页打开文章）的事件带 `tab` 字段，能区分。
- 隐私：本轮含登录态数据（`/api/v4/me` 响应体等），测完已删除 `lab/out/ext-events.jsonl`。

## E5 复测（日常 Chrome，附着我开的测试 tab，Chrome 155，一次会话）
- **根因不是 `Page.enable`**。跨站跳转后页面里的监听脚本（`addScriptToEvaluateOnNewDocument`）**仍然会重新运行**（`__tcrInstalled===1`），丢的是 `Runtime.addBinding` 的 `__tcr`：跳转后 `typeof __tcr === "undefined"`，输入报不回扩展。
- 手动再调一次 `Runtime.addBinding`，对已存在的页面上下文立即生效。
- 修法（已进 `lab/ext/background.js`）：主框架 `Page.frameNavigated` 后重新 `addBinding`，耗时 19–62ms；页面脚本在 `__tcr` 未就绪时缓存事件（最多 50 条）并 20ms 轮询补发，避免空窗期丢人的输入。
- 修复后复测：example.com → 知乎（跨站）、example.com 刷新（cmd+r）、知乎刷新，`__tcr` 全部为 `function`；刷新后点击立刻被收到（`pointerdown` 延迟 0.5ms，`pointermove` 8.4ms；Claude in Chrome 的点击没有水印，所以被当成人，符合预期）。
- **与 Claude in Chrome 共存**：同一个 tab 上 Claude in Chrome 的调试器和本实验扩展同时附着，没有冲突、没有被挤掉。
- 扩展重载会丢附着，需要重新 attach（产品里要处理）。
- 知乎（已登录）在附着、跨站跳转、刷新后页面正常，没有踢出登录或报错。
- **反调试对照没做成**：页面内的探针（`Error.stack` getter + `console.debug`）连正向对照都是 0（Runtime 开着时手动执行也不触发），说明这个探针在本版本 Chrome 里无效；另外 Claude in Chrome 自己的调试器可能已经开了 Runtime 域，两者混在一起。结论：目前**没有**证据表明知乎/IT之家检测到调试器，但也没有有效的检测手段去证明没有。
- 横幅：Chrome 窗口顶部一条提示，“<扩展名>”已开始调试此浏览器，右侧有按钮；点“取消”后扩展收到 `onDetach`，`reason: "canceled_by_user"`，扩展状态清空，之后需要重新 attach（产品里要有重连提示，不能静默重连）。横幅点名的是扩展名，产品扩展名要让人看了不慌。Claude in Chrome 的截图只截页面内容，截不到浏览器界面和横幅。窗口 `outerHeight` 913 vs `innerHeight` 736（含标签栏、地址栏、横幅，没有无横幅对照值）。

## 已作废和已转入产品的部分
- **E2 的时间窗口对账**（键盘、滚轮约 1–2% 误判）已被"构造法"取代：agent 用 `insertText`、`scrollBy` 等不会产生 `keydown`、`wheel` 的方式，特殊键再用一对一消耗对账。构造法依赖的两个假设（`insertText` 不触发 `keydown`，`scrollBy` 不触发 `wheel`）**没有实测**，见 `docs/DESIGN.md` 的 TODO。E2 的真人滚轮样本没有收集。
- **反调试对照**没做成（探针在这个 Chrome 版本里无效，连正向对照都是 0）。
- **轻量层**（E6、E6b）已落成产品里的 `src/chrome-extension/journal/`；**E5 的修法**（跨站跳转后重新 `addBinding`）属于重量层，产品里还没用到，做 agent 的输入通道时再带上。

