import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";
import { expect, test } from "@playwright/test";
import { companionWithInstallation, link, startClaim, webUser } from "./world";
import { JWT_SECRET, REST_OVERRIDE, STACK_DIR, admin, anonymous, auth, claimsOf, logoutLocal, registeredSession, resetBudgets, restGet, rpc, uniq } from "./stack";
import type pg from "pg";

/**
 * REAL PostgREST acceptance (not an emulation): JWT validation, session-claim propagation, SQL role / EXECUTE privileges, commit
 * semantics, error-code propagation, the effect of `Prefer: tx=rollback` and of `db-tx-end`, schema-cache reload, and the proof
 * that no client-controlled header defeats abuse accounting or reaches private data.
 */
let db: pg.Client;
test.beforeAll(async () => { db = await admin(); });
test.afterAll(async () => { await db.end(); });

const b64u = (o: unknown) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
const sign = (claims: Record<string, unknown>, secret = JWT_SECRET, header: Record<string, unknown> = { alg: "HS256", typ: "JWT" }) => {
  const head = b64u(header), body = b64u(claims);
  return `${head}.${body}.${createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url")}`;
};
const ACCOUNT_FUNCTIONS: [string, Record<string, unknown>][] = [
  ["fdb_account_claim_start", { p_installation_id: "x-1" }],
  ["fdb_account_claim_redeem", { p_code: "0123456789ABCDEF0123456789ABCDEF" }],
  ["fdb_installation_link_status", { p_installation_id: "x-1" }],
  ["fdb_account_installations", {}],
];

test("schema cache: the functions did not exist for PostgREST before 0012 and appeared after the migration's NOTIFY, without a restart", async () => {
  const evidence = JSON.parse(readFileSync(`${STACK_DIR}/schema-cache.json`, "utf8")) as { function_status_before_0012: number; function_status_after_0012: number; reload_observed_ms: number };
  expect(evidence.function_status_before_0012).toBe(404); // PGRST202: not in the schema cache
  expect([401, 403]).toContain(evidence.function_status_after_0012); // present, EXECUTE refused to anon
  expect(evidence.reload_observed_ms).toBeLessThan(20_000);
  test.info().annotations.push({ type: "schema-cache", description: JSON.stringify(evidence) });
});

test("JWT validation by PostgREST itself: bad signature, alg none, wrong key, expired, malformed and missing tokens never reach SQL", async () => {
  const id = await anonymous();
  const claims = claimsOf(id.token);
  const good = await rpc(id.token, "fdb_installation_link_status", { p_installation_id: "x-1" });
  expect(good.status).toBe(200);
  const tampered = `${id.token.split(".").slice(0, 2).join(".")}.${"A".repeat(43)}`;
  const algNone = `${b64u({ alg: "none", typ: "JWT" })}.${b64u(claims)}.`;
  const wrongKey = sign(claims, "another-secret-that-is-at-least-32-characters-long-xx");
  const expired = sign({ ...claims, exp: Math.floor(Date.now() / 1000) - 60 });
  const bodySwap = `${id.token.split(".")[0]}.${b64u({ ...claims, sub: "00000000-0000-4000-8000-000000000000" })}.${id.token.split(".")[2]}`;
  for (const [label, tok, code] of [["tampered signature", tampered, "PGRST301"], ["alg none", algNone, "PGRST301"], ["wrong key", wrongKey, "PGRST301"], ["expired", expired, "PGRST301"], ["payload swapped, old signature", bodySwap, "PGRST301"], ["garbage", "not-a-jwt", "PGRST301"]] as const) {
    const r = await rpc(tok, "fdb_installation_link_status", { p_installation_id: "x-1" });
    expect(r.status, label).toBe(401);
    expect(r.body.code, label).toBe(code);
    if (label === "expired") expect(r.body.message).toMatch(/expired/i);
  }
  // no bearer at all -> the anon role: EXECUTE is revoked for every account function
  for (const [name, args] of ACCOUNT_FUNCTIONS) {
    const r = await fetch(`${process.env.ACCOUNT_STACK_URL}/rest/v1/rpc/${name}`, { method: "POST", headers: { apikey: process.env.ACCOUNT_STACK_ANON_KEY!, "content-type": "application/json" }, body: JSON.stringify(args) });
    expect(r.status, name).toBe(401);
  }
});

test("SQL role and EXECUTE privileges as PostgREST applies them: anon and service_role are refused for every account function; kinds are enforced", async ({ playwright }) => {
  const anon = await anonymous();
  const w = await webUser(playwright, "pgrole");
  const registered = await registeredSession(w.email, w.password);
  const serviceRole = sign({ role: "service_role", aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 600 });
  for (const [name, args] of ACCOUNT_FUNCTIONS) {
    const r = await rpc(serviceRole, name, args);
    expect([401, 403], `service_role ${name}`).toContain(r.status); // EXECUTE was revoked from service_role as well
    expect(r.body.code, `service_role ${name}`).toBe("42501");
  }
  // identity kinds: registered-only functions refuse an anonymous user (403); claim_start refuses a registered user (403)
  for (const name of ["fdb_account_claim_redeem", "fdb_account_installations"]) {
    const args = ACCOUNT_FUNCTIONS.find(([n]) => n === name)![1];
    const r = await rpc(anon.token, name, args);
    expect(r.status, `anonymous ${name}`).toBe(403);
    expect(r.body.code).toBe("PT403");
  }
  const start = await rpc(registered.token, "fdb_account_claim_start", { p_installation_id: "x-1" });
  expect(start.status).toBe(403);
  expect(start.body.code).toBe("PT403");
  // the Companion-facing status function is open to every live session
  expect((await rpc(anon.token, "fdb_installation_link_status", { p_installation_id: "x-1" })).body).toEqual({ state: "unknown" });
  expect((await rpc(registered.token, "fdb_installation_link_status", { p_installation_id: "x-1" })).body).toEqual({ state: "unknown" });
});

test("session claims propagate: a correctly signed token for a session that does not exist, belongs to another user, or has no session_id is PT401; sign-out kills an unexpired token; a banned user is refused", async ({ playwright }) => {
  const a = await anonymous();
  const other = await anonymous();
  const c = claimsOf(a.token);
  const exp = Math.floor(Date.now() / 1000) + 600;
  const forged = (over: Record<string, unknown>, omit: string[] = []) => { const x: Record<string, unknown> = { ...c, exp, ...over }; for (const k of omit) delete x[k]; return sign(x); };
  const probe = (tok: string) => rpc(tok, "fdb_installation_link_status", { p_installation_id: "x-1" });
  // LS-2 (no session_id), LS-3 (another user's session), unknown session id: all rejected by the guard with PT401, through PostgREST
  for (const [label, tok] of [["no session_id", forged({}, ["session_id"])], ["other user's session", forged({ session_id: claimsOf(other.token).session_id })], ["unknown session", forged({ session_id: "00000000-0000-4000-8000-0000000000aa" })]] as const) {
    const r = await probe(tok);
    expect(r.status, label).toBe(401);
    expect(r.body.code, label).toBe("PT401");
  }
  // LS-9 over real PostgREST: sign out, the SAME unexpired token is refused
  expect((await probe(a.token)).status).toBe(200);
  expect(await logoutLocal(a.token)).toBe(204);
  const after = await probe(a.token);
  expect([after.status, after.body.code]).toEqual([401, "PT401"]);
  expect((await probe(other.token)).status).toBe(200); // the other session is unaffected
  // a banned user with a live session row
  const w = await webUser(playwright, "ban");
  const reg = await registeredSession(w.email, w.password);
  expect((await rpc(reg.token, "fdb_account_installations")).status).toBe(200);
  await db.query("update auth.users set banned_until = now() + interval '1 hour' where id = $1", [w.uid]);
  const banned = await rpc(reg.token, "fdb_account_installations");
  expect([banned.status, banned.body.code]).toEqual([401, "PT401"]);
  await db.query("update auth.users set banned_until = null where id = $1", [w.uid]);
});

test("27. budgets: business failures COMMIT (counters persist), exhaustion is HTTP 429, and no client header can roll the counters back or move them", async ({ playwright }) => {
  const w = await webUser(playwright, "budget");
  const s = await registeredSession(w.email, w.password);
  const bucket = `claim_redeem:uid:${w.uid}`;
  const calls = async () => (await db.query("select calls from private.foreverdb_api_budgets where bucket = $1", [bucket])).rows[0]?.calls ?? 0;
  const wrong = (headers: Record<string, string> = {}, base?: string) => rpc(s.token, "fdb_account_claim_redeem", { p_code: "FEEDFACEFEEDFACEFEEDFACEFEEDFACE" }, { headers, base });
  await resetBudgets(db);
  expect(await calls()).toBe(0);

  // 1-3: wrong codes return a RESULT (200 + ok:false) and the counter is committed
  for (let i = 1; i <= 3; i += 1) {
    const r = await wrong();
    expect([r.status, r.body]).toEqual([200, { ok: false, error: "invalid_claim" }]);
    expect(await calls()).toBe(i);
  }
  // headers a client controls cannot undo that accounting on the reviewed configuration (db-tx-end = commit)
  const hostile: Record<string, string>[] = [{ Prefer: "tx=rollback" }, { Prefer: "tx=rollback, handling=lenient" }, { "X-Forwarded-For": "203.0.113.99" }, { "Content-Profile": "public" }, { Prefer: "return=representation" }, { Range: "0-0" }];
  let n = 3;
  for (const h of hostile) {
    n += 1;
    const r = await wrong(h);
    expect(r.status, JSON.stringify(h)).toBe(200);
    expect(await calls(), JSON.stringify(h)).toBe(n);
  }
  // `params=single-object` re-interprets the body as ONE json argument: the function is then not found (404), nothing runs, nothing is counted
  const single = await wrong({ Prefer: "params=single-object" });
  expect(single.status).toBe(404);
  expect(await calls()).toBe(n);
  // the DANGEROUS configuration, shown for the record: with `db-tx-end = commit-allow-override` the very same header DOES roll the counter back.
  // That is why the deployment checklist pins `commit` (0012-deployment-and-recovery.md) and the staging acceptance re-checks it.
  const before = await calls();
  const overridden = await wrong({ Prefer: "tx=rollback" }, `${REST_OVERRIDE}`);
  expect(overridden.status).toBe(200);
  expect(await calls()).toBe(before); // NOT counted: a client could attempt guesses without ever spending budget
  // ... but the reviewed stack ignores the header:
  await wrong({ Prefer: "tx=rollback" });
  expect(await calls()).toBe(before + 1);

  // exhaustion: the per-account budget is 10 per 5 minutes; the 11th call is PT429 -> HTTP 429, and the counter stays at the ceiling
  while ((await calls()) < 10) await wrong();
  const refused = await wrong();
  expect([refused.status, refused.body.code]).toEqual([429, "PT429"]);
  expect(await calls()).toBe(10);
  // the website maps it to 429 for the user (no "invalid code" disguise), with the account's own web session
  const viaSite = await link(w.c, "FEEDFACEFEEDFACEFEEDFACEFEEDFACE", w.password);
  expect(viaSite.status()).toBe(429);
  expect(await viaSite.json()).toEqual({ ok: false, error: "rate_limited" });
  expect(viaSite.headers()["retry-after"]).toBeTruthy();
  // the wrong-code transactions also left audit rows (committed)
  expect((await db.query("select count(*)::int n from private.account_audit where account_uid = $1 and event = 'redeem_rejected'", [w.uid])).rows[0].n).toBeGreaterThanOrEqual(10);
  await resetBudgets(db);
});

test("unknown codes never touch a REAL pending claim, and the real code still redeems afterwards (SQL logic reached through PostgREST)", async ({ playwright }) => {
  const w = await webUser(playwright, "attempts");
  const s = await registeredSession(w.email, w.password);
  const comp = await companionWithInstallation();
  const code = await startClaim(comp);
  await resetBudgets(db);
  const attempts = async () => (await db.query("select status, attempts from private.installation_claims where installation_id = $1", [comp.installationId])).rows[0];
  expect(await attempts()).toEqual({ status: "pending", attempts: 0 });
  // an UNKNOWN code never touches the real claim
  for (let i = 0; i < 6; i += 1) {
    const r = await rpc(s.token, "fdb_account_claim_redeem", { p_code: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" + i });
    expect([r.status, r.body]).toEqual([200, { ok: false, error: "invalid_claim" }]);
  }
  expect(await attempts()).toEqual({ status: "pending", attempts: 0 });
  // the real code still works afterwards for a registered account
  await resetBudgets(db);
  const ok = await rpc(s.token, "fdb_account_claim_redeem", { p_code: code });
  expect(ok.body).toMatchObject({ ok: true, installation_id: comp.installationId });
});

test("30. private data is unreachable through PostgREST for anon and for every registered account; no schema or profile header opens it", async ({ playwright }) => {
  const a = await webUser(playwright, "tbl");
  const comp = await companionWithInstallation();
  expect((await link(a.c, await startClaim(comp), a.password)).status()).toBe(200);
  const aTok = (await registeredSession(a.email, a.password)).token;
  const bUser = await webUser(playwright, "tblB");
  const bTok = (await registeredSession(bUser.email, bUser.password)).token;
  const anon = await anonymous();
  const publicPrivateTables = ["installations", "installation_guilds", "installation_guild_members", "installation_guild_professions", "installation_item_stats", "installation_source_stats", "installation_location_stats"];
  for (const [who, tok] of [["anon key", null], ["anonymous user", anon.token], ["registered A (the OWNER)", aTok], ["registered B", bTok]] as const) {
    for (const t of publicPrivateTables) {
      const r = await restGet(tok, `${t}?select=*&limit=1`);
      expect([401, 403, 404], `${who} ${t}`).toContain(r.status);
      expect(JSON.stringify(r.body), `${who} ${t}`).not.toContain(comp.installationId);
    }
    // private tables of the account feature, and schemas that are not exposed (profile headers are validated against db-schemas)
    for (const t of ["installation_claims", "account_installations", "account_audit", "foreverdb_api_budgets"]) {
      for (const profile of [{}, { "Accept-Profile": "private" }, { "Accept-Profile": "auth" }] as Record<string, string>[]) {
        const r = await restGet(tok, `${t}?select=*&limit=1`, profile);
        expect([401, 403, 404, 406], `${who} ${t} ${JSON.stringify(profile)}`).toContain(r.status);
      }
    }
    for (const t of ["users", "sessions", "refresh_tokens"]) {
      const r = await restGet(tok, `${t}?select=*&limit=1`, { "Accept-Profile": "auth" });
      expect([401, 403, 404, 406], `${who} auth.${t}`).toContain(r.status);
    }
  }
  // POST/PATCH/DELETE on those tables are equally refused
  for (const m of ["POST", "PATCH", "DELETE"]) {
    const r = await fetch(`${process.env.ACCOUNT_STACK_URL}/rest/v1/installations?id=eq.${comp.installationId}`, { method: m, headers: { apikey: process.env.ACCOUNT_STACK_ANON_KEY!, authorization: `Bearer ${aTok}`, "content-type": "application/json" }, body: m === "DELETE" ? undefined : JSON.stringify({ owner_user_id: a.uid }) });
    expect([401, 403, 404, 405]).toContain(r.status);
  }
  expect((await db.query("select owner_user_id from public.installations where id = $1", [comp.installationId])).rows[0].owner_user_id).toBe(a.uid);
  // the OpenAPI root does not describe the private tables
  const root = await restGet(aTok, "");
  const paths = Object.keys((root.body as { paths?: Record<string, unknown> }).paths ?? {});
  expect(paths.length).toBeGreaterThan(0);
  expect(paths.filter((p) => /^\/(installation_claims|account_audit|account_installations|foreverdb_api_budgets)$/.test(p))).toEqual([]);
  expect(paths).toContain("/rpc/fdb_account_installations"); // the functions ARE exposed (and guarded in SQL), tables of the private schema are not
});

test("response format and error assumptions of the website's client hold against the real PostgREST (shapes, content types, error bodies)", async ({ playwright }) => {
  const w = await webUser(playwright, "fmt");
  const comp = await companionWithInstallation({ guilds: 1, members: 2 });
  expect((await link(w.c, await startClaim(comp), w.password)).status()).toBe(200);
  const s = await registeredSession(w.email, w.password);
  const list = await rpc(s.token, "fdb_account_installations");
  expect(list.headers["content-type"]).toMatch(/^application\/json/);
  expect(Array.isArray(list.body)).toBe(true); // RETURNS TABLE -> array
  expect(Object.keys(list.body[0]).sort()).toEqual(["guild_count", "installation_id", "last_seen_at", "linked_at"]);
  const redeem = await rpc(s.token, "fdb_account_claim_redeem", { p_code: "00000000000000000000000000000000" });
  expect(Array.isArray(redeem.body)).toBe(false); // jsonb -> a bare object
  expect(redeem.body).toEqual({ ok: false, error: "invalid_claim" });
  // Local-only V1 deliberately has no cloud Guildbook response path.
  expect((await rpc(s.token, "fdb_account_guildbook_members", { p_installation_id: "bad id", p_guild_key: "g", p_limit: 10, p_offset: 0 })).status).toBe(404);
  expect((await rpc(s.token, "fdb_account_guildbook_guilds", { p_installation_id: comp.installationId })).status).toBe(404);
  void auth; void uniq;
});
