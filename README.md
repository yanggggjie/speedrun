# TabBot

> TabBot —— 人和 agent 在同一个浏览器里协作，人一碰就安全停下。

人和 agent 共用同一个浏览器。人可以做，agent 也可以做；agent 做事时人可随时插手，agent 能感知"现在是人在帮我"。

**状态：第一阶段（常驻录制和只读观察）和第二阶段第一块（在原页面上操作，人一动手就停）已实现。** 代码起点是 yodo 的源码（Apache-2.0），已改名并大幅改造；命令见 `skills/tabbot/SKILL.md` 第 9 节：观察 `sites / tabs / log / sql / snapshot / wait / status`，操作 `takeover / release / act`。设计与路线见 [docs/DESIGN.md](docs/DESIGN.md)，实验记录见 [docs/EXPERIMENTS.md](docs/EXPERIMENTS.md)，换机器继续请先读 [docs/CONTEXT.md](docs/CONTEXT.md)。
