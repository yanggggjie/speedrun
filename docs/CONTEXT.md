# 项目上下文（换机器继续用）

## 这是什么
TwoCursor：人和 agent 共用同一个浏览器。人做到一半可交给 agent，agent 做时人可随时插手并被 agent 感知。完整设计见 [DESIGN.md](DESIGN.md)，实验记录见 [EXPERIMENTS.md](EXPERIMENTS.md)。

## 名字与仓库
- 最终名字 **TwoCursor**（单数，代码里是 `twocursor`）。讨论过 tcr、handle(hdl)、take-it-over、twohands、co-browser、tagin 等，均未采用；co-browser 与已有 MCP 项目和 co-browsing 行业词撞车。
- 仓库 `yanggggjie/TwoCursor`（私有，Apache-2.0）。代码起点是 yodo 的源码，已重命名为 twocursor，历史已清空，与 yodo 仓库无关联；`bench/`、`brand/` 已删除。
- **扩展图标 `skills/twocursor/src/chrome-extension/icons/*.png` 仍是 yodo 的图**，要重画。`SKILL.md`、manifest 描述仍是 yodo 时代的话，产品方向落地后重写。
- 原主体代码（`skills/twocursor/`）尚未按 TwoCursor 目标改造；它的扩展只操作自己开的窗口，本项目需要附着到用户已有标签页，权限面更大。
- 测试：`npm test` 在 `holder.e2e.selfcheck.mjs` 超时失败，**原版 yodo 同样失败**，与改名无关；因为它在第一个失败处停止，排在它之后的自检没有跑过。
- 曾 `git push -f` 覆盖过一次远端历史（用户明确要求）。

## 已定决策（来自用户）
- 接受"正在调试此浏览器"横幅，直接用 `chrome.debugger`。
- 重放失败降级 DOM 操作，DOM 操作也要录制。
- 录制时脱敏；agent 看脱敏版，原始值留本地、重放时本地替换。
- 录制时长可到 24h，分层存储。
- 仓库先私有；许可证沿用 Apache-2.0。
- 测试用日常 Chrome：手动加载 `lab/ext-light` 记录，操作（导航、点击）统一用 Claude in Chrome 工具在专用 tab 里完成。只对用户点名的站点测，响应体只写 `lab/out/`，测完删除。

## 原型 A 到目前的结论（细节见 EXPERIMENTS.md）
- `isTrusted` 不能区分真人与 CDP；DOM 方法触发的是 false。
- 鼠标可用水印确定性区分：`Input.dispatchMouseEvent` 带 `force: 0.123`，页面 `pressure≈0.123`（float32，比较要留容差）。真人是 0.5。
- 键盘/滚轮靠对账（ledger 时间窗 + 类型匹配）；并发测试里 agent 事件零漏判，真人按键有约 1–2% 被误判为 agent。该方向不安全，判定必须偏向"是人"。
- `Input.setIgnoreInputEvents` 会连 agent 的 CDP 输入一起挡，不能用来只屏蔽人。
- 接管延迟（真人输入→扩展）中位数 4.5ms、p90 8.7ms，撤销后 agent 点击全部被拒。只让 pointerdown/keydown/wheel 触发撤销。
- 不启用 Runtime 域也能用 `Runtime.addBinding` + 页面监听拿到人的输入。
- DevTools 在 Chrome 155 与 `chrome.debugger` 可共存（单次测试）。
- **E5 有未解决问题：刷新后页面脚本丢失**，见 EXPERIMENTS.md。

## 怎么在新机器上复现实验台
`lab/` 是实验用代码，不属于产品。Node ≥24。
1. **E1–E3（独立 Chrome，不需要扩展）**：`node lab/lab.mjs up`（后台运行，启动临时 profile 的 Chrome，调试端口 9333，探针页在 127.0.0.1:8765）→ `node lab/lab.mjs agent 5` → 手动操作探针页 → `node lab/analyze.mjs`；并发测试 `node lab/e2.mjs`（等你第一次操作后开始 25s）→ `node lab/e2-analyze.mjs`。`lab/e3.mjs` 测水印与 setIgnoreInputEvents。macOS 路径写死在 `lab.mjs` 的 `CHROME` 常量。
2. **E4/E5（需要真实 Chrome + 扩展）**：Chrome 137 起品牌版 Chrome 不再支持 `--load-extension`，必须手动：`chrome://extensions` → 开发者模式 → 加载已解压 → 选 `lab/ext`。然后 `node lab/hub.mjs`（后台，端口 8766，同时托管探针页 http://127.0.0.1:8766/）。用 `node lab/ctl.mjs <op> '<json>'` 控制扩展：`tabs`（会列出全部标签页 URL，注意隐私）、`attach`（不给 tabId 则附着当前前台标签）、`ping`、`eval`、`raw`、`grant`、`click`、`e4round`。`node lab/e4.mjs 12` 跑 E4。
3. `lab/out/` 是运行产物，已 gitignore。
4. 扩展重载后，hub 会把下一条命令派给已死的长轮询连接而丢失，重发即可。
5. 附着受限：`chrome://` 等页面不能附着；E5 时前台必须是普通 http(s) 标签。

## 隐私提醒
实验扩展有 `debugger` 和 `tabs` 权限，只和 127.0.0.1:8766 通信。用完请在 `chrome://extensions` 移除。

## 下一步建议
1. 先把 E5 刷新丢脚本的问题查清（EXPERIMENTS.md「未完成」第 1–3 条）。
2. 补测 E2（真人滚轮、更多样本）。
3. 设计层面：租约状态机、`since_last_call`、交接包——见 DESIGN.md 第 4、5、7 节。
4. 之前提出、未采纳也未否决的建议：先手动用一周现有 agent 做"做到一半交接"，校准交接包该放什么；第一版考虑"按需附着"而非常驻录制，降低信任门槛；`find_by_value` 可与原型并行先做。
