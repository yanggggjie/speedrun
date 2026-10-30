# TabBot

> TabBot —— agent 用你已登录的 Chrome 做网站上的事，做过的事都沉淀成 task，下次毫秒级完成。

agent 干活在单独的 `tabbot agent` 窗口里，不录、不碰你的窗口；你只需要说要做什么（可以给链接，或说"我的某某页面"），以及页面要登录时登录。有 task 就直接 `tabbot run`；没有就开学习会话自己探索，只录自己的窗口、学自己做出来的请求，写成 task（一份一个接口，有请求就用请求）再执行。日志和 task 是 `~/.tabbot/sites/<站点>/` 下的结构化文件（时间线 JSONL、每个请求一个 JSON、`endpoints.json`），agent 用 `rg`、`node`、Python 直接读，格式和命令见 `skills/tabbot/SKILL.md`，目标、角色分工、运行时架构和排障见 [skills/tabbot/ARCHITECTURE.md](skills/tabbot/ARCHITECTURE.md)，隐私见 [PRIVACY.md](PRIVACY.md)。部分代码最初来自 yodo（Apache-2.0）。
