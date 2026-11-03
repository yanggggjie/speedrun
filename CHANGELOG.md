# 更新记录

## 未发布

- daemon 的工作目录改到 `~/.lore`：之前重装（build 没变、daemon 没重启）后 action 会报 `ENOENT uv_cwd`。
- learn 的探索按 open-claude-in-chrome（Claude in Chrome）的做法：新增 `find`、`read_page`（a11y 树）、`get_page_text`、`form_input`；`computer` 的点击、悬停、拖拽、滚动可以用 `--ref ref_N` 指元素，不用看截图猜坐标。用 ref 的每一步输出「定位：」，写进 action。
- 输入只走 CDP（真实输入）：learn 的 `computer` / `form_input` 和 action 的 `click` / `hover` / `key` / `scroll` / `form_input` 共用一条路径；截图改用 CDP（不再把标签页切到前台），`evaluate` 不再受页面 CSP 限制。扩展新增 `debugger` 权限，agent 窗口顶部会显示「正在调试此浏览器」；只支持 Chrome。
- 扩展会自己重新加载：升级后 daemon 发现扩展不是磁盘上这一版，就让它从磁盘重新加载（ABI 13 起用 `reload`；更旧的版本由 agent 窗口的 anchor 页触发，也不用手动刷新）。
- 不再区分 agent 和有人在 agent 窗口里的输入：去掉 `src: user` 和 `input` 行，agent 窗口里的一切都记为 agent。
- learn 窗口的命令：去掉 `observe`（等晚到的请求用 `computer wait`，全部请求在 `timeline.jsonl` 里）；`lore learn <句柄> run --action <名>` 改名 `lore learn <句柄> try_action <名>`；`lore learn <句柄> close` 改成 `lore learn close <句柄>`。
- SDK：`fill` / `select` / `check` 合成 `form_input(定位, 值)`；`text` 改名 `get_page_text`；新增 `hover(定位)`；`click` 可以 `{ button: "right" }`、`{ count: 2 }`。

- 去掉 `lore run --dry` 和 `request()` 的 `readOnly`：批量写先跑读的 action 拿到目标，在 compose 里用 `lore.ask` 确认，再跑写的 action。
- 去掉 `--yes`：`@write` 只是提示，不拦；`lore run` 和 `lore learn <句柄> run` 的输出列出这次已发出的 write 请求。
- action 的 SDK 不用再传 page：`goto(url)`、`click(定位)`、`request({…})`。
- 新目录 `~/.lore/helpers/`：agent 自己抽出来的纯函数，升级和重启都不覆盖。
- `@param` 可以写类型（`@param offset?:number`，也有 `boolean`、`json`），run 时转好。
- `lore run --compose` 可以只写哈希的前几位。
- `lore status` 不再列 learn 窗口，看 `lore learn list`。
- action 文件写成 `export default async () => 结果`，不用再包一层 `lore.run`。
- `lore run --compose` 的哈希不到 4 位时直接报错，并列出以它开头的。
- 删掉对旧版本的兼容：旧目录（`~/.tabbot` 等）迁移、日志布局升级、`@uses`、`@status:` 写法、已删命令和参数的专门提示。
- 扩展 ABI 升到 10（页面脚本里的命名统一成 lore）：更新后要在 `chrome://extensions` 里刷新 lore；ABI 对不上时 `lore doctor` 判为失败。
