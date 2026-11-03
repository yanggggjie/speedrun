# 更新记录

## 未发布

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
