# TwoCursor 设计交接

> 人和 agent 共用同一个浏览器。人可以做，agent 也可以做；agent 做的时候人可随时插手，agent 能感知"现在是人在帮我"。
> 状态：从 twocursor 源码起步（fork 自 yanggggjie/TwoCursor），尚未开始改造。下文体积估算与 CDP 行为判断均为经验推断，**先验证再依赖**。

## 1. 目标
1. 扩展常驻监听并录制请求（必要时 DOM/截图），整理成结构化数据，滚动保留。
2. 人做到一半可交给 agent，agent 靠录制数据知道下一步。
3. agent 可重放历史请求（页面内 fetch，带登录态）；失败降级 DOM 操作，DOM 操作同样被录制。
4. agent 探索页面时也在录制，后续用请求更高效地探索。
5. 核心差异：人和 agent 同时在场，agent 能识别人的插手并调整。

## 2. 已定决策
- 接受"正在调试此浏览器"横幅，直接用 `chrome.debugger`（CDP）。
- 重放失败 → DOM 降级，且被录制。
- 录制时脱敏：给 agent 看脱敏版，原始值留本地，重放时本地层替换回真值。
- 录制时长可达 24h 甚至启动即录，分层存储。
- 名字 TwoCursor（单数）；副标题候选 `it takes two to browse`（商标风险未评估）。

## 3. 现有项目（不保证无遗漏）
browser-dvr-mcp、PilotBrowseMCP、R44VC0RP/browse、Alezander9/browser-control、Open Browser Control、Tandem Browser（名字已占用）、ego-lite、BrowserSkill、BrowserTools MCP、mcp-chrome、reverse-api-engineer、agent-browser `derive-client`、Understudy/Overline/Flow2Skill 等。人机共用/交接已有人做，TwoCursor 收窄到：
1. 被动常驻录制 + 结构化摘要，交接给 agent 完整上下文。
2. agent 自动感知人的插手（工具返回附带"人做了什么"）。
3. 接口优先、DOM 降级，两者在同一条带来源标签的时间线上。

## 4. 三态与控制权
| 状态 | 谁操作 | 标签 | 对 agent |
|---|---|---|---|
| 人操作 | 人 | `human` | 只能看和查 |
| agent 操作 | agent | `agent` | 持有控制权 |
| 人插手 | 人（agent 任务中） | `human-assist` | 暂停，视为协助 |

- 租约（lease）：agent 持租约才能动作；人的输入永远优先并立即撤销；输入后 1–3 秒防抖内仍算人。
- 写操作（下单/删除/发送/支付）默认人确认。
- agent 可带原因反向交还控制权。
- 按标签页隔离，只有同一标签页才发生"插手"。

## 5. 技术难点
### 5.1 区分人与 agent 输入（最不确定，优先原型验证）
- CDP `Input.dispatch*` 事件 `isTrusted` 为 true，不能靠它区分。
- 对账法：扩展记录 agent 每条指令（`cmd_id`+时间窗），页面捕获的输入事件按时间/坐标/目标匹配，匹配不上 → 人。
- `Runtime.evaluate`/DOM 方法触发的事件 `isTrusted` 为 false。
- `Input.setIgnoreInputEvents` 可否用于关键动作期间忽略人的输入——需查文档/实测。

### 5.2 agent 感知插手
MCP 拉取式，每次工具返回附带 `since_last_call`（status/reason/人的点击输入/URL 变化/空闲时长）。被抢占后：不重试刚才动作，先读变化再重规划。另提供 `get_control_state`、`wait_for_human_idle`。

### 5.3 其他风险
- 同标签页只能挂一个调试器，开 DevTools 会挤掉 → 检测重连；个别风控站点可检测调试器。
- 全量抓响应体有开销 → 限流/采样。
- 签名/时间戳/一次性 token 导致重放失败 → DOM 降级要稳并记录失败原因。
- 权限面远大于 twocursor（附着所有标签页），安装说明要讲清。
- 页面内容与响应体是不可信数据（提示词注入）。
- Native Messaging 写本机 SQLite 未验证。

## 6. 存储（估算未实测）
| 层 | 内容 | 估算 | 保留 |
|---|---|---|---|
| 索引 | URL/方法/状态/耗时/发起者/用户事件/标题 | 0.5–1KB/请求 | 几天到几周 |
| 响应体 | fetch/XHR/文档的 JSON/HTML/文本，zstd | 1h 压缩前几十–几百 MB | 容量上限滚动（如 2GB） |
| 快照 | 关键节点 DOM/webp | DOM 100KB–1MB；图 100–300KB | 几小时 |
| 摘要 | 每段结构化摘要 | 几 KB | 长期 |

降体积：静态资源/埋点只记元数据；按哈希去重；单体设上限；按容量淘汰。存储：Native Messaging → 本机 SQLite（FTS5），MCP server 直接查库。

## 7. 交接包（2–4k token）
目标（可选一句话，否则推断并标置信度）；当前状态（URL/筛选/表单/分页，DOM 确定性提取）；轨迹（每步链接请求/事件 ID）；关键接口（参数模板与变化参数、响应结构、是否验证可重放）；已获数据；约束（已执行写操作、重放失败的接口及原因）。
关键：用户操作与请求关联（`requestWillBeSent` initiator + 用户事件后 1–2s 窗口）。
接手规则：先核对页面与交接包一致；优先重放，失败降级 DOM 并记原因。

## 8. 大数据分析
数据不进上下文，agent 按需查询。确定性预处理（噪声过滤、URL 模板化、参数差异找变量、按导航/空闲切片段、JSON 结构推断），LLM 仅处理片段摘要，异步缓存。
MCP 工具：`get_handoff_pack`、`get_control_state`/`wait_for_human_idle`、`timeline`、`search_requests`(FTS)、`get_request(id, jsonpath)`、**`find_by_value`**（按页面上看到的值反查接口，最有用）、`diff_requests`、`replay_request`、`dom_snapshot`、可选只读 SQL。

## 9. 功能分层
- L1：常驻录制+来源标签；租约/人优先；agent 感知插手；交接包；接口优先 DOM 降级；可视化当前是谁在操作（标识、agent 虚拟光标、接管/交还快捷键）。
- L2：安全边界；脱敏可重放；分层存储；语义查询；标签页隔离；反向交还；交接后状态核对。
- L3：纠正沉淀为技能；动作带 reason；审批模式；通知；审计回放；多 agent；多设备。
- 第一版：L1 全做 + 安全边界与脱敏。

## 10. 开发顺序
1. 原型 A：最小扩展+CDP，验证 5.1。
2. 原型 B：索引+响应体录制器跑 1–2 天，校准体积。
3. 手写几个"做到一半"的理想交接包，倒推摘要内容。
4. 租约、`since_last_call`、MCP 工具、skill。

## 11. 待决
- 独立扩展 vs twocursor 新模式（独立可保住 twocursor "小而可审计"）。
- 仓库可见性（倾向先私有）、许可证（Apache-2.0，继承 twocursor）。
- skill 之外是否同时提供 MCP server（默认都要）。
- 名字未做 npm/GitHub/域名核查；Together、Tandem、Ghost Cursor 不宜用。
