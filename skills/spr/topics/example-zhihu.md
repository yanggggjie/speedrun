# 示范：请求优先完成批量筛选并沉淀 action

目标：在知乎搜 `agent`，看前 30 条，挑出硬核技术的回答点赞同。

1. **搜已有脚本**：`rg -i "zhihu" ~/.speedrun/action` 没有现成的。因为要看 30 条并批量点赞，先在 `debug` 窗口摸一次接口再写成 `action` 最快。
2. **摸清搜索与点赞接口**：
   - `spr debug zhihu-task navigate https://www.zhihu.com/search?q=agent` → 观察里出现 `GET /api/v4/search_v3`，「请求头」提示 `x-zse-96 每次都变`；写 `~/.speedrun/action/zhihu.com/zhihu-search.js`（先 `navigate` 搜索页再 `request`，签名同 endpoint 整组自动抄）。
   - 在第一张卡片做一次点赞（写好后再点一次取消）：`find "赞同"` → `computer left_click --ref ref_31` → 观察里出现 `POST /api/v4/answers/:id/voters`，「请求头」提示 `x-xsrftoken 页面级不变 ← cookie _xsrf` → 写 `~/.speedrun/action/zhihu.com/zhihu-vote.js`（标 `@write`，用 `auth: { "x-xsrftoken": "cookie:_xsrf" }`）。
3. **两步完成交付**：
   - 第 1 步拉列表：`spr run zhihu-search --q agent --n 30`（跑通后 `zhihu-search` 自动变成 `verified`）；
   - 第 2 步挑出硬核回答 ID 后批量点赞：`spr run -e 'for (const id of ["101","205"]) await action("zhihu-vote", { id }); return { voted: 2 }'`（共用 1 个 `run` 窗口完成，`zhihu-vote` 也自动变成 `verified`）。
