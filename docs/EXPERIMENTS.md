# 原型 A 实验记录

环境：macOS，Chrome 155，独立临时 profile + `--remote-debugging-port`（CDP 与扩展 `chrome.debugger` 同一协议，输入行为一致）。代码在 `lab/`：`lab.mjs up|agent|mark`、`e2.mjs`、`e2-analyze.mjs`、`analyze.mjs`。样本量小（单人、单机、单次），结论是方向性的。

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

## 当前结论
1. 鼠标：水印可确定性区分，无需对账。
2. 键盘/滚轮：对账法可用，但会把约 1–2% 的真人按键误判成 agent（真人按键恰好落在 agent 指令窗口内）。这个方向**不安全**：真人输入被当成 agent，就不会触发抢占。所以判定要偏向"是人"：窗口内出现与指令预期不符的事件（键值、坐标、目标元素对不上）一律当人。
3. `setIgnoreInputEvents` 不能用于屏蔽人。

## E4 接管延迟（扩展 `chrome.debugger`，真实 Chrome，12 轮）
通道：`Runtime.addBinding` + 页面 capture 监听 → `Runtime.bindingCalled` → 扩展撤销租约。**全程未启用 Runtime 域。**

- 真人输入发生 → 扩展收到：中位数 4.5ms，p90 8.7ms，最大 42.2ms（偶发离群，未深究）。
- 租约撤销 → agent 紧接着的点击：12/12 被拒绝，间隔 0.1–1ms。
- 观察：`pointermove` 经常是第一个触发撤销的事件。设计结论：**只有 `pointerdown`/`keydown`/`wheel` 触发撤销，`pointermove` 只当"人在场"信号**，否则鼠标悬停就会打断 agent。
- 水印 `force: 0.123` 在扩展里同样有效（agent 自己的点击不会撤销租约）。

## E5 附着到用户已有的普通标签页（进行中）
已测（Chrome 155，一个普通站点标签页，单次）：
- 附着成功，CDP 命令正常；人的输入实时收到（2–4ms）。横幅是否出现、观感如何：**未记录**。
- **DevTools 共存**：附着期间用户打开 DevTools，没有断开事件，CDP 照常返回。这个版本里不会被挤掉（只测一次，别的版本未知）。
- `chrome://` 页面不能附着（"Cannot access a chrome:// URL"），属浏览器限制；受限页面都要在设计里处理。
- **发现的问题**：用户跳转 + 刷新后，页面里的监听脚本和 `__tcr` 绑定都没了（`typeof __tcr === "undefined"`），附着本身没断。当时的写法是未先启用 `Page` 域就 `Page.addScriptToEvaluateOnNewDocument`；**推测**是这个导致没生效，尚未验证。已在 `lab/ext/background.js` 改成附着时先 `Page.enable`，并加了 `raw` 调试操作；**改后的版本还没有完成"跳转+刷新"复测**。
- 因同一原因，早先在探针页上的反调试对照（Runtime 开/关，均 0 命中）**作废**：刷新后脚本根本没运行。

## 未完成 / 下一步
1. E5 复测：重新附着（需要前台是普通 http(s) 标签页），确认 `__tcrInstalled===1`，再让用户跳转 + 刷新，看脚本是否留住；留不住就改成 `Page.frameNavigated`/`Page.loadEventFired` 后补注入，并量化空窗期。
2. E5 反调试对照重做：Runtime.enable 开/关各一次，确认探针确实运行过；再在用户指定的几个有风控的站点上附着观察。注意：Chrome 的反调试手法会随版本变，当前探针命中为 0 并不代表不会被检测。
3. 记录附着时横幅的表现。
4. E2 补测：真人滚轮、更多样本、键值收窄（agent 事件键值/坐标/目标与指令预期不符 → 当人）。
5. 已知小问题：`lab/hub.mjs` 的长轮询在扩展重载后会把第一条命令派给已死的连接，命令丢失（重发即可）。
