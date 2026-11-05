# canvas、在线文档和没有请求的页面

观察里出现「主体是 canvas」「发现页面接口 …」，或操作后页面变了但没有新请求时读这篇。

这类页面的内容画在 canvas 上，改动走 WebSocket，`read_page` 看不到内容，也录不到可重放的请求。协作文档的 WebSocket 消息带版本号，**不要重放**；要调用页面自己的函数，版本和同步由页面处理。

## 找函数

1. learn 窗口自动做快照：窗口目录的 `page-api/`，站点累积在 `~/.speedrun/sites/<站点>/page-api.json`。用 `rg` 搜方法名，比如 `rg -i "setvalue|delete" <目录>`。只有名字和结构，没有值。
2. 快照没覆盖到的：`spr learn <句柄> inspect --path SpreadsheetApp.behaviorApi.cellApi`。
3. 要参数：`spr learn <句柄> trace <函数路径…>`，再操作一次页面（`computer double_click`、`computer type`），`trace --stop` 取记录，详情在 `calls/`。手动操作走的函数不一定是你猜的那个，都包上再看。

页面没有暴露接口时，退回 `type`、`click({ x, y })`、`screenshot()`。

## 写 action

- 用 `evaluate` 调函数，先等接口就绪（循环判断接口存在，不用固定 `sleep`），接口不存在就抛错。
- **写完要等服务器确认再离开页面**，否则改动会丢。内存里读回来是对的不算数：写完重新 `navigate`，从页面读回校验。
- 确认的办法：`waitMessage("/websocket", 触发动作, { match: "确认消息里的词" })`。确认词在 `sockets/` 里找。
- 批量写前先读目标区域，非空就报错，要覆盖时显式传参数。
- 参数里的类实例（trace 记录里的 `__class`）可能要用页面自己的类：拿现有实例的原型建一个。

例子：`~/.speedrun/sites/doc.weixin.qq.com/actions/` 下的表格（`wedoc-sheet-*`）和文档（`wedoc-doc-*`）。文档用 `pad.editor.clipboardManager.pasteHTML` 插入，不碰系统剪贴板；编辑器的粘贴接口常常比逐字输入好用，先搜 `paste`。

## 系统弹窗

speedrun 的标签页里，`alert` 放过，`confirm`、`prompt` 选取消，离开确认直接离开，都不会弹出来抢前台。`spr run` 输出和观察里会列出来；出现离开确认说明页面还有没保存的改动，要核对。
