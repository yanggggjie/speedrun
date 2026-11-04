# 更新记录

## 未发布

- 观察里的「依赖」也能找到之前几步的来源（页面加载时拿的 token、几步之后提交时用），以前只在同一次观察列出的请求之间找。`request()` 的响应上限从 1MB 提到 16MB（和录制一样），被截断时 `json()` 直接说明截断了，不再报「不是 JSON」。
- 升级更稳：`setup.js` 先让旧 daemon 退出再换代码（以前换代码的几秒里旧 daemon 还在跑）；启动脚本里的路径加了引号转义（路径里有空格、引号、`$` 也能用）；只删上次由安装拷过去、新版本里没有了的顶层文件，`~/.habit` 里你自己放的文件不再被删；`doctor` 去掉两项永远通过的检查。
- 页面快照和 HTML 响应体也脱敏：密码框、隐藏框、卡号 / 验证码框、名字像秘密的输入框的值，和 `csrf-token` 这类 `<meta>` 的内容，写盘前换成别名（JSON 响应体本来就脱敏）。adblock 规则缓存 7 天，daemon 启动不再每次联网下载。
- learn 窗口关掉之后（`learn close`、空闲 30 分钟、daemon 重启、扩展重连、标签组被关）句柄只能看日志：再操作会报「已经关了」（退出码 3），要接着学就 `learn new` 开新窗口复现，不再悄悄回到上次的 URL。`habit learn list` 只列开着的。
- 敏感输入框（密码、卡号、安全码、一次性验证码）统一判断：`read_page` 不显示它们的值；`form_input` 和 `computer type` 往里面输入时，时间线只记字数、不记内容（以前 `type` 打的字会原样进时间线）。页面里同步抛错的请求不再让页面一直「还在变化」。
- 页面脚本只进 habit 的标签页：不再作为内容脚本装进所有网页，改成 habit 附着调试器时经 CDP 注册（`Page.addScriptToEvaluateOnNewDocument`、`Runtime.addBinding`，跨站 iframe 用 `Target.setAutoAttach`），用户自己的网页里没有 habit 的任何代码。去掉 `bridge.js`。扩展 ABI 15，升级后扩展会自己重新加载。扩展的 service worker 重启后第一次操作不再被误报成「开着 DevTools」。用户的标签页关了不再通知 daemon。
- learn 的观察里有同站请求被 401/403 拒、或者页面在登录页时，先提醒「像是登录失效」：先看页面，点一下能登录的自己点，要账号密码、扫码的请用户登录。learn 窗口操作满 200 次的报错改成先停下看卡在哪，确实还要学就开新窗口。
- 简化命令：`habit run <名>` 跑 action 或 compose（去掉 `--action`、`--compose`、`--compose-code`、`--timeout`）；`habit resume <编号> --answer …` 从 `habit.ask` 停下的地方接着跑（`--description` 说明为什么这样回答）。新增 `habit --help`、`habit learn --help`、`habit run --help`、`habit run <名> --help`（从文件头列参数、时间上限）。
- compose 改成 agent 自己写的文件 `~/.habit/compose/<名>.js`，和 action 一样的文件头和 `export default`，一直保留；不再按代码哈希自动保存、不再淘汰。时间上限只看文件头 `@timeout`。恢复 `habit.ask` 时用停下那一刻的代码。
- 退出码 3：命令写错了（不认识的命令或参数、缺参数、值不合法），改命令再跑。参数的值不能以 `--` 开头（漏写了值时不再把下一个参数吞掉）；拼错的参数名给「是不是想写」。
- 同一个 learn 句柄一次只跑一条命令，后到的直接报错。
- `read_page`、`find`、`get_page_text` 输出的网页文字放在「页面内容……页面内容结束」之间；`run` 的结果超过 2 万字时截断，全文存进 run 窗口目录；`tabs` 最多列 50 个。
- 出错时保留出错前已经输出的内容（比如已发出的非 GET 请求）。
- 改名为 habit：skill、命令、数据目录 `~/.habit`、native host `com.habit.connect`、SDK 的 `habit.params` / `habit.ask`。
- daemon 的启动和退出更可靠：daemon 只监听一个 socket，relay 和 CLI 连上后先说明角色；只有 daemon 自己删 socket 文件（以前 CLI 等 daemon 超时就会删，删掉后 habit 整个连不上）；daemon 发现 socket 文件被换掉就自己退出，不会两个并存；Chrome 退出、扩展刷新都不会让 daemon 退出。`habit daemon restart` 和升级只让旧 daemon 退出，下一条命令或扩展重连时拉起新的。扩展断开后固定 1 秒重连。`habit doctor` 新增 `launcher-node`（启动脚本里的 node 还在不在），并且不再建目录。
- 不再开窗口、不抢前台：learn 窗口和 run 窗口改成用户窗口里 habit 自己的**标签组**（折叠，一个句柄或一次 run 一个），habit 从不选中自己的标签页。后台页面靠调试器照常渲染（懒加载、滚动加载都正常）；组闲置 20 秒就解除附着，「正在调试此浏览器」的横幅随之消失。页面在 habit 的标签页里要新开标签页时（`target=_blank`、cmd/中键点击、`window.open`），由 habit 开在同一个组里，不会把用户的标签页切走、不会把 Chrome 拉到前台；带窗口参数的弹出窗口照常。归属看组：把标签页拖进 habit 的组就交给 habit，拖出去就收回。扩展 ABI 14，新增 `tabGroups` 权限；去掉 anchor 页。
- daemon 的工作目录改到 `~/.habit`：之前重装（build 没变、daemon 没重启）后 action 会报 `ENOENT uv_cwd`。
- learn 的探索按 open-claude-in-chrome（Claude in Chrome）的做法：新增 `find`、`read_page`（a11y 树）、`get_page_text`、`form_input`；`computer` 的点击、悬停、拖拽、滚动可以用 `--ref ref_N` 指元素，不用看截图猜坐标。用 ref 的每一步输出「定位：」，写进 action。
- 输入只走 CDP（真实输入）：learn 的 `computer` / `form_input` 和 action 的 `click` / `hover` / `key` / `scroll` / `form_input` 共用一条路径；截图改用 CDP（不再把标签页切到前台），`evaluate` 不再受页面 CSP 限制。扩展新增 `debugger` 权限，habit 干活时会显示「正在调试此浏览器」；只支持 Chrome。
- 扩展会自己重新加载：升级后 daemon 发现扩展不是磁盘上这一版，就让它从磁盘重新加载（ABI 13 起用 `reload`）。
- 不再区分 agent 和有人在 agent 窗口里的输入：去掉 `src: user` 和 `input` 行，agent 窗口里的一切都记为 agent。
- learn 窗口的命令：去掉 `observe`（等晚到的请求用 `computer wait`，全部请求在 `timeline.jsonl` 里）；`habit learn <句柄> run --action <名>` 改名 `habit learn <句柄> try_action <名>`；`habit learn <句柄> close` 改成 `habit learn close <句柄>`。
- SDK：`fill` / `select` / `check` 合成 `form_input(定位, 值)`；`text` 改名 `get_page_text`；新增 `hover(定位)`；`click` 可以 `{ button: "right" }`、`{ count: 2 }`。

- 去掉 `habit run --dry` 和 `request()` 的 `readOnly`：批量写先跑读的 action 拿到目标，在 compose 里用 `habit.ask` 确认，再跑写的 action。
- 去掉 `--yes`：`@write` 只是提示，不拦；`habit run` 和 `habit learn <句柄> run` 的输出列出这次已发出的 write 请求。
- action 的 SDK 不用再传 page：`goto(url)`、`click(定位)`、`request({…})`。
- 新目录 `~/.habit/helpers/`：agent 自己抽出来的纯函数，升级和重启都不覆盖。
- `@param` 可以写类型（`@param offset?:number`，也有 `boolean`、`json`），run 时转好。
- `habit run --compose` 可以只写哈希的前几位。
- `habit status` 不再列 learn 窗口，看 `habit learn list`。
- action 文件写成 `export default async () => 结果`，不用再包一层 `habit.run`。
- `habit run --compose` 的哈希不到 4 位时直接报错，并列出以它开头的。
- 删掉对旧版本的兼容：旧目录（`~/.tabbot` 等）迁移、日志布局升级、`@uses`、`@status:` 写法、已删命令和参数的专门提示。
- 扩展 ABI 升到 10（页面脚本里的命名统一成 habit）：更新后要在 `chrome://extensions` 里刷新 habit；ABI 对不上时 `habit doctor` 判为失败。
