import assert from "node:assert/strict";
import { noiseReason, shouldStoreBody } from "./filter.ts";

const page = "https://www.zhihu.com/";
const req = (url: string, method = "GET", extra: { status?: number; via?: string } = {}) => noiseReason({ url, method, page, via: extra.via ?? "fetch", status: extra.status });

// 第一方埋点：知乎自己的上报都是同站，只有启发式抓得到
assert.equal(req("https://zhihu-web-analytics.zhihu.com/api/v2/za/logs/batch", "POST"), "telemetry-host");
assert.equal(req("https://datahub.zhihu.com/collector/zlab", "POST"), "telemetry-host");
assert.equal(req("https://www.zhihu.com/zbst/events/r", "POST"), "telemetry-path");
assert.equal(req("https://www.zhihu.com/sc-profiler", "POST", { status: 204 }), "telemetry-path");
assert.equal(req("https://www.zhihu.com/x/y", "POST", { status: 204 }), "no-content");

// 不能误伤：GET 的数据接口、登录、普通 POST
assert.equal(req("https://www.zhihu.com/api/v4/stats/summary"), null);
assert.equal(req("https://www.zhihu.com/api/v4/me"), null);
assert.equal(req("https://www.zhihu.com/api/login", "POST", { status: 200 }), null);
assert.equal(req("https://www.zhihu.com/api/v4/answers/1/voters", "POST", { status: 200 }), null);

// 响应体：同站、非噪声、有内容才写盘；失败的请求只留小响应体
const body = (over: Partial<Parameters<typeof shouldStoreBody>[0]> = {}) => shouldStoreBody({ noise: false, url: "https://www.zhihu.com/api/v4/me", page, status: 200, body: "{}", ...over });
assert.equal(body(), true);
assert.equal(body({ noise: true }), false);
assert.equal(body({ url: "https://cdn.other.com/a.json" }), false);
assert.equal(body({ body: "" }), false);
assert.equal(body({ status: 500, body: "x".repeat(5000) }), false);
assert.equal(body({ status: 500, body: "boom" }), true);

console.log("filter.selfcheck ok");
