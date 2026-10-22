#!/usr/bin/env node
// G-2 harness: does the welcome provenance rule behave the same on a given Supabase Auth (GoTrue) deployment as on the pinned local build?
// OWNER-RUN against an ISOLATED STAGING project (or the disposable local stack). It never prints addresses, tokens or keys.
//
// SAFETY (all enforced in code):
//   * hosted mode requires FDB_STAGING_REF = a 20-character project ref that is NOT the private/production ref, https URLs, and BOTH AUTH_URL and
//     REST_URL hostnames exactly equal to `<ref>.supabase.co` (no ports, no credentials, no look-alike hosts); if the server key is a JWT its `ref`
//     claim must equal FDB_STAGING_REF;
//   * loopback mode (the disposable local stack) needs STATS_MODE=pg, a loopback PGHOST and a database name starting with `fdb_`;
//   * sends no e-mail: flows are driven with the Auth ADMIN generate_link API (hashed tokens) and the normal /verify endpoint, so the SAME
//     verification code path runs as for a real link; users are synthetic, on the non-routable domain welcome-probe.invalid;
//   * every user it creates is DELETED at the end (also after a failure), which cascades to their candidate/outbox rows; dispatch must be OFF
//     before the first scenario AND before every scenario (a switch flipped mid-run aborts it), so no synthetic event can ever be sent;
//   * the project must already have migration 0015 applied with `enqueue_enabled = true` and `activation_at` set (reads public.azerdex_welcome_stats()).
//
// Env:  AUTH_URL (https://<ref>.supabase.co/auth/v1)  REST_URL (https://<ref>.supabase.co/rest/v1)  SERVICE_KEY (server key, environment only)
//       FDB_STAGING_REF  ANON_KEY (publishable key; REQUIRED for G-2 PASS: it drives the anonymous scenario S7)
//       STATS_MODE=rpc (default, PostgREST) | pg (disposable local stack only)
// G-2 PASS = exit code 0 AND S1..S5 and S7 all `pass: true` AND cleanup restored the outbox. S6 is INFORMATIONAL (it acts on an already-confirmed user,
// so it cannot fire the confirm trigger; secure e-mail change also needs both confirmations): repeat it by hand with real mail to an owner-controlled
// address if wanted. Evidence is printed as JSON without personal data.
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

const parse = (raw, what) => { try { return new URL(raw); } catch { throw new Error(`${what} is not a valid URL`); } };
function jwtRef(token) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try { return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")).ref ?? null; } catch { return null; }
}
function guard() {
  if (!AUTH_URL || !SERVICE_KEY) throw new Error("AUTH_URL and SERVICE_KEY are required");
  const a = parse(AUTH_URL, "AUTH_URL");
  if (a.hostname === "127.0.0.1" || a.hostname === "localhost") {
    if (STATS_MODE !== "pg") throw new Error("loopback requires STATS_MODE=pg");
    const pgHost = env("PGHOST") || "127.0.0.1";
    if (pgHost !== "127.0.0.1" && pgHost !== "localhost") throw new Error("refusing: PGHOST must be loopback in pg mode");
    if (!(env("FDB_IT_DB") || "fdb_account_it").startsWith("fdb_")) throw new Error("refusing: pg mode only talks to a disposable fdb_* database");
    return;
  }
  if (STATS_MODE !== "rpc") throw new Error("STATS_MODE=pg is only for the disposable local stack");
  if (!/^[a-z0-9]{20}$/.test(REF)) throw new Error("refusing: FDB_STAGING_REF must be a 20-character project ref");
  if (REF === PROD_REF) throw new Error("refusing: FDB_STAGING_REF names the private/production project");
  const r = parse(REST_URL, "REST_URL");
  for (const [name, u] of [["AUTH_URL", a], ["REST_URL", r]]) {
    if (u.protocol !== "https:" || u.username || u.password || u.port) throw new Error(`refusing: ${name} must be a plain https URL`);
    if (u.hostname.includes(PROD_REF)) throw new Error(`refusing: ${name} names the private/production project`);
    if (u.hostname !== `${REF}.supabase.co`) throw new Error(`refusing: ${name} host must be exactly <FDB_STAGING_REF>.supabase.co`);
  }
  const claim = jwtRef(SERVICE_KEY);
  if (claim !== null && claim !== REF) throw new Error("refusing: the SERVICE_KEY belongs to a different project than FDB_STAGING_REF");
}

async function http(url, { method = "POST", body, key = SERVICE_KEY, extra = {} } = {}) {
  const res = await fetch(url, { method, redirect: "error", headers: { "content-type": "application/json", apikey: key, authorization: `Bearer ${key}`, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
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
  if (!pgClient) {
    const { createRequire } = await import("node:module");
    const pg = createRequire(new URL("../web/package.json", import.meta.url))("pg");
    pgClient = new pg.Client({ host: env("PGHOST") || "127.0.0.1", port: Number(process.env.PGPORT ?? 5432), user: process.env.PGUSER, password: process.env.PGPASSWORD, database: env("FDB_IT_DB") || "fdb_account_it" });
    await pgClient.connect();
  }
  const q = async (sql) => Number((await pgClient.query(sql)).rows[0].n);
  const cfg = (await pgClient.query("select enqueue_enabled, dispatch_enabled from private.azerdex_welcome_config")).rows[0];
  return { enqueue_enabled: cfg.enqueue_enabled, dispatch_enabled: cfg.dispatch_enabled, by_status: { total: await q("select count(*) n from private.azerdex_welcome_outbox") }, candidates: await q("select count(*) n from private.azerdex_welcome_candidates") };
}
const outboxTotal = (s) => (s.by_status?.total ?? Object.values(s.by_status ?? {}).reduce((a, b) => a + Number(b), 0));

const createdUsers = new Set();
const email = (tag) => `${tag}-${randomUUID().slice(0, 8)}@${DOMAIN}`;
const link = async (type, addr, extra = {}) => {
  const r = await auth("/admin/generate_link", { body: { type, email: addr, ...extra } });
  if (r.status !== 200 || !r.json?.hashed_token) throw new Error(`generate_link(${type}) failed (${r.status})`);
  const id = r.json.id ?? r.json.user?.id;
  if (id) createdUsers.add(id);
  return r.json.hashed_token;
};
const verify = (type, token_hash) => auth("/verify", { body: { type, token_hash } });

const results = [];
async function scenario(id, title, expectDelta, expectCandidates, fn, { must = null, informational = false } = {}) {
  const before = await stats();
  if (before.dispatch_enabled) throw new Error("dispatch_enabled became true during the run: aborting (a synthetic event could be sent)");
  let note = "";
  try { note = (await fn()) ?? ""; } catch (e) { note = `ERROR: ${e.message}`; }
  const after = await stats();
  const delta = outboxTotal(after) - outboxTotal(before);
  const cDelta = Number(after.candidates ?? 0) - Number(before.candidates ?? 0);
  const matches = delta === expectDelta && (expectCandidates === null || cDelta === expectCandidates) && !note.startsWith("ERROR");
  // `must` is the provider answer a scenario needs in order to prove anything (e.g. "verify 200"): without it the result is INCONCLUSIVE, never PASS.
  const conclusive = must === null || note.includes(must);
  const ok = !matches ? false : informational || !conclusive ? null : true;
  results.push({ id, title, expected_outbox_delta: expectDelta, outbox_delta: delta, candidate_delta: cDelta, pass: ok,
    ...(informational && matches ? { informational: true } : {}), ...(!informational && ok === null ? { inconclusive: `needed "${must}"` } : {}),
    note: note.replace(/[\w.+-]+@[\w.-]+/g, "<redacted>") });
}

async function cleanup() {
  let deleted = 0;
  for (const id of createdUsers) {
    const r = await auth(`/admin/users/${id}`, { method: "DELETE", body: { should_soft_delete: false } });
    if (r.status === 200) deleted += 1;
  }
  return { users_created: createdUsers.size, users_deleted: deleted };
}

guard();
const s0 = await stats();
if (!s0.enqueue_enabled) throw new Error("enqueue_enabled is false: switch intake ON on STAGING first (select private.azerdex_welcome_set_switch(true, null))");
if (s0.dispatch_enabled) throw new Error("dispatch_enabled is true: refusing to test while sending is possible (set dispatch OFF)");
const baselineOutbox = outboxTotal(s0);

let fatal = null;
let cleanupReport = { users_created: 0, users_deleted: 0 };
try {
  await scenario("S1", "first genuine signup confirmation queues exactly one event (the candidate is consumed)", +1, 0, async () => {
    const a = email("s1"); const t = await link("signup", a, { password: PASSWORD });
    const v = await verify("signup", t); return `verify ${v.status}`;
  }, { must: "verify 200" });
  await scenario("S2", "repeating the (already consumed) confirmation adds nothing", +1, 0, async () => {
    const a = email("s2"); const t = await link("signup", a, { password: PASSWORD });
    const first = await verify("signup", t);
    const before = outboxTotal(await stats()); const v = await verify("signup", t);
    if (outboxTotal(await stats()) !== before) throw new Error("repeat verification changed the outbox");
    return `first verify ${first.status}; second verify ${v.status}`;
  }, { must: "first verify 200" });
  await scenario("S3", "recovery link on an UNCONFIRMED signup confirms the address but queues nothing", 0, +1, async () => {
    const a = email("s3"); await link("signup", a, { password: PASSWORD });
    const r = await link("recovery", a); const v = await verify("recovery", r); return `recovery verify ${v.status}`;
  }, { must: "recovery verify 200" });
  await scenario("S4", "password recovery of a confirmed account queues nothing beyond its first event", +1, 0, async () => {
    const a = email("s4"); await verify("signup", await link("signup", a, { password: PASSWORD }));
    const before = outboxTotal(await stats());
    const v = await verify("recovery", await link("recovery", a));
    if (outboxTotal(await stats()) !== before) throw new Error("recovery of a confirmed account changed the outbox");
    return `recovery verify ${v.status}`;
  }, { must: "recovery verify 200" });
  await scenario("S5", "recovery requested BEFORE the signup link is used: documented safe false negative (no event)", 0, +1, async () => {
    const a = email("s5"); const t = await link("signup", a, { password: PASSWORD });
    await link("recovery", a); const v = await verify("signup", t); return `signup verify ${v.status}`;
  }, { must: "signup verify 200" });
  await scenario("S6", "INFORMATIONAL: e-mail change of a confirmed account (cannot fire the confirm trigger; needs both confirmations)", +1, 0, async () => {
    const a = email("s6"); await verify("signup", await link("signup", a, { password: PASSWORD }));
    const before = outboxTotal(await stats());
    const t = await link("email_change_new", a, { new_email: email("s6n") });
    const v = await verify("email_change", t);
    if (outboxTotal(await stats()) !== before) throw new Error("email change changed the outbox");
    return `email_change verify ${v.status}`;
  }, { informational: true });
  if (ANON_KEY) {
    await scenario("S7", "anonymous sign-in never becomes a candidate or an event", 0, 0, async () => {
      const r = await http(`${AUTH_URL}/signup`, { body: {}, key: ANON_KEY });
      const id = r.json?.user?.id ?? r.json?.id; if (id) createdUsers.add(id);
      return `anonymous signup ${r.status}`;
    }, { must: "anonymous signup 200" });
  } else {
    results.push({ id: "S7", title: "anonymous sign-in: NOT RUN (ANON_KEY not set); G-2 cannot PASS without it", pass: null, inconclusive: "ANON_KEY missing" });
  }
  // The admin-API "confirm user" edge case is row-level identical to a signup confirmation (documented residual risk; local test PV-13). Not exercised here.
} catch (e) {
  fatal = e.message;
} finally {
  cleanupReport = await cleanup();
}
const after = await stats();
const restored = outboxTotal(after) === baselineOutbox;
const cleanupOk = cleanupReport.users_created === cleanupReport.users_deleted && restored;
const required = ["S1", "S2", "S3", "S4", "S5", "S7"];
const failed = results.filter((r) => r.pass === false);
const g2Pass = !fatal && failed.length === 0 && required.every((id) => results.find((r) => r.id === id)?.pass === true) && cleanupOk;
console.log(JSON.stringify({
  auth_host_class: STATS_MODE === "pg" ? "loopback" : "hosted-staging",
  scenarios: results,
  cleanup: { ...cleanupReport, outbox_total_restored: restored },
  ...(fatal ? { aborted: fatal } : {}),
  summary: { pass: results.filter((r) => r.pass === true).length, fail: failed.length, inconclusive_informational_or_skipped: results.filter((r) => r.pass === null).length, g2_pass: g2Pass },
}, null, 2));
if (pgClient) await pgClient.end();
process.exit(g2Pass ? 0 : 1);
