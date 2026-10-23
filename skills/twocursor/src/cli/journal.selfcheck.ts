// 常驻录制的 CLI：HOME 指向临时目录，真实起 twocursor 子进程，读事先写好的日志。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "twocursor-journal-cli-"));
process.env.HOME = home;
const { Ingestor } = await import("../journal/ingest.ts");
const { JournalStore } = await import("../journal/store.ts");
const { JOURNAL_DIR } = await import("../utils/constants.ts");
assert.ok(JOURNAL_DIR.startsWith(home), "日志目录应在临时 HOME 下");

const store = new JournalStore();
await store.open();
const ingest = new Ingestor(store);
const page = "https://www.ithome.com/";
const t = Date.now() - 5 * 60_000;
ingest.handleBatch([
  { k: "ev", t, tab: 4, page, type: "click", trusted: true, pressure: 0.5, target: { tag: "a", text: "公司客服称微信已适配" } },
  { k: "net", t: t + 50, tab: 4, page, via: "xhr", method: "GET", url: "https://www.ithome.com/block/rank.html", status: 200, ct: "text/html", body: "<div>rank</div>", size: 15 },
  { k: "net", t: t + 60, tab: 4, page, via: "fetch", method: "POST", url: "https://apm.ithome.com/collector/apm", status: 200, ct: "text/plain", body: "", size: 0 },
] as never);
store.close();

const run = (...args: string[]) => spawnSync(process.execPath, [new URL("./twocursor.ts", import.meta.url).pathname, ...args], { env: { ...process.env, HOME: home }, encoding: "utf8", timeout: 30_000 });

// log：第一行是结论，其后一行一个事件；默认不含噪声；stderr 干净（没有 sqlite 的实验性警告）
const log = run("log");
assert.equal(log.status, 0, log.stdout + log.stderr);
assert.equal(log.stderr, "");
const lines = log.stdout.trim().split("\n");
assert.match(lines[0]!, /^2 条事件，其中人的操作 1 条（游标 2，下次加 --since 2）$/);
assert.match(lines[1]!, /^#1 \d\d:\d\d:\d\d tab4 human click a\[公司客服称微信已适配\]$/);
assert.match(lines[2]!, /^#2 .* tab4 page  GET \/block\/rank\.html 200 15B body:\d{4}-\d{2}-\d{2}\/[0-9a-f]{16}\.txt ← #1$/);
assert.match(run("log", "--all").stdout, /\[noise\]/);
assert.match(run("log", "--since", "2").stdout, /^无新事件（游标 2）/);
assert.match(run("log", "--src", "agent").stdout, /^无新事件/);
assert.equal(JSON.parse(run("log", "--json").stdout).length, 2);
assert.equal(JSON.parse(run("log", "--src", "bad").stdout).status, "failure");

// 响应体是普通文件，agent 可以直接 rg
const body = fs.readdirSync(path.join(JOURNAL_DIR, "bodies"), { recursive: true, withFileTypes: true }).find((e) => e.isFile());
assert.ok(body && fs.readFileSync(path.join(body.parentPath, body.name), "utf8").includes("rank"));

// sql
const sql = run("sql", "SELECT src, COUNT(*) AS n FROM events WHERE noise = 0 GROUP BY src ORDER BY src");
assert.equal(sql.status, 0, sql.stdout + sql.stderr);
assert.deepEqual(sql.stdout.trim().split("\n"), ["2 行", "src\tn", "human\t1", "page\t1"]);
assert.equal(JSON.parse(run("sql", "DELETE FROM events").stdout).status, "failure");

// wait：没有新的人的操作就超时；--since 之前的不算
assert.match(run("wait", "--since", "2", "--timeout", "1").stdout, /^无变化（等了 1s，游标 2）/);
const done = run("wait", "--since", "0", "--idle", "1", "--timeout", "5");
assert.match(done.stdout, /^人已停手（静默 1s），新增 2 条（游标 2）/);

// status、sites（没有 daemon 时只保存，并说明）
assert.match(run("status").stdout, /录制：0 个站点，1 天 3 条事件/);
const add = run("sites", "add", "https://www.zhihu.com/hot", "ithome.com");
assert.equal(add.status, 0, add.stdout + add.stderr);
assert.match(add.stdout, /已加入，现在录制 2 个站点：ithome\.com, zhihu\.com。扩展没连上，连上后自动生效。/);
assert.match(run("sites").stdout, /录制 2 个站点：ithome\.com, zhihu\.com/);
assert.match(run("sites", "rm", "zhihu.com").stdout, /已移除，现在录制 1 个站点：ithome\.com/);
assert.equal(JSON.parse(run("sites", "add").stdout).status, "failure");

console.log("journal cli selfcheck ok");
