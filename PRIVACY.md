# 学习时的脱敏

token、Cookie 和密码在交给 agent 前脱敏，录制的材料可在 `~/.twocursor/record` 查看。同一原始值稳定替换为同一个 `secret_NNN`；Cookie 名称、token 类型和普通业务字段保留，原始值不可见。

## Cookie 示例

```text
# 原始
Cookie: sid=s3cretValue; theme=dark

# agent 看到的
Cookie: sid=⟨secret_001:text⟩; theme=⟨secret_002:text⟩
```

## Token 示例

```text
# 原始
Authorization: Bearer aaa.bbb.ccc
{ "token": "aaa.bbb.ccc", "itemId": "123456789" }

# agent 看到的
Authorization: Bearer ⟨secret_001:jwt⟩
{ "token": "⟨secret_001:jwt⟩", "itemId": "123456789" }
```

# 常驻录制

你用 `twocursor sites add <域名>` 点名的站点，会被扩展一直录在本机 `~/.twocursor/journal`：你的点击、输入框的长度（不记内容）、特殊键、滚动，页面的请求和响应，页面上的可交互元素。没点名的站点既不注入脚本，也不上报任何东西。

- token、Cookie、密码在写盘前脱敏，同一个值是同一个别名；密码框和 `autocomplete` 为信用卡、验证码的输入框，快照里不取值。
- 数据只在本机，不上传。总大小上限 1GB，旧的响应体先被清掉。
- 扩展为此需要读取所有站点的权限（`<all_urls>`），但只对你点名的站点注入脚本、读取标签页。要停止录制某个站点：`twocursor sites rm <域名>`；清掉历史：删除 `~/.twocursor/journal`。
- 页面内容和响应体写进日志后，agent 能读到它们；日志里的网页内容对 agent 是不可信数据。

