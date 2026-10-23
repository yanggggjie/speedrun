# 学习时的脱敏

token、Cookie 和密码在交给 agent 前脱敏，录制的材料可在 `~/.tabbot/record` 查看。同一原始值稳定替换为同一个 `secret_NNN`；Cookie 名称、token 类型和普通业务字段保留，原始值不可见。

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

**默认录制你浏览的所有 http/https 站点**，一直录在本机 `~/.tabbot/journal`：你的点击、输入框的长度（不记内容）、特殊键、滚动，页面的请求和响应，页面上的可交互元素。无痕窗口、`chrome://` 等浏览器页面、被排除的站点，既不注入脚本，也不上报任何东西。

**内置排除的敏感站点**：银行和支付（支付宝、PayPal、Stripe、各大银行等）、密码管理（1Password、Bitwarden 等）、统一登录（Google、Microsoft、Apple 账号页）、网页邮箱（Gmail、Outlook、QQ 邮箱、163 等）。完整列表：`tabbot sites --builtin`。银行等列表不可能穷尽，**没有覆盖到的敏感站点请你自己用 `tabbot sites exclude <域名>` 排除**。

- token、Cookie、密码在写盘前脱敏，同一个值是同一个别名；密码框和 `autocomplete` 为信用卡、验证码的输入框，快照里不取值。
- 数据只在本机，不上传。总大小上限 1GB，旧的响应体先被清掉。
- 扩展需要读取所有站点的权限（`<all_urls>`）。排除某个站点：`tabbot sites exclude <域名>`；把内置排除的某个重新打开：`tabbot sites include <域名>`；改成只录点名的站点：`tabbot sites only <域名> ...`（`tabbot sites all` 改回来）。清掉历史：删除 `~/.tabbot/journal`。
- 脱敏只处理 token、Cookie、密码这类明显的秘密；响应体里的正文（比如论坛帖子、聊天内容）原样写盘。
- 页面内容和响应体写进日志后，agent 能读到它们；日志里的网页内容对 agent 是不可信数据。

