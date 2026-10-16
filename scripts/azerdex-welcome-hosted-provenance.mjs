#!/usr/bin/env node
// G-2 harness: does the welcome provenance rule behave the same on a given Supabase Auth (GoTrue) deployment as on the pinned local build?
// OWNER-RUN against an ISOLATED STAGING project (or the disposable local stack). It never prints addresses, tokens or keys.
//
// SAFETY (all enforced in code):
//   * refuses to run unless FDB_STAGING_REF names the project AND the URL host starts with that ref (or the URL is loopback for the local stack);
//   * refuses the known private/production project ref (klxhikdlfwgxurdyexdi) unconditionally;
//   * sends no e-mail: flows are driven with the Auth ADMIN generate_link API (hashed tokens) and the normal /verify endpoint, so the SAME
//     verification code path runs as for a real link; use synthetic addresses on a non-routable domain;
//   * the project must already have migration 0015 applied with `enqueue_enabled = true` (it reads public.azerdex_welcome_stats());
//     dispatch must stay OFF (the script aborts if dispatch_enabled is true) so nothing can be sent while testing.
//
// Env:  AUTH_URL (e.g. https://<ref>.supabase.co/auth/v1)   SERVICE_KEY (server key; read from the environment only)
//       FDB_STAGING_REF (project ref)   STATS_MODE=rpc (default; PostgREST /rest/v1/rpc, needs REST_URL) | pg (disposable local stack only)
//       REST_URL (e.g. https://<ref>.supabase.co/rest/v1)   ANON_KEY (publishable key; only for the anonymous-sign-in scenario)
// Exit code 0 only if EVERY expectation held. Evidence is printed as JSON without personal data.
import { randomUUID } from "node:crypto";

const PROD_REF = "klxhikdlfwgxurdyexdi";
const env = (n) => (process.env[n] ?? "").trim();
const AUTH_URL = env("AUTH_URL").replace(/\/+$/, "");
const REST_URL = env("REST_URL").replace(/\/+$/, "");
const SERVICE_KEY = env("SERVICE_KEY");
const ANON_KEY = env("ANON_KEY");
const REF = env("FDB_STAGING_REF");
const STATS_MODE = env("STATS_MODE") || "rpc";
const DOMAIN = "welcome-probe.invalid";
const PASSWORD = `P-${randomUUID()}-aA1!`;

function guard() {
  const host = (() => { try { return new URL(AUTH_URL).hostname; } catch { return ""; } })();
  const loopback = host === "127.0.0.1" || host === "localhost";
  if (!AUTH_URL || !SERVICE_KEY) throw new Error("AUTH_URL and SERVICE_KEY are required");
  if (loopback) { if (STATS_MODE !== "pg") throw new Error("loopback requires STATS_MODE=pg"); return; }
  if (STATS_MODE !== "rpc") throw new Error("STATS_MODE=pg is only for the disposable local stack");
  if (!REF || REF === PROD_REF || AUTH_URL.includes(PROD_REF) || REST_URL.includes(PROD_REF)) throw new Error("refusing: FDB_STAGING_REF missing or names the private/production project");
  if (!host.startsWith(`${REF}.`)) throw new Error("refusing: AUTH_URL host does not belong to FDB_STAGING_REF");
  if (!REST_URL.includes(`${REF}.`)) throw new Error("refusing: REST_URL host does not belong to FDB_STAGING_REF");
}

async function http(url, { method = "POST", body, key = SERVICE_KEY, extra = {} } = {}) {
  const res = await fetch(url, { method, headers: { "content-type": "application/json", apikey: key, authorization: `Bearer ${key}`, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, json };
}
const auth = (path, opts) => http(`${AUTH_URL}${path}`, opts);

let pgClient = null;
async function stats() {
  if (STATS_MODE === "rpc") {
    const r = await http(`${REST_URL}/rpc/azerdex_welcome_stats`, { body: {} });
    if (r.status !== 200) throw new Error(`stats RPC failed (${r.status})`);
    return r.json;
  }
  if (!pgClient) { const { createRequire } = await import("node:module"); const pg = createRequire(new URL("../web/package.json", import.meta.url))("pg"); pgClient = new pg.Client({ host: "127.0.0.1", port: Number(process.env.PGPORT ?? 5432), user: process.env.PGUSER, password: process.env.PGPASSWORD, database: process.env.FDB_IT_DB ?? "fdb_account_it" }); await pgClient.connect(); }
  const q = async (sql) => Number((await pgClient.query(sql)).rows[0].n);
  const cfg = (await pgClient.query("select enqueue_enabled, dispatch_enabled from private.azerdex_welcome_config")).rows[0];
  return { enqueue_enabled: cfg.enqueue_enabled, dispatch_enabled: cfg.dispatch_enabled, by_status: { total: await q("select count(*) n from private.azerdex_welcome_outbox") }, candidates: await q("select count(*) n from private.azerdex_welcome_candidates") };
}
const outboxTotal = (s) => (s.by_status?.total ?? Object.values(s.by_status ?? {}).reduce((a, b) => a + Number(b), 0));

const email = (tag) => `${tag}-${randomUUID().slice(0, 8)}@${DOMAIN}`;
const link = async (type, addr, extra = {}) => {
  const r = await auth("/admin/generate_link", { body: { type, email: addr, ...extra } });
  if (r.status !== 200 || !r.json?.hashed_token) throw new Error(`generate_link(${type}) failed (${r.status})`);
  return r.json.hashed_token;
};
const verify = (type, token_hash) => auth("/verify", { body: { type, token_hash } });

const results = [];
async function scenario(id, title, expectDelta, expectCandidates, fn, must = null) {
  const before = await stats();
  let note = "";
  try { note = (await fn()) ?? ""; } catch (e) { note = `ERROR: ${e.message}`; }
  const after = await stats();
  const delta = outboxTotal(after) - outboxTotal(before);
  const cDelta = Number(after.candidates ?? 0) - Number(before.candidates ?? 0);
  const matches = delta === expectDelta && (expectCandidates === null || cDelta === expectCandidates) && !note.startsWith("ERROR");
  // `must` is the provider answer the scenario needs in order to prove anything (e.g. "verify 200"): without it the result is INCONCLUSIVE, never PASS.
  const conclusive = must === null || note.includes(must);
  const ok = !matches ? false : conclusive ? true : null;
  results.push({ id, title, expected_outbox_delta: expectDelta, outbox_delta: delta, candidate_delta: cDelta, pass: ok, ...(ok === null ? { inconclusive: `needed "${must}"` } : {}), note: note.replace(/[\w.+-]+@[\w.-]+/g, "<redacted>") });
}

guard();
const s0 = await stats();
if (!s0.enqueue_enabled) throw new Error("enqueue_enabled is false: switch intake ON on STAGING first (select private.azerdex_welcome_set_switch(true, null))");
if (s0.dispatch_enabled) throw new Error("dispatch_enabled is true: refusing to test while sending is possible (set dispatch OFF)");

await scenario("S1", "first genuine signup confirmation queues exactly one event (the candidate is consumed)", +1, 0, async () => {
  const a = email("s1"); const t = await link("signup", a, { password: PASSWORD });
  const v = await verify("signup", t); return `verify ${v.status}`;
}, "verify 200");
await scenario("S2", "repeating the (already consumed) confirmation adds nothing", +1, 0, async () => {
  const a = email("s2"); const t = await link("signup", a, { password: PASSWORD });
  await verify("signup", t);
  const before = outboxTotal(await stats()); const v = await verify("signup", t);
  if (outboxTotal(await stats()) !== before) throw new Error("repeat verification changed the outbox");
  return `second verify ${v.status}`;
});
await scenario("S3", "recovery link on an UNCONFIRMED signup confirms the address but queues nothing", 0, +1, async () => {
  const a = email("s3"); await link("signup", a, { password: PASSWORD });
  const r = await link("recovery", a); const v = await verify("recovery", r); return `recovery verify ${v.status}`;
}, "recovery verify 200");
await scenario("S4", "password recovery of a confirmed account queues nothing beyond its first event", +1, 0, async () => {
  const a = email("s4"); await verify("signup", await link("signup", a, { password: PASSWORD }));
  const before = outboxTotal(await stats());
  const v = await verify("recovery", await link("recovery", a));
  if (outboxTotal(await stats()) !== before) throw new Error("recovery of a confirmed account changed the outbox");
  return `recovery verify ${v.status}`;
}, "recovery verify 200");
await scenario("S5", "recovery requested BEFORE the signup link is used: documented safe false negative (no event)", 0, +1, async () => {
  const a = email("s5"); const t = await link("signup", a, { password: PASSWORD });
  await link("recovery", a); const v = await verify("signup", t); return `signup verify ${v.status}`;
}, "signup verify 200");
await scenario("S6", "e-mail change of a confirmed account queues nothing beyond its first event", +1, 0, async () => {
  const a = email("s6"); await verify("signup", await link("signup", a, { password: PASSWORD }));
  const before = outboxTotal(await stats());
  const t = await link("email_change_new", a, { new_email: email("s6n") });
  const v = await verify("email_change", t);
  if (outboxTotal(await stats()) !== before) throw new Error("email change changed the outbox");
  return `email_change verify ${v.status}`;
}, "email_change verify 200");
if (ANON_KEY) {
  await scenario("S7", "anonymous sign-in never becomes a candidate or an event", 0, 0, async () => {
    const r = await http(`${AUTH_URL}/signup`, { body: {}, key: ANON_KEY }); return `anonymous signup ${r.status}`;
  });
} else {
  results.push({ id: "S7", title: "anonymous sign-in (skipped: ANON_KEY not set)", pass: null });
}
// The admin-API "confirm user" edge case is row-level identical to a signup confirmation (documented residual risk; local test PV-13). Not exercised here.

const failed = results.filter((r) => r.pass === false);
console.log(JSON.stringify({ auth_host_class: STATS_MODE === "pg" ? "loopback" : "hosted-staging", scenarios: results, summary: { pass: results.filter((r) => r.pass === true).length, fail: failed.length, inconclusive_or_skipped: results.filter((r) => r.pass === null).length } }, null, 2));
if (pgClient) await pgClient.end();
process.exit(failed.length === 0 ? 0 : 1);
