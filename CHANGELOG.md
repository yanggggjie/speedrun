# 更新记录

## 未发布

- **角色分工**：主 agent 叫 主 agent，没有调试权限；缺能力就用 `tabbot delegate <task 名> --goal …` 派 subagent（subagent），它拿票据在自己的 agent 窗口里调试（`tabbot debug --ticket …`，可以真发有副作用的请求，但必须如实回报副作用清单），把做法写成 task。**task 改名 task，一份只覆盖一个请求**；`tabbot run` 执行、`tabbot compose` 只组合 task、`tabbot task` 列出/生成骨架。`tabbot api` 把已有 task 覆盖的接口标出来，没覆盖的排前面；`run` 真跑成功自动晋升为 verified，`--dry` 不真发非 GET。几个 subagent 各有自己的 agent 窗口，可以并行（同一站点最多 2 个）。
- **清理**：agent 的窗口叫 `tabbot agent`；删除租约、`takeover`/`release`/`wait`、页面脚本里为“人抢占”服务的代码、`task new` 生成器、`hook-e2e.mjs`；文档收成 `ARCHITECTURE.md`、`SKILL.md`、`install.md`、`AGENTS.md`；自检只留最关键的纯逻辑部分，不再模拟扩展（删除假扩展 e2e、桩 chrome.* 的测试和 Chrome for Testing 脚本），真实行为用 Claude in Chrome 验证。

- 新图标：整个图标面就是一个 t：白色的曲线（没有直线）组成 t，笔画延伸出图标边缘，把图标切成粉色、深莓色、蜜桃粉三块。
- 新增常驻录制：一直记录你浏览的所有 http/https 页面——人的操作、HTML 文档（渲染后的 DOM）、XHR 和 fetch 的请求与响应、页面状态，落在 `~/.tabbot/journal`。日志是一个按大小滚动的队列：50MB 一段，总共 500MB，写满就整段删除最旧的。埋点和广告自动识别为噪声；token、Cookie、密码脱敏成稳定的别名。
- 新增请求优先：`tabbot req find`（在响应体和页面 HTML 里找页面上看到的值）、`req show`、`replay <编号> [--set ...] [--yes]`，把录下来的请求原样再发一次（带登录态），比点页面快。原始请求（含 token 真值）只在本机 daemon 的内存里，绝不落盘；`--set` 里可以直接写日志里看到的别名，由 daemon 换成真值。
- 新增 `tabbot context`（用户最近在各个站点上做了什么，包括哪个操作引发了哪个请求）和 `tabbot api <站点>`（这个站点出现过的接口清单：触发它的用户操作、变量、响应结构、能不能直接重放）；`replay --set` 可以改查询参数里的 JSON 字段（`variables.cursor=…`，GraphQL 翻页用）。skill 改成“先读录制，再动手”的流程：有现成接口就重放，不点页面。
- 架构：扩展是固定 ABI 2 的管道，页面脚本是扩展包里的静态内容脚本，不再需要「允许用户脚本」；从旧版本升级要先在 `chrome://extensions` 里移除旧的 TabBot 再重新加载，Chrome 135 及以上。
- 新增 `tabbot agent` 窗口：agent 在单独的窗口里干活，不抢焦点、不碰你的标签页；同站点的标签页会复用。
