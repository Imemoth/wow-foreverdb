import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { verifyWebhook, hookKey } from "../../supabase/functions/azerdex-auth-email/webhook.ts";
import { loadConfig, missingSettings } from "../../supabase/functions/azerdex-auth-email/config.ts";
import { planEmails, HookError, HANDLED_ACTIONS, safeRecipient, LINK_TYPES } from "../../supabase/functions/azerdex-auth-email/actions.ts";
import { handle, embeddedLogoBytes } from "../../supabase/functions/azerdex-auth-email/index.ts";
import { buildBody } from "../../supabase/functions/azerdex-auth-email/send.ts";
import { validateLogo } from "../../supabase/functions/azerdex-auth-email/logo.ts";
import { makePng, jsonResponse, RESEND_KEY } from "../welcome-worker/fixtures.mjs";

const KEY = Buffer.from("0123456789abcdef0123456789abcdef");
const SECRET = `v1,whsec_${KEY.toString("base64")}`;
const HASH = "7c3b8b833f6cd885a5be77172c083575dd95da9ecabc08c07c56c270";
const HASH2 = "aaaaaaaabbbbbbbbccccccccddddddddeeeeeeeeffffffff00000000";
const env = (over = {}) => {
  const b = { SEND_EMAIL_HOOK_SECRET: SECRET, RESEND_API_KEY: RESEND_KEY, ...over };
  return { get: (n) => b[n] };
};
const cfg = (over) => loadConfig(env(over));

function sign(body, { id = "msg_1", ts = Math.floor(Date.now() / 1000), key = KEY } = {}) {
  const mac = createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64");
  return { "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": `v1,${mac}`, "content-type": "application/json" };
}
const event = (action, over = {}, user = {}) => ({
  user: { id: "u1", email: "new.user@example.test", ...user },
  email_data: { token: "123456", token_hash: HASH, redirect_to: "https://evil.example/steal", email_action_type: action, site_url: "https://stale-preview.vercel.app", token_new: "", token_hash_new: "", ...over },
});
const req = (obj, headers) => { const body = JSON.stringify(obj); return new Request("https://x.test/hook", { method: "POST", body, headers: headers ?? sign(body) }); };
const logoBytes = () => makePng();

function harness({ fetchImpl } = {}) {
  const calls = { fetch: [], logs: [] };
  const io = async (url, init) => { calls.fetch.push({ url, init, body: JSON.parse(init.body) }); return (fetchImpl ?? (() => jsonResponse(200, { id: "re_msg_0123456789" })))(url, init); };
  const run = (r, over) => handle(r, env(over), io, (e, f) => calls.logs.push({ e, f }), logoBytes);
  return { calls, run };
}

// ---- signature ---------------------------------------------------------------------------------------------------------------------
test("AE-1 Standard Webhooks signature: valid passes; tampered body, wrong key, stale/future timestamp, malformed headers and secrets fail closed", async () => {
  const body = '{"a":1}';
  const h = { get: (n) => sign(body)[n] ?? null };
  assert.equal(await verifyWebhook(body, h, SECRET), true);
  assert.equal(await verifyWebhook(body, h, SECRET.replace("v1,", "")), true, "the bare whsec_ form is accepted too");
  assert.equal(await verifyWebhook(body + " ", h, SECRET), false, "tampered body");
  const other = Buffer.from("fedcba9876543210fedcba9876543210").toString("base64");
  assert.equal(await verifyWebhook(body, h, `v1,whsec_${other}`), false, "wrong key");
  const old = sign(body, { ts: Math.floor(Date.now() / 1000) - 400 });
  assert.equal(await verifyWebhook(body, { get: (n) => old[n] ?? null }, SECRET), false, "stale");
  const future = sign(body, { ts: Math.floor(Date.now() / 1000) + 400 });
  assert.equal(await verifyWebhook(body, { get: (n) => future[n] ?? null }, SECRET), false, "future");
  for (const bad of [{ "webhook-signature": "" }, { "webhook-signature": "v2,AAAA" }, { "webhook-signature": "garbage" }, { "webhook-id": "" }, { "webhook-timestamp": "abc" }, { "webhook-timestamp": "" }]) {
    const m = { ...sign(body), ...bad };
    assert.equal(await verifyWebhook(body, { get: (n) => m[n] ?? null }, SECRET), false, JSON.stringify(bad));
  }
  for (const s of ["", "v1,whsec_", "whsec_!!!", "v1,whsec_QQ==", "plain-secret"]) assert.equal(hookKey(s), null, s);
  // one good signature among several candidates is enough; a list of only bad ones is not
  const good = sign(body)["webhook-signature"];
  const multi = { ...sign(body), "webhook-signature": `v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= ${good}` };
  assert.equal(await verifyWebhook(body, { get: (n) => multi[n] ?? null }, SECRET), true);
});

// ---- planning ----------------------------------------------------------------------------------------------------------------------
test("AE-2 every documented action type is handled: none is silently dropped, each yields a template and the variables that template declares", () => {
  const manifest = JSON.parse(fs.readFileSync("docs/azerdex-auth-email/templates/manifest.json", "utf8"));
  const byAlias = new Map(manifest.map((t) => [t.alias, t]));
  for (const action of HANDLED_ACTIONS) {
    const d = action === "email_change" ? { token_hash_new: HASH2 } : {};
    const plans = planEmails(event(action, d, action === "email_change" ? { new_email: "next@example.test" } : {}), cfg());
    assert.ok(plans.length >= 1, action);
    for (const p of plans) {
      const t = byAlias.get(p.template);
      assert.ok(t, `${action}: template ${p.template} is in the manifest`);
      assert.deepEqual(Object.keys(p.variables).sort(), [...t.variables].sort(), `${action}: variables match the template's declaration`);
      assert.ok(p.subject.length > 0);
    }
  }
  assert.equal(HANDLED_ACTIONS.length, 14, "the 14 email_action_type values Supabase documents");
  assert.throws(() => planEmails(event("something_new"), cfg()), (e) => e instanceof HookError && e.status === 400 && e.message === "unsupported_email_action");
  assert.throws(() => planEmails({ email_data: {} }, cfg()), HookError);
});

test("AE-3 links come from configuration + Auth's token_hash only: redirect_to / site_url from the payload are never used", () => {
  for (const [action, tmpl, key] of [["signup", "azerdex-confirm-signup-v1", "CONFIRM_URL"], ["recovery", "azerdex-reset-password-v1", "RESET_URL"]]) {
    const [p] = planEmails(event(action), cfg());
    assert.equal(p.template, tmpl);
    assert.equal(p.variables[key], `https://beta.azerdex.com/auth/confirm?type=${action}&token_hash=${HASH}`);
    assert.ok(!JSON.stringify(p).includes("evil.example") && !JSON.stringify(p).includes("stale-preview"));
  }
  assert.equal(cfg({ AZERDEX_AUTH_LINK_BASE: "https://azerdex.com/" }).linkBase, "https://azerdex.com");
  for (const bad of ["http://beta.azerdex.com", "https://evil.example", "https://beta.azerdex.com.evil.example", "javascript:alert(1)", "https://beta.azerdex.com@evil.example"]) {
    const c = cfg({ AZERDEX_AUTH_LINK_BASE: bad });
    assert.equal(c.linkBase, "", bad);
    assert.deepEqual(missingSettings(c), ["AZERDEX_AUTH_LINK_BASE"]);
  }
  for (const type of LINK_TYPES) assert.match(`type=${type}`, /^type=[a-z_]+$/);
  for (const bad of ["", "short", "has space-0123456789", "a/b/c/d/e/f/g/h", "x".repeat(200), "../../etc/passwd", "ab?cd=ef&gh=ij"]) {
    assert.throws(() => planEmails(event("signup", { token_hash: bad }), cfg()), (e) => e instanceof HookError && e.message === "invalid_token_data", bad);
  }
});

test("AE-4 email change follows Supabase's reversed field names: secure change mails BOTH addresses with the matching hash, otherwise only the new address", () => {
  const user = { email: "old@example.test", new_email: "next@example.test" };
  const both = planEmails(event("email_change", { token_hash: HASH, token_hash_new: HASH2 }, user), cfg());
  assert.equal(both.length, 2);
  assert.equal(both[0].to, "old@example.test");
  assert.match(both[0].variables.CONFIRM_URL, new RegExp(`type=email_change&token_hash=${HASH2}$`), "CURRENT address pairs with token_hash_new");
  assert.equal(both[1].to, "next@example.test");
  assert.match(both[1].variables.CONFIRM_URL, new RegExp(`type=email_change&token_hash=${HASH}$`), "NEW address pairs with token_hash");
  assert.ok(both.every((m) => m.variables.NEW_EMAIL === "next@example.test"));
  const one = planEmails(event("email_change", { token_hash: HASH, token_hash_new: "" }, user), cfg());
  assert.deepEqual(one.map((m) => m.to), ["next@example.test"]);
  const oneNew = planEmails(event("email_change", { token_hash: "", token_hash_new: HASH2 }, user), cfg());
  assert.match(oneNew[0].variables.CONFIRM_URL, new RegExp(`token_hash=${HASH2}$`));
  assert.throws(() => planEmails(event("email_change", {}, { email: "old@example.test" }), cfg()), (e) => e.message === "invalid_recipient", "no new_email: refused, not sent to the old address");
});

test("AE-5 recipients that could split a header or address list are refused", () => {
  for (const ok of ["a@b.co", "first.last+tag@example.test", "ünï@exämple.test"]) assert.equal(safeRecipient(ok), true, ok);
  for (const bad of ["", "a", "a@", "@b.co", "a b@c.co", "a@b.co, c@d.co", "<a@b.co>", "a@b.co\r\nBcc: x@y.z", "a@@b.co", 'a"b@c.co', "a;b@c.co", undefined, 5]) assert.equal(safeRecipient(bad), false, String(bad));
  assert.throws(() => planEmails(event("signup", {}, { email: "a@b.co, evil@x.test" }), cfg()), (e) => e.message === "invalid_recipient");
});

// ---- handler -----------------------------------------------------------------------------------------------------------------------
test("AE-6 a correctly signed signup event sends exactly one Resend template message with the CID emblem, fixed sender/reply-to and a stable idempotency key", async () => {
  const h = harness();
  const body = JSON.stringify(event("signup"));
  const res = await h.run(new Request("https://x.test", { method: "POST", body, headers: sign(body, { id: "msg_abc" }) }));
  assert.equal(res.status, 200);
  assert.equal(h.calls.fetch.length, 1);
  const f = h.calls.fetch[0];
  assert.equal(f.url, "https://api.resend.com/emails");
  assert.equal(f.init.headers.authorization, `Bearer ${RESEND_KEY}`);
  assert.equal(f.init.headers["idempotency-key"], "azerdex-auth:msg_abc:0");
  assert.deepEqual(f.body.to, ["new.user@example.test"]);
  assert.equal(f.body.from, "AzerDex <noreply@azerdex.com>");
  assert.equal(f.body.reply_to, "support@azerdex.com");
  assert.equal(f.body.template.id, "azerdex-confirm-signup-v1");
  assert.deepEqual(Object.keys(f.body.template.variables), ["CONFIRM_URL"]);
  assert.equal(f.body.attachments.length, 1);
  assert.deepEqual({ ...f.body.attachments[0], content: "<b64>" }, { filename: "azerdex-logo.png", content: "<b64>", content_type: "image/png", content_id: "azerdex-logo" });
  assert.ok(!("html" in f.body) && !("text" in f.body), "template and html/text are mutually exclusive at the provider");
  // a retry of the SAME event reuses the key; a different event does not
  await h.run(new Request("https://x.test", { method: "POST", body, headers: sign(body, { id: "msg_abc" }) }));
  assert.equal(h.calls.fetch[1].init.headers["idempotency-key"], "azerdex-auth:msg_abc:0");
});

test("AE-7 unsigned, wrongly signed, replayed-stale and non-POST requests send nothing and parse nothing", async () => {
  const h = harness();
  const body = JSON.stringify(event("signup"));
  const cases = [
    new Request("https://x.test", { method: "POST", body }),
    new Request("https://x.test", { method: "POST", body, headers: sign(body, { key: Buffer.from("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz") }) }),
    new Request("https://x.test", { method: "POST", body, headers: sign(body, { ts: Math.floor(Date.now() / 1000) - 3600 }) }),
    new Request("https://x.test", { method: "POST", body: body + "x", headers: sign(body) }),
  ];
  for (const r of cases) assert.equal((await h.run(r)).status, 401);
  assert.equal((await h.run(new Request("https://x.test", { method: "GET" }))).status, 405);
  assert.equal(h.calls.fetch.length, 0);
});

test("AE-8 missing or invalid settings fail closed with Auth's error contract, before any send, naming no value", async () => {
  for (const over of [{ SEND_EMAIL_HOOK_SECRET: "" }, { RESEND_API_KEY: "" }, { AZERDEX_AUTH_LINK_BASE: "https://evil.example" }]) {
    const h = harness();
    const res = await h.run(req(event("signup")), over);
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: { http_code: 500, message: "email_hook_not_configured" } });
    assert.equal(h.calls.fetch.length, 0);
  }
});

test("AE-9 provider failures are NEVER reported as success (Auth must see an error); transient and permanent are distinguished", async () => {
  for (const [status, expect, code] of [[500, 503, "email_temporarily_unavailable"], [429, 503, "email_temporarily_unavailable"], [409, 503, "email_temporarily_unavailable"], [401, 500, "email_hook_failed"], [403, 500, "email_hook_failed"], [422, 500, "email_hook_failed"]]) {
    const h = harness({ fetchImpl: () => jsonResponse(status, { message: `leaked ${HASH} new.user@example.test` }) });
    const res = await h.run(req(event("signup")));
    assert.equal(res.status, expect, String(status));
    const j = await res.json();
    assert.equal(j.error.message, code);
    assert.ok(!JSON.stringify(j).includes(HASH) && !JSON.stringify(j).includes("example.test"));
  }
  const bad2xx = harness({ fetchImpl: () => jsonResponse(200, { nope: true }) });
  assert.equal((await bad2xx.run(req(event("signup")))).status, 503, "2xx without an id is ambiguous, not success");
  const boom = harness({ fetchImpl: () => { throw new Error("socket"); } });
  assert.equal((await boom.run(req(event("signup")))).status, 503);
});

test("AE-10 email change with both addresses sends two messages; a failure on the second is reported (never half-silent)", async () => {
  const ev = event("email_change", { token_hash: HASH, token_hash_new: HASH2 }, { email: "old@example.test", new_email: "next@example.test" });
  const h = harness();
  assert.equal((await h.run(req(ev))).status, 200);
  assert.deepEqual(h.calls.fetch.map((c) => c.body.to[0]), ["old@example.test", "next@example.test"]);
  assert.deepEqual(h.calls.fetch.map((c) => c.init.headers["idempotency-key"].endsWith(":0") || c.init.headers["idempotency-key"].endsWith(":1")), [true, true]);
  let n = 0;
  const f = harness({ fetchImpl: () => (++n === 2 ? jsonResponse(500, {}) : jsonResponse(200, { id: "re_msg_0123456789" })) });
  const res = await f.run(req(ev));
  assert.equal(res.status, 503);
  assert.deepEqual(f.calls.logs.find((l) => l.e === "send_failed").f, { action: "email_change", code: "provider_5xx", sent_before: 1 });
});

test("AE-11 unsupported action types and malformed events get a 4xx contract answer and send nothing", async () => {
  const h = harness();
  const res = await h.run(req(event("brand_new_type")));
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { error: { http_code: 400, message: "unsupported_email_action" } });
  const body = "not json";
  const r2 = await h.run(new Request("https://x.test", { method: "POST", body, headers: sign(body) }));
  assert.equal(r2.status, 500);
  assert.equal(h.calls.fetch.length, 0);
});

test("AE-12 logs carry counts and allowlisted codes only: no token, link, address, key or secret ever reaches a log or an error body", async () => {
  const h = harness();
  const secrets = [HASH, HASH2, "new.user@example.test", "next@example.test", RESEND_KEY, SECRET, KEY.toString("base64"), "123456", "evil.example", "stale-preview"];
  await h.run(req(event("signup")));
  await h.run(req(event("reauthentication")));
  await h.run(req(event("email_change", { token_hash: HASH, token_hash_new: HASH2 }, { email: "old@example.test", new_email: "next@example.test" })));
  await h.run(req(event("nonsense")));
  await h.run(new Request("https://x.test", { method: "POST", body: "{}", headers: {} }));
  const failing = harness({ fetchImpl: () => jsonResponse(500, { m: HASH }) });
  await failing.run(req(event("signup")));
  for (const hh of [h, failing]) {
    const blob = JSON.stringify(hh.calls.logs);
    for (const s of secrets) assert.ok(!blob.includes(s), `log leaked ${s.slice(0, 8)}…`);
  }
  assert.ok(h.calls.logs.length >= 4);
});

test("AE-13 the embedded emblem is the reviewed 128x128 PNG and every template/payload references it by CID (no external image)", () => {
  const logo = validateLogo(embeddedLogoBytes());
  assert.equal(logo.bytes, 6819);
  const manifest = JSON.parse(fs.readFileSync("docs/azerdex-auth-email/templates/manifest.json", "utf8"));
  assert.equal(manifest.length, 6);
  for (const t of manifest) {
    const html = fs.readFileSync(path.join("docs/azerdex-auth-email/templates", `${t.alias}.html`), "utf8");
    const txt = fs.readFileSync(path.join("docs/azerdex-auth-email/templates", `${t.alias}.txt`), "utf8");
    assert.match(html, /src="cid:azerdex-logo"/, t.alias);
    assert.ok(!/<img[^>]+src="https?:/i.test(html) && !/url\(\s*https?:/i.test(html), `${t.alias}: no external image`);
    assert.ok(!/azerdex\.com\/[^"\s]*\.(png|jpg|gif|svg)/i.test(html));
    const used = [...html.matchAll(/\{\{\{(\w+)\}\}\}/g)].map((m) => m[1]);
    assert.ok(used.length > 0 && used.every((v) => t.variables.includes(v)), `${t.alias}: only declared variables are used`);
    assert.ok(t.variables.every((v) => html.includes(`{{{${v}}}}`) && txt.includes(`{{{${v}}}}`)), `${t.alias}: every declared variable appears in html and text`);
    assert.ok(txt.length > 100, `${t.alias}: plain-text alternative`);
    assert.deepEqual(t.reply_to, ["support@azerdex.com"]);
    assert.ok(/#07091C/.test(html) && /#6C41C7|#191A47/.test(html), "AzerDex palette");
  }
  const b = buildBody(cfg(), { to: "a@b.co", template: "azerdex-confirm-signup-v1", subject: "s", variables: { CONFIRM_URL: "u" } }, logo);
  assert.equal(b.attachments[0].content_id, "azerdex-logo");
});

test("AE-14 the generated template files are current", async () => {
  const { render, outDir } = await import("../../scripts/build-azerdex-auth-templates.mjs");
  for (const [n, c] of Object.entries(render())) assert.equal(fs.readFileSync(path.join(outDir, n), "utf8"), c, `${n} is stale: run node scripts/build-azerdex-auth-templates.mjs`);
});
