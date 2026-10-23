# 项目上下文（换机器继续用）

## 这是什么
TabBot（曾用名 TwoCursor、TabCobot）：人和 agent 共用同一个 Chrome。常驻录制用户浏览的所有站点（内置排除敏感站点），agent 读日志了解现场；人可随时插手。设计见 [DESIGN.md](DESIGN.md)，实验记录见 [EXPERIMENTS.md](EXPERIMENTS.md)。

## 仓库
- GitHub 仓库 `yanggggjie/TabBot`（私有，Apache-2.0；2026-10-23 从 `TwoCursor` 改名，GitHub 会保留旧地址的跳转）。本机检出目录名仍是 `TwoCursor`，可自行改名。代码起点是 yodo 的源码，已改名并大幅改造，历史已清空，与 yodo 仓库无关联。
- 命名规则：**要书写、打字、匹配的地方一律小写 `tabbot`**（命令、skill 名和触发词、数据目录 `~/.tabbot`、native host `com.tabbot.connect`、环境变量 `TABBOT_*`、Chrome 窗口标题 `tabbot run`/`tabbot record`）；**给用户看的地方写 `TabBot`**（产品名、文档正文、扩展显示名、提示文案）。和 yodo 完全独立：skill 名、命令、数据目录、native host、扩展 ID 都不同，可以同时安装使用。
- 产品代码在 `skills/tabbot/`（运行时、扩展、文档），开发约束、检查和测试、分发见 `skills/tabbot/AGENTS.md`，运行时架构见 `skills/tabbot/ARCHITECTURE.md`（第 7 节是常驻录制）。
- 实验代码（原 `lab/`）已删除，需要时 `git log --stat -- lab`。

## 已定决策
- 接受"正在调试此浏览器"横幅，需要时直接用 `chrome.debugger`；轻量层常驻（不弹横幅），重量层按需。
- 只做 skill 加 CLI，不做 MCP。
- 前台阻塞的 `wait`，不依赖 harness 的后台通知。
- **默认录所有 http/https 站点**，内置排除敏感站点（银行、支付、密码管理、登录、网页邮箱），用户可再排除或改成只录点名的站点（2026-10-23 由原先的“只录点名站点”改来，用户要求）；只录前台页面（agent 的 tab 例外）；硬上限 1GB。
- 录制时脱敏：agent 看别名，原值留本地。
- 判不准就判"人"。
- 重放的真值只留在浏览器里（扩展的会话存储，不落盘），重放在页面里发；日志和 agent 只有别名，不建"保管处"（参考 yodo 的 task：任务在浏览器里运行，token 留在页面里）。请求优先，不行再 `act`。
- 实验用的 Chrome 扩展一旦让用户加载过，就保持路径和身份不变，不让用户反复重装；配置走运行时。
- 仓库先私有；许可证沿用 Apache-2.0。

## 开发与测试
- Node ≥24（直接运行 `.ts`）。`npm install --prefix skills/tabbot/src --omit=optional` 之后：`npm run check`（tsc）、`npm test`（全部自检）、`npm run verify:pack`（隔离 HOME 真实安装）。
- 在真实 Chrome 里测：`npm run dev:install` 本地安装（会写 `~/.tabbot`、注册 Chrome 的 native messaging host），再在 `chrome://extensions` 加载 `~/.tabbot/src/chrome-extension`，默认就会录制所有站点；`tabbot sites` 看范围。品牌版 Chrome 不支持 `--load-extension`，必须手动加载。
- 用 Claude in Chrome 在专用 tab 里操作页面，产品的轻量层同时记录；它的截图只截页面内容，截不到浏览器界面和横幅。注意它在后台标签页里加载的页面，按设计不会被记录（后台只计数）。
- 自检（`npm test`）会在临时目录里造数据，结束时自己清掉；真实 Chrome 里的测试数据在 `~/.tabbot/journal`。
- 本机的 8766 端口曾被一个无关服务占用；产品不用固定端口，走 Unix socket 和 native messaging。

## 下一步
见 `DESIGN.md` 第 9、10 节：在日常 Chrome 里端到端验证 `act`（先在不重要的页面上试），再补兼容性、写操作确认、页面上的提示和交还入口。

## 隐私提醒
日常 Chrome 里测试时，日志含登录态内容（响应体等），在 `~/.tabbot/journal`；测完用 `tabbot sites exclude <域名>` 排除或 `sites only` 缩小范围，需要时删除该目录。
