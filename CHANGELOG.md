# 更新记录

## 未发布

- 新图标：整个图标面就是一个 t：白色的曲线（没有直线）组成 t，笔画延伸出图标边缘，把图标切成粉色、深莓色、蜜桃粉三块。
- 新增常驻录制：一直记录你浏览的所有 http/https 页面——人的操作、HTML 文档（渲染后的 DOM）、XHR 和 fetch 的请求与响应、页面状态，落在 `~/.tabbot/journal`。日志是一个按大小滚动的队列：50MB 一段，总共 500MB，写满就整段删除最旧的。埋点和广告自动识别为噪声；token、Cookie、密码脱敏成稳定的别名。
- 新增观察命令：`tabbot log`、`sql`、`snapshot`、`text`、`tabs`、`wait`、`status`。
- 新增请求优先：`tabbot req find`（在响应体和页面 HTML 里找页面上看到的值）、`req show`、`replay <编号> [--set ...] [--yes]`，把录下来的请求原样再发一次（带登录态），比点页面快。原始请求（含 token 真值）只在本机 daemon 的内存里，绝不落盘；`--set` 里可以直接写日志里看到的别名，由 daemon 换成真值。
- 新增 `tabbot context`（用户最近在各个站点上做了什么，包括哪个操作引发了哪个请求）和 `tabbot api <站点>`（这个站点出现过的接口清单：触发它的用户操作、变量、响应结构、能不能直接重放）；`replay --set` 可以改查询参数里的 JSON 字段（`variables.cursor=…`，GraphQL 翻页用）。skill 改成“先读录制，再动手”的流程：有现成接口就重放，不点页面。
- 新增 `tabbot run` 窗口：agent 在单独的窗口里干活，不碰你的窗口和标签页（不抢焦点）；同站点的标签页会复用，所以很快。只有「你做一半 → agent 接着做」，没有租约和接管。
- 新增 task：`tabbot task` 列出/运行，`tabbot task new` 把 agent 在 run 窗口里做过的步骤生成 task 草稿，`tabbot eval` 组合 task；task 里的 `request` 默认继承页面自己发过的请求头（token 真值只在内存里）。做过的事都能变成 task，下次直接跑。
- 新增探索命令：`tabbot open`、`snapshot`、`text`、`act`（目标可以是 `@e12`、CSS 或 `{role,name}`）、`close`，都在 run 窗口里执行。`wait`、`takeover`、`release` 已删除。
- 架构：扩展是固定 ABI 2 的管道，页面脚本改为扩展包里的静态内容脚本，**不再需要「允许用户脚本」**；从旧版本升级要在 `chrome://extensions` 里移除旧的 TabBot 再重新加载，Chrome 135 及以上。
