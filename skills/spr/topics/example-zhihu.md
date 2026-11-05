# 示范：请求优先学一个站点

在知乎搜 agent，看前 30 条，给硬核技术的回答点赞同。

1. 拆成 `zhihu-search`（`q`、`n`）和 `zhihu-vote`（回答 id）。"前 30 条"写在 compose 里，"硬核技术"交给 `spr.ask`，点赞只在第一张卡片上学。
2. `spr learn new --url https://www.zhihu.com …` 拿到句柄；`navigate` 搜索页 → 观察里有 `GET /api/v4/search_v3`，「请求头」里 `x-zse-96 每次都变`；`zhihu-search` 先 `navigate` 搜索页再 `request` 它（页面发过同一个 endpoint，签名整组抄），在窗口里 `try_action zhihu-search --offset 20` 通过。
3. `find "赞同"` 拿到第一张卡片赞同按钮的 ref，`computer left_click --ref ref_31` → 观察里 `#1230 POST /api/v4/answers/:id/voters`，「请求头」里 `x-xsrftoken 页面级不变 ← cookie _xsrf` → `zhihu-vote` 只写 `request`；run 时页面没发带 `x-xsrftoken` 的请求被拒，才照位置加 `auth: { "x-xsrftoken": "cookie:_xsrf" }`。
4. 写 `~/.speedrun/compose/zhihu-vote-hardcore.js`（上面那段），`spr run zhihu-vote-hardcore --description "给知乎 agent 搜索结果里硬核技术的回答点赞同" --q agent` → 停在 ask，`spr resume` 继续 → 结果，两个 action 和这个 compose 都变成 verified。
