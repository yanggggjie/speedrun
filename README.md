# TabBot

> TabBot —— agent 用你已登录的 Chrome 做网站上的事，做过的事都沉淀成 action（业务动作），下次毫秒级完成。

agent 干活在单独的 `tabbot agent` 窗口里，不录、不碰你的窗口；你只需要说要做什么（可以给链接，或说"我的某某页面"），以及页面要登录时登录。有 action 就直接 `tabbot run`；缺的就拆成要学的 action，开一个学习窗口（持久的句柄，一直保留）自己探索，只录自己的窗口、学自己做出来的请求，写成 action（一个业务动作，有请求就用请求），再用 `tabbot run --compose` 在用完即关的 run 窗口里组合成你要的事。日志按窗口存在 `~/.tabbot/learn-windows/`、`run-windows/`（时间线 JSONL、每个请求一个语义化命名的 JSON），知识在 `~/.tabbot/sites/<站点>/`（`endpoints.json`、action），agent 用 `rg`、`node`、Python 直接读，格式和命令见 `skills/tabbot/SKILL.md`，目标、角色分工、运行时架构和排障见 [skills/tabbot/ARCHITECTURE.md](skills/tabbot/ARCHITECTURE.md)，隐私见 [PRIVACY.md](PRIVACY.md)。部分代码最初来自 yodo（Apache-2.0）。
