# 故障排查

TabBot 完全以原始源码分发：`~/.tabbot` 是 skill 目录的原样镜像（源码 `src/`、开发脚本 `scripts/dev/`、文档），架构见 `ARCHITECTURE.md`，开发约定见 `AGENTS.md`。下面的问题都可以读源码定位，并直接修复。直接改 `~/.tabbot/src` 或 `~/.tabbot/scripts` 是临时修复，下次升级会覆盖；改完可以在 `~/.tabbot/src` 里 `npm install && npm test` 验证。

先运行 `~/.tabbot/bin/tabbot doctor`（加 `--json` 得到机器可读结果），失败项会带修复命令。

## 1. 安装

| 现象 | 处理 |
|---|---|
| Node 版本低于 24 | 用 fnm、nvm、Homebrew 或官方安装升级后重跑 `setup.js` |
| `npm install` 失败 | 看 npm 的报错（网络、权限、registry）；解决后重跑 `setup.js`，它可重复执行 |
| `doctor` 的 `home`、`src`、`deps`、`session`、`native-host`、`launcher` 失败 | 重跑 `node <skill 安装目录>/setup.js`（`npx skills ls -g` 找安装目录） |
| `npx skills add` 失败 | clone 仓库，直接运行 `node <仓库>/skills/tabbot/setup.js`（本地安装，不经过 `skills add`） |
| 找不到 `tabbot` 命令 | 命令是 `~/.tabbot/bin/tabbot`，用绝对路径，或把 `~/.tabbot/bin` 加入 PATH |

## 2. 扩展与连接

| 现象 | 处理 |
|---|---|
| `need-extension`，且从没加载过扩展 | 打开 `chrome://extensions`，开启「开发者模式」，「加载已解压的扩展程序」，选择 `~/.tabbot/src/chrome-extension` |
| `need-extension`，扩展已加载 | 在 `chrome://extensions` 确认 TabBot 开着，点一下它的工具栏图标 |
| `extension-abi` 提示 ABI 不对，或命令报"扩展是旧版本" | 扩展代码太旧（ABI 变了才会出现），在 `chrome://extensions` 里点 TabBot 卡片上的刷新 |
| `user-scripts` 失败，或命令报"允许用户脚本" | 页面脚本由 holder 经 `chrome.userScripts` 下发，开关没打开时录制和 `act` 都不工作。在 `chrome://extensions` 打开 TabBot 的详情页，打开『允许用户脚本』，再点一下扩展图标 |
| `extension-id` 失败 | 重跑 `setup.js` 重写 native host manifest；扩展 ID 由 `manifest.json` 里的 key 固定 |
| `need-chrome` | 启动 Google Chrome |
| 刷新扩展后连不上 | 刷新会断开旧 relay，Chrome 会重新拉起；等几秒，仍不行就重启 Chrome |

## 3. 升级

| 现象 | 处理 |
|---|---|
| 升级后旧 daemon 还在跑 | `setup.js` 会提示；运行 `tabbot daemon restart` |

## 4. 运行

| 现象 | 处理 |
|---|---|
| `act` 或 `replay` 被拒（`no-lease`） | 没有租约或人刚动过。先 `tabbot takeover`；被拒说明人 1.5 秒内有输入，按 `SKILL.md` 先读日志，不要抢回 |
| `snapshot`、`act` 报"页面里没有 TabBot 的脚本" | 页面脚本没装上（开关没打开、页面是 `chrome://` 之类的），或页面是在脚本下发之前打开的：刷新这个页面后再试 |
| 日志里没有某个站点的事件 | 后台标签页只记导航和请求数，不记响应体；先看 `tabbot doctor` 里的 `user-scripts` |
| `replay` 报"原始内容已经不在 holder 的内存里" | holder 重启过或太旧被清掉；在页面上再触发一次这个操作，然后重试 |
| `replay --set` 报"别名已失效" | 别名对照表只在 holder 内存里，holder 重启后就没了；重新取这个请求的最新日志行 |

## 5. 取日志与现场

- 运行时日志：`~/.tabbot/session/log.jsonl`
- daemon 状态：`tabbot doctor --json`，其中 `holder` 项会 ping daemon（含 `build`、`abi`、`userScripts`）
- 进入运行中的 daemon：`kill -USR1 <holder pid>` 用 Node inspector 连入（注意：能看到内存里的 token 真值）
- 仍无法解决：把 `doctor --json` 的输出和日志末尾给用户，说明需要用户做的一件事

## 6. 开发脚本

- `~/.tabbot/scripts/dev/hook-e2e.mjs` 在无头 Chrome 里验证页面脚本（`src/page/`），用法见 `AGENTS.md` 2.3。
- 仓库根目录的 `tools/`（`verify-pack`、`export-payload`）和 `README.md`、`CHANGELOG.md`、`PRIVACY.md` 不分发；需要它们请 clone 仓库。
