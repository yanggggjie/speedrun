# 更新记录

## 未发布

- 新图标：整个图标面就是一个 t：白色的曲线（没有直线）组成 t，笔画延伸出图标边缘，把图标切成粉色、深莓色、蜜桃粉三块。
- 新增常驻录制：一直记录你浏览的所有 http/https 页面——人的操作、HTML 文档（渲染后的 DOM）、XHR 和 fetch 的请求与响应、页面状态，落在 `~/.tabbot/journal`。日志是一个按大小滚动的队列：50MB 一段，总共 500MB，写满就整段删除最旧的。埋点和广告自动识别为噪声；token、Cookie、密码脱敏成稳定的别名。
- 新增观察命令：`tabbot log`、`sql`、`snapshot`、`text`、`tabs`、`wait`、`status`。
- 新增在原页面上操作：`tabbot takeover`、`release`、`act click|fill|select|check|press|scroll|goto`。agent 的动作是页面里的 DOM 事件（不弹调试横幅）；元素用稳定引用 `@e12`；每个动作自带等页面稳定，并返回引发的请求。**人一动手（点击、按键、输入）租约立刻撤销**，动作等页面稳定的时候你动手也会立刻停。
- 新增请求优先：`tabbot req find`（在响应体和页面 HTML 里找页面上看到的值）、`req show`、`replay <编号> [--set ...] [--yes]`，把录下来的请求原样再发一次（带登录态），比点页面快。原始请求（含 token 真值）只在本机 daemon 的内存里，绝不落盘；`--set` 里可以直接写日志里看到的别名，由 daemon 换成真值。
- 架构：扩展只是一个固定 ABI 的管道，所有逻辑和数据在 daemon；页面脚本由 daemon 经 `chrome.userScripts` 下发，更新页面脚本不用刷新扩展。**需要在 `chrome://extensions` 里打开 TabBot 的「允许用户脚本」**，Chrome 135 及以上。
