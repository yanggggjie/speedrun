# AGENTS

agent 使用 lore 的流程见 `skills/lore/SKILL.md`。本文只规定仓库边界、开发验证、分发发布和运行时实现。

lore 完全以原始源码分发：`skills/lore/` 整个目录（源码、`scripts/dev`、文档）安装后原样镜像到 `~/.lore`，本文在 `~/.lore/AGENTS.md`。文中以仓库为基准的路径，在本机去掉 `skills/lore/` 前缀即可，如 `skills/lore/src` → `~/.lore/src`、`skills/lore/scripts/dev` → `~/.lore/scripts/dev`。目标、角色分工、运行时架构和故障排查都在 `ARCHITECTURE.md`。遇到问题可以直接读源码并修改；下次升级会覆盖 `~/.lore/src` 与 `~/.lore/scripts`。

## 1. 职责边界

### 1.1 分离安装与运行时职责

| 文件 | 职责 |
|---|---|
| `skills/lore/install.md` | 只负责一次性安装与更新，并在结束前确保本机安装正确 |
| `skills/lore/SKILL.md` | 只描述安装后的运行时任务；不提及、不跳转到、也不感知 `install.md` |

运行时 skill 不负责安装、更新或环境修复；相关变更只维护在 `install.md` 和仓库开发约束中。

## 2. 开发与验证

源码位于 `skills/lore/src/`。Node ≥24 通过 strip types 直接运行 `.ts`，不生成编译产物。

### 2.1 本地安装

用户要求“本地安装”“从本地安装”“本地更新”或同义操作时，完整执行 `skills/lore/install.md`（本地安装的安装目录就是仓库里的 `skills/lore`，运行其中的 `setup.js`）。不在本文件重复安装、迁移或验收步骤。

**不使用 dev-install**：已删除 `tools/dev-install.mjs` 和 `npm run dev:install`，不要再按“导出再 `skills add`”的方式本地安装。

### 2.2 检查与测试

Node strip types 不执行类型检查。运行 check 或 test 前，先安装 `skills/lore/src/node_modules`；该目录被 gitignore，不进入 payload。

```bash
npm install --prefix skills/lore/src --omit=optional
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

**不再模拟扩展**：没有假扩展、没有桩 `chrome.*`、没有起 Chrome for Testing 的端到端脚本。改了扩展、页面脚本、agent 窗口、action 运行时之后，用真实的 Chrome 验证。lore 只录 agent 自己的窗口，所以录制要在 learn 窗口里触发（`lore learn new --url …` 拿到句柄，`lore learn <句柄> <操作>`），再读 `~/.lore/learn-windows/<句柄>/` 下的 `timeline.jsonl`、`requests/` 和 `~/.lore/sites/<站点>/endpoints.json`（格式见 `ARCHITECTURE.md` 第 6 节）；Claude in Chrome 只用来在用户窗口里浏览（确认不产生记录），以及开出被 `--url tab号` 引用的页面：

1. `node skills/lore/setup.js` 重装到 `~/.lore`；改了 `background.js`、`manifest.json`、`page/` 下的页面脚本要在 `chrome://extensions` 里刷新 lore；只改了 daemon、CLI、`src/commands/`、`src/learn/`、`src/run/`、`src/browser/`、`src/record/` 的 `lore daemon restart` 即可。`lore doctor` 的 `extension-abi` 提示扩展是否太旧。
2. 只录 agent 窗口：用 Claude in Chrome 在用户窗口里浏览、点击几个站点，`~/.lore` 下不产生任何新行和新文件。
3. 走一遍 learn 窗口，至少在三个站点上试：一个公共站点、一个 GraphQL 站点、一个公司内部多子域站点：
   - `lore learn new --url <链接|tab 号> --description "…"`（`tab 号` 用 `lore tabs` 按标题对出来）：第一行 `ok`，拿到句柄 `<站点>-<时间>`，输出里有窗口目录、learn 指引的路径（第一次或有更新时附全文，写在 `~/.lore/learn-guide.md`）、起点的观察结果。
   - **观察**：多步操作（`screenshot` 加坐标 `click` / `type` / `key` / `scroll`，都带 `--description`），每步附带的观察和实际操作相符，输出里的文件名在窗口目录里都找得到、是语义化的（`requests/<编号>-<方法>-<endpoint 名>.json`）；等几秒单独 `observe`，拿到晚到的请求，且和上一次不重复；第二步之后的观察不再列 `/me` 这类前面出现过的 endpoint，`observe --all` 列全部。页面跳到别的站点时写明站点。
   - **请求头和在窗口里 run**：观察里带非浏览器头的请求有一行「请求头」（值怎么变、页面里的位置），和实际相符、没有真值；action 只写 `request({ url, method, json })`，`lore learn <句柄> run --action <名> --参数 值` 在当前页面跑通、换参数也跑通，不变成 verified；run 窗口里同样跑通（头从这次窗口里页面发过的请求抄）；故意去掉 `goto` 让它被拒，失败输出写清抄了什么、没抄什么。
   - **写请求**：点赞这类轻量写操作真的发出（站点上看得到结果）；带 `@write` 的 action 在 learn 窗口里 `run` 直接发，输出的「已发出的 write 请求」和实际一致（查询用的 POST 不算）。
   - **一个窗口学多个 action**：在同一个窗口里写两个 action（draft），`run --compose-code …` 新开 run 窗口、跑完窗口消失、`run-windows/<名字>/` 有日志和 meta、两个 draft 变成 verified、`endpoints.json` 没有多出 run 窗口的请求；多行 `@endpoint` 漏了前置请求时不变成 verified 并说明。
   - **持久**：`learn <句柄> close` 后、`lore daemon restart` 后，对同一个句柄 `screenshot` / `click`：窗口从上次的 URL 重新打开，日志接着写进同一个目录，游标接着上次；新句柄不重名。learn 窗口空闲 30 分钟自动关。
   - **run 窗口**：同一个站点连跑两次 `run`，第二次不沿用第一次的页面；两个 `run` 同时跑，各开各的窗口，互不排队。
   - **description 与 compose**：操作的 `--description` 进了时间线，并出现在 endpoint 的 `endpoints.json` 的 `descriptions` 里；compose 文件出现在 `~/.lore/compose/`，`rg` 能用 description 里的词命中，`lore run --compose <名>` 带别的参数再跑一次，`@description` 多一句。
   - **@write 和 @start**：带 `@start` 的 action 在 run 窗口里先打开那个页面；带 `@write` 的 draft 在 `lore status` 里标出；学出来的 action 里调用 `lore.action` 被拒。
   - **SDK、参数、helpers**：`export default async () => …` 加 `goto(url)`、`request({…})` 写法的 action 能跑；`@param n:number` 收到的是数字；`~/.lore/helpers/` 里的函数被 action `import` 后能跑，`lore daemon restart` 后还在；`--compose` 写哈希前几位能跑。
4. 速度问题要用真实站点量（有统计脚本、被墙资源的页面最能暴露"等页面加载完"这类问题）：量 `lore learn <句柄> open`、`lore run` 的耗时（新开 run 窗口的代价，尤其是 daemon 刚重启、request 要等页面先发请求才能抄头时）。

日常 Chrome 里测试时日志含登录态内容，在 `~/.lore/learn-windows`、`~/.lore/run-windows`；测完删除测试用的窗口目录。

### 2.4 图标

图标源文件是 `skills/lore/scripts/dev/icons/icon.svg`（48、128px）和 `icon-small.svg`（16、32px，线条更粗），改动后运行 `node skills/lore/scripts/dev/make-icons.mjs` 重新生成 PNG（需要本机 Chrome），再在 `chrome://extensions` 里刷新扩展。

### 2.5 命名与约定

- **任何地方都写小写 `lore`**：命令、skill 名和触发词、数据目录 `~/.lore`、native host `com.lore.connect`、产品名、文档正文、扩展显示名、提示文案、代码里的名字，不写 `lore`。
- GitHub 仓库 `yanggggjie/lore`（私有，Apache-2.0；先后叫过 TabBot、Deft、Silt，GitHub 会把旧地址转到新地址）。部分代码最初来自 yodo，历史已清空，与 yodo 仓库无关联。
- **不写兼容代码**：lore 还没对外发布，没有要兼容的旧版本。改了命令、参数、文件格式、SDK 写法，就直接删掉旧的，不留迁移、不留「已经去掉」的专门报错；本机 `~/.lore` 里的 action、compose 一起改成新格式。
- 本机的 8766 端口曾被一个无关服务占用；产品不用固定端口，走 Unix socket 和 native messaging。

## 3. 分发与发布

### 3.1 Skill payload

`skills/lore/` 是分发 payload：

```text
skills/lore/
├── src/                     运行时（daemon、commands、learn、run、browser、record、cli、chrome-extension 含页面脚本）+ 自检 + package.json
├── scripts/dev/             图标生成
├── setup.js  SKILL.md  install.md  LICENSE
├── AGENTS.md                ← 仓库根目录的 AGENTS.md 是指向它的软链接
└── ARCHITECTURE.md          目标、角色、架构、排障
```

`setup.js` 把整个目录镜像到 `~/.lore`（只排除 `node_modules`、`.DS_Store`），然后在 `~/.lore/src` 里 `npm install`。规则：`skills/lore/` 里的都分发，仓库根目录的都只在仓库里：`tools/`（`verify-pack`、`export-payload`，依赖 git 和仓库根）、根 `package.json`（只放命令入口，没有版本号）、`README.md`、`CHANGELOG.md`、`PRIVACY.md`。文档只在 `skills/lore/` 里维护一份，不要在别处复制。`verify:pack` 先用 `git ls-files` 导出文件再安装，保证在线安装的内容完整。

不要将 `node_modules` 提交到 git 或放入 payload。用户或 agent 运行 `setup.js` 时，才在 `~/.lore/src` 本地执行 `npm install`。

### 3.2 发布规则

- **安装**：对外安装与更新以 `skills/lore/install.md` 为准。
- **开发**：可以在任意 branch 开发，不要求同步维护发布文档。
- **发布**：不发布 npm 包，不创建 GitHub Release。release commit 进入 `main` 即完成发布。
- **回溯**：需要可回溯版本时创建 `vX.Y.Z` tag。

### 3.3 发布分支

用户明确要求“发布分支”时，创建 `release/vX.Y.Z`，不修改 `main`，也不 push。然后：

1. 把本次版本号改成一致：`skills/lore/src/package.json`，以及 `skills/lore/src/package-lock.json` 里 lore 包自己的 `version`（两处）。根 `package.json` 没有版本号。
2. 把本次发布里用户能感知的变化写入 `CHANGELOG.md`，版本号与上面相同。

完成后停下来，等用户测试和检查。用户自己 push。

### 3.4 发布到 `main`

用户明确要求“发布到 main”时，将发布分支相对 `main` 的提交压缩为一个提交，合入 `main`。

未收到“发布到 main”时，不得修改或 push `main`。

## 4. 运行时架构

运行时架构（命令入口、relay 与 daemon、扩展、窗口、录制、存储与安装）见同目录的 `ARCHITECTURE.md`。
