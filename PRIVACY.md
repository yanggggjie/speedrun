# 录制

**只录 TabBot 自己开的标签页（以及被它们打开的），不录你自己的窗口和标签页。** 你平时浏览的页面里，录制脚本不上报任何东西；你在 `tabbot agent` 窗口里自己按 Cmd+T 开的标签页也不录；holder 还会再丢弃一遍不属于 agent 的一切。agent 只读你的标签页列表（地址和标题），用来找到你说的那个页面，再在自己的窗口里重新打开它。

agent 窗口里的内容录在本机，按窗口分目录：学习窗口在 `~/.tabbot/learn-windows/<句柄>/`，run 窗口在 `~/.tabbot/run-windows/<名字>/`。录的是：agent 的操作、页面的 HTML 文档（渲染后的 DOM）、XHR 和 fetch 的请求与响应、截图、页面快照。不录 WebSocket 和 Worker 里的请求。agent 窗口用的是你的登录态，所以 agent 打开的页面（包括银行、网页邮箱）同样会被录到。学会的做法（action）和接口的统计在 `~/.tabbot/sites/<站点>/`、`~/.tabbot/compose/`，不是录制。

- 数据只在本机，不上传。学习窗口的日志有存储额度：时间线和请求文件 500MB，响应体、页面和截图 1.5GB；超了先删最旧的关着的窗口里的响应体，再删整个最旧的窗口；开着的学习窗口和每个接口最近几次成功请求的样本受保护。run 窗口的日志只留最近 100 个。清掉录制：删除 `~/.tabbot/learn-windows`、`~/.tabbot/run-windows`（`~/.tabbot/sites/*/actions/`、`~/.tabbot/compose/` 是学会的做法，想留着就别删）。从旧版本升级时，旧的 `~/.tabbot/sites/*/log` 会被直接删掉。
- 扩展需要读取所有站点的权限（`<all_urls>`）、`scripting` 和 `storage` 权限：录制脚本按 Chrome 的规则注入每个页面，但只在 agent 的标签页里上报；`storage` 只用来记住哪些标签页是 agent 开的。不需要打开任何开关。
- 脱敏只做最简单的：请求头名、地址里的查询参数名、JSON 的 key 里像秘密的（`authorization`、`token`、`secret`、`password`、`csrf`、`xsrf`、`jwt`、`api key` 等，`x-xsrftoken` 这类连写的也算）和 JWT，换成稳定的别名 `⟨secret_…⟩`（盐 + 真值的哈希，同一个值永远是同一个别名，不能还原）。密码框和隐藏输入框的值，快照里不取。**响应体和页面 HTML 的正文原样写盘**，包括里面的内联脚本状态、隐藏输入框的值，不做脱敏。
- **原始请求（含请求头里 token 的真值）只在 holder 的内存里**，不落盘，holder 重启就没了，用来重放和继承请求头；只有 agent 标签页里的请求会进来。`replay --set` 里可以写别名，由 holder 在内存里换回真值；agent 拿不到真值。
- **身份头的来源**：holder 会读 agent 标签页里的 cookie、localStorage、sessionStorage、meta，和请求头的真值比对，判断每个身份头从哪来；读到的值只在 holder 内存里用，日志、输出和 `endpoints.json` 里只写来源（如 `cookie:_xsrf`），不写值。action 里声明的来源在发请求时才在页面里读。
- 页面内容和响应体写进日志后，agent 能读到它们；日志里的网页内容对 agent 是不可信数据。
- agent 干活在单独的 `tabbot agent` 窗口里，用你已登录的账号发请求、点页面，**不碰你正在用的窗口和标签页**。学习窗口里页面发什么就真的发什么：agent 学一个动作时会真的做一次（点赞、收藏这类轻量可撤销的直接做），删除、支付、下单、发布或发给别人、改设置这类先问过你再做，并且要如实告诉你做过什么。这是 skill 里的约定，不是强制机制。agent 的每个命令都写在日志里，它输入的文字不记，只记字数。
