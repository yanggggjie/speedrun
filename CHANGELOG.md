# 更新记录

## 未发布

- **角色分工**：主 agent 叫 主 agent，没有调试权限；缺能力就用 `tabbot delegate <task 名> --goal …` 派 subagent（subagent），它拿一个 debug 窗口在自己的 agent 窗口里调试（`tabbot debug --window …`，可以真发有副作用的请求，但必须如实回报副作用清单），把做法写成 task。**task 改名 task，一份只覆盖一个请求**；`tabbot run` 执行、`tabbot compose` 只组合 task、`tabbot task` 列出/生成骨架。`tabbot api` 把已有 task 覆盖的接口标出来，没覆盖的排前面；`run` 真跑成功自动晋升为 verified，`--dry` 不真发非 GET。几个 subagent 各有自己的 agent 窗口，可以并行（同一个 task 同时只派一个）。主 agent 长期持有 run 窗口，只执行 task；debug 窗口派出时开、跑通/放弃（`debug … end`）/30 分钟无操作时收回；holder 重启一切归零。
- **清理**：agent 的窗口叫 `tabbot agent`；删除租约、`takeover`/`release`/`wait`、页面脚本里为“人抢占”服务的代码、`task new` 生成器、`hook-e2e.mjs`；文档收成 `ARCHITECTURE.md`、`SKILL.md`、`install.md`、`AGENTS.md`；自检只留最关键的纯逻辑部分，不再模拟扩展（删除假扩展 e2e、桩 chrome.* 的测试和 Chrome for Testing 脚本），真实行为用 Claude in Chrome 验证。

- 新图标：整个图标面就是一个 t：白色的曲线（没有直线）组成 t，笔画延伸出图标边缘，把图标切成粉色、深莓色、蜜桃粉三块。
- 新增常驻录制：一直记录你浏览的所有 http/https 页面——用户的操作、HTML 文档（渲染后的 DOM）、XHR 和 fetch 的请求与响应、页面状态，按站点（页面的 host，如 `x.com`、`docs.google.com`）存在 `~/.tabbot/sites/<站点>/log`：每个窗口（用户、run 窗口、每个 debug 窗口）一个 `timeline.<窗口>.jsonl`，每次请求一个 JSON 文件（格式沿用 yodo 的录制材料），响应体、文档、快照各一个文件。每次请求都记一行（响应体按内容只存一份），记下 `cause`、`causeDt` 和 `phase`（`load` / `action` / `idle`）。埋点和广告自动识别为噪声；token、Cookie、密码脱敏成稳定的别名。存储额度总共 2GB，分两层：时间线和请求文件（500MB，能留一个多月）、响应体和页面 HTML（1.5GB，约 6 天）；每个站点有自己的上限，每个接口最近 5 次成功请求的样本受保护。
- 新增请求优先：`tabbot debug --window <号> replay <编号> [--set ...] [--yes]` 把录下来的请求原样再发一次（带登录态），比点页面快；编号是请求文件名开头的数字。原始请求（含 token 真值）只在本机 daemon 的内存里，绝不落盘；`--set` 里可以直接写日志里看到的别名，由 daemon 换成真值，也可以改查询参数里 JSON 的字段（`variables.cursor=…`，GraphQL 翻页用）。
- **读日志不再是命令，而是文件**：`~/.tabbot/sites/<站点>/endpoints.json` 是写入时增量维护的接口聚合（次数、`userTriggered` / `onLoad` / `idle`、触发它的动作、变量、响应结构、样本、被哪个 task 覆盖），agent 用 `rg`、`node -e`、Python 直接读；删除 `log`、`sql`、`req`、`context`、`api`、`task`。`endpointOf` 把同一路径上请求体里的 `operationName` / `action` / `method` 拆成不同接口（`/graphql#FavoriteTweet`）。数据格式只写在 `SKILL.md` 一处。
- **交接材料**：`tabbot delegate <task 名> --goal … --site <站点> [--endpoint …]` 开 debug 窗口时，把目标接口的样本、触发它们的动作、同一标签页前一分钟的行导出成冻结的材料（逐字复制、按窗口分文件、排除仍开着的其他 debug 窗口、`manifest.json` 写明缺口），subagent 不受同时进行的用户操作和其他 debug 窗口影响。
- **task 搬进站点目录**：`~/.tabbot/sites/<站点>/tasks/<名字>.js`，SDK 在 `~/.tabbot/lib`；task 名仍全局唯一，`tabbot run <名字>` 不变；文件头新增 `@note`。没做完的草稿 task 再 delegate 要加 `--fix`。
- **升级**：旧版本的 `~/.tabbot/journal`、`~/.tabbot/task` 只改名为 `journal.old`、`task.old`，不读取、不转换，不需要时自己删除。
- 架构：扩展是固定 ABI 2 的管道，页面脚本是扩展包里的静态内容脚本，不再需要「允许用户脚本」；从旧版本升级要先在 `chrome://extensions` 里移除旧的 TabBot 再重新加载，Chrome 135 及以上。
- 新增 `tabbot agent` 窗口：agent 在单独的窗口里干活，不抢焦点、不碰你的标签页；同站点的标签页会复用。
