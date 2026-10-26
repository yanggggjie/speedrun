# 改造计划：按站点存结构化日志，agent 用文件和脚本读

**状态**：第 1 步到第 6 步已实现，`npm run check` 和 `npm test` 通过，用隔离 HOME 起真实 holder 冒烟通过；第 7 步（真实 Chrome 里验证）和 `npm run verify:pack` 还没跑。实现与本计划的差别见文末"实现时的调整"。

目标：日志**忠实、准确、不混**，按站点组织，全部是结构化数据（JSONL 加每个请求一个 JSON 文件，格式沿用 yodo 的录制材料）；agent 用 `ls`、glob、`rg`、`node -e`、Python 去读和处理；TabBot 只保留必须由它做的命令（控制浏览器、持有不能落盘的原始请求）。

原则：

1. **能用文件系统表达的，就不做成命令。**
2. **给 agent 读的是结构化数据，不是 md。** 数据格式的说明只写在 `/Users/me/Code/x/TwoCursor/skills/tabbot/SKILL.md` 一处，数据目录里不放 md。
3. **日志不可变**：追加写，不改已写的行。
4. **录制要准确**：每一次请求都记一行（不去重、不丢），来源、站点、窗口、因果都在写入时记对；有缺口（后台标签页、截断、失败）要明确标出，不假装完整。
5. **不混**：站点之间不混；用户、run 窗口、每个 debug 窗口的记录在**物理上分文件**；交接材料逐字复制原始行，不改写、不汇总，并写明包含和排除了什么。
6. **存储大方分配**：总量 2GB，以不影响效果为准。

下文路径：源码以 `/Users/me/Code/x/TwoCursor/skills/tabbot/src/` 为根写完整绝对路径，运行时数据以 `/Users/me/.tabbot/` 为根。

## 推演依据（先看这一节）

本计划的设计依据两份数据，二者能说明的事不同：

| 数据 | 是什么 | 能说明 | 不能说明 |
|---|---|---|---|
| yodo 的两份录制 `/Users/me/.yodo/record/console-scale-out-9fb542/`、`/Users/me/.yodo/record/expt-move-whitelist-ad1daa/` | 用户在专门的录制窗口里做的短演示，全是公司内部系统（RPC 风格，几乎全是 POST） | **文件格式**（请求文件、timeline 行）；一次点击可以引发多个请求；内部系统常把不同子系统放在同一个注册域名下 | 连续录制的体量、噪声、方法分布、站点分布 |
| 本机真实日志 `/Users/me/.tabbot/journal`（41 小时，8 段，约 8100 个事件，449MB） | TabBot 连续录制的日常浏览，含公共站点和公司内部站点 | **体量、方法分布、响应体分布、因果覆盖率、重复率、站点分布** | 其它用户的使用方式 |

本机真实日志的实测数字：

| 指标 | 实测 | 对设计的影响 |
|---|---|---|
| 总量 | 41 小时 449MB，约 260MB/天；其中响应体与文档约 98%，`events.db` 仅约 17MB（约 10MB/天） | 轻量层（时间线与请求文件）几乎不占空间，可以长期保留；占空间的是响应体 |
| 响应体大小 | 中位数 0.6KB，p90 67KB，p99 3.3MB，最大 5MB；总 296MB | 少数大响应占绝大部分空间，要按站点、按层分配额 |
| 站点集中度 | `app.example.com` 855 个请求占 168MB，`www.douyin.com` 810 个占 83MB；而 `x.com` 1491 个请求只占 8MB | 重度站点会吃光预算，必须每个站点有自己的上限 |
| 方法 | GET 80%，POST 19%，DELETE 极少 | 公共站点 GET 为主；内部系统几乎全 POST。方法只是弱信号，需要因果与加载阶段的信号 |
| 因果覆盖 | 只有 17% 的请求有 `cause`；有 `cause` 的里，`human click` 610 次，`agent goto` 608 次 | 83% 的请求是页面加载或后台自发；`goto` 引发的是整页加载，不是"用户动作" |
| 一次动作的扇出 | 一次 `cause` 引发 1 到 10 个以上请求 | 不能假定"一个动作一个请求"；需要区分页面加载阶段与动作阶段 |
| 重复 | 5124 行里 1581 行有重复，总请求次数 11534，去重省了 56% 的行 | 现有"只计数、不写第二行"会丢轮询间隔等信息；行很小，**改为每次都写**，只对响应体按内容哈希去重 |
| 缺口 | 后台标签页的请求只有计数（`bg` 行）；7 条响应被截断；166 条请求失败 | 要在材料里明确标出缺口 |
| 站点划分 | `app.example.com` 属于注册域名 `example.com`，同一个用户的 yodo 录制里 `app.example.com`、`app.example.com` 也都在 `example.com` 下；`mail.google.com`、`docs.google.com` 同属 `google.com`；`foo.github.io` 属于 `github.io` | 按注册域名划分会把无关系统混在一个目录，**站点改为页面的 host** |

## 最终方案与效果（示意，先看这一节）

下面的文件内容和命令输出都是**示意**，实现时以代码为准。

### A. 最终存储方案

**一句话：按站点、按段、按窗口分文件的 JSONL 时间线 + 每次请求一个 JSON 文件 + 响应体文件；分两层保留；原始请求只在 holder 内存里。**

**站点 = 页面的 host，去掉前导 `www.`**：`app.example.com`、`app.example.com` 是两个站点；`mail.google.com` 与 `docs.google.com` 是两个站点；`www.zhihu.com` 与 `zhihu.com` 是同一个，`zhuanlan.zhihu.com` 是另一个。请求按**发出请求的页面**归属，不按请求地址的 host：`x.com` 页面调用的 `api.x.com` 接口仍属于 `x.com`。

```
/Users/me/.tabbot/sites/<站点>/
├── endpoints.json                          holder 增量维护的接口聚合（结构化）
├── tasks/                                  task 代码 *.js；文件头 @endpoint / @summary / @status / @param / @note
├── log/<段>/                               一个站点的日志分成若干段
│   ├── timeline.user.jsonl                 用户窗口里发生的一切
│   ├── timeline.run.jsonl                  run 窗口里发生的一切
│   ├── timeline.debug-ab12.jsonl           debug-ab12 窗口里发生的一切（每个 debug 窗口一个文件）
│   ├── 001284_POST_x.com_i_api_graphql_FavoriteTweet.json            请求文件
│   ├── 001284_POST_x.com_i_api_graphql_FavoriteTweet.response.json   响应体
│   ├── 001290.doc.html                     渲染后的 HTML 文档
│   └── 001291.snap.json                    页面快照
└── debug/<窗口号>/                         debug 窗口的工作区，窗口收回时整个删除
    └── material/                           delegate 时导出的冻结材料（见 C）

/Users/me/.tabbot/sites/.seq      全局编号计数器（每批落盘）
/Users/me/.tabbot/alias-salt      脱敏盐，权限 0600（从 journal 目录移出）
/Users/me/.tabbot/lib/            task SDK（原 task/lib）
/Users/me/.tabbot/run/            task 运行历史（不变）
```

**为什么每个窗口一个时间线文件**：

- "用户做了什么" 就是 `cat log/*/timeline.user.jsonl`，不用过滤。
- "这个 subagent 做了什么" 就是 `cat log/*/timeline.debug-ab12.jsonl`。
- "全部历史，不区分操作人" 就是 `cat log/*/timeline.*.jsonl`。
- 不再靠"读的时候记得加 `win` 过滤"这种约定来避免混。

| 层 | 存什么 | 在哪 | 谁写 | 保留 |
|---|---|---|---|---|
| **轻量层** | 各窗口的 `timeline.*.jsonl`、请求文件 | `log/<段>/` | holder（唯一写者，追加） | 总计 500MB，单站点 150MB；超出时删最旧的整段 |
| **重量层** | 响应体、HTML 文档、页面快照（按内容哈希去重，后出现的相同内容只让请求文件指向已有文件） | `log/<段>/` | holder | 总计 1.5GB，单站点 600MB；超出时从最旧的段**只删响应体、文档、快照**，时间线与请求文件保留 |
| **样本** | 每个接口最近 5 次成功请求的请求文件和响应体 | 仍在原来的段里，在 `endpoints.json` 的 `samples` 里登记 | holder | 受保护：重量层淘汰时跳过；每个站点样本合计上限 100MB |
| 接口聚合 | 每个接口的次数、阶段、触发操作、变量、响应结构、样本、覆盖的 task | `endpoints.json` | holder 增量维护 | 只随站点目录 |
| 原始请求 | 含 token 真值的请求头和请求体 | **holder 内存**（`RawStore`，50MB，单条 64KB） | holder | 先丢最旧的；重启即无；**绝不落盘** |
| 编号计数器、脱敏盐 | 见上 | `sites/.seq`、`alias-salt` | holder | 不淘汰 |
| 知识 | task 代码，经验写在 task 文件头的 `@note` 行 | `tasks/` | subagent / 主 agent | **永不淘汰** |

**存储预算**（总计 2GB）：

| 项 | 额度 |
|---|---|
| 轻量层总计 | 500MB（按本机实测约 10 到 15MB/天，够存一个多月） |
| 重量层总计 | 1.5GB（按本机实测约 260MB/天，完整响应体约 6 天） |
| 单站点轻量层 | 150MB |
| 单站点重量层 | 600MB |
| 单站点样本 | 100MB |
| 换段 | 重量层写满 64MB，或满 24 小时，先到者 |

**淘汰规则**：

1. 重量层超限（单站点或总计）：从最旧的段开始，只删非样本的响应体、文档、快照；总计超限时先处理占用最多的站点。
2. 轻量层超限：删最旧的整段目录；该段里受保护的样本随之失效，`endpoints.json` 里对应的 `samples` 标为不可用。
3. 当前段永远不动。一个忙站点只挤自己，不挤别的站点。

**写入路径**：页面脚本上报 → 判断噪声 → 脱敏 → 分配编号 → 响应体按哈希写入或复用 → 写请求文件 → 往该窗口的 `timeline.<窗口>.jsonl` 追加一行 → 更新内存里的接口聚合（节流后写 `endpoints.json`）。**每一次请求都写一行，不去重。**

### A1. timeline 一行

沿用 yodo 的 `type` / `actionType` / `requestType`，加上 TabBot 才有的字段：

| 字段 | 含义 |
|---|---|
| `seq` | 日志编号，全局唯一、单调递增（跨站点也不重复，所以 `#1284` 不需要站点上下文） |
| `t` | 毫秒时间戳 |
| `win` | `user`、`run`、`debug-xxxx`（与所在文件名一致） |
| `src` | `user`（真人输入，`isTrusted`）、`page`（页面脚本触发的请求和导航）、`agent`（TabBot 自己发出的动作和重放；run 与 debug 窗口里的一切都记为 `agent`） |
| `tab`、`frame` | 标签页、帧 |
| `type` | `request`、`action`、`nav`、`doc`、`snap`、`cmd`、`tab`、`bg` |
| `cause` | 这个请求由哪个动作引发（同一标签页 2 秒内最近一次用户事件或 agent 命令的 `seq`） |
| `causeDt` | `cause` 与请求之间相隔的毫秒数，让读者自己判断可信度 |
| `phase` | 请求行才有：`load`（页面刚导航后的加载期，同标签页最近一次 `nav` 之后、期间没有新动作）、`action`（动作引发）、`idle`（既不是加载也不是动作：轮询、后台自发） |
| `endpoint` | 请求行才有：`方法 接口名`（写入时由 `endpointOf` 算好，见 A4），也就是 task 里 `@endpoint` 的写法 |
| `noise` | 1 = 埋点、广告，默认不看 |
| `file` | 指向请求文件、文档或快照，路径相对站点的 `log/` 目录：`<段>/<文件名>` |
| 其余 | 沿用 yodo：action 行的 `actionType`、`role`、`name`、`selector`、`value`、`deltaY`；request 行的 `requestType`、`method`、`url`、`status` |

```json
{"seq":1283,"t":1792566434500,"win":"user","src":"user","tab":7,"type":"action","actionType":"click","role":"button","name":"Like","selector":"[data-testid=\"like\"]"}
{"seq":1284,"t":1792566434609,"win":"user","src":"page","tab":7,"type":"request","requestType":"fetch","method":"POST","url":"https://x.com/i/api/graphql/…/FavoriteTweet","endpoint":"POST graphql FavoriteTweet","status":200,"cause":1283,"causeDt":109,"phase":"action","file":"000012/001284_POST_x.com_i_api_graphql_FavoriteTweet.json"}
```

### A2. 请求文件

和 yodo 的请求文件一致，另加 `seq`、`win`、`cause`、`phase`、`endpoint`、`rid`（去内存里找原始请求用）；失败的请求有 `error`，被截断的响应有 `truncated: true`，没读到响应体的写明原因 `bodyOmitted`：

```json
{
  "seq": 1284, "win": "user", "cause": 1283, "phase": "action", "endpoint": "POST graphql FavoriteTweet", "rid": "d:42",
  "method": "POST",
  "url": { "bareUrl": "https://x.com/i/api/graphql/…/FavoriteTweet", "query": {} },
  "frameUrl": { "bareUrl": "https://x.com/elonmusk/status/111", "query": {} },
  "headers": { "content-type": "application/json", "x-csrf-token": "⟨secret_a1b2c3d4e5f6:opaque⟩" },
  "requestBody": { "variables": { "tweet_id": "111" }, "queryId": "…" },
  "status": 200,
  "responseHeaders": { "content-type": "application/json" },
  "responseBodyPath": "000012/001284_POST_x.com_i_api_graphql_FavoriteTweet.response.json",
  "startedAt": 1792566434609, "endedAt": 1792566434795
}
```

### A3. endpoints.json（取代 endpoints.md；不排序，只提供信号）

```json
{ "site": "x.com", "updatedAt": 1792566500000, "endpoints": [
  { "key": "POST graphql FavoriteTweet", "method": "POST", "host": "x.com", "name": "graphql FavoriteTweet",
    "count": 3, "firstSeq": 1100, "lastSeq": 1284, "lastStatus": 200,
    "userTriggered": 3, "onLoad": 0, "idle": 0, "lastCause": "user click button[Like]",
    "variables": ["tweet_id"], "shape": "data.favorite_tweet", "replayable": true,
    "samples": [{ "seq": 1284, "file": "000012/001284_POST_x.com_i_api_graphql_FavoriteTweet.json", "available": true }],
    "task": null },
  { "key": "GET graphql HomeTimeline", "method": "GET", "host": "x.com", "name": "graphql HomeTimeline",
    "count": 41, "firstSeq": 900, "lastSeq": 1301, "lastStatus": 200,
    "userTriggered": 14, "onLoad": 3, "idle": 24, "lastCause": "user scroll",
    "variables": ["variables.count", "variables.cursor"], "shape": "data.home.home_timeline_urt.{instructions,metadata}", "replayable": true,
    "samples": [], "task": "x-home-timeline" }
] }
```

- `key` 就是 task 文件头 `@endpoint` 的写法；`task` 是覆盖它的 task 名，没有为 `null`。
- `userTriggered`、`onLoad`、`idle` 按 `phase` 统计，是 agent 判断"用户刚才做的那个动作对应哪个接口"的依据：**`userTriggered > 0` 且 `onLoad == 0`** 的接口最像用户的显式操作。方法只是弱信号（本机 GET 占 80%，内部系统几乎全 POST，`query_*` 也是 POST）。
- 聚合不排序。排序、过滤由 agent 用脚本做，SKILL.md 里放现成片段。
- 聚合在写入时增量维护，不再每次重读 20000 行；`task` 字段在下一次写入、`run`、`delegate` 时刷新。

### A4. 接口名（endpointOf）

沿用现有规则（路径里的长数字、哈希、uuid 换成 `:id`；Twitter 风格 `/graphql/<queryId>/<操作名>` 取操作名），新增：同一路径、请求体顶层有字符串型的 `operationName`、`action`、`method`、`cmd`、`type` 之类的字段时，把它拼进接口名（如 `/graphql#FavoriteTweet`、`/rpc#listUsers`）。否则 `POST /graphql`、`POST /rpc` 会把所有不同操作并成一个接口。因此 `endpointOf` 的入参增加请求体，写入时算好存进 `endpoint` 字段。

### B. 最终 api 方案（agent 看到的接口）

分三类：**文件（读）、脚本（查）、命令（做）**。

#### B1. 文件（读）

| 文件 | 回答什么 | 谁用 |
|---|---|---|
| `endpoints.json` | 这个站点有哪些接口，哪些还没有 task，哪些像用户的显式操作 | 主 agent 决定派谁；subagent 找样本 |
| `log/*/timeline.user.jsonl` | 用户做了什么，哪个操作引发了哪个请求 | 主 agent 判断交接上下文 |
| `log/*/timeline.<窗口>.jsonl` | 某个窗口做了什么 | 对应的 subagent 看自己 |
| 请求文件、响应体 | 一个请求的完整样子 | subagent |
| `tasks/*.js` | 现有 task，文件头是接口覆盖信息和 `@note` 经验 | `ls`、`rg '@endpoint'` |
| `debug/<窗口号>/material/` | 交接材料（冻结） | 对应的 subagent |

**没有任何 md**。数据格式的说明在 `SKILL.md`。

#### B2. 脚本（查）

Node ≥24 是 TabBot 的硬依赖，所以 `node -e` 一定有；Python 和 `rg` 通常也有。SKILL.md 里放三个现成片段，避免每个 agent 重写：

```bash
# 1. 像用户显式操作的接口（用户触发过、不在页面加载期发、还没有 task）
node -e '
const d = JSON.parse(require("fs").readFileSync("/Users/me/.tabbot/sites/x.com/endpoints.json", "utf8"));
for (const e of d.endpoints.filter((e) => !e.task && e.userTriggered > 0 && e.onLoad === 0))
  console.log(e.key, "×" + e.count, "#" + e.lastSeq, e.lastCause, e.replayable ? "✓" : "✗", e.variables.join(","));'

# 2. 用户最近的操作，以及每个操作引发了哪些请求
python3 - <<'EOF'
import json, glob
rows = [json.loads(l) for f in sorted(glob.glob("/Users/me/.tabbot/sites/x.com/log/*/timeline.user.jsonl")) for l in open(f)]
rows.sort(key=lambda r: r["seq"])
by = {r["seq"]: r for r in rows}
for r in rows[-300:]:
    if r["type"] == "request" and r.get("phase") == "action" and not r.get("noise"):
        c = by.get(r.get("cause"), {})
        print(c.get("actionType"), c.get("name") or c.get("selector"), "→", r["endpoint"], r["status"], "#%d" % r["seq"])
EOF

# 3. 找页面上看到的值在哪个响应里
rg -l "独一无二的标题" /Users/me/.tabbot/sites/x.com/log/*/*.response.json
```

#### B3. 命令（做）

只保留必须由 TabBot 做的 8 个：

| 命令 | 谁用 | 作用 | 示例输出 |
|---|---|---|---|
| `tabbot run <task> [--参数 值] [--dry]` | 主 agent（run 窗口） | 执行 task，用户拿到的结果必须来自这里 | `{ "mode": "执行", "status": "success", "result": … }` |
| `tabbot compose '<代码>'` | 主 agent | 只组合 task，不碰页面 | 同上 |
| `tabbot delegate <task 名> --goal "…" --site <站点> [--endpoint "方法 接口名"] [--fix]` | 主 agent | 开 debug 窗口，导出交接材料，输出 brief | brief 全文，含窗口号 `debug-ab12` |
| `tabbot debug --window <号> open\|snapshot\|text\|act\|replay\|close` | subagent | 在自己的 debug 窗口里调试 | `[调试] debug 窗口 debug-ab12（3/80），目标 task：like-tweet` |
| `tabbot run <task> --window <号>` | subagent | 在自己的窗口里验证自己的 task，成功就收回窗口 | 同 `run` |
| `tabbot tabs` | 主 agent | 用户当前打开的页面 | `2 个标签页 …` |
| `tabbot status` | 主 agent | 日志占用、daemon、当前 debug 窗口、未完成的 draft task | `debug 窗口：debug-ab12（like-tweet，3/80）` |
| `tabbot daemon restart`、`tabbot doctor` | 运维 | 重启 holder、诊断 | — |

`replay` 示例（编号对应请求文件名的前缀，站点由 debug 窗口登记的站点得出）：

```bash
tabbot debug --window debug-ab12 replay 1284 --set body.variables.tweet_id=222 --yes
# ✓ 重放 #1284（改了 body.variables.tweet_id）：POST → 200
# JSON 对象，字段：data
```

**规则**（TabBot 强制）：

- `debug` 必须带 debug 窗口号；run 窗口、不存在、已收回、用完 80 次，一律拒绝。
- `compose` 只能 `task(名字, 参数)`，任何页面操作被拒绝。
- 同一个 task 名同时只能有一个 debug 窗口；**一个 subagent 只学一个站点的一个接口**，跨站点任务拆成多个 subagent。
- debug 窗口收回的三种方式：自己的 task `run` 成功；`debug … close`；30 分钟没有操作。
- 窗口被用户关掉，下次用到时自动重开（run 和 debug 一样）；holder 重启一切归零。
- `delegate` 遇到同名 task 存在：若是 `draft` 且没有活跃的 debug 窗口，提示"上次未完成，加 `--fix` 续"，并把旧文件路径写进 brief；`status` 会列出所有 draft。

**被删除的命令**：`log`、`sql`、`req find`、`req show`、`context`、`api`、`task list`、`task new`。

### C. 交接材料（debug 视图的隔离）

从 yodo 学到的关键一点：**subagent 的输入就是一份"录制材料"**。`delegate` 时导出到 `debug/<窗口号>/material/`，格式和 yodo 的录制目录一样，并且：

1. **只含一个站点**，与 `--site` 一致。
2. **逐字复制**原始行和原始文件（硬链接，不行就复制），不改写、不汇总。
3. **按窗口分文件**，沿用 `timeline.<窗口>.jsonl`：
   - 包含：`user`、`run`、**已收回**的 debug 窗口。
   - **排除：仍开着的其他 debug 窗口**（它们正在试错，不能混进来）。
4. **以目标接口的样本为锚点**，不是固定时间窗：
   - 给了 `--endpoint`：取它最近 20 个样本，对每个样本带上它的 `cause` 链，以及同一标签页前 60 秒的行；再加该站点用户窗口最近 30 分钟的行。
   - 没给 `--endpoint`：取用户窗口最近 30 分钟里 `phase` 为 `action` 的请求，最多 50 个，同样带上 `cause` 链和前 60 秒。
5. **清单 `manifest.json`**（结构化，告诉 agent 里面有什么、缺什么）：

```json
{ "site": "x.com", "createdAt": 1792566600000, "fromSeq": 1100, "toSeq": 1310,
  "windows": { "included": ["user", "run", "debug-9f31"], "excluded": ["debug-c2d4"] },
  "counts": { "rows": 214, "requests": 63, "requestFiles": 63, "responseBodies": 58 },
  "warnings": [
    "后台标签页在此期间有 41 个请求只有计数，没有内容（bg 行）",
    "2 个响应被截断（truncated），见请求文件",
    "目标接口只有 1 个样本",
    "目标接口的样本 #1284 的原始请求已不在内存，replayable 为 false：需要 subagent 自己 debug open 加 act 触发一次" ] }
```

这份材料在开窗口那一刻冻结，所以**debug 视图的隔离不需要任何过滤**：subagent 读 `material/` 加它自己的 `timeline.debug-ab12.jsonl`，不受同时进行的用户操作和其他 debug 窗口影响。

### D. 整体效果

#### D1. 一次完整任务（"给这条推文点赞"）

1. **主 agent** 跑片段 1，或直接读 `/Users/me/.tabbot/sites/x.com/endpoints.json`，看到 `POST graphql FavoriteTweet` 的 `task` 是 `null`、`userTriggered` 是 3、`onLoad` 是 0、`lastCause` 是用户点赞，`lastSeq` 是 `1284`。
2. `tabbot delegate like-tweet --goal "给指定推文点赞" --site x.com --endpoint "POST graphql FavoriteTweet"`。TabBot 创建 `debug-ab12` 窗口，导出 `material/`（含 `manifest.json`），输出 brief。
3. **subagent**：
   - 先读 `manifest.json` 看有什么、缺什么。
   - 读 `material/001284_….json` 看请求头和请求体。
   - `replayable` 是 `false` 时（holder 重启过），`debug open` 加 `debug act` 在自己的窗口里触发一次，之后原始请求进内存，就能重放。
   - `tabbot debug --window debug-ab12 replay 1284 --set body.variables.tweet_id=222 --yes` 真发一次。
   - 直接写 `/Users/me/.tabbot/sites/x.com/tasks/like-tweet.js`，文件头 `@endpoint POST graphql FavoriteTweet`，学到的坑写成 `@note` 行。
   - `tabbot run like-tweet --tweet 222 --window debug-ab12` 跑通：task 变 `verified`，窗口收回。
4. **主 agent**：`endpoints.json` 里这个接口的 `task` 变成 `like-tweet`；`tabbot run like-tweet --tweet 333` 毫秒级完成，结果交给用户。

#### D2. 现在与之后

| 项 | 现在 | 之后 |
|---|---|---|
| 站点 | 注册域名（`example.com` 把 `logs`、`console`、`expt` 混在一起） | 页面 host，去 `www.` |
| 存储 | SQLite 分段 + 哈希命名的 body 文件，`detail` 是字符串里的 JSON | JSONL + 每次请求一个 JSON（yodo 格式），都是对象 |
| 运行时依赖 | `node:sqlite`（Node 24 里是实验性，要过滤警告） | 无 |
| 容量与保留 | 总 500MB，按时间先进先出；重度站点几小时把别人挤掉 | 总 2GB，两层：时间线与请求文件保留一个多月，响应体保留约 6 天；接口样本受保护；每站点有上限 |
| 重复请求 | 5 分钟内只计数、不写行（丢轮询间隔） | 每次都写一行；响应体按哈希去重 |
| 谁做的 | 只有 `src` | `src` + 窗口物理分文件 |
| 因果 | 同标签页 2 秒内最近动作 | 增加 `causeDt` 与 `phase`（`load` / `action` / `idle`） |
| 看某站点的接口 | `api <站点>`：先取 20000 行再在内存里筛 | 读 `endpoints.json`（写入时增量维护） |
| 读日志的方式 | `log`、`sql`、`req find`、`req show`、`context`、`api` 六个命令 | 文件加 `node -e` / Python / `rg`，0 个读命令 |
| debug 的历史隔离 | 无 | 窗口物理分文件 + 交接材料冻结，并排除仍开着的其他 debug 窗口 |
| 材料的准确性 | 无 | 逐字复制；`manifest.json` 写明窗口、数量和缺口 |
| task 位置与覆盖标记 | 全局 `task/`，覆盖标记靠 `api` 命令 | `sites/<站点>/tasks/`，覆盖标记在 `endpoints.json` 的 `task` 字段 |
| 站点的经验 | 无处存放 | task 文件头的 `@note` 行 |
| 顶层命令 | 14 个 | 8 个，都是必须由 TabBot 做的 |
| 并发限制 | 同站点最多 2 个 subagent | 同一 task 名只能有一个，站点不限 |

#### D3. 做不到或需要注意

- 没有 SQL。跨行聚合要用脚本；常用聚合已在 `endpoints.json`，其余在 Python 里几行字典。
- 后台标签页的请求只有计数，没有内容；WebSocket、`sendBeacon`、Worker、事件流不记录。这些缺口写在 `manifest.json` 的 `warnings` 里，不假装完整。
- `endpoints.json` 可能比日志旧一个节流周期；要最新就读 `timeline.*.jsonl`。
- 隔离不是安全边界：agent 能读所有站点目录；"只看该看的"靠交接材料和物理分文件，不强制。
- **不转换旧日志**：旧日志和旧 task 不迁移内容，升级时只改名为 `journal.old`、`task.old` 保留，由用户自己决定何时删除。新格式的验证数据靠第 7 步在真实 Chrome 里现场录制。
- 站点改域名后目录会断；`zhuanlan.zhihu.com` 与 `www.zhihu.com` 是两个站点，历史不合并。
- 登录态内容落在 `/Users/me/.tabbot/sites`，测完要删。

## 0. 前提与默认选择

| 项 | 默认 |
|---|---|
| 窗口 | 三种：`user`、`run`（主 agent 长期持有，只执行 task）、`debug-xxxx`（一个 subagent 一个，派出时开、收回时关） |
| 粒度 | 窗口、站点（页面 host，去 `www.`）、接口（`方法 接口名`）、日志编号（`seq`）；origin 只在执行层内部使用，不对外 |
| 事件来源 | `src` 的 `human` 改成 `user` |
| `debug close` | 删旧的"还回页面"，把 `end` 改名为 `close`（关掉这个 debug 窗口） |
| task 名 | 仍然全局唯一，`tabbot run <名字>` 不变，文件落在站点目录的 `tasks/`，运行时扫描所有站点找到它；约定以站点简称做前缀 |
| 存储 | 去掉 SQLite，改 JSONL + 文件；字段名沿用 yodo；窗口分文件；总 2GB 两层保留 |
| 聚合文件写入 | 脏了之后 2 秒内写一次 |
| 旧数据 | `setup.js` 不删，改名为 `journal.old`、`task.old`，提示用户自行删除 |

不变的：扩展（固定 ABI）、holder、relay、recorder / executor、脱敏与别名、原始请求只在内存、task 运行时与 worker。

## 1. 步骤

每一步结束都跑 `npm run check` 和 `npm test`（改完全部文件后一次性跑）。

### 第 1 步：窗口与命名收尾

对应已经做完但没有 commit 的 run 窗口 / debug 窗口改动。

| 文件 | 改什么 |
|---|---|
| `/Users/me/Code/x/TwoCursor/skills/tabbot/src/run/window.ts` | `MAIN_KEY` 改成 `"run"` |
| `/Users/me/Code/x/TwoCursor/skills/tabbot/src/run/debug-windows.ts` | 窗口号前缀改成 `debug-`；登记站点；`end` 改名为 `close` |
| `/Users/me/Code/x/TwoCursor/skills/tabbot/src/journal/commands.ts` | 删旧的 `closeCommand`；`delegate` 要求必填 `--site` |
| `/Users/me/Code/x/TwoCursor/skills/tabbot/src/journal/types.ts`、`ingest.ts`、`digest.ts`、`commands.selfcheck.ts` | `human` 改成 `user` |

### 第 2 步：存储改为按站点、按窗口的 JSONL

最大的一步，破坏性的。

| 文件 | 改什么 |
|---|---|
| `/Users/me/Code/x/TwoCursor/skills/tabbot/src/utils/constants.ts` | 换成 `SITES_DIR`、总额度 2GB 及各层额度（见"存储预算"）、换段条件（重量层 64MB 或 24 小时）；盐文件路径搬家 |
| `/Users/me/Code/x/TwoCursor/skills/tabbot/src/utils/url.ts`、`digest.ts` | `siteOf` 改为取页面 host 去前导 `www.`；`normalizeSite` 同步；`endpointOf` 增加请求体入参（A4） |
| `/Users/me/Code/x/TwoCursor/skills/tabbot/src/journal/types.ts` | 删 `SCHEMA`、`NewEvent`；改为 timeline 行类型 `Row` 和请求文件类型 `RequestFile` |
| `/Users/me/Code/x/TwoCursor/skills/tabbot/src/journal/sitelog.ts`（新增，取代 `store.ts`） | 按站点路由；每个窗口一个 `timeline.<窗口>.jsonl`；全局编号 `reserve()` 并落盘到 `sites/.seq`；写请求文件，响应体按内容哈希写入或复用；换段 |
| `/Users/me/Code/x/TwoCursor/skills/tabbot/src/journal/retention.ts`（新增） | 两层淘汰：重量层只删非样本的响应体、文档、快照；轻量层删整段；样本保护；单站点与总额度 |
| `/Users/me/Code/x/TwoCursor/skills/tabbot/src/journal/reqfile.ts`（新增） | 把脱敏后的请求拼成 yodo 格式的请求文件（`url.query`、`requestBody` 解析成对象），带 `error`、`truncated`、`bodyOmitted` |
| `/Users/me/Code/x/TwoCursor/skills/tabbot/src/journal/ingest.ts` | 站点由**页面**的 host 得出；命令记录按标签页最后所在站点归属，找不到的归 `_other`；`isAgentTab` 换成 `winOf(tab)`，非用户窗口的 `src` 记为 `agent`；**不再去重**，每次请求都写行；计算 `causeDt`、`phase`；记录 `endpoint`；`cmd` 开始时预留 `seq`、结束时写一行 |
| `/Users/me/Code/x/TwoCursor/skills/tabbot/src/run/window.ts` | 提供 `winOf(tab)` |
| `/Users/me/Code/x/TwoCursor/skills/tabbot/src/holder.ts` | 构造新的 `sitelog` 和 `ingest`，淘汰在批处理后触发 |
| `/Users/me/Code/x/TwoCursor/skills/tabbot/src/journal/sqlite.ts`、`query.ts`、`store.ts`、`format.ts` | 删除（不再使用的） |
| `/Users/me/Code/x/TwoCursor/skills/tabbot/src/journal/replay.ts`、`replay-core.ts` | 改为从请求文件取模板，`--set` 的路径沿用 |

验证点：

- 淘汰只动本站点，不影响别的站点；重量层淘汰不删时间线和请求文件，也不删受保护的样本。
- 编号重启后继续递增、全局唯一。
- 不同窗口的行落在不同文件里，`cat timeline.user.jsonl` 里没有 run 或 debug 窗口的行。
- 同一个请求出现两次，写两行，响应体只存一份。
- `sites/` 下任何文件都不含 token 真值。

### 第 3 步：接口聚合、交接材料与 task 搬家

| 内容 | 实现 |
|---|---|
| `endpoints.json` | 新增 `/Users/me/Code/x/TwoCursor/skills/tabbot/src/journal/endpoints.ts`：每个站点一个内存聚合（字段见 A3）；`variables`、`shape` 复用 `digest.ts` 的 `variablesOf`、`shapeOf`，只在更新"最近一次"时算；`userTriggered` / `onLoad` / `idle` 按 `phase` 计；`samples` 登记每个接口最近 5 次成功请求，并通知 `retention.ts` 保护；`task` 读该站点 `tasks/` 的 `@endpoint`（按 mtime 缓存）；淘汰整段后把失效的样本标 `available: false`；节流后原子写（临时文件加 rename）；holder 启动时从文件读回 |
| 交接材料 | 新增 `/Users/me/Code/x/TwoCursor/skills/tabbot/src/journal/material.ts`：`exportMaterial(站点, 目录, {endpoint?})`，规则见 C（只含一个站点、逐字复制、按窗口分文件、排除仍开着的其他 debug 窗口、以样本为锚点、写 `manifest.json`）；硬链接，不行就复制 |
| `/Users/me/Code/x/TwoCursor/skills/tabbot/src/journal/digest.ts` | 保留 `siteOf`、`normalizeSite`、`endpointOf`、`shapeOf`、`variablesOf`、`actionLabel`；删 `buildCatalog`、`buildContext`、`formatCatalog` |
| task 搬家 | `/Users/me/Code/x/TwoCursor/skills/tabbot/src/run/tasks.ts`：`TASK_DIR` 改为扫描 `sites/*/tasks`；`taskFile`、`listTasks`、`coveredEndpoints` 改成按站点；SDK `task-lib` 同步到 `/Users/me/.tabbot/lib/`；task 里的 import 路径改为 `../../../lib/index.js`；`compose` 生成的临时文件的 import 同步（`/Users/me/Code/x/TwoCursor/skills/tabbot/src/run/runner.ts`） |
| `@note` | task 文件头新增可选的 `@note` 行（`headerTags` 已能读任意标签，不用改解析） |
| `delegate` | `--site` 必填；task 名全局唯一（跨站点也查）；同名 draft 且没有活跃窗口时提示用 `--fix` 续；创建站点目录和 `debug/<窗口号>/`；导出 `material/`；brief 指向这些文件 |

### 第 4 步：命令面收缩

| 文件 | 改什么 |
|---|---|
| `/Users/me/Code/x/TwoCursor/skills/tabbot/src/journal/commands.ts` | 删除 `log`、`sql`、`req`、`context`、`api`、`task`；`replay` 通过 debug 窗口登记的站点定位请求文件；`status` 列出 debug 窗口和 draft task |
| `/Users/me/Code/x/TwoCursor/skills/tabbot/src/protocol.ts` | `USAGE`、帮助文字同步 |
| `/Users/me/Code/x/TwoCursor/skills/tabbot/src/run/brief.ts` | 重写为文件优先的流程：先读 `material/manifest.json`，再读 `material/` 和 `endpoints.json`，`replayable` 为 `false` 时自己触发一次，再 `debug`；只学一个站点的一个接口；页面要登录就停下来请主 agent 转告用户；回报里仍要求副作用清单 |

### 第 5 步：自检

按 `/Users/me/Code/x/TwoCursor/AGENTS.md` 2.2：一个测试只守一个"坏了就会静默出错或泄密"的点，改完全部文件后一次性跑。

| 文件 | 守什么 |
|---|---|
| `/Users/me/Code/x/TwoCursor/skills/tabbot/src/journal/sitelog.selfcheck.ts`（取代 `store.selfcheck.ts`） | 编号持久且全局唯一；不同窗口的行落在不同文件；重复请求写两行、响应体只存一份；`sites/` 下没有 token 真值 |
| `/Users/me/Code/x/TwoCursor/skills/tabbot/src/journal/retention.selfcheck.ts`（新增） | 按站点淘汰互不影响；重量层淘汰不删时间线、请求文件和受保护的样本；轻量层删整段后样本标为不可用 |
| `/Users/me/Code/x/TwoCursor/skills/tabbot/src/journal/ingest.selfcheck.ts` | 站点由页面 host 得出；`win` 归属；`phase` 区分 `load` 与 `action`；`causeDt` |
| `/Users/me/Code/x/TwoCursor/skills/tabbot/src/journal/endpoints.selfcheck.ts`（新增） | 聚合的 `count`、`userTriggered`、`onLoad`、`task` 覆盖标记正确；`/graphql` 按 `operationName` 拆成不同接口；`endpoints.json` 里没有 token 真值 |
| `/Users/me/Code/x/TwoCursor/skills/tabbot/src/journal/material.selfcheck.ts`（新增） | 材料只含一个站点；排除仍开着的其他 debug 窗口；逐字复制；`manifest.json` 写明缺口 |
| `/Users/me/Code/x/TwoCursor/skills/tabbot/src/journal/commands.selfcheck.ts` | 缩小后的命令面：`delegate`（导出 `material/`、同名 task 不派两个、draft 提示 `--fix`）、`debug`（run 窗口不能调试、`close` 收回）、`run`、`replay` 校验 |

删除随命令一起消失的断言，不留空壳测试。

### 第 6 步：文档与迁移

- `/Users/me/Code/x/TwoCursor/skills/tabbot/SKILL.md`：新增"数据格式"一节（目录、timeline 行、请求文件、`endpoints.json`、`@note`）和三个脚本片段，改成文件优先的流程。这是**唯一**描述数据格式的地方。
- `/Users/me/Code/x/TwoCursor/skills/tabbot/ARCHITECTURE.md`：第 5-8 节、测试一节、排障表。
- `/Users/me/Code/x/TwoCursor/skills/tabbot/install.md`：迁移说明。
- `/Users/me/Code/x/TwoCursor/AGENTS.md`：调试路径从 `/Users/me/.tabbot/journal` 改为 `/Users/me/.tabbot/sites`，含登录态内容、测完要删。
- `/Users/me/Code/x/TwoCursor/CHANGELOG.md`、`/Users/me/Code/x/TwoCursor/README.md`、`/Users/me/Code/x/TwoCursor/PRIVACY.md`：路径与能力描述。
- `/Users/me/Code/x/TwoCursor/skills/tabbot/setup.js`、`/Users/me/Code/x/TwoCursor/skills/tabbot/src/store/deploy.ts`：升级时执行改名迁移。
- 不做旧日志的转换工具：`setup.js` 只负责把旧目录改名，不读取、不转换其中的内容。

### 第 7 步：真实 Chrome 验证

按 `/Users/me/Code/x/TwoCursor/AGENTS.md` 2.3，用真实 Chrome 和 Claude in Chrome：

1. `node /Users/me/Code/x/TwoCursor/skills/tabbot/setup.js` 重装，在 `chrome://extensions` 刷新 TabBot。
2. 在**至少三个**站点上操作（一个公共站点、一个 GraphQL 站点、一个公司内部多子域站点），确认站点按 host 分目录、`timeline.user.jsonl`、请求文件、`endpoints.json` 的 `phase` 统计与实际相符。
3. 用 `node -e` 和 Python 读上面几个文件，确认字段与 `SKILL.md` 一致；跑三个脚本片段。
4. `tabbot delegate` 派一个 subagent，看它读 `material/manifest.json`、`debug`、写 task、`run` 跑通后窗口收回。
5. 并行派两个 subagent（不同 task，同一站点），确认第二个的 `material/` 排除了第一个的行，且两个窗口各自的 `timeline.<窗口>.jsonl` 互不混。
6. 重启 holder，确认窗口清空、编号继续递增、`endpoints.json` 读回、`replayable` 变 `false`，subagent 能自己触发后重放。
7. 观察 24 小时：磁盘占用、文件数量、淘汰是否按预期。
8. 测完删除 `/Users/me/.tabbot/sites`。

## 2. 提交与顺序

当前分支 `refactor/thin-extension`，run / debug 窗口的改动还没 commit。建议：

1. 先把已有改动单独 commit（需要用户明确同意）。
2. 第 1 步到第 6 步各自一个提交，第 2 步出问题可以单独回退。
3. 第 7 步通过后再谈发布分支（`/Users/me/Code/x/TwoCursor/AGENTS.md` 3.3 的流程）。

## 3. 风险

| 风险 | 说明 / 对策 |
|---|---|
| 写入路径、淘汰、样本保护、编号落盘 | 静默出错的地方，第 5 步自检要覆盖 |
| 追加写不能改行 | `cmd` 结果改为结束时写一行；`cmd` 行的位置晚于它引发的请求，读者按 `seq` 排序 |
| 文件数量 | 每次请求 1 到 2 个文件：按本机实测约 7000 次请求/天，一个 24 小时段约一万多个小文件；整段删除、只删响应体都是批量 `unlink`，未压测，第 7 步观察 |
| `phase` 判断可能出错 | 以"同标签页最近一次 `nav` 之后、期间没有新动作"为 `load`，是启发式；`causeDt` 与原始 `nav` 行都在，读者可以自己重算 |
| 聚合文件"略旧" | 节流后写；`SKILL.md` 写明：要最新就读 `timeline.*.jsonl` |
| 隔离不是安全边界 | agent 能读所有站点目录；靠物理分文件、交接材料和约定，不强制 |
| 没有 SQL | 跨行聚合要用脚本；常用聚合已在 `endpoints.json`，三个现成片段在 `SKILL.md` |
| 破坏性迁移 | 存储布局、task 位置、命令面、站点划分都变；旧数据改名保留，不删 |
| 改造期间不一致 | 分支上会有一段时间命令面和文档不一致，不适合发布 |
| 站点改域名、同产品多子域 | 目录名跟着断；历史不合并，暂不处理 |
| `cause` 的准确性 | 本机实测只有 17% 的请求有 `cause`；点击引发的请求扇出可达 10 个以上；`causeDt` 与 `phase` 缓解，不能保证因果正确 |
| 样本保护让重量层实际用量超出额度 | 每站点样本上限 100MB，计入总额度的预留，不另算 |

## 4. 暂不做

- Python 版 task SDK（Node ≥24 已是依赖，Python 不一定装；等真的需要再说）。
- 用 PreToolUse hook 对主 agent 调用 `tabbot debug` 做硬拒绝（`/Users/me/Code/x/TwoCursor/skills/tabbot/ARCHITECTURE.md` 第 11 节已记）。
- 窗口被完全遮住时 `requestAnimationFrame` 可能停止的问题（同上）。
- 同一产品多子域的历史合并。

## 5. 实现时的调整

- 文件引用统一写成相对站点 `log/` 目录的 `<段>/<文件名>`（`file`、`responseBodyPath`），这样后出现的相同响应体可以直接指向较早的段；交接材料里保持同样的相对路径，所以行逐字复制后引用仍然有效。
- 站点目录名是站点字符串里非 `[A-Za-z0-9._-]` 的字符换成下划线（`localhost:3000` → `localhost_3000`）。
- 编号上界按 1000 一块落盘到 `sites/.seq`，崩溃只会留下编号空洞，不会重复。
- 请求文件另记 `tab`（原始请求在内存里按标签页加 `rid` 存，重放靠它找回来）。
- `recorder.js` 给每个请求加了 `at`（请求开始时离文档开始的毫秒数），`phase` 的 `load` 靠它判断；这是页面脚本的改动，要在 `chrome://extensions` 里刷新 TabBot 才生效（没有 `at` 时只靠 `nav` 行判断）。
- `delegate` 对写错的 `--endpoint` 只提示、不拒绝（仍然开窗口）。
- 旧数据迁移：`setup.js` 调 `retireLegacyData` 改名，旧的脱敏盐复制到 `~/.tabbot/alias-salt`；有自检守着（`store/deploy.selfcheck.ts`）。
- `tools/verify-pack.mjs` 已按新布局更新（检查 `sites/` 不被动、旧 `journal` 被改名保留）。
