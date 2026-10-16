import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, missingSettings, isAllowedDbUrl } from "../../supabase/functions/azerdex-welcome-worker/config.ts";
import { validateLogo, LogoError } from "../../supabase/functions/azerdex-welcome-worker/logo.ts";
import { buildPayload, renderHtml, renderText } from "../../supabase/functions/azerdex-welcome-worker/email.ts";
import { sendEmail } from "../../supabase/functions/azerdex-welcome-worker/resend.ts";
import { runOnce } from "../../supabase/functions/azerdex-welcome-worker/worker.ts";
import { handle, secretMatches } from "../../supabase/functions/azerdex-welcome-worker/index.ts";
import { createDb } from "../../supabase/functions/azerdex-welcome-worker/db.ts";
import { makePng, env, job, jsonResponse, SECRET, RESEND_KEY, DB_KEY } from "./fixtures.mjs";

const logoBytes = async () => makePng();
const cfg = (over) => loadConfig(env(over));

function harness({ jobs = [job()], fetchImpl, logo = logoBytes, over } = {}) {
  const calls = { claim: 0, finish: [], fetch: [], logs: [] };
  const db = {
    async claim(limit) { calls.claim++; calls.limit = limit; return jobs; },
    async finish(a) { calls.finish.push(a); return true; },
  };
  const fetch = async (url, init) => { calls.fetch.push({ url, init, body: init?.body ? JSON.parse(init.body) : null }); return (fetchImpl ?? (() => jsonResponse(200, { id: "re_msg_0123456789" })))(url, init, calls.fetch.length); };
  return { calls, deps: { cfg: cfg(over), db, fetch, loadLogoBytes: logo, log: (e, f) => calls.logs.push({ e, f }) } };
}

// ---- configuration / feature flag --------------------------------------------------------------------------------------------------
test("WT-1 disabled by default and fail-closed: only the exact string 'true' enables sending", async () => {
  for (const v of [undefined, "", "false", "TRUE", "True", "1", "yes", "on", "true;"]) {
    const h = harness({ over: { AZERDEX_WELCOME_ENABLED: v } });
    const s = await runOnce(h.deps);
    assert.equal(s.state, "disabled", String(v));
    assert.equal(h.calls.claim, 0, "disabled: the database is not even asked");
    assert.equal(h.calls.fetch.length, 0);
  }
  assert.equal(cfg({ AZERDEX_WELCOME_ENABLED: " true " }).enabled, true);
  assert.equal(loadConfig({ get: () => undefined }).enabled, false);
});

test("WT-2 missing/weak settings stop the run before any claim (names only are reported)", async () => {
  for (const over of [{ AZERDEX_WORKER_SECRET: "short" }, { RESEND_API_KEY: "" }, { SUPABASE_URL: "http://evil.example" }, { AZERDEX_WORKER_DB_KEY: "" }]) {
    const h = harness({ over });
    assert.equal((await runOnce(h.deps)).state, "misconfigured");
    assert.equal(h.calls.claim, 0);
  }
  assert.deepEqual(missingSettings(cfg({ RESEND_API_KEY: "" })), ["RESEND_API_KEY"]);
  for (const bad of ["http://localhost.evil.com", "http://127.0.0.1.evil.com", "http://user:pw@127.0.0.1", "ftp://x.test", "not a url", "https://u:p@x.test"]) assert.equal(isAllowedDbUrl(bad), false, bad);
  for (const good of ["https://abc.supabase.co", "http://127.0.0.1:54321", "http://localhost:54321"]) assert.equal(isAllowedDbUrl(good), true, good);
});

test("WT-3 sender, reply-to, subject and CTA are fixed in code: no setting or request can change them", () => {
  const c = cfg({ AZERDEX_WELCOME_FROM: "evil@x.test", AZERDEX_WELCOME_CTA_URL: "https://evil.example", AZERDEX_WELCOME_SUBJECT: "x" });
  assert.equal(c.from, "AzerDex <welcome@azerdex.com>");
  assert.equal(c.replyTo, "support@azerdex.com");
  assert.equal(c.subject, "Welcome to AzerDex — Know Your World");
  assert.equal(c.ctaUrl, "https://azerdex.com/");
  assert.equal(c.templateId, "azerdex-welcome-v1");
  assert.equal(cfg({ AZERDEX_WELCOME_MAX_PER_RUN: "1000" }).maxPerRun, 10);
  assert.equal(cfg({ AZERDEX_WELCOME_MAX_PER_RUN: "3" }).maxPerRun, 3);
  for (const v of ["-1", "0", "abc", "1.5x"]) assert.equal(cfg({ AZERDEX_WELCOME_MAX_PER_RUN: v }).maxPerRun, 1, `throttle ${v} means the smallest run, never the largest`);
  assert.equal(cfg({ AZERDEX_WELCOME_MAX_PER_RUN: "" }).maxPerRun, 10);
});

// ---- CID attachment -----------------------------------------------------------------------------------------------------------------
test("WT-4 the emblem is validated BEFORE any send: missing, non-PNG, wrong size and oversize files stop the run", async () => {
  assert.throws(() => validateLogo(null), (e) => e instanceof LogoError && e.code === "logo_missing");
  assert.throws(() => validateLogo(new Uint8Array()), (e) => e.code === "logo_missing");
  assert.throws(() => validateLogo(new TextEncoder().encode("GIF89a...............................................")), (e) => e.code === "logo_not_png");
  assert.throws(() => validateLogo(makePng(64, 64)), (e) => e.code === "logo_wrong_size");
  assert.throws(() => validateLogo(makePng(128, 129)), (e) => e.code === "logo_wrong_size");
  assert.throws(() => validateLogo(new Uint8Array(20_000).fill(1)), (e) => e.code === "logo_too_large");
  assert.equal(validateLogo(makePng()).bytes > 0, true);
  // integrity: a flipped byte, trailing data, a truncated tail or a missing IEND must fail closed (a corrupted or tampered attachment is never sent)
  const good = makePng();
  const flip = (i) => { const b = new Uint8Array(good); b[i] ^= 0xff; return b; };
  assert.throws(() => validateLogo(flip(good.length - 20)), (e) => e.code === "logo_corrupt", "bad CRC in IDAT/IEND region");
  assert.throws(() => validateLogo(flip(30)), (e) => e.code === "logo_corrupt", "bad IHDR CRC");
  assert.throws(() => validateLogo(new Uint8Array([...good, 0])), (e) => e.code === "logo_corrupt", "trailing byte after IEND");
  assert.throws(() => validateLogo(good.slice(0, good.length - 12)), (e) => e.code === "logo_corrupt", "IEND chunk removed");
  assert.throws(() => validateLogo(good.slice(0, good.length - 5)), (e) => e.code === "logo_corrupt", "truncated");
  for (const bad of [null, makePng(10, 10), new Uint8Array([1, 2, 3])]) {
    const h = harness({ logo: async () => bad });
    const s = await runOnce(h.deps);
    assert.equal(s.state, "logo_invalid");
    assert.equal(h.calls.claim, 0, "no job is claimed (no attempt consumed) when the attachment is unusable");
    assert.equal(h.calls.fetch.length, 0);
  }
  const h = harness({ logo: async () => { throw new Error("EACCES"); } });
  assert.equal((await runOnce(h.deps)).state, "logo_invalid");
});

test("WT-5 html mode: CID image, matching attachment, Dark Arcane palette, text part, no external image or tracking, fixed headers", () => {
  const logo = validateLogo(makePng());
  const p = buildPayload(cfg(), "a@example.test", logo);
  assert.deepEqual(p.to, ["a@example.test"]);
  assert.equal(p.from, "AzerDex <welcome@azerdex.com>");
  assert.equal(p.reply_to, "support@azerdex.com");
  assert.equal(p.subject, "Welcome to AzerDex — Know Your World");
  assert.equal(p.attachments.length, 1);
  assert.equal(p.attachments[0].content_id, "azerdex-logo");
  assert.equal(p.attachments[0].content_type, "image/png");
  assert.equal(p.attachments[0].content, logo.base64);
  assert.match(p.html, /<img src="cid:azerdex-logo"/);
  assert.match(p.html, /alt="AzerDex rune emblem"/);
  for (const c of ["#07091C", "#0D0F33", "#191A47", "#6C41C7", "#D9B978"]) assert.ok(p.html.includes(c), c);
  assert.ok(p.html.includes("Explore AzerDex") && p.html.includes('href="https://azerdex.com/"'));
  assert.ok(!/prefers-color-scheme\s*:\s*light/i.test(p.html), "no automatic light theme");
  const srcs = [...p.html.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(srcs, ["cid:azerdex-logo"], "no externally hosted image");
  assert.ok(!/(pixel|track|utm_|open\.|click\.)/i.test(p.html));
  const urls = [...p.html.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((m) => m[0]);
  assert.ok(urls.every((u) => u.startsWith("https://azerdex.com/")), `only the CTA host appears: ${urls}`);
  assert.ok(p.text.includes("Explore AzerDex: https://azerdex.com/") && p.text.includes("support@azerdex.com"));
  assert.ok(!/password\s*:|verification code\s*:|token=/i.test(p.html + p.text));
  assert.match(p.html + p.text, /never ask for your password/);
  assert.equal(p.template, undefined);
  assert.equal(p.headers, undefined);
});

test("WT-6 template mode (opt-in, unproven until the owner-run provider test): template id + CTA_URL variable, CID attachment still attached, no html/text", () => {
  const p = buildPayload(cfg({ AZERDEX_WELCOME_MODE: "template" }), "a@example.test", validateLogo(makePng()));
  assert.deepEqual(p.template, { id: "azerdex-welcome-v1", variables: { CTA_URL: "https://azerdex.com/" } });
  assert.equal(p.html, undefined);
  assert.equal(p.text, undefined);
  assert.equal(p.attachments[0].content_id, "azerdex-logo");
  assert.equal(cfg({ AZERDEX_WELCOME_MODE: "garbage" }).mode, "html", "unknown mode falls back to the proven rendered-HTML path");
  assert.equal(cfg().mode, "html");
});

test("WT-7 rendered text/html contain no per-user data at all (recipient is only the envelope)", () => {
  const html = renderHtml("https://azerdex.com/"), text = renderText("https://azerdex.com/");
  assert.ok(!/@example\.test|user_id|lease/.test(html + text));
});

// ---- Resend outcomes ----------------------------------------------------------------------------------------------------------------
const send = (fetchImpl, timeoutMs = 50) => sendEmail({ fetch: fetchImpl, apiKey: RESEND_KEY, payload: { a: 1 }, idempotencyKey: "k-1", timeoutMs });

test("WT-8 Resend response taxonomy", async () => {
  assert.deepEqual(await send(async () => jsonResponse(200, { id: "re_abcdefgh1234" })), { kind: "accepted", providerId: "re_abcdefgh1234" });
  assert.equal((await send(async () => jsonResponse(200, { nope: 1 }))).kind, "ambiguous");
  assert.equal((await send(async () => jsonResponse(200, { id: "has spaces and <script>" }))).code, "provider_malformed_response");
  assert.equal((await send(async () => new Response("<html>", { status: 200 }))).code, "provider_malformed_response");
  assert.deepEqual(await send(async () => jsonResponse(429, {}, { "retry-after": "17" })), { kind: "retry", code: "provider_rate_limited", retryAfterSeconds: 17 });
  assert.equal((await send(async () => jsonResponse(429, {}, { "retry-after": "999999" }))).retryAfterSeconds, 3600);
  assert.equal((await send(async () => jsonResponse(429, {}))).retryAfterSeconds, 60);
  for (const st of [500, 502, 503, 504]) assert.deepEqual(await send(async () => jsonResponse(st, {})), { kind: "ambiguous", code: "provider_5xx" });
  assert.equal((await send(async () => jsonResponse(409, {}))).code, "provider_idempotency_conflict");
  for (const st of [202, 204, 408, 423, 425]) assert.equal((await send(async () => new Response(null, { status: st }))).kind, "ambiguous", `status ${st} may have been accepted`);
  assert.deepEqual(await send(async () => jsonResponse(401, {})), { kind: "permanent", code: "provider_auth" });
  assert.deepEqual(await send(async () => jsonResponse(403, {})), { kind: "permanent", code: "provider_auth" });
  assert.deepEqual(await send(async () => jsonResponse(422, {})), { kind: "permanent", code: "provider_rejected" });
  assert.deepEqual(await send(async () => jsonResponse(404, {})), { kind: "permanent", code: "provider_4xx" });
  assert.deepEqual(await send(async () => { throw new TypeError("fetch failed"); }), { kind: "ambiguous", code: "provider_transport" });
});

test("WT-9 a hanging provider is cut off by the timeout and reported as an AMBIGUOUS outcome (never as failure-to-send)", async () => {
  const hang = (_u, init) => new Promise((_res, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  const t0 = Date.now();
  assert.deepEqual(await send(hang, 40), { kind: "ambiguous", code: "provider_timeout" });
  assert.ok(Date.now() - t0 < 1000);
});

test("WT-9b headers arrive but the body stalls: still cut off by the timeout and reported ambiguous", async () => {
  const stalled = (_u, init) => {
    const body = new ReadableStream({ start(c) { init.signal.addEventListener("abort", () => c.error(Object.assign(new Error("aborted"), { name: "AbortError" }))); } });
    return Promise.resolve(new Response(body, { status: 200 }));
  };
  const t0 = Date.now();
  assert.deepEqual(await send(stalled, 40), { kind: "ambiguous", code: "provider_timeout" });
  assert.ok(Date.now() - t0 < 1000);
});

test("WT-10 request shape: bearer key, idempotency key, JSON body, no redirects followed", async () => {
  let seen;
  await send(async (u, init) => { seen = { u, init }; return jsonResponse(200, { id: "re_abcdefgh1234" }); });
  assert.equal(seen.u, "https://api.resend.com/emails");
  assert.equal(seen.init.method, "POST");
  assert.equal(seen.init.headers.authorization, `Bearer ${RESEND_KEY}`);
  assert.equal(seen.init.headers["idempotency-key"], "k-1");
  assert.equal(seen.init.redirect, "error");
});

// ---- run loop -----------------------------------------------------------------------------------------------------------------------
test("WT-11 happy path: one send per claimed job with its own idempotency key; finish records the provider id", async () => {
  const jobs = [job(), job({ user_id: "u2", recipient: "two@example.test", lease_token: "l2", idempotency_key: "azerdex-welcome-v1:u2:1" })];
  const h = harness({ jobs });
  const s = await runOnce(h.deps);
  assert.deepEqual([s.state, s.claimed, s.sent], ["ok", 2, 2]);
  assert.equal(h.calls.fetch.length, 2);
  assert.deepEqual(h.calls.fetch.map((f) => f.init.headers["idempotency-key"]), jobs.map((j) => j.idempotency_key));
  assert.deepEqual(h.calls.fetch.map((f) => f.body.to[0]), jobs.map((j) => j.recipient));
  assert.deepEqual(h.calls.finish.map((f) => [f.outcome, f.provider_id]), [["sent", "re_msg_0123456789"], ["sent", "re_msg_0123456789"]]);
  assert.equal(h.calls.limit, 10);
});

test("WT-12 failure classes map to the right database outcome", async () => {
  const cases = [
    [() => jsonResponse(429, {}, { "retry-after": "30" }), "retry", "provider_rate_limited", 30],
    [() => jsonResponse(503, {}), "ambiguous", "provider_5xx"],
    [() => { throw new Error("socket"); }, "ambiguous", "provider_transport"],
    [() => jsonResponse(200, {}), "ambiguous", "provider_malformed_response"],
    [() => jsonResponse(422, {}), "permanent", "provider_rejected"],
  ];
  for (const [fetchImpl, outcome, code, ra] of cases) {
    const h = harness({ fetchImpl });
    await runOnce(h.deps);
    assert.equal(h.calls.finish[0].outcome, outcome);
    assert.equal(h.calls.finish[0].error_code, code);
    if (ra) assert.equal(h.calls.finish[0].retry_after_seconds, ra);
    assert.equal(h.calls.finish[0].provider_id, undefined);
  }
});

test("WT-13 circuit breaker: after 3 consecutive provider failures the rest are released unsent, with no further provider calls", async () => {
  const jobs = Array.from({ length: 8 }, (_, i) => job({ user_id: `u${i}`, lease_token: `l${i}`, idempotency_key: `k${i}` }));
  const h = harness({ jobs, fetchImpl: () => jsonResponse(503, {}) });
  const s = await runOnce(h.deps);
  assert.equal(s.state, "circuit_open");
  assert.equal(h.calls.fetch.length, 3);
  const released = h.calls.finish.filter((f) => f.error_code === "circuit_open");
  assert.equal(released.length, 5);
  assert.ok(released.every((f) => f.outcome === "retry"));
});

test("WT-14 a success resets the failure streak", async () => {
  const jobs = Array.from({ length: 6 }, (_, i) => job({ user_id: `u${i}`, lease_token: `l${i}`, idempotency_key: `k${i}` }));
  let n = 0;
  const h = harness({ jobs, fetchImpl: () => (++n % 3 === 0 ? jsonResponse(200, { id: "re_abcdefgh1234" }) : jsonResponse(503, {})) });
  const s = await runOnce(h.deps);
  assert.equal(s.state, "ok");
  assert.equal(h.calls.fetch.length, 6);
});

test("WT-14b a rejected provider key is a RUN-level failure: the run stops at once and no user is parked (attempt given back, not review_required)", async () => {
  const jobs = Array.from({ length: 6 }, (_, i) => job({ user_id: `u${i}`, lease_token: `l${i}`, idempotency_key: `k${i}` }));
  for (const st of [401, 403]) {
    const h = harness({ jobs, fetchImpl: () => jsonResponse(st, {}) });
    const s = await runOnce(h.deps);
    assert.equal(h.calls.fetch.length, 1);
    assert.equal(s.state, "provider_auth_failed");
    assert.equal(h.calls.finish.length, 6, "every claimed job is finished/released");
    assert.ok(h.calls.finish.every((f) => f.outcome === "retry" && f.error_code === "circuit_open"), "none is marked permanent");
    assert.ok(h.calls.logs.some((l) => l.e === "provider_auth_failed"));
  }
});

test("WT-14c a claim failure is logged (code only) and reported, never thrown", async () => {
  const h = harness();
  h.deps.db.claim = async () => { throw new Error("rpc_azerdex_welcome_claim_503"); };
  const s = await runOnce(h.deps);
  assert.equal(s.state, "claim_failed");
  assert.ok(h.calls.logs.some((l) => l.e === "claim_failed"));
});

test("WT-15 a failing finish call never throws (the lease expiry is the safety net) and is counted", async () => {
  const h = harness();
  h.deps.db.finish = async () => { throw new Error("db down"); };
  const s = await runOnce(h.deps);
  assert.equal(s.sent, 1);
  assert.equal(s.finish_failed, 1);
});

test("WT-16 never sends more than the per-run cap even if the database returns more", async () => {
  const jobs = Array.from({ length: 25 }, (_, i) => job({ user_id: `u${i}`, lease_token: `l${i}`, idempotency_key: `k${i}` }));
  const h = harness({ jobs });
  await runOnce(h.deps);
  assert.equal(h.calls.fetch.length, 10);
  assert.equal(h.calls.finish.filter((f) => f.error_code === "circuit_open").length, 15, "the 15 jobs beyond the cap are released, never left leased");
});

test("WT-17 logs and run summaries contain no secret, address, key, provider body or payload", async () => {
  const h = harness({ fetchImpl: () => jsonResponse(500, { message: "to new.user@example.test failed", key: RESEND_KEY }) });
  const s = await runOnce(h.deps);
  const everything = JSON.stringify([h.calls.logs, s]);
  for (const bad of ["new.user@example.test", RESEND_KEY, DB_KEY, SECRET, "11111111-2222-3333", "lease"]) assert.ok(!everything.includes(bad), bad);
});

// ---- HTTP entry point ---------------------------------------------------------------------------------------------------------------
const mkReq = (headers = {}, method = "POST", body) => new Request("https://fn.example/azerdex-welcome-worker", { method, headers, body });
const stdIo = (calls = []) => async (url, init) => {
  calls.push(url);
  if (url.includes("/rest/v1/rpc/azerdex_welcome_claim")) return jsonResponse(200, [job()]);
  if (url.includes("/rest/v1/rpc/azerdex_welcome_finish")) return jsonResponse(200, true);
  return jsonResponse(200, { id: "re_abcdefgh1234" });
};

test("WT-18 unauthorized invocation is rejected without running anything or revealing state", async () => {
  const calls = [];
  for (const headers of [{}, { "x-azerdex-worker-secret": "wrong" }, { "x-azerdex-worker-secret": SECRET.slice(0, -1) }, { authorization: `Bearer ${SECRET}` }, { "x-azerdex-worker-secret": "" }]) {
    const r = await handle(mkReq(headers), env(), stdIo(calls), logoBytes);
    assert.equal(r.status, 401);
    assert.deepEqual(await r.json(), { error: "unauthorized" });
  }
  assert.equal((await handle(mkReq({}, "GET"), env(), stdIo(calls), logoBytes)).status, 405);
  // a worker with no/weak configured secret rejects everyone, including a caller sending the same weak value
  const weak = await handle(mkReq({ "x-azerdex-worker-secret": "short" }), env({ AZERDEX_WORKER_SECRET: "short" }), stdIo(calls), logoBytes);
  assert.equal(weak.status, 401);
  const none = await handle(mkReq({ "x-azerdex-worker-secret": "" }), env({ AZERDEX_WORKER_SECRET: "" }), stdIo(calls), logoBytes);
  assert.equal(none.status, 401);
  assert.deepEqual(calls, [], "nothing was called");
});

test("WT-19 authorized invocation runs once; the request body can never supply a recipient or limit", async () => {
  const calls = [], bodies = [];
  const io = async (url, init) => { bodies.push(init?.body); return stdIo(calls)(url, init); };
  const r = await handle(mkReq({ "x-azerdex-worker-secret": SECRET }, "POST", JSON.stringify({ to: "attacker@evil.test", limit: 9999, recipient: "attacker@evil.test", html: "<b>x</b>" })), env(), io, logoBytes);
  assert.equal(r.status, 200);
  const summary = await r.json();
  assert.deepEqual([summary.state, summary.sent], ["ok", 1]);
  assert.ok(!bodies.some((b) => b && String(b).includes("attacker")));
  assert.ok(!JSON.stringify(summary).includes("example.test"));
  assert.ok(calls.some((u) => u.includes("azerdex_welcome_claim")));
});

test("WT-20 disabled worker with a valid secret answers 'disabled' and calls nothing", async () => {
  const calls = [];
  const r = await handle(mkReq({ "x-azerdex-worker-secret": SECRET }), env({ AZERDEX_WELCOME_ENABLED: "false" }), stdIo(calls), logoBytes);
  assert.equal((await r.json()).state, "disabled");
  assert.deepEqual(calls, []);
});

test("WT-21 secretMatches is exact and rejects short/empty values", async () => {
  assert.equal(await secretMatches(SECRET, SECRET), true);
  assert.equal(await secretMatches(SECRET + "x", SECRET), false);
  assert.equal(await secretMatches("", SECRET), false);
  assert.equal(await secretMatches("a".repeat(31), "a".repeat(31)), false);
});

// ---- database client ----------------------------------------------------------------------------------------------------------------
test("WT-22 the DB client only calls the two named RPCs, sends the server key as header, and never echoes response bodies in errors", async () => {
  const seen = [];
  const f = async (url, init) => { seen.push({ url, init }); return url.endsWith("azerdex_welcome_claim") ? jsonResponse(200, [job(), { user_id: 5 }, null]) : jsonResponse(500, { secret: "LEAK-ME" }); };
  const db = createDb(cfg(), f);
  const jobs = await db.claim(10);
  assert.equal(jobs.length, 1, "malformed rows are dropped");
  assert.equal(seen[0].url, "https://example-ref.supabase.co/rest/v1/rpc/azerdex_welcome_claim");
  assert.equal(seen[0].init.headers.apikey, DB_KEY);
  assert.deepEqual(JSON.parse(seen[0].init.body), { p_limit: 10 });
  assert.ok(seen[0].init.signal instanceof AbortSignal, "RPC calls carry a timeout signal");
  await assert.rejects(() => db.finish({ user_id: "u", lease_token: "l", outcome: "sent", provider_id: "re_abcdefgh1234" }), (e) => e.message === "rpc_azerdex_welcome_finish_500" && !e.message.includes("LEAK"));
  assert.deepEqual(JSON.parse(seen[1].init.body), { p_user_id: "u", p_lease_token: "l", p_outcome: "sent", p_provider_id: "re_abcdefgh1234", p_error_code: null, p_retry_after_seconds: null });
  await assert.rejects(() => createDb(cfg(), async () => jsonResponse(200, { not: "an array" })).claim(1), /rpc_claim_shape/);
});
