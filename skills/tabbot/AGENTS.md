# AGENTS

agent 使用 TabBot 的流程见 `skills/tabbot/SKILL.md`。本文只规定仓库边界、开发验证、分发发布和运行时实现。

TabBot 完全以原始源码分发：`skills/tabbot/` 整个目录（源码、`scripts/dev`、文档）安装后原样镜像到 `~/.tabbot`，本文在 `~/.tabbot/AGENTS.md`。文中以仓库为基准的路径，在本机去掉 `skills/tabbot/` 前缀即可，如 `skills/tabbot/src` → `~/.tabbot/src`、`skills/tabbot/scripts/dev` → `~/.tabbot/scripts/dev`。运行时架构见 `ARCHITECTURE.md`，故障排查见 `TROUBLESHOOTING.md`。遇到问题可以直接读源码并修改；下次升级会覆盖 `~/.tabbot/src` 与 `~/.tabbot/scripts`。

## 1. 职责边界

### 1.1 分离安装与运行时职责

| 文件 | 职责 |
|---|---|
| `skills/tabbot/install.md` | 只负责一次性安装与更新，并在结束前确保本机安装正确 |
| `skills/tabbot/SKILL.md` | 只描述安装后的运行时任务；不提及、不跳转到、也不感知 `install.md` |

运行时 skill 不负责安装、更新或环境修复；相关变更只维护在 `install.md` 和仓库开发约束中。

## 2. 开发与验证

源码位于 `skills/tabbot/src/`。Node ≥24 通过 strip types 直接运行 `.ts`，不生成编译产物。

### 2.1 本地安装

用户要求“本地安装”“从本地安装”“本地更新”或同义操作时，完整执行 `skills/tabbot/install.md`（本地安装的安装目录就是仓库里的 `skills/tabbot`，运行其中的 `setup.js`）。不在本文件重复安装、迁移或验收步骤。

**不使用 dev-install**：已删除 `tools/dev-install.mjs` 和 `npm run dev:install`，不要再按“导出再 `skills add`”的方式本地安装。

### 2.1.1 调试触发：用 Claude in Chrome

在真实 Chrome 里调试时，用 Claude in Chrome 触发页面操作（导航、点击、滚动、输入），TabBot 的常驻录制同时记录，再用 `tabbot log`、`tabbot snapshot` 等命令检查结果。流程：本地安装 → 在 `chrome://extensions` 加载或刷新 `~/.tabbot/src/chrome-extension` → 用 Claude in Chrome 在测试 tab 里操作 → 读日志。注意：Claude in Chrome 发出的输入 `isTrusted` 为真，会被记成 `human`，并撤销租约，所以它只用来触发和制造页面行为，不用来验证租约；验证租约和 `act` 用 `tabbot takeover` / `act` 本身。它在后台标签页里加载的页面按设计不会被完整记录（后台只计数）。

### 2.2 检查与测试

Node strip types 不执行类型检查。运行 check 或 test 前，先安装 `skills/tabbot/src/node_modules`；该目录被 gitignore，不进入 payload。

```bash
npm install --prefix skills/tabbot/src --omit=optional
npm run check
npm test
npm run verify:pack
```

| 命令 | 作用 |
|---|---|
| `npm run check` | 运行 `tsc --noEmit` |
| `npm test` | 按文件名顺序逐个运行 `*.selfcheck.ts` |
| `npm run verify:pack` | 使用隔离 HOME 执行真实的 `skills add`、setup 和 doctor |

多文件改动时，改完全部文件再一次性跑 `check`/`test`，不要逐文件验证。这几个命令都不是瞬间返回：`check` 要过一遍 `npx` 解析，`test` 里有真实的 `sleep`/超时等待，`verify:pack` 是真实的 `npm install`；跑一次和跑五次的差距是实打实的时间。

### 2.3 真实 Chrome 里的验证

页面脚本（`skills/tabbot/src/page/`）在真实页面里的行为，用 `scripts/dev/hook-e2e.mjs` 在无头 Chrome 里验证：录制的请求和主文档、执行的点击 / 填写 / 选择 / 勾选 / 按键 / 滚动、等页面稳定、真人动手时中止、重放（需要本机 Chrome，不在 `npm test` 里）。改了页面脚本之后跑一次：

```bash
node skills/tabbot/scripts/dev/hook-e2e.mjs
```

扩展本身（`background.js`、`manifest.json`）只在 ABI 或权限变化时才需要在 `chrome://extensions` 里刷新；页面脚本由 holder 下发，改完 `tabbot daemon restart` 即可（holder 在扩展下次连接时重新注册）。`tabbot doctor` 的 `extension-abi`、`user-scripts` 会提示状态。

日常 Chrome 里测试时日志含登录态内容，在 `~/.tabbot/journal`；测完删除该目录。

### 2.4 命名与约定

- **要书写、打字、匹配的地方一律小写 `tabbot`**（命令、skill 名和触发词、数据目录 `~/.tabbot`、native host `com.tabbot.connect`）；**给用户看的地方写 `TabBot`**（产品名、文档正文、扩展显示名、提示文案）。
- GitHub 仓库 `yanggggjie/TabBot`（私有，Apache-2.0）。部分代码最初来自 yodo，历史已清空，与 yodo 仓库无关联。
- 本机的 8766 端口曾被一个无关服务占用；产品不用固定端口，走 Unix socket 和 native messaging。

## 3. 分发与发布

### 3.1 Skill payload

`skills/tabbot/` 是分发 payload：

```text
skills/tabbot/
├── src/                     运行时（holder、journal、cli、page 页面脚本、chrome-extension）+ 自检 + package.json
├── scripts/dev/             hook-e2e.mjs（真实 Chrome 验证）、图标生成
├── setup.js  SKILL.md  install.md  LICENSE
├── AGENTS.md                ← 仓库根目录的 AGENTS.md 是指向它的软链接
├── ARCHITECTURE.md
└── TROUBLESHOOTING.md
```

`setup.js` 把整个目录镜像到 `~/.tabbot`（只排除 `node_modules`、`.DS_Store`），然后在 `~/.tabbot/src` 里 `npm install`。规则：`skills/tabbot/` 里的都分发，仓库根目录的都只在仓库里：`tools/`（`verify-pack`、`export-payload`，依赖 git 和仓库根）、根 `package.json`（只放命令入口，没有版本号）、`README.md`、`CHANGELOG.md`、`PRIVACY.md`。文档只在 `skills/tabbot/` 里维护一份，不要在别处复制。`verify:pack` 先用 `git ls-files` 导出文件再安装，保证在线安装的内容完整。

不要将 `node_modules` 提交到 git 或放入 payload。用户或 agent 运行 `setup.js` 时，才在 `~/.tabbot/src` 本地执行 `npm install`。

### 3.2 发布规则

- **安装**：对外安装与更新以 `skills/tabbot/install.md` 为准。
- **开发**：可以在任意 branch 开发，不要求同步维护发布文档。
- **发布**：不发布 npm 包，不创建 GitHub Release。release commit 进入 `main` 即完成发布。
- **回溯**：需要可回溯版本时创建 `vX.Y.Z` tag。

### 3.3 发布分支

用户明确要求“发布分支”时，创建 `release/vX.Y.Z`，不修改 `main`，也不 push。然后：

1. 把本次版本号改成一致：`skills/tabbot/src/package.json`，以及 `skills/tabbot/src/package-lock.json` 里 TabBot 包自己的 `version`（两处）。根 `package.json` 没有版本号。
2. 把本次发布里用户能感知的变化写入 `CHANGELOG.md`，版本号与上面相同。

完成后停下来，等用户测试和检查。用户自己 push。

### 3.4 发布到 `main`

用户明确要求“发布到 main”时，将发布分支相对 `main` 的提交压缩为一个提交，合入 `main`。

未收到“发布到 main”时，不得修改或 push `main`。

## 4. 运行时架构

运行时架构（命令入口、relay 与 holder、扩展、窗口、录制、存储与安装）见同目录的 `ARCHITECTURE.md`。
