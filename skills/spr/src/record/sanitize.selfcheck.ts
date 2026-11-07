import assert from "node:assert/strict";
import { Sanitizer } from "./sanitize.ts";

const s = new Sanitizer("test-key");
const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abcdefghijk";

// 同一个秘密永远是同一个别名（12 位），不同秘密不同别名，密钥不同别名也不同
const a = s.url(`https://x.com/api?token=${jwt}&page=2`);
assert.equal(a.query.page, "2");
assert.match(a.query.token!, /^⟨secret_[0-9a-f]{12}:jwt⟩$/);
assert.equal(new Sanitizer("test-key").url(`https://x.com/?token=${jwt}`).query.token, a.query.token);
assert.notEqual(new Sanitizer("other-key").url(`https://x.com/?token=${jwt}`).query.token, a.query.token);
assert.notEqual(s.url("https://x.com/?token=abc").query.token, s.url("https://x.com/?token=abd").query.token);

// 名字有边界：author、design 不是秘密，x-auth-token、access_token 是
assert.equal(s.url("https://x.com/?author=bob&design=1&host=www.example.com").query.author, "bob");
assert.equal(s.url("https://x.com/?design=1").query.design, "1");
assert.match(s.url("https://x.com/?access_token=t1").query.access_token!, /^⟨secret_/);
const h = s.headers({ authorization: "Bearer abc123456", "x-auth-token": "zzz", "x-csrf-token": "c", accept: "*/*", "x-zse-96": "2.0_abc" });
assert.match(h.authorization!, /^⟨secret_/);
assert.match(h["x-auth-token"]!, /^⟨secret_/);
assert.match(h["x-csrf-token"]!, /^⟨secret_/);
assert.equal(h.accept, "*/*");
assert.equal(h["x-zse-96"], "2.0_abc", "签名头不是秘密，原样保留");

// 请求体：JSON 逐层走，表单编码可拆；正文里的自由文本不扫描
const body = s.body({ access_token: "t1", nested: { list: [{ password: "p" }] }, name: "ok", text: "token=abc123 在文字里" }) as { access_token: string; nested: { list: { password: string }[] }; name: string; text: string };
assert.match(body.access_token, /^⟨secret_/);
assert.match(body.nested.list[0]!.password, /^⟨secret_/);
assert.equal(body.name, "ok");
assert.equal(body.text, "token=abc123 在文字里");
const form = s.body("user=bob&password=hunter2", true) as Record<string, string>;
assert.equal(form.user, "bob");
assert.match(form.password!, /^⟨secret_/);
assert.match((s.body({ k: jwt }) as { k: string }).k, /^⟨secret_[0-9a-f]{12}:jwt⟩$/, "值是 JWT 就换掉");

// 别名对照表（只在内存）：能换回真值；不认识的别名报错
const aliased = s.url("https://x.com/?token=REALSECRET123").query.token!;
assert.equal(s.resolve(`header ${aliased} end`), "header REALSECRET123 end");
assert.equal(s.resolve("没有别名的文字"), "没有别名的文字");
assert.throws(() => new Sanitizer("test-key").resolve(aliased), /已失效/, "新的实例（daemon 重启后）没有对照表");

// 连写的 auth 头名也要脱敏（知乎的 x-xsrftoken 曾经明文落盘）
{
  const sz = new Sanitizer("k");
  const h = sz.headers({ "x-xsrftoken": "abcdef123456", csrftoken: "abcdef123456", "x-accesstoken": "abcdef123456", "content-type": "application/json" });
  assert.match(h["x-xsrftoken"]!, /^⟨secret_/); assert.match(h.csrftoken!, /^⟨secret_/); assert.match(h["x-accesstoken"]!, /^⟨secret_/);
  assert.equal(h["content-type"], "application/json");
}
// 登记过的值（auth、authQuery 现读的）：名字再普通，在 URL、请求头、请求体里也换成别名
const reg = new Sanitizer("k2");
reg.register("PLAINVALUE-998877");
assert.match(reg.url("https://x.com/q?key=PLAINVALUE-998877&q=a").query.key!, /^⟨secret_/);
assert.equal(reg.url("https://x.com/q?key=PLAINVALUE-998877&q=a").query.q, "a");
assert.match(reg.headers({ "x-k": "PLAINVALUE-998877" })["x-k"]!, /^⟨secret_/);
assert.ok(!JSON.stringify(reg.body({ sig: "PLAINVALUE-998877" })).includes("PLAINVALUE"));
reg.register("abc");
assert.equal(reg.url("https://x.com/q?v=abc").query.v, "abc", "太短的不登记");
console.log("sanitize.selfcheck ok");

// HTML：密码框、隐藏框、卡号框、像秘密的 meta 换成别名；普通输入框、普通 meta 原样（页面快照不能把秘密写盘，也不能把正常内容弄乱）
{
  const sz = new Sanitizer("k");
  const html = `<meta name="csrf-token" content="CSRF-REAL"><meta name="description" content="hello"><input type="hidden" name="authenticity_token" value='HID-REAL'><input id=u value="alice"><input autocomplete="cc-number" value="4111111111111111"><input type=password value=PW-REAL>`;
  const out = sz.html(html);
  for (const real of ["CSRF-REAL", "HID-REAL", "4111111111111111", "PW-REAL"]) assert.ok(!out.includes(real), `${real} 应该被换掉：${out}`);
  assert.ok(out.includes('content="hello"') && out.includes('value="alice"'), out);
  assert.equal(sz.resolve(/content="([^"]+)"/.exec(out)![1]!), "CSRF-REAL", "别名能换回真值（只在内存里）");
}
