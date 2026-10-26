import { test } from "node:test";
import assert from "node:assert/strict";
import { handle, parseInput } from "../../supabase/functions/azerdex-auth-confirm/index.ts";
import { jsonResponse } from "../welcome-worker/fixtures.mjs";

const HASH = "7c3b8b833f6cd885a5be77172c083575dd95da9ecabc08c07c56c270";
const URL_ = "https://abcdefghijklmnopqrst.supabase.co";
const env = (over = {}) => { const b = { SUPABASE_URL: URL_, SUPABASE_ANON_KEY: "anon-key-NOT-REAL", ...over }; return { get: (n) => b[n] }; };
const post = (obj, method = "POST") => new Request("https://x.test", { method, body: method === "POST" ? JSON.stringify(obj) : undefined });

function harness(routes) {
  const calls = [];
  const logs = [];
  const io = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
    const key = `${init.method} ${new URL(url).pathname}${new URL(url).search}`;
    const r = routes[key];
    if (!r) throw new Error(`unexpected ${key}`);
    return typeof r === "function" ? r() : r;
  };
  return { calls, logs, run: (r, e) => handle(r, e ?? env(), io, (ev, f) => logs.push({ ev, f })) };
}
const SESSION = { access_token: "SECRET.ACCESS.TOKEN", refresh_token: "SECRET-REFRESH", user: { id: "u" } };

test("AC-1 strict input: three types only, exact keys, password only (and always) for recovery", () => {
  assert.deepEqual(parseInput({ type: "signup", token_hash: HASH }), { type: "signup", tokenHash: HASH });
  assert.deepEqual(parseInput({ type: "email_change", token_hash: HASH }), { type: "email_change", tokenHash: HASH });
  assert.deepEqual(parseInput({ type: "recovery", token_hash: HASH, password: "long enough" }), { type: "recovery", tokenHash: HASH, password: "long enough" });
  for (const bad of [null, "x", [], {}, { type: "magiclink", token_hash: HASH }, { type: "invite", token_hash: HASH }, { type: "signup", token_hash: "x" }, { type: "signup", token_hash: HASH, extra: 1 },
    { type: "signup", token_hash: HASH, password: "long enough" }, { type: "recovery", token_hash: HASH }, { type: "recovery", token_hash: HASH, password: "short" },
    { type: "recovery", token_hash: HASH, password: "x".repeat(73) }, { type: "recovery", token_hash: HASH, password: 12345678 }, { type: "recovery", token_hash: HASH, password: "é".repeat(37) }]) {
    assert.equal(parseInput(bad), null, JSON.stringify(bad));
  }
});

test("AC-2 signup confirmation calls ONLY Auth's /verify, returns no session or token, and never calls /user or /logout", async () => {
  const h = harness({ "POST /auth/v1/verify": jsonResponse(200, SESSION) });
  const res = await h.run(post({ type: "signup", token_hash: HASH }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, kind: "confirmed" });
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0].body, { type: "signup", token_hash: HASH });
  assert.equal(h.calls[0].headers.apikey, "anon-key-NOT-REAL");
  assert.ok(!("authorization" in h.calls[0].headers));
  assert.ok(!JSON.stringify(h.logs).includes("SECRET") && !JSON.stringify(h.logs).includes(HASH));
});

test("AC-3 an invalid, expired or replayed token is a generic 400; Auth's rate limit and outage are distinguished", async () => {
  for (const [status, expect, err] of [[403, 400, "invalid_or_expired"], [400, 400, "invalid_or_expired"], [404, 400, "invalid_or_expired"], [429, 429, "rate_limited"], [500, 503, "temporarily_unavailable"], [502, 503, "temporarily_unavailable"]]) {
    const h = harness({ "POST /auth/v1/verify": jsonResponse(status, { error_code: "otp_expired", msg: `leak ${HASH}` }) });
    const res = await h.run(post({ type: "signup", token_hash: HASH }));
    assert.equal(res.status, expect, String(status));
    const j = await res.json();
    assert.equal(j.error, err);
    assert.ok(!JSON.stringify(j).includes(HASH) && !JSON.stringify(j).includes("otp"));
  }
  const down = harness({ "POST /auth/v1/verify": () => { throw new Error("net"); } });
  assert.equal((await down.run(post({ type: "signup", token_hash: HASH }))).status, 503);
});

test("AC-4 recovery: verify, set the new password inside that session, then end EVERY session; success is reported only after the password change", async () => {
  const h = harness({
    "POST /auth/v1/verify": jsonResponse(200, SESSION),
    "PUT /auth/v1/user": jsonResponse(200, { id: "u" }),
    "POST /auth/v1/logout?scope=global": new Response(null, { status: 204 }),
  });
  const res = await h.run(post({ type: "recovery", token_hash: HASH, password: "a long new password" }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, kind: "password_reset", sessions_revoked: true });
  assert.deepEqual(h.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`), ["POST /auth/v1/verify", "PUT /auth/v1/user", "POST /auth/v1/logout"]);
  assert.equal(h.calls[1].headers.authorization, "Bearer SECRET.ACCESS.TOKEN");
  assert.deepEqual(h.calls[1].body, { password: "a long new password" });
  assert.ok(!JSON.stringify(h.logs).includes("SECRET") && !JSON.stringify(h.logs).includes("long new password"));
  // a failed global logout is reported, not hidden
  const h2 = harness({ "POST /auth/v1/verify": jsonResponse(200, SESSION), "PUT /auth/v1/user": jsonResponse(200, {}), "POST /auth/v1/logout?scope=global": jsonResponse(500, {}) });
  assert.deepEqual(await (await h2.run(post({ type: "recovery", token_hash: HASH, password: "a long new password" }))).json(), { ok: true, kind: "password_reset", sessions_revoked: false });
});

test("AC-5 recovery password problems come back as a fixable error; a failed change is never success", async () => {
  for (const [status, code, expect] of [[422, "weak_password", "weak_password"], [422, "same_password", "same_password"], [422, "something_else", "invalid_password"], [400, "validation_failed", "invalid_password"]]) {
    const h = harness({ "POST /auth/v1/verify": jsonResponse(200, SESSION), "PUT /auth/v1/user": jsonResponse(status, { error_code: code, msg: "internal detail" }) });
    const res = await h.run(post({ type: "recovery", token_hash: HASH, password: "a long new password" }));
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, expect);
    assert.equal(h.calls.length, 2, "no logout when nothing changed");
  }
  const srv = harness({ "POST /auth/v1/verify": jsonResponse(200, SESSION), "PUT /auth/v1/user": jsonResponse(500, {}) });
  assert.equal((await srv.run(post({ type: "recovery", token_hash: HASH, password: "a long new password" }))).status, 503);
  const noToken = harness({ "POST /auth/v1/verify": jsonResponse(200, { user: {} }) });
  assert.equal((await noToken.run(post({ type: "recovery", token_hash: HASH, password: "a long new password" }))).status, 400);
});

test("AC-6 non-POST, oversized, malformed and misconfigured requests never reach Auth", async () => {
  const h = harness({});
  assert.equal((await h.run(post({}, "GET"))).status, 405);
  assert.equal((await h.run(new Request("https://x.test", { method: "POST", body: "{" }))).status, 400);
  assert.equal((await h.run(new Request("https://x.test", { method: "POST", body: "x".repeat(5000) }))).status, 413);
  assert.equal((await h.run(post({ type: "signup", token_hash: HASH }), env({ SUPABASE_URL: "https://evil.example" }))).status, 503);
  assert.equal((await h.run(post({ type: "signup", token_hash: HASH }), env({ SUPABASE_ANON_KEY: "" }))).status, 503);
  assert.equal(h.calls.length, 0);
});
