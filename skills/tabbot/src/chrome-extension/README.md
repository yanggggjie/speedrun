# TabBot Chrome 扩展

两件事，都不含业务逻辑：

1. 薄层 CDP 代理：把 holder（经 relay 转发）发来的 tab / window 操作和页面级 CDP 转给 `chrome.tabs`、`chrome.windows`、`chrome.debugger`，再把结果与事件回传。只操作 TabBot 自己开的窗口。
2. 常驻录制：对录制范围内的站点（默认所有 http/https 站点，排除敏感站点；`tabbot sites` 看和改）注册页面脚本，把观察到的事件批量交给 holder。见 `ARCHITECTURE.md` 第 7 节。

## 文件

- `manifest.json`：固定 `key`，扩展 ID 为 `dkjmgdhelenchaippejoppbcfbjfgppl`（与 `native-messaging-host/install.ts` 的 `EXTENSION_ID` 一致）。权限：`debugger`、`tabs`、`nativeMessaging`、`storage`、`alarms`、`scripting`，以及 `host_permissions: <all_urls>`。内容脚本不写在 manifest 里，按录制范围动态注册，被排除的站点不注入、不读取。
- `background.js`：连接、操作、事件转发、所有权登记、录制范围与事件批量转发。
- `journal/hook.js`（页面里，MAIN world）与 `journal/relay.js`（隔离世界）：录制脚本。
- `background.selfcheck.mjs`：用桩对象模拟 `chrome.*` 的冒烟测试（`npm test` 运行）。

## 加载

由 `setup` 注册 native host 后，在 `chrome://extensions` 开启开发者模式，点「加载已解压的扩展程序」，选择 `~/.tabbot/src/chrome-extension`。之后改了扩展代码，在同一页点刷新即可。

## 与 chrome-use `ab-connect` 的差异

- 有 relay：Chrome 拉起的 native host 是无状态的 relay，只转发字节；holder 是 relay 拉起的常驻 daemon，不随扩展刷新退出。
- 没有 idle detach、没有 tab group、没有 OOPIF、没有 download manager、没有 stealth 相关逻辑。
- 所有权登记：只接受 TabBot 自己开的窗口和 tab，以及 opener 属于 TabBot 的新 tab。登记同时写入 `chrome.storage.session`（service worker 重启后仍在）和 `chrome.storage.local`（扩展刷新后仍在）。恢复 `local` 时只接受窗口里仍有标题为 `tabbot run` / `tabbot record` 的 tab 的窗口，因为 tab id 在浏览器重启后会被复用。
- 重连：`onStartup` / `onInstalled` 立即连接；`alarms` 每 30 秒兜底；断开后指数退避，上限 30 秒。
- 协议版本：`hello` 带 `protocolVersion: 1`，holder 不一致时直接报错。
