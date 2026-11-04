# speedrun

> speedrun —— 快速通关：第一次让 agent 在你已登录的 Chrome 里用页面操作、截图摸清网站的接口，学成 action（业务动作）；之后直接发请求，快速通关。简称 `spr`：触发词和命令都是它。

agent 在你 Chrome 里 speedrun 自己的折叠标签组里干活，不切换、不录你的标签页，你自己的网页里没有 speedrun 的任何代码；你只需要说要做什么（可以给链接，或说"我的某某页面"），以及页面要登录时登录。有 action 就直接 `spr run <名>`；缺的就开一个 learn 窗口自己探索，只学自己做出来的请求，写成 action（有请求就用请求，读不了才用页面操作），要串起几个就写成 compose，再用 `spr run <名>` 在用完即关的 run 窗口里交付。日志按窗口存在 `~/.speedrun/learn-windows/`、`run-windows/`，action 和 `endpoints.json` 在 `~/.speedrun/sites/<站点>/`，compose 在 `~/.speedrun/compose/`，agent 用 `rg`、`node`、Python 直接读。用法见 [skills/spr/SKILL.md](skills/spr/SKILL.md)，目标、架构和排障见 [skills/spr/ARCHITECTURE.md](skills/spr/ARCHITECTURE.md)，隐私见 [PRIVACY.md](PRIVACY.md)。部分代码最初来自 yodo（Apache-2.0）。
