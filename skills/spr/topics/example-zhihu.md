# 示范：请求优先写一个站点的 action

在知乎搜 agent，看前 30 条，给硬核技术的回答点赞同。

1. Find 没有现成的。Write：写 `~/.speedrun/compose/zhihu-vote-hardcore.js`（上面那段），调用还不存在的 `zhihu-search`（`q`、`n`）和 `zhihu-vote`（回答 id）。"前 30 条"写在 compose 里，"硬核技术"交给 `ask`。`spr run zhihu-vote-hardcore --q agent` 报这两个 is not defined。
2. Debug：`spr debug zhihu-vote-hardcore navigate https://www.zhihu.com/search?q=agent` → 观察里有 `GET /api/v4/search_v3`，「请求头」里 `x-zse-96 每次都变`；`zhihu-search` 先 `navigate` 搜索页再 `request` 它（页面发过同一个 endpoint，签名整组抄）。
3. 同一个窗口接着写 `zhihu-vote`，只在第一张卡片上触发：`find "赞同"` 拿到赞同按钮的 ref，`computer left_click --ref ref_31` → 观察里 `#1230 POST /api/v4/answers/:id/voters`，「请求头」里 `x-xsrftoken 页面级不变 ← cookie _xsrf` → `zhihu-vote` 只写 `request`；run 时页面没发带 `x-xsrftoken` 的请求被拒，才照位置加 `auth: { "x-xsrftoken": "cookie:_xsrf" }`。
4. Run：`spr run zhihu-vote-hardcore --q agent` → 停在 ask，`spr resume` 继续 → 结果，两个 action 和这个 compose 都变成 verified。
