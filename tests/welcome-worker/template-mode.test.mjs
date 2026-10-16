// G-4 follow-up: the worker's `template` mode must send exactly the request shape the owner's real provider test proved
// (POST /emails, published template `azerdex-welcome-v1`, inline CID image attachment, template variables rendered, text alternative present,
// subject/from overridden). These are MOCKED regression tests: they pin the request shape and our handling of the provider's answers.
// They do NOT replace the real provider evidence and say nothing about the deployed Edge Function path (hosted G-3/G-7).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../supabase/functions/azerdex-welcome-worker/config.ts";
import { buildPayload } from "../../supabase/functions/azerdex-welcome-worker/email.ts";
import { validateLogo } from "../../supabase/functions/azerdex-welcome-worker/logo.ts";
import { runOnce } from "../../supabase/functions/azerdex-welcome-worker/worker.ts";
import { env, job, jsonResponse } from "./fixtures.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fnDir = path.join(root, "supabase/functions/azerdex-welcome-worker");
const png = new Uint8Array(fs.readFileSync(path.join(fnDir, "azerdex-logo.png")));
const logo = validateLogo(png);
const cfg = (over = {}) => loadConfig(env({ AZERDEX_WELCOME_MODE: "template", ...over }));

/** A model of the provider's documented/observed rules for POST /emails (not Resend itself). */
function providerModel({ requiredVariables = ["CTA_URL"], knownTemplates = ["azerdex-welcome-v1"] } = {}) {
  const seen = new Map(); // idempotency key -> payload JSON (24 h window assumed unexpired)
  const calls = [];
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const key = init.headers["idempotency-key"];
    calls.push({ url, key, body });
    if (url !== "https://api.resend.com/emails" || init.method !== "POST") return jsonResponse(404, { name: "not_found" });
    if (init.headers.authorization !== `Bearer ${"re_test_key_NOT_A_REAL_KEY_123456"}`) return jsonResponse(401, { name: "restricted_api_key" });
    if (!key || key.length > 256) return jsonResponse(400, { name: "invalid_idempotency_key" });
    if (seen.has(key)) return seen.get(key) === init.body ? jsonResponse(200, { id: "re_dup_replay_0001" }) : jsonResponse(409, { name: "invalid_idempotent_request" });
    if (body.template && (body.html || body.text || body.react)) return jsonResponse(422, { name: "validation_error" }); // template is exclusive with content
    if (!body.template && !body.html && !body.text) return jsonResponse(422, { name: "missing_required_field" });
    if (body.template) {
      if (!knownTemplates.includes(body.template.id)) return jsonResponse(404, { name: "not_found" });
      for (const v of requiredVariables) if (!(v in (body.template.variables ?? {}))) return jsonResponse(422, { name: "validation_error" });
    }
    for (const a of body.attachments ?? []) if (!a.filename || !a.content || !a.content_id) return jsonResponse(422, { name: "invalid_attachment" });
    seen.set(key, init.body);
    return jsonResponse(200, { id: `re_model_${String(calls.length).padStart(8, "0")}` });
  };
  return { fetch, calls };
}

function run(provider, over = {}, jobs = [job()]) {
  const finishes = [];
  const deps = {
    cfg: cfg(over),
    db: { claim: async () => jobs, finish: async (a) => { finishes.push(a); return true; } },
    fetch: provider.fetch,
    loadLogoBytes: async () => png,
    log: () => {},
  };
  return { go: () => runOnce(deps), finishes };
}

test("TM-1 template payload has EXACTLY the proven shape: nothing extra, nothing missing", () => {
  const p = buildPayload(cfg(), "a@example.test", logo);
  assert.deepEqual(Object.keys(p).sort(), ["attachments", "from", "reply_to", "subject", "template", "to"]);
  assert.deepEqual(p.template, { id: "azerdex-welcome-v1", variables: { CTA_URL: "https://azerdex.com/" } });
  assert.deepEqual(p.to, ["a@example.test"]);
  assert.equal(p.from, "AzerDex <welcome@azerdex.com>");
  assert.equal(p.reply_to, "support@azerdex.com");
  assert.equal(p.subject, "Welcome to AzerDex — Know Your World");
  assert.equal(p.attachments.length, 1);
  assert.deepEqual(Object.keys(p.attachments[0]).sort(), ["content", "content_id", "content_type", "filename"]);
  for (const forbidden of ["html", "text", "react", "headers", "tags", "cc", "bcc", "scheduled_at", "attachments_url"]) assert.equal(p[forbidden], undefined, forbidden);
});

test("TM-2 the attachment is the committed emblem byte for byte: image/png, 6,819 bytes, pinned sha256, CID matches the template's img", () => {
  const a = buildPayload(cfg(), "a@example.test", logo).attachments[0];
  const bytes = Buffer.from(a.content, "base64");
  assert.equal(bytes.length, 6819);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), fs.readFileSync(path.join(fnDir, "azerdex-logo.sha256"), "utf8").split(/\s+/)[0]);
  assert.deepEqual([a.filename, a.content_type, a.content_id], ["azerdex-logo.png", "image/png", "azerdex-logo"]);
  assert.ok(!a.content.includes("data:"), "raw base64, not a data URI");
});

test("TM-3 end to end in template mode against the provider model: accepted, finished as sent, same key replay is idempotent", async () => {
  const provider = providerModel();
  const r = run(provider);
  const s = await r.go();
  assert.deepEqual([s.state, s.sent], ["ok", 1]);
  assert.equal(r.finishes[0].outcome, "sent");
  assert.match(r.finishes[0].provider_id, /^re_model_/);
  assert.equal(provider.calls.length, 1);
  assert.equal(provider.calls[0].key, job().idempotency_key);
  // a crash-recovery retry with the SAME key and SAME payload is answered idempotently by the provider (no second message)
  const again = await run(provider).go();
  assert.equal(again.sent, 1);
  assert.equal(provider.calls.filter((c) => c.key === job().idempotency_key).length, 2);
});

test("TM-4 idempotency key is independent of the mode: it comes from the database only, so a mode switch can never mint a second key for one event", async () => {
  const p1 = providerModel(), p2 = providerModel();
  await run(p1, { AZERDEX_WELCOME_MODE: "html" }).go();
  await run(p2, { AZERDEX_WELCOME_MODE: "template" }).go();
  assert.equal(p1.calls[0].key, p2.calls[0].key);
});

test("TM-5 switching html -> template while an event is mid-retry: the provider answers 409 (key reused with a different payload); worker treats it as ambiguous, retries only under the SAME key, never sends a second message", async () => {
  const provider = providerModel();
  await run(provider, { AZERDEX_WELCOME_MODE: "html" }).go(); // first attempt (say its outcome was lost) accepted under key K in html mode
  const r = run(provider, { AZERDEX_WELCOME_MODE: "template" });
  const s = await r.go();
  assert.equal(s.ambiguous, 1);
  assert.deepEqual([r.finishes[0].outcome, r.finishes[0].error_code], ["ambiguous", "provider_idempotency_conflict"]);
  assert.equal(new Set(provider.calls.map((c) => c.key)).size, 1, "only one idempotency key ever used");
});

test("TM-6 a template-level misconfiguration (unknown template id / missing required variable) is NEVER a successful send, and parks at most 3 users per run", async () => {
  const jobs = Array.from({ length: 6 }, (_, i) => job({ user_id: `u${i}`, lease_token: `l${i}`, idempotency_key: `k${i}` }));
  for (const provider of [providerModel({ knownTemplates: ["something-else"] }), providerModel({ requiredVariables: ["CTA_URL", "FIRST_NAME"] })]) {
    const r = run(provider, {}, jobs);
    const s = await r.go();
    assert.equal(s.sent, 0);
    assert.equal(provider.calls.length, 3, "breaker: only 3 provider calls");
    assert.deepEqual(r.finishes.filter((f) => f.outcome === "permanent").length, 3);
    assert.equal(r.finishes.filter((f) => f.error_code === "circuit_open").length, 3, "the other 3 are released unsent, attempts given back");
    assert.equal(s.state, "circuit_open");
  }
});

test("TM-7 provider error classification and retry behaviour hold in template mode (429 / 5xx / timeout / malformed / auth)", async () => {
  const cases = [
    [() => jsonResponse(429, {}, { "retry-after": "42" }), "retry", "provider_rate_limited"],
    [() => jsonResponse(503, {}), "ambiguous", "provider_5xx"],
    [() => jsonResponse(200, { not: "an id" }), "ambiguous", "provider_malformed_response"],
    [() => jsonResponse(422, { name: "validation_error" }), "permanent", "provider_rejected"],
  ];
  for (const [respond, outcome, code] of cases) {
    const r = run({ fetch: async () => respond(), calls: [] });
    await r.go();
    assert.equal(r.finishes[0].outcome, outcome);
    assert.equal(r.finishes[0].error_code, code);
  }
  const finishes = [];
  const hangFetch = (_u, init) => new Promise((_res, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  await runOnce({ cfg: { ...cfg(), sendTimeoutMs: 30 }, db: { claim: async () => [job()], finish: async (a) => (finishes.push(a), true) }, fetch: hangFetch, loadLogoBytes: async () => png, log: () => {} });
  assert.deepEqual([finishes[0].outcome, finishes[0].error_code], ["ambiguous", "provider_timeout"]);
  const auth = run({ fetch: async () => jsonResponse(401, {}), calls: [] });
  const s = await auth.go();
  assert.equal(s.state, "provider_auth_failed");
  assert.deepEqual([auth.finishes[0].outcome, auth.finishes[0].error_code], ["retry", "circuit_open"]);
});

test("TM-8 mode selection is explicit and fail-safe: only the exact value 'template' selects it; anything else (unset, typo, wrong case) is the version-controlled html path", () => {
  for (const v of [undefined, "", "html", "TEMPLATE", "Template", "templates", " html ", "1", "true"]) assert.equal(loadConfig(env({ AZERDEX_WELCOME_MODE: v })).mode, "html", String(v));
  assert.equal(loadConfig(env({ AZERDEX_WELCOME_MODE: "template" })).mode, "template");
  assert.equal(loadConfig(env({ AZERDEX_WELCOME_MODE: " template " })).mode, "template", "surrounding whitespace from a secret manager is trimmed");
});

test("TM-9 the fail-closed switches still apply in template mode: disabled flag sends nothing and consumes nothing", async () => {
  const provider = providerModel();
  const r = run(provider, { AZERDEX_WELCOME_ENABLED: "false" });
  assert.equal((await r.go()).state, "disabled");
  assert.equal(provider.calls.length, 0);
  assert.equal(r.finishes.length, 0);
});

test("TM-10 the html fallback is untouched by template mode: html payload still carries rendered body + CID img and no template field", () => {
  const p = buildPayload(loadConfig(env({})), "a@example.test", logo);
  assert.equal(p.template, undefined);
  assert.match(p.html, /<img src="cid:azerdex-logo"/);
  assert.ok(p.text.length > 50);
  assert.equal(p.attachments[0].content_id, "azerdex-logo");
});

test("TM-11 the REAL Resend email id shape (UUID with hyphens, as returned in the owner's G-4 test) is accepted by the worker and fits the database constraint", async () => {
  const realShape = "01a143e5-595b-791a-a12a-421f3e444c19";
  const r = run({ fetch: async () => jsonResponse(200, { id: realShape }), calls: [] });
  const s = await r.go();
  assert.equal(s.sent, 1);
  assert.equal(r.finishes[0].provider_id, realShape);
  // the same pattern the database enforces on outbox.provider_message_id and finish()
  const sql = fs.readFileSync(path.join(root, "database/migrations/0015_azerdex_welcome_outbox.sql"), "utf8");
  const m = sql.match(/provider_message_id ~ '(\^\[A-Za-z0-9_-\]\{8,64\}\$)'/);
  assert.ok(m, "database pattern found");
  assert.ok(new RegExp(m[1]).test(realShape));
  assert.ok(new RegExp(m[1]).test("re_abcdefgh1234"));
});
