# AGENTS

agent 使用 speedrun 的流程见 `skills/spr/SKILL.md`。本文只规定仓库边界、开发验证、分发发布和运行时实现。

speedrun 完全以原始源码分发：`skills/spr/` 整个目录（源码、文档）安装后原样镜像到 `~/.speedrun`，本文在 `~/.speedrun/AGENTS.md`。文中以仓库为基准的路径，在本机去掉 `skills/spr/` 前缀即可，如 `skills/spr/src` → `~/.speedrun/src`。目标、角色分工、运行时架构和故障排查都在 `ARCHITECTURE.md`。遇到问题可以直接读源码并修改；下次升级会覆盖 `~/.speedrun/src`。

## 1. 职责边界

### 1.1 分离安装与运行时职责

| 文件 | 职责 |
|---|---|
| `skills/spr/install.md` | 只负责一次性安装与更新，并在结束前确保本机安装正确 |
| `skills/spr/SKILL.md` | 只描述安装后的运行时任务；不提及、不跳转到、也不感知 `install.md` |

运行时 skill 不负责安装、更新或环境修复；相关变更只维护在 `install.md` 和仓库开发约束中。

## 2. 开发与验证

源码位于 `skills/spr/src/`。Node ≥24 通过 strip types 直接运行 `.ts`，不生成编译产物。

### 2.1 本地安装

用户要求“本地安装”“从本地安装”“本地更新”或同义操作时，完整执行 `skills/spr/install.md`（本地安装的安装目录就是仓库里的 `skills/spr`，运行其中的 `setup.js`）。不在本文件重复安装、迁移或验收步骤。

**不使用 dev-install**：已删除 `tools/dev-install.mjs` 和 `npm run dev:install`，不要再按“导出再 `skills add`”的方式本地安装。

### 2.2 检查与测试

Node strip types 不执行类型检查。运行 check 或 test 前，先安装 `skills/spr/src/node_modules`；该目录被 gitignore，不进入 payload。

```bash
npm install --prefix skills/spr/src --omit=optional
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

**不再模拟扩展**：没有假扩展、没有桩 `chrome.*`、没有起 Chrome for Testing 的端到端脚本。改了扩展、页面脚本、speedrun 窗口（标签组）、action 运行时之后，用真实的 Chrome 验证。speedrun 只录自己标签组里的标签页，所以录制要在 debug 窗口里触发（先写好 compose，`spr debug <compose> navigate <网址>` 打开，`spr debug <compose> <工具>` 操作），再读 `~/.speedrun/debug-windows/<id>/` 下的 `timeline.jsonl`、`requests/` 和 `~/.speedrun/action/<站点>/endpoints.json`（格式见 `ARCHITECTURE.md` 第 6 节）；Claude in Chrome 只用来在 speedrun 组外浏览（确认不产生记录），以及开出被 `--url tab号` 引用的页面。

**不抢前台是硬要求**：下面每一项都要同时记录前台应用（`lsappinfo info -only name $(lsappinfo front)`）和用户选中的标签页（`spr tabs` 里「前台」的那个），每 0.2 秒一次、只记变化；测试期间请用户待在 Chrome 以外的应用、不碰 Chrome。speedrun 操作期间这两样都不能变，也不能出现新窗口。

1. `node skills/spr/setup.js` 重装到 `~/.speedrun`：daemon 换成新代码；扩展（ABI ≥ 13）下一次握手发现自己不是磁盘上这一版，会自动从磁盘重新加载（不用去 `chrome://extensions` 点），跑一次 `spr doctor` 或任何要扩展的命令就会触发。只有第一次加载要在 `chrome://extensions` 里手动操作。`spr doctor` 的 `extension-abi` 提示扩展是否太旧。
2. 只录 speedrun 组里的标签页：用 Claude in Chrome 在组外浏览、点击几个站点（包括点 `target=_blank` 链接），`~/.speedrun` 下不产生任何新行和新文件，链接照常在新标签页打开（拦截只在 speedrun 的标签页里）。
3. 走一遍 debug 窗口，至少在三个站点上试：一个公共站点、一个 GraphQL 站点、一个公司内部多子域站点：
   - 先写好 compose，`spr debug <compose> navigate <链接|tab 号>`（`tab 号` 用 `spr tabs` 按标题对出来）：第一行 `ok`，输出里有窗口目录、debug 指引的路径（第一次或有更新时附全文，写在 `~/.speedrun/debug-guide.md`）、起点的观察结果。compose 不存在、写成 action 名都是用法错误。
   - **看结构**：`find "<查询>"` 找得到目标、带 ref 和定位；`read_page --filter interactive` 的 `role "name"` 和页面相符，`--ref` 只看一块；全文存进 `pages/<编号>-a11y.txt`；`get_page_text` 取到正文。三者不计操作次数。
   - **观察**：多步操作（`computer left_click --ref` / `form_input` / `computer type` / `key` / `scroll`），每步附带的观察和实际操作相符（「稳定：」写了等了多久），输出里的文件名在窗口目录里都找得到、是语义化的（`requests/<编号>-<方法>-<endpoint 名>.json`）；`computer wait 2` 拿到晚到的请求，且和上一次不重复；第二步之后的观察不再在「请求」里列前面出现过的 endpoint，改在「重复」里写第几次、上次的编号，没有建议文字。页面跳到别的站点时写明站点。
   - **定位能回放**：每个用 ref 的操作输出的「定位：」，在 run 窗口的 action 里用同名 SDK 函数能找回同一个元素（`read_page` 显示的名字和回放的匹配是同一套算法）。
   - **标签组和不抢前台**：第一次 `navigate` 后用户窗口里出现一个折叠的、标题是 `speedrun` 的蓝色组，没有新窗口；点 `target=_blank` 链接、cmd+点击、中键点击、`window.open(url)`、`window.open()` 后设地址、`target=_blank` 表单：都不抢前台，新标签页进同一个组并被录，观察里有「新标签页：页面打开了…」；带窗口参数的 `window.open` 照常弹出；用户把一个标签页拖进组后被录，拖出去后不录；组闲置 20 秒后「正在调试此浏览器」的横幅消失（请用户看一眼），再操作照常；懒加载（滚动后才发的请求，如 IT之家评论）在后台组里照常触发。
   - **CDP 输入**：speedrun 的标签页从不被选中，点击、输入、滚动照样生效；截图不把标签页切到前台；在 speedrun 的标签页里打开 DevTools 后操作报「连不上这个标签页的调试接口」，关掉后恢复；点掉「正在调试此浏览器」提示条后下一次操作自动重新附着；严格 CSP 的页面上 `evaluate` 能跑。
   - **跨站和疑似埋点**：页面调另一个注册域名的接口（如 hn.algolia.com 调 `*.algolia.net`），请求文件里有响应体、`waitRequest` 拿得到；按路径规则猜的埋点在观察里折叠成「可能是埋点」，请求文件和响应体照常存；命中广告规则的不存，`bodyOmitted` 是 `noise`。
   - **查询参数**：key 在地址查询参数里、值在页面存储里的请求，观察里有一行「查询参数」（名字和来源，没有值）；`request` 用 `authQuery` 现读拼进地址能跑通，`run-windows/` 的请求文件里这个值是别名。
   - **请求头**：观察里带非浏览器头的请求有一行「请求头」（值怎么变、页面里的位置），和实际相符、没有真值；action 只写 `request({ url, method, json })`，写一个调用它的 compose，`spr run` 跑通、换参数也跑通（头从这次窗口里页面发过的请求抄）；故意去掉 `navigate` 让它被拒，失败输出写清抄了什么、没抄什么。
   - **写请求**：点赞这类轻量写操作真的发出（站点上看得到结果）；带 `@write` 的 action 在 `spr run` 里直接发，输出的「已发出的非 GET 请求」和实际一致；观察里的请求行没有 `write` 前缀。
   - **工具对齐和目标行**：`computer` 的 13 个 action 都能用，坐标和 `--ref` 两种写法都行（`zoom` 的图只有那块、`hover` 出悬停菜单、`left_click_drag` 拖得动、`type` 时页面收到按键事件、`key "Enter"` 能提交表单、`key "cmd+a"` 能全选）；`form_input` 填文本框、选下拉、勾复选框，填完核对；`navigate back` 能后退；每条成功输出的末行是 `目标：spr run <compose>`，缺 action 时列出还缺哪些，带 compose 里的调用参数（`zhihu-vote({ id })`）。
   - **一个窗口写多个 action**：在同一个窗口里写两个 action（draft），写一个调用这两个 action 的 compose（`~/.speedrun/compose/<名>.js`），`spr run <名>` 新开 run 窗口、跑完窗口消失、`run-windows/<名字>/` 有日志和 meta、两个 draft 变成 verified、`endpoints.json` 没有多出 run 窗口的请求；run 成功和失败后 debug 窗口都还在，失败后 `screenshots/failure.*` 和日志都在。
   - **关掉的窗口**：`spr debug <compose> close` 后、`spr daemon restart` 后（旧组被关掉）、用户手动关掉组后，`computer screenshot` / `computer left_click`：报「窗口没开」、退出码 3，提示重新 navigate；日志目录还在；重开时换一个新目录。debug 窗口空闲 30 分钟自动关。
   - **run 窗口**：`run` 期间出现一个标题是 `speedrun` 的灰色组，跑完组消失；同一个站点连跑两次 `run`，第二次不沿用第一次的页面；两个 `run` 同时跑，各开各的组，互不排队。
   - **compose 和恢复**：写一个 `@status draft` 的 compose 文件 → `spr run <名>` 停在 ask → `spr resume` 继续 → 成功，compose 和它调用的 draft 都变成 verified，compose 文件除了 `@status` 一个字节没变；让一个 action 失败，修好文件后 `spr resume <编号>` 接着跑，已完成的 action 不重跑；缺 action 时 `spr run` 报 `<name>(<params>) is not defined` 且没有打开窗口。
   - **@write 和 compose**：带 `@write` 的 draft 在 `spr status` 里标出；action 里调用 `action()` 被拒；compose 里调用 `navigate` 这类页面操作被拒；compose 里调用别的 compose，执行前检查和运行时都被拒。
   - **同一个 compose 串行**：在 Claude Code 里一次并行发两条 `spr debug <同一个 compose> computer …`：一条成功，一条报「上一条命令还没结束」。
   - **SDK、参数、helpers**：`export default async () => …` 加 `navigate(url)`、`request({…})`、`click(<locator>)`、`hover(<locator>)`、`form_input(<locator>, <value>)`、`key(…)`、`scroll({ direction })`、`get_page_text()` 写法的 action 能跑；`@param n:number` 收到的是数字；`~/.speedrun/helpers/` 里的函数被 action `import` 后能跑，`spr daemon restart` 后还在。
4. 页面脚本只进 speedrun 的标签页：
   - 用户的普通标签页里（用 Claude in Chrome 打开）`window.__spr` 是 `undefined`，`fetch.toString()` 含 `[native code]`。
   - debug 窗口打开后第一次观察里有加载期的请求；有跨站 iframe 的页面，iframe 里的请求也录到。
   - 把用户的标签页拖进 speedrun 的组：之后的请求录到；拖出去：不再录，刷新后 `window.__spr` 是 `undefined`。
   - 组闲置 20 秒后再操作：照常录。`chrome://extensions` 里点 service worker 的「停止」后再操作：不报「开着 DevTools」，照常录。
5. daemon 的启动和退出（`ARCHITECTURE.md` §3 的 8 条）：改了 `src/session/`、`daemon.ts`、`relay.ts` 或扩展的重连之后，逐条验证，每一条都要能自己恢复、不需要手动操作：

   | 操作 | 期望 |
   |---|---|
   | `kill -STOP <daemon>`，5 秒后再 `kill -CONT` | 这段时间里发的 `spr status` 一直等，恢复后正常返回；`session/sock` 的 inode 没变；没有出现第二个 daemon |
   | `kill -9 <daemon>` 后马上 `spr tabs` | 拉起新 daemon，命令成功 |
   | 没有 daemon 时，同时跑 5 个 `spr status` | 都成功；最后只有一个 daemon 进程（`pgrep -f daemon.ts`） |
   | `kill <relay>` | 扩展 1 秒内重连，daemon 的 pid 不变 |
   | 在 `chrome://extensions` 刷新 speedrun | 同上；之前开着的 debug 窗口算关掉（再操作提示重新 navigate），新开的照常 |
   | 退出 Chrome，2 分钟内重新打开 | daemon 的 pid 不变 |
   | 退出 Chrome 超过 10 分钟 | daemon 退出，`session/sock` 被删掉 |
   | `node skills/spr/setup.js`（build 变了） | 旧 daemon 退出；扩展重连后是新 build，`doctor` 全部通过 |
   | 手动 `rm session/sock` | 2 秒内旧 daemon 退出；下一条命令拉起新的 |

6. 速度问题要用真实站点量（有统计脚本、被墙资源的页面最能暴露"等页面加载完"这类问题）：量 `spr debug <compose> navigate`、`spr run` 的耗时（新开 run 窗口的代价，尤其是 daemon 刚重启、request 要等页面先发请求才能抄头时）。

日常 Chrome 里测试时日志含登录态内容，在 `~/.speedrun/debug-windows`、`~/.speedrun/run-windows`；测完删除测试用的窗口目录。

7. 输出遵循渐进式发现：默认只给结论和线索，每层说明下一步去哪看。加一条输出前问：它会改变 agent 的下一步吗；需要时找得到吗；有上限吗，超了有没有说明还有多少、在哪里。

### 2.4 图标

图标在仓库根目录的 `brand/`，不进 payload。参数都在 `brand/icon.py`，设计依据和参数说明见 `brand/icon.md`。改完参数运行 `node brand/make-icons.mjs`（需要本机 python3 和 Chrome），它先生成 `brand/icon.svg`，再出 `skills/spr/src/chrome-extension/icons/` 下 16、32、48、128 四个 PNG；之后 `node skills/spr/setup.js` 重装（扩展会自动重新加载）。

### 2.5 命名与约定

- **名字只有两种写法，都小写：`speedrun` 和 `spr`**。来源是「快速通关」：第一次用页面操作、截图摸清接口，之后直接发请求通关。
  - `speedrun` 是名字（让人知道这是什么）：产品名、文档正文、GitHub 仓库、扩展显示名、标签组标题、数据目录 `~/.speedrun`、native host `com.speedrun.connect`、包名。
  - `spr` 是要敲的（人或 agent 打出来的）：命令 `~/.speedrun/bin/spr`、skill 名和触发词、SDK 包名 `import … from "spr"`、页面全局变量 `window.__spr` 和 binding `__sprSend`。
  - 不写大写形式（`Speedrun`、`SPR` 都不写）；代码里需要大写的名字不带产品名（`DATA_HOME`、`isAgentGroup`）。
- GitHub 仓库 `yanggggjie/speedrun`（私有，Apache-2.0；先后叫过 TabBot、Deft、Silt、Lore、habit，GitHub 会把旧地址转到新地址）。部分代码最初来自 yodo，历史已清空，与 yodo 仓库无关联。
- **不写兼容代码**：speedrun 还没对外发布，没有要兼容的旧版本。改了命令、参数、文件格式、SDK 写法，就直接删掉旧的，不留迁移、不留「已经去掉」的专门报错；本机 `~/.speedrun` 里的 action、compose 一起改成新格式。
- 本机的 8766 端口曾被一个无关服务占用；产品不用固定端口，走 Unix socket 和 native messaging。

## 3. 分发与发布

### 3.1 Skill payload

`skills/spr/` 是分发 payload：

```text
skills/spr/
├── src/                     运行时（daemon、commands、debug、run、browser、record、cli、chrome-extension 含页面脚本）+ 自检 + package.json
├── setup.js  SKILL.md  install.md  LICENSE
├── AGENTS.md                ← 仓库根目录的 AGENTS.md 是指向它的软链接
└── ARCHITECTURE.md          目标、角色、架构、排障
```

`setup.js` 把整个目录镜像到 `~/.speedrun`（只排除 `node_modules`、`.DS_Store`），然后在 `~/.speedrun/src` 里 `npm install`。规则：`skills/spr/` 里的都分发，仓库根目录的都只在仓库里：`tools/`（`verify-pack`、`export-payload`，依赖 git 和仓库根）、`brand/`（图标源文件和生成脚本）、根 `package.json`（只放命令入口，没有版本号）、`README.md`、`CHANGELOG.md`、`PRIVACY.md`。文档只在 `skills/spr/` 里维护一份，不要在别处复制。`verify:pack` 先用 `git ls-files` 导出文件再安装，保证在线安装的内容完整。

不要将 `node_modules` 提交到 git 或放入 payload。用户或 agent 运行 `setup.js` 时，才在 `~/.speedrun/src` 本地执行 `npm install`。

### 3.2 发布规则

- **安装**：对外安装与更新以 `skills/spr/install.md` 为准。
- **开发**：可以在任意 branch 开发，不要求同步维护发布文档。
- **发布**：不发布 npm 包，不创建 GitHub Release。release commit 进入 `main` 即完成发布。
- **回溯**：需要可回溯版本时创建 `vX.Y.Z` tag。

### 3.3 发布分支

用户明确要求“发布分支”时，创建 `release/vX.Y.Z`，不修改 `main`，也不 push。然后：

1. 把本次版本号改成一致：`skills/spr/src/package.json`，以及 `skills/spr/src/package-lock.json` 里 speedrun 包自己的 `version`（两处）。根 `package.json` 没有版本号。
2. 把本次发布里用户能感知的变化写入 `CHANGELOG.md`，版本号与上面相同。

完成后停下来，等用户测试和检查。用户自己 push。

### 3.4 发布到 `main`

用户明确要求“发布到 main”时，将发布分支相对 `main` 的提交压缩为一个提交，合入 `main`。

未收到“发布到 main”时，不得修改或 push `main`。

## 4. 运行时架构

运行时架构（命令入口、relay 与 daemon、扩展、窗口、录制、存储与安装）见同目录的 `ARCHITECTURE.md`。
