import assert from "node:assert/strict";
import { endpointOf, normalizeSite, shapeOf, siteOf } from "./digest.ts";

// 站点 = 注册域名；输入可以是域名或网址
assert.equal(siteOf("https://www.zhihu.com/question/1"), "zhihu.com");
assert.equal(siteOf("https://api.x.com/i/api"), "x.com");
assert.equal(siteOf("not a url"), "");
assert.equal(normalizeSite("https://www.x.com/home"), "x.com");
assert.equal(normalizeSite("X.com"), "x.com");
assert.equal(normalizeSite("  "), "");

// 接口名：GraphQL 取操作名（queryId 会变）；其它路径把 id 换成 :id
assert.deepEqual(endpointOf("https://x.com/i/api/graphql/lI07N6Otwv1PhnEgXILM7A/FavoriteTweet"), { host: "x.com", name: "graphql FavoriteTweet" });
assert.deepEqual(endpointOf("https://x.com/i/api/graphql/OTHERID/FavoriteTweet?x=1"), { host: "x.com", name: "graphql FavoriteTweet" }, "queryId 变了还是同一个接口");
assert.equal(endpointOf("https://www.zhihu.com/api/v4/answers/1234567890/voters").name, "/api/v4/answers/:id/voters");
assert.equal(endpointOf("https://a.com/u/3f2a9c1e8b7d4a6f5e/profile").name, "/u/:id/profile");
assert.equal(endpointOf("https://a.com/api/v4/me").name, "/api/v4/me");

// 响应结构：沿着单键对象往下走，到第一个多键的地方列出键
assert.equal(shapeOf({ data: { home: { urt: { instructions: [], metadata: {} } } } }), "data.home.urt.{instructions,metadata}");
assert.equal(shapeOf({ items: [{ id: 1, name: "x" }] }), "items[1]{id,name}");
assert.equal(shapeOf([1, 2, 3]), "[3]");
assert.equal(shapeOf({}), "（空）");
assert.equal(shapeOf({ a: 1, b: 2 }), "{a,b}");

console.log("digest.selfcheck ok");
