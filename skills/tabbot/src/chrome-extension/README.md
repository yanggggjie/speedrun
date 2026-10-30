# TabBot Chrome 扩展

一个固定 ABI 的管道，没有业务逻辑；页面脚本是扩展包里的静态内容脚本（`page/`）。只在 tabbot agent 窗口（有 anchor 页的窗口）里录制和执行，用户自己的窗口里页面脚本不上报任何东西。

## 文件

- `manifest.json`：固定 `key`，扩展 ID 为 `dkjmgdhelenchaippejoppbcfbjfgppl`（与 `native-messaging-host/install.ts` 的 `EXTENSION_ID` 一致）。权限：`tabs`、`nativeMessaging`、`alarms`、`scripting`，以及 `host_permissions: <all_urls>`；`minimum_chrome_version` 135。
- `background.js`：连接 holder；ABI 里的 4 个操作 `register`、`exec`、`tabs`、`goto`；把页面脚本经 bridge 发来的消息和标签页的地址变化、关闭转给 holder。
- `background.selfcheck.mjs`：用桩对象模拟 `chrome.*` 的冒烟测试（`npm test` 运行）。

## 加载

由 `setup` 注册 native host 后，在 `chrome://extensions` 开启开发者模式，点「加载已解压的扩展程序」，选择 `~/.tabbot/src/chrome-extension`，再在这个扩展的详情页打开「允许用户脚本」（没有这个开关，页面脚本装不上，录制和操作都不工作）。

## 更新

扩展只在 ABI 变化（`browser/extension.ts` 的 `ABI`）或权限变化时才需要在 `chrome://extensions` 里点刷新；`tabbot doctor` 的 `extension-abi` 会提示。

## 连接

- Chrome 拉起的 native host 是无状态的 relay，只转发字节；holder 是 relay（或 CLI）拉起的常驻 daemon，不随扩展刷新退出。
- 重连：`onStartup` / `onInstalled` 立即连接；`alarms` 每 30 秒兜底；断开后指数退避，上限 30 秒。
- `hello` 带 `abi`，holder 的 ABI 不一致时不会工作，会提示用户刷新扩展。
