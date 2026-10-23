# 项目上下文（换机器继续用）

## 这是什么
TwoCursor：人和 agent 共用同一个 Chrome。常驻录制用户点名的站点，agent 读日志了解现场；人可随时插手。设计见 [DESIGN.md](DESIGN.md)，实验记录见 [EXPERIMENTS.md](EXPERIMENTS.md)。

## 仓库
- `yanggggjie/TwoCursor`（私有，Apache-2.0）。代码起点是 yodo 的源码，已重命名为 twocursor，历史已清空，与 yodo 仓库无关联。
- 产品代码在 `skills/twocursor/`（运行时、扩展、文档），开发约束、检查和测试、分发见 `skills/twocursor/AGENTS.md`，运行时架构见 `skills/twocursor/ARCHITECTURE.md`（第 7 节是常驻录制）。
- 实验代码（原 `lab/`）已删除，需要时 `git log --stat -- lab`。

## 已定决策
- 接受"正在调试此浏览器"横幅，需要时直接用 `chrome.debugger`；轻量层常驻（不弹横幅），重量层按需。
- 只做 skill 加 CLI，不做 MCP。
- 前台阻塞的 `wait`，不依赖 harness 的后台通知。
- 只录用户点名的站点、只录前台页面（agent 的 tab 例外）；硬上限 1GB。
- 录制时脱敏：agent 看别名，原值留本地。
- 判不准就判"人"。
- 实验用的 Chrome 扩展一旦让用户加载过，就保持路径和身份不变，不让用户反复重装；配置走运行时。
- 仓库先私有；许可证沿用 Apache-2.0。

## 开发与测试
- Node ≥24（直接运行 `.ts`）。`npm install --prefix skills/twocursor/src --omit=optional` 之后：`npm run check`（tsc）、`npm test`（全部自检）、`npm run verify:pack`（隔离 HOME 真实安装）。
- 在真实 Chrome 里测：`npm run dev:install` 本地安装（会写 `~/.twocursor`、注册 Chrome 的 native messaging host），再在 `chrome://extensions` 加载 `~/.twocursor/src/chrome-extension`，`twocursor sites add <域名>` 点名站点。品牌版 Chrome 不支持 `--load-extension`，必须手动加载。
- 用 Claude in Chrome 在专用 tab 里操作页面，产品的轻量层同时记录；它的截图只截页面内容，截不到浏览器界面和横幅。
- 本机的 8766 端口曾被一个无关服务占用；产品不用固定端口，走 Unix socket 和 native messaging。

## 下一步
见 `DESIGN.md` 第 9、10 节：先在日常 Chrome 里端到端验证第一阶段（`hook.js` 兼容性、体积统计），再做第二阶段（先验证构造法的两个假设）。

## 隐私提醒
日常 Chrome 里测试时，日志含登录态内容（响应体等），在 `~/.twocursor/journal`；测完用 `twocursor sites rm` 停止录制，需要时删除该目录。
