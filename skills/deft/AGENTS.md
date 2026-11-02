# AGENTS

agent 使用 Deft 的流程见 `skills/deft/SKILL.md`。本文只规定仓库边界、开发验证、分发发布和运行时实现。

Deft 完全以原始源码分发：`skills/deft/` 整个目录（源码、`scripts/dev`、文档）安装后原样镜像到 `~/.deft`，本文在 `~/.deft/AGENTS.md`。文中以仓库为基准的路径，在本机去掉 `skills/deft/` 前缀即可，如 `skills/deft/src` → `~/.deft/src`、`skills/deft/scripts/dev` → `~/.deft/scripts/dev`。目标、角色分工、运行时架构和故障排查都在 `ARCHITECTURE.md`。遇到问题可以直接读源码并修改；下次升级会覆盖 `~/.deft/src` 与 `~/.deft/scripts`。

## 1. 职责边界

### 1.1 分离安装与运行时职责

| 文件 | 职责 |
|---|---|
| `skills/deft/install.md` | 只负责一次性安装与更新，并在结束前确保本机安装正确 |
| `skills/deft/SKILL.md` | 只描述安装后的运行时任务；不提及、不跳转到、也不感知 `install.md` |

运行时 skill 不负责安装、更新或环境修复；相关变更只维护在 `install.md` 和仓库开发约束中。

## 2. 开发与验证

源码位于 `skills/deft/src/`。Node ≥24 通过 strip types 直接运行 `.ts`，不生成编译产物。

### 2.1 本地安装

用户要求“本地安装”“从本地安装”“本地更新”或同义操作时，完整执行 `skills/deft/install.md`（本地安装的安装目录就是仓库里的 `skills/deft`，运行其中的 `setup.js`）。不在本文件重复安装、迁移或验收步骤。

**不使用 dev-install**：已删除 `tools/dev-install.mjs` 和 `npm run dev:install`，不要再按“导出再 `skills add`”的方式本地安装。

### 2.1.1 调试触发：用 Claude in Chrome

Deft 只录 agent 自己的窗口（学习窗口和 run 窗口），Claude in Chrome 在用户窗口里的操作不会被录。在真实 Chrome 里调试录制：`deft learn --url <链接|tab 号> --description "…"` 打开学习窗口拿到句柄，用 `deft learn <句柄> <操作>` 在学习窗口里操作，再读 `~/.deft/learn-windows/<句柄>/` 下的文件检查结果（`timeline.jsonl`、`requests/`，以及 `~/.deft/sites/<站点>/endpoints.json`，格式见 `SKILL.md` 第 3 节）。Claude in Chrome 用来在用户窗口里浏览，确认这些操作**不**产生任何记录，以及开出被 `--url tab号` 引用的页面。流程：本地安装 → 在 `chrome://extensions` 加载或刷新 `~/.deft/src/chrome-extension` → 打开学习窗口操作 → 读日志。

### 2.2 检查与测试

Node strip types 不执行类型检查。运行 check 或 test 前，先安装 `skills/deft/src/node_modules`；该目录被 gitignore，不进入 payload。

```bash
npm install --prefix skills/deft/src --omit=optional
npm run check
npm test
npm run verify:pack
```

| 命令 | 作用 | 何时跑 |
|---|---|---|
| `npm run check` | `tsc --noEmit` | 每次改完 |
| `npm test` | 逐个运行 `*.selfcheck.*`（几秒，不依赖 Chrome） | 每次改完 |
| `npm run verify:pack` | 隔离 HOME 下真实的 `skills add`、setup、doctor（真实 `npm install`，慢） | 只在发布前 |

**自检只留最关键的，不模拟扩展**：一个测试必须守住一个“坏了就会静默出错或泄密”的点，否则不留。多文件改动时，改完全部文件再一次性跑 `check`/`test`，不要逐文件验证。

### 2.3 真实 Chrome 里的验证：用 Claude in Chrome

**不再模拟扩展**：没有假扩展、没有桩 `chrome.*`、没有起 Chrome for Testing 的端到端脚本。改了扩展、页面脚本、agent 窗口、action 运行时之后，用真实的 Chrome 验证：

1. `node skills/deft/setup.js` 重装到 `~/.deft`；改了 `background.js`、`manifest.json`、`page/` 下的页面脚本要在 `chrome://extensions` 里刷新 Deft；只改了 holder、CLI、`src/run/` 的 `deft daemon restart` 即可。`deft doctor` 的 `extension-abi` 提示扩展是否太旧。
2. 只录 agent 窗口：用 Claude in Chrome 在用户窗口里浏览、点击几个站点，`~/.deft` 下不产生任何新行和新文件。
3. 走一遍学习窗口，至少在三个站点上试：一个公共站点、一个 GraphQL 站点、一个公司内部多子域站点：
   - `deft learn --url <链接|tab 号> --description "…"`（`tab 号` 用 `deft tabs` 按标题对出来）：拿到句柄 `<站点>-<时间>`，输出里有窗口目录、学习指引（拆分和通用操作、粒度、观察、写请求判断、文件位置、做法齐全）、起点的观察结果。
   - **观察**：多步操作（`screenshot` 加坐标 `click` / `type` / `key` / `scroll`，都带 `--description`），每步附带的观察和实际操作相符，输出里的文件名在窗口目录里都找得到、是语义化的（`requests/<编号>-<方法>-<接口名>.json`）；等几秒单独 `observe`，拿到晚到的请求，且和上一次不重复；`observe --since` 重看不推进游标。页面跳到别的站点时写明站点。
   - **重放**：`replay <编号> --set …` 在当前页面发出（请求文件里 Referer、页面是当前页面）；当前页面不同源时说明在另开的标签页里发。
   - **写请求**：点赞这类轻量写操作真的发出（站点上看得到结果）；`replay` 非 GET 不带 `--yes` 被拒。
   - **一个窗口学多个 action**：在同一个窗口里写两个 action（草稿），`run --compose … --name <名>` 新开 run 窗口、跑完窗口消失、`run-windows/<名字>/` 有日志和 meta、两个草稿晋升 verified、`endpoints.json` 没有多出 run 窗口的请求；多行 `@endpoint` 漏了前置请求时不晋升并说明。`run --dry` 不真发、不晋升。
   - **持久**：`learn <句柄> close` 后、`deft daemon restart` 后，对同一个句柄 `screenshot` / `click`：窗口从上次的 URL 重新打开，日志接着写进同一个目录，游标接着上次；新句柄不重名。学习窗口空闲 30 分钟自动关。
   - **run 窗口**：同一个站点连跑两次 `run`，第二次不沿用第一次的页面；两个 `run` 同时跑，各开各的窗口，互不排队。
   - **业务知识与组合**：操作的 `--description` 进了时间线，并出现在接口的 `endpoints.json` 的 `descriptions` 里；组合文件出现在对应站点的 `actions/`（跨站点在 `~/.deft/compose/`），`rg` 能用 description 里的词命中，`deft run <名>` 带别的参数再跑一次，`@description` 多一句。
   - **布局升级**：旧版本数据（`sites/*/log/`、`~/.deft/actions/`）升级后旧日志已删、`descriptions` 还在、空站点目录没了、组合在 `compose/` 里能按名字 run；再重启 holder 不重复做。
   - 可选：把 `src/hooks/stop-receipt.mjs` 注册成 Stop hook，确认跑过 `deft run` 却没引用回执、用过 `learn` 却没有任何回执、停在 `deft.ask` 却没恢复时会被拦一次。
4. 速度问题要用真实站点量（有统计脚本、被墙资源的页面最能暴露"等页面加载完"这类问题）：量 `deft learn <句柄> open`、`deft run` 的耗时（新开 run 窗口的代价，尤其是 holder 刚重启、需要预热首页时）。

日常 Chrome 里测试时日志含登录态内容，在 `~/.deft/learn-windows`、`~/.deft/run-windows`；测完删除测试用的窗口目录。

### 2.4 命名与约定

- **要书写、打字、匹配的地方一律小写 `deft`**（命令、skill 名和触发词、数据目录 `~/.deft`、native host `com.deft.connect`）；**给用户看的地方写 `Deft`**（产品名、文档正文、扩展显示名、提示文案）。
- GitHub 仓库 `yanggggjie/Deft`（私有，Apache-2.0；改名前叫 TabBot，GitHub 会把旧地址转到新地址）。部分代码最初来自 yodo，历史已清空，与 yodo 仓库无关联。
- 本机的 8766 端口曾被一个无关服务占用；产品不用固定端口，走 Unix socket 和 native messaging。

## 3. 分发与发布

### 3.1 Skill payload

`skills/deft/` 是分发 payload：

```text
skills/deft/
├── src/                     运行时（holder、journal、run、cli、chrome-extension 含页面脚本）+ 自检 + package.json
├── scripts/dev/             图标生成
├── setup.js  SKILL.md  install.md  LICENSE
├── AGENTS.md                ← 仓库根目录的 AGENTS.md 是指向它的软链接
└── ARCHITECTURE.md          目标、角色、架构、排障
```

`setup.js` 把整个目录镜像到 `~/.deft`（只排除 `node_modules`、`.DS_Store`），然后在 `~/.deft/src` 里 `npm install`。规则：`skills/deft/` 里的都分发，仓库根目录的都只在仓库里：`tools/`（`verify-pack`、`export-payload`，依赖 git 和仓库根）、根 `package.json`（只放命令入口，没有版本号）、`README.md`、`CHANGELOG.md`、`PRIVACY.md`。文档只在 `skills/deft/` 里维护一份，不要在别处复制。`verify:pack` 先用 `git ls-files` 导出文件再安装，保证在线安装的内容完整。

不要将 `node_modules` 提交到 git 或放入 payload。用户或 agent 运行 `setup.js` 时，才在 `~/.deft/src` 本地执行 `npm install`。

### 3.2 发布规则

- **安装**：对外安装与更新以 `skills/deft/install.md` 为准。
- **开发**：可以在任意 branch 开发，不要求同步维护发布文档。
- **发布**：不发布 npm 包，不创建 GitHub Release。release commit 进入 `main` 即完成发布。
- **回溯**：需要可回溯版本时创建 `vX.Y.Z` tag。

### 3.3 发布分支

用户明确要求“发布分支”时，创建 `release/vX.Y.Z`，不修改 `main`，也不 push。然后：

1. 把本次版本号改成一致：`skills/deft/src/package.json`，以及 `skills/deft/src/package-lock.json` 里 Deft 包自己的 `version`（两处）。根 `package.json` 没有版本号。
2. 把本次发布里用户能感知的变化写入 `CHANGELOG.md`，版本号与上面相同。

完成后停下来，等用户测试和检查。用户自己 push。

### 3.4 发布到 `main`

用户明确要求“发布到 main”时，将发布分支相对 `main` 的提交压缩为一个提交，合入 `main`。

未收到“发布到 main”时，不得修改或 push `main`。

## 4. 运行时架构

运行时架构（命令入口、relay 与 holder、扩展、窗口、录制、存储与安装）见同目录的 `ARCHITECTURE.md`。
