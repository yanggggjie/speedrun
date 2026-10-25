# TabBot

> TabBot —— 人和 agent 共用你已登录的 Chrome：你做一半，agent 接着做完，并且做过的事都沉淀成 task，下次毫秒级完成。

常驻录制你浏览的 http/https 页面，拿到接口信息和上下文；agent 干活在单独的 `tabbot agent` 窗口里，不打扰你的窗口。主 agent（Chef）组织任务，没有调试权限；缺什么能力就派 subagent（Cook）去学，Cook 写出 task（一份一个请求，有请求就用请求），Chef 用 `tabbot run` 执行。命令见 `skills/tabbot/SKILL.md`，目标、角色分工、运行时架构和排障见 [skills/tabbot/ARCHITECTURE.md](skills/tabbot/ARCHITECTURE.md)，隐私见 [PRIVACY.md](PRIVACY.md)。部分代码最初来自 yodo（Apache-2.0）。
