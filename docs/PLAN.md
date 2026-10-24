# 实现状态与后续

2026-10-24。"让扩展、relay、CLI 变薄，逻辑集中到 holder"的计划已经全部实现；设计依据见 `/Users/me/Code/x/TwoCursor/docs/DESIGN.md`，实现见 `/Users/me/Code/x/TwoCursor/skills/tabbot/ARCHITECTURE.md`。

## 已完成

- **扩展**：约 130 行，固定 ABI（`register`、`exec`、`tabs`、`goto`），没有业务逻辑，不放页面脚本；权限 `tabs`、`nativeMessaging`、`alarms`、`userScripts`，不再有 `debugger`、`scripting`、`storage`。删除了版本哈希、`SITE_OPS` 对账，换成整数 ABI。
- **页面脚本**：`src/page/` 下的 `common.js`、`recorder.js`、`executor.js`、`bridge.js`，由 holder 在扩展连接时经 `chrome.userScripts` 下发。录制与执行解耦，没有共享状态；只录 HTML 文档（渲染后的 DOM）、XHR、fetch，不录 WebSocket、`sendBeacon`、Worker；响应体不设策略上限（技术底线 16MiB，不读事件流）。
- **来源**：只看 `isTrusted`（真是 `human`，假是 `page`）；`agent` 只用于命令记录和重放；`log` 不隐藏任何一类。
- **holder**：租约（`journal/lease.ts`）、原始请求的内存表（`journal/raw.ts`，绝不落盘）、别名对照表（`journal/sanitize.ts`，别名 12 位十六进制，`--set` 里可以写别名）、全部命令（`journal/commands.ts`）、`PageHost`（`journal/pages.ts`）。重放的目标限制放宽为"同站且标签页 origin 等于请求原来的页面 origin"。CLI 拉起的 holder 按"无扩展连接且无命令请求超过 10 分钟"退出。
- **CLI 零逻辑**：只发 `run { argv }`，打印 holder 返回的文本，用它返回的退出码；`doctor`、`daemon restart` 留在 CLI；holder 不在时 CLI 会拉起它。
- **日志**：分段队列（50MB 一段，总共 500MB，写满整段删除最旧的，和时间无关），只有 holder 读写日志目录。
- **脱敏**：最简版本（带单词边界的一条正则加 JWT，只作用于请求头名、查询参数名、JSON key；正文原样写盘）。
- **范围**：没有范围配置，没有排除列表，没有 `sites` 命令。
- **测试与文档**：自检重写，`npm test` 约 8 秒、不依赖 Chrome（含"整个 `~/.tabbot` 里没有 token 真值"的扫描）；`scripts/dev/hook-e2e.mjs` 在无头 Chrome 里验证页面脚本（含录制、主文档、真人动手中止）。删除 `EXPERIMENTS.md`、`CONTEXT.md`，文档与代码对齐。

## 还没有验证的

- **真实 Chrome 里加载新扩展**：`chrome.userScripts` 的 `register`、`execute`、`configureWorld({ messaging: true })`、`onUserScriptMessage` 的行为，没有在真实的扩展里跑过（自检用桩对象，`hook-e2e.mjs` 用 CDP 注入页面脚本，两者都没有走真正的 `userScripts`）。第一次加载后用 `tabbot doctor` 看 `extension-abi`、`user-scripts`，再用 Claude in Chrome 触发页面操作、`tabbot log` 看结果。
- `userScripts` 注册是否跨浏览器重启保留：设计上不依赖（每次扩展 `hello` 之后 holder 都重新注册）。
- 衍生事件（动作触发的 `submit`、`execCommand` 的 `input`）的 `isTrusted`：按"全为假"处理；若真机上发现某个为真并导致 `act` 撤销了自己的租约，再单独处理。

## 升级后要做的

1. 在仓库里运行 `node skills/tabbot/setup.js`（本地安装）。
2. 在 `chrome://extensions` 里刷新 TabBot 扩展（ABI 变了），并在它的详情页打开「允许用户脚本」。
3. `tabbot doctor` 应当全部通过。

## 后续（`DESIGN.md` 第 7 节的 TODO 之外）

- 重放的成功率在真实站点上还没有系统地量过（知乎这类签名站点会降级到 `act`）。
- 如果某些站点的 `fetch` / XHR 包装出问题，目前没有自动停用机制（决定不做）。
