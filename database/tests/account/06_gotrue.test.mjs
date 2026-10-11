// LS-9 and real-session behaviour: everything here uses tokens and sessions issued by a REAL GoTrue (supabase/auth) running
// against the same PostgreSQL. No fabricated session rows. The only emulated layer is PostgREST: `verifyJwt` checks signature and
// exp exactly as PostgREST does, then the claims are handed to the database verbatim (see harness.mjs).
//
// If GoTrue is unreachable the suite is BLOCKED (skipped with that reason), or FAILS when FDB_REQUIRE_GOTRUE=1 (CI).
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Fixtures, adminToken, connect, decodeClaims, expectCode, gotrue, gotrueAvailable, rpc, snapshot, uniq, verifyJwt,
} from "./harness.mjs";

const available = await gotrueAvailable();
const required = process.env.FDB_REQUIRE_GOTRUE === "1";
if (!available) {
  describe("real GoTrue", () => {
    it("GoTrue is reachable", { skip: required ? false : "BLOCKED: GoTrue is not reachable; LS-9 cannot be evidenced" }, () => {
      assert.fail("GoTrue is not reachable but FDB_REQUIRE_GOTRUE=1");
    });
  });
} else {
  const admin = await connect();
  const client = await connect();
  const fx = new Fixtures(admin);
  after(async () => {
    await client.end();
    await admin.end();
  });
  const PASSWORD = "Correct-horse-battery-1";

  async function anonymousSignup() {
    const r = await gotrue("/signup", { body: {} });
    assert.equal(r.status, 200, r.text);
    const claims = verifyJwt(r.json.access_token);
    return { token: r.json.access_token, refresh: r.json.refresh_token, claims, uid: claims.sub, sid: claims.session_id };
  }
  async function registeredLogin(email, password = PASSWORD) {
    const r = await gotrue("/token?grant_type=password", { body: { email, password } });
    assert.equal(r.status, 200, r.text);
    const claims = verifyJwt(r.json.access_token);
    return { token: r.json.access_token, refresh: r.json.refresh_token, claims, uid: claims.sub, sid: claims.session_id };
  }
  async function createRegistered({ confirmed = true } = {}) {
    const email = `real-${uniq("u")}@example.invalid`;
    const r = await gotrue("/admin/users", { body: { email, password: PASSWORD, email_confirm: confirmed }, token: adminToken() });
    assert.equal(r.status, 200, r.text);
    return { email, uid: r.json.id };
  }
  // What PostgREST does with a bearer token, then the RPC.
  const call = (session, fn, args = []) => rpc(client, verifyJwt(session.token), fn, args);
  const sessionRow = async (sid) => (await admin.query("select * from auth.sessions where id = $1", [sid])).rowCount;
  const ingestOwnedBy = async (session, inst) => {
    await fx.resetBudgets();
    const out = await call(session, "ingest_foreverdb_snapshot_auth", [snapshot(inst, { updatedAt: Date.now() % 1e9, guilds: 1, members: 2, sources: 1 })]);
    assert.equal(out.ok, true);
  };

  describe("LS-9: real GoTrue anonymous session, logout, revoked-but-unexpired token", () => {
    it("an anonymous access token from /signup contains session_id (a uuid), is_anonymous=true, and a matching auth.sessions row exists", async () => {
      const a = await anonymousSignup();
      assert.match(a.sid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      assert.equal(a.claims.is_anonymous, true);
      assert.equal(a.claims.role, "authenticated");
      const row = (await admin.query("select s.user_id, s.not_after, u.is_anonymous from auth.sessions s join auth.users u on u.id = s.user_id where s.id = $1", [a.sid])).rows[0];
      assert.equal(row.user_id, a.uid);
      assert.equal(row.not_after, null, "session time-boxing is off (product requirement)");
      assert.equal(row.is_anonymous, true);
    });

    it("LS-9: after POST /logout the SAME unexpired token is refused by fdb_account_claim_start (PT401); before it, it works", async () => {
      const a = await anonymousSignup();
      const inst = uniq("ls9");
      await ingestOwnedBy(a, inst); // the installation's owner is this real anonymous UID
      assert.equal(await fx.owner(inst), a.uid);

      const live = await call(a, "fdb_account_claim_start", [inst]);
      assert.equal(live.ok, true, "a live real session may start a claim");

      const out = await gotrue("/logout?scope=local", { token: a.token });
      assert.equal(out.status, 204);
      assert.equal(await sessionRow(a.sid), 0, "logout deleted the auth.sessions row (the assumption the migration relies on)");

      // The token is still cryptographically valid and unexpired ...
      assert.doesNotThrow(() => verifyJwt(a.token));
      assert.ok(a.claims.exp * 1000 > Date.now() + 60_000);
      // ... and its UID still owns the installation ...
      assert.equal(await fx.owner(inst), a.uid);
      // ... but every account function refuses it.
      await fx.resetBudgets();
      const claimsBefore = (await fx.claimRows(inst)).length;
      await expectCode(call(a, "fdb_account_claim_start", [inst]), "PT401");
      await expectCode(call(a, "fdb_installation_link_status", [inst]), "PT401");
      assert.equal((await fx.claimRows(inst)).length, claimsBefore, "no new claim row");
      assert.equal(await fx.owner(inst), a.uid, "ownership unchanged");
      // the refresh token was revoked with the session
      const refreshed = await gotrue("/token?grant_type=refresh_token", { body: { refresh_token: a.refresh } });
      assert.ok(refreshed.status >= 400 && refreshed.status < 500, `refresh after logout: ${refreshed.status}`);
    });

    it("session id survives token refresh (the Companion's claim stays valid) and the refreshed token works", async () => {
      const a = await anonymousSignup();
      const inst = uniq("refresh");
      await ingestOwnedBy(a, inst);
      const { code } = await call(a, "fdb_account_claim_start", [inst]);
      assert.match(code, /^[0-9A-F]{32}$/);
      await new Promise((resolve) => setTimeout(resolve, 1100)); // iat has 1 s resolution: a same-second refresh returns the same token
      const r = await gotrue("/token?grant_type=refresh_token", { body: { refresh_token: a.refresh } });
      assert.equal(r.status, 200, r.text);
      const refreshed = verifyJwt(r.json.access_token);
      assert.equal(refreshed.session_id, a.sid, "session_id is stable across refresh");
      assert.notEqual(r.json.access_token, a.token);
      await fx.resetBudgets();
      assert.equal((await call({ token: r.json.access_token }, "fdb_account_claim_start", [inst])).ok, true);
    });

    it("documented residual, unchanged by V1: ingest and read RPCs only check the JWT, so a revoked-but-unexpired token can still ingest (it can no longer change ownership)", async () => {
      const a = await anonymousSignup();
      const inst = uniq("residual");
      await ingestOwnedBy(a, inst);
      await gotrue("/logout?scope=local", { token: a.token });
      await fx.resetBudgets();
      const out = await call(a, "ingest_foreverdb_snapshot_auth", [snapshot(inst, { updatedAt: 99_999_999, guilds: 1, members: 1, sources: 1 })]);
      assert.equal(out.ok, true, "existing behaviour (0003/0005/0009), explicitly not changed");
      await expectCode(call(a, "fdb_account_claim_start", [inst]), "PT401");
    });
  });

  describe("real session invalidation matches the assumptions in the SQL", () => {
    it("logout scope=local removes only that session; the user's other session stays live (web logout must not kill the Companion)", async () => {
      const u = await createRegistered();
      const web = await registeredLogin(u.email);
      const companion = await registeredLogin(u.email);
      assert.notEqual(web.sid, companion.sid);
      assert.equal((await gotrue("/logout?scope=local", { token: web.token })).status, 204);
      assert.equal(await sessionRow(web.sid), 0);
      assert.equal(await sessionRow(companion.sid), 1);
      await expectCode(call(web, "fdb_account_installations"), "PT401");
      assert.deepEqual(await call(companion, "fdb_account_installations"), []);
    });

    it("logout scope=others keeps the current session; scope=global removes every session of the user", async () => {
      const u = await createRegistered();
      const s1 = await registeredLogin(u.email);
      const s2 = await registeredLogin(u.email);
      assert.equal((await gotrue("/logout?scope=others", { token: s1.token })).status, 204);
      assert.equal(await sessionRow(s1.sid), 1);
      assert.equal(await sessionRow(s2.sid), 0);
      assert.equal((await gotrue("/logout?scope=global", { token: s1.token })).status, 204);
      assert.equal(await sessionRow(s1.sid), 0);
      await expectCode(call(s1, "fdb_account_installations"), "PT401");
    });

    it("an admin ban keeps the session row but sets banned_until: the guard refuses it; lifting the ban restores access", async () => {
      const u = await createRegistered();
      const s = await registeredLogin(u.email);
      assert.deepEqual(await call(s, "fdb_account_installations"), []);
      let r = await gotrue(`/admin/users/${u.uid}`, { method: "PUT", body: { ban_duration: "1h" }, token: adminToken() });
      assert.equal(r.status, 200, r.text);
      assert.equal(await sessionRow(s.sid), 1, "ban does not delete the session row; the guard must check banned_until");
      await expectCode(call(s, "fdb_account_installations"), "PT401");
      r = await gotrue(`/admin/users/${u.uid}`, { method: "PUT", body: { ban_duration: "none" }, token: adminToken() });
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(await call(s, "fdb_account_installations"), []);
    });

    it("deleting the user removes its sessions (hard delete) or sets deleted_at (soft delete); both are refused", async () => {
      const hard = await createRegistered();
      const hs = await registeredLogin(hard.email);
      assert.equal((await gotrue(`/admin/users/${hard.uid}`, { method: "DELETE", token: adminToken() })).status, 200);
      assert.equal(await sessionRow(hs.sid), 0);
      await expectCode(call(hs, "fdb_account_installations"), "PT401");

      const soft = await createRegistered();
      const ss = await registeredLogin(soft.email);
      const r = await gotrue(`/admin/users/${soft.uid}`, { method: "DELETE", body: { should_soft_delete: true }, token: adminToken() });
      assert.equal(r.status, 200, r.text);
      const u = (await admin.query("select deleted_at from auth.users where id = $1", [soft.uid])).rows[0];
      assert.ok(u.deleted_at, "soft delete sets auth.users.deleted_at");
      await expectCode(call(ss, "fdb_account_installations"), "PT401");
    });

    it("an unconfirmed registered user cannot obtain a session from GoTrue at all; after real confirmation it can", async () => {
      const u = await createRegistered({ confirmed: false });
      const denied = await gotrue("/token?grant_type=password", { body: { email: u.email, password: PASSWORD } });
      assert.equal(denied.status, 400);
      assert.equal(denied.json.error_code, "email_not_confirmed");
      assert.equal((await admin.query("select 1 from auth.sessions where user_id = $1", [u.uid])).rowCount, 0);
      // real confirmation through GoTrue (admin-generated link, then the verify endpoint; no SMTP in this stack)
      const link = await gotrue("/admin/generate_link", { body: { type: "magiclink", email: u.email }, token: adminToken() });
      assert.equal(link.status, 200, link.text);
      const verified = await gotrue("/verify", { body: { type: "magiclink", token_hash: link.json.hashed_token } });
      assert.equal(verified.status, 200, verified.text);
      const confirmedAt = (await admin.query("select email_confirmed_at from auth.users where id = $1", [u.uid])).rows[0].email_confirmed_at;
      assert.ok(confirmedAt, "GoTrue set email_confirmed_at");
      const s = await registeredLogin(u.email);
      assert.deepEqual(await call(s, "fdb_account_installations"), []);
    });
  });

  describe("end to end with real sessions", () => {
    it("Companion (anonymous) starts a claim; website (registered) redeems; ownership moves; the old token is cut off; LS-6/LS-7 with real revocation", async () => {
      await fx.resetBudgets();
      const companion = await anonymousSignup();
      const inst = uniq("e2e");
      await ingestOwnedBy(companion, inst);
      const u = await createRegistered();
      const web = await registeredLogin(u.email);

      const { code } = await call(companion, "fdb_account_claim_start", [inst]);
      // the website logs out and in again: a NEW registered session redeems, the Companion session is untouched
      await gotrue("/logout?scope=local", { token: web.token });
      await expectCode(call(web, "fdb_account_claim_redeem", [code]), "PT401"); // LS-6 with a real revoked registered token
      assert.equal((await fx.claimRows(inst))[0].status, "pending");
      const web2 = await registeredLogin(u.email);
      const out = await call(web2, "fdb_account_claim_redeem", [code]);
      assert.equal(out.ok, true);
      assert.equal(await fx.owner(inst), u.uid);

      assert.deepEqual(await call(companion, "fdb_installation_link_status", [inst]), { state: "transferred" });
      assert.deepEqual(await call(web2, "fdb_installation_link_status", [inst]), { state: "owned" });
      await fx.resetBudgets();
      await assert.rejects(call(companion, "ingest_foreverdb_snapshot_auth", [snapshot(inst, { updatedAt: 1e9 })]), /belongs to another authenticated client/);
      await ingestOwnedBy(web2, inst);
      assert.equal((await call(web2, "fdb_account_guildbook_guilds", [inst])).length, 1);
      await expectCode(call(companion, "fdb_account_guildbook_guilds", [inst]), "PT403");
    });

    it("LS-7 real: the Companion signs out (issuing session revoked) before the website redeems: invalid_claim, nothing consumed", async () => {
      await fx.resetBudgets();
      const companion = await anonymousSignup();
      const inst = uniq("e2e-ls7");
      await ingestOwnedBy(companion, inst);
      const u = await createRegistered();
      const web = await registeredLogin(u.email);
      const { code } = await call(companion, "fdb_account_claim_start", [inst]);
      await gotrue("/logout?scope=local", { token: companion.token });
      assert.deepEqual(await call(web, "fdb_account_claim_redeem", [code]), { ok: false, error: "invalid_claim" });
      assert.equal((await fx.claimRows(inst))[0].status, "pending");
      assert.equal(await fx.owner(inst), companion.uid);
    });

    it("LS-7 real: deleting the anonymous owner identity cancels its pending claim", async () => {
      await fx.resetBudgets();
      const companion = await anonymousSignup();
      const inst = uniq("e2e-del");
      await ingestOwnedBy(companion, inst);
      const u = await createRegistered();
      const web = await registeredLogin(u.email);
      const { code } = await call(companion, "fdb_account_claim_start", [inst]);
      assert.equal((await gotrue(`/admin/users/${companion.uid}`, { method: "DELETE", token: adminToken() })).status, 200);
      assert.deepEqual(await call(web, "fdb_account_claim_redeem", [code]), { ok: false, error: "invalid_claim" });
      assert.equal(await fx.owner(inst), companion.uid);
    });

    it("a registered account cannot start a claim and an anonymous session cannot redeem or read private Guildbook (real tokens)", async () => {
      const companion = await anonymousSignup();
      const u = await createRegistered();
      const web = await registeredLogin(u.email);
      await expectCode(call(web, "fdb_account_claim_start", ["x"]), "PT403");
      await expectCode(call(companion, "fdb_account_claim_redeem", ["A".repeat(32)]), "PT403");
      await expectCode(call(companion, "fdb_account_installations"), "PT403");
    });
  });
}
