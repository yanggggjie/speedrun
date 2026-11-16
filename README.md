# speedrun

> speedrun —— 快速通关：用你本机已登录的 Chrome 快速完成网站任务，并由后台 subagent 自动把探索过的接口沉淀成可复用的 `action` 脚本，下次一行命令直接通关。简称 `spr`：触发词和命令都是它。

agent 在你 Chrome 里 speedrun 自己的折叠标签组里干活，不切换、不录你的标签页，你自己的网页里没有 speedrun 的任何代码；你只需要说要做什么（可以给链接，或说"我的某某页面"），以及页面要登录时登录。主 agent 先在 `~/.speedrun/action/<站点>/` 里找已有的 `action`，找到就直接 `spr run <action>`（多步或批量用免落盘的 `spr run -e '<js>'` 共用单个窗口跑完）；没有现成脚本就直接开 `debug` 窗口把事办成交付给你，同时派发后台 subagent 读取 `~/.speedrun/agents/distiller.md`，从窗口录制的日志里按五层优先级（无 token 公开 API、页面 HTTP 请求、页面函数、WebSocket、页面操作）提炼并验证新的 `action`。用法见 [skills/spr/SKILL.md](skills/spr/SKILL.md)，沉淀代理说明见 [skills/spr/agents/distiller.md](skills/spr/agents/distiller.md)，目标、架构和排障见 [skills/spr/ARCHITECTURE.md](skills/spr/ARCHITECTURE.md)，隐私见 [PRIVACY.md](PRIVACY.md)。部分代码最初来自 yodo（Apache-2.0）。
