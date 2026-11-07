import assert from "node:assert/strict";
import { isNoise, noiseReason, shouldStoreBody } from "./filter.ts";

const page = "https://www.zhihu.com/";
const req = (url: string, method = "GET", extra: { status?: number; via?: string } = {}) => noiseReason({ url, method, page, via: extra.via ?? "fetch", status: extra.status });

// 第一方埋点：知乎自己的上报都是同站，只有启发式抓得到
assert.equal(req("https://zhihu-web-analytics.zhihu.com/api/v2/za/logs/batch", "POST"), "telemetry-host");
assert.equal(req("https://datahub.zhihu.com/collector/zlab", "POST"), "telemetry-host");
// events、stats、logs、monitor 是常见的业务词，不再算埋点（建日程的 POST /api/events 不能被藏起来）
assert.equal(req("https://www.zhihu.com/zbst/events/r", "POST"), null);
assert.equal(req("https://calendar.example.com/api/events", "POST"), null);
assert.equal(req("https://app.example.com/api/logs", "POST"), null);
// 按规则猜的都不是噪声：只打标签，照常存；只有命中广告规则的算噪声
assert.equal(isNoise("telemetry-path"), false);
assert.equal(isNoise("no-content"), false);
assert.equal(isNoise("adblock"), true);
assert.equal(req("https://www.zhihu.com/sc-profiler", "POST", { status: 204 }), "telemetry-path");
assert.equal(req("https://www.zhihu.com/x/y", "POST", { status: 204 }), "no-content");

// 不能误伤：GET 的数据 endpoint、登录、普通 POST
assert.equal(req("https://www.zhihu.com/api/v4/stats/summary"), null);
assert.equal(req("https://www.zhihu.com/api/v4/me"), null);
assert.equal(req("https://www.zhihu.com/api/login", "POST", { status: 200 }), null);
assert.equal(req("https://www.zhihu.com/api/v4/answers/1/voters", "POST", { status: 200 }), null);

// 响应体：非噪声、有内容就写盘（跨站的也写，跨站在这里已经不是条件）；失败的请求只留小响应体
const body = (over: Partial<Parameters<typeof shouldStoreBody>[0]> = {}) => shouldStoreBody({ noise: false, status: 200, body: "{}", ...over });
assert.equal(body(), true);
assert.equal(body({ noise: true }), false);
assert.equal(body({ body: "" }), false);
assert.equal(body({ status: 500, body: "x".repeat(5000) }), false);
assert.equal(body({ status: 500, body: "boom" }), true);

console.log("filter.selfcheck ok");
