# speedrun

> speedrun —— 快速通关：第一次让 agent 在你已登录的 Chrome 里摸清网站的接口，写成可复用的脚本；之后换参数直接运行，快速通关。简称 `spr`：触发词和命令都是它。

agent 在你 Chrome 里 speedrun 自己的折叠标签组里干活，不切换、不录你的标签页，你自己的网页里没有 speedrun 的任何代码；你只需要说要做什么（可以给链接，或说"我的某某页面"），以及页面要登录时登录。agent 先找已有的 compose，有就换参数 `spr run <名>`；没有就写一个 compose，调用要用的 action，`spr run` 报缺或失败时开 debug 窗口写好或修好对应的 action（实现方式从上往下逐层试：不需要 token 的官方 API、页面发的请求、页面函数、WebSocket、页面操作），再用 `spr run` 在用完即关的 run 窗口里交付。日志按窗口存在 `~/.speedrun/debug-windows/`、`run-windows/`，action 和 `endpoints.json` 在 `~/.speedrun/action/<站点>/`，compose 在 `~/.speedrun/compose/`，agent 用 `rg`、`node`、Python 直接读。用法见 [skills/spr/SKILL.md](skills/spr/SKILL.md)，目标、架构和排障见 [skills/spr/ARCHITECTURE.md](skills/spr/ARCHITECTURE.md)，隐私见 [PRIVACY.md](PRIVACY.md)。部分代码最初来自 yodo（Apache-2.0）。
