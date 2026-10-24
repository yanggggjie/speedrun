# TabBot

> TabBot —— 人和 agent 在同一个浏览器里协作，人一碰就安全停下。

人和 agent 共用同一个浏览器。人可以做，agent 也可以做；agent 做事时人可随时插手，agent 能感知"现在是人在帮我"。

常驻录制你浏览的 http/https 页面，agent 读日志了解现场；请求优先——能直接重放的接口就不去点页面；需要动手时在你正在用的原页面上操作，你一碰就停。命令见 `skills/tabbot/SKILL.md`：观察 `tabs / log / sql / snapshot / text / wait / status`，请求优先 `req / replay`，操作 `takeover / release / act`。部分代码最初来自 yodo（Apache-2.0）。产品设计见 [docs/DESIGN.md](docs/DESIGN.md)，运行时架构见 [skills/tabbot/ARCHITECTURE.md](skills/tabbot/ARCHITECTURE.md)，隐私见 [PRIVACY.md](PRIVACY.md)。
