// The whole flow with tokens issued by a REAL GoTrue (supabase/auth): real anonymous device identities, real confirmed account sessions,
// real logout / ban / delete / refresh. Only PostgREST is emulated (signature + exp verification, then claims handed to the database).
// If GoTrue is unreachable the suite is BLOCKED (skipped), or FAILS with FDB_REQUIRE_GOTRUE=1 (CI).
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { adminToken, connect, expectCode, gotrue, gotrueAvailable, rpc, uniq, verifyJwt, Fixtures } from "../account/harness.mjs";
import { instId, snapshot, SECRET_RE } from "./world.mjs";

const available = await gotrueAvailable();
const required = process.env.FDB_REQUIRE_GOTRUE === "1";
if (!available) {
  describe("real GoTrue", () => {
    it("GoTrue is reachable", { skip: required ? false : "BLOCKED: GoTrue is not reachable; real-session behaviour cannot be evidenced" }, () => {
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

  const anonymousSignup = async () => {
    const r = await gotrue("/signup", { body: {} });
    assert.equal(r.status, 200, r.text);
    const claims = verifyJwt(r.json.access_token);
    return { token: r.json.access_token, refresh: r.json.refresh_token, claims, uid: claims.sub, sid: claims.session_id };
  };
  const registered = async () => {
    const email = `real-${uniq("u")}@example.invalid`;
    const created = await gotrue("/admin/users", { body: { email, password: PASSWORD, email_confirm: true }, token: adminToken() });
    assert.equal(created.status, 200, created.text);
    const r = await gotrue("/token?grant_type=password", { body: { email, password: PASSWORD } });
    assert.equal(r.status, 200, r.text);
    const claims = verifyJwt(r.json.access_token);
    return { email, token: r.json.access_token, refresh: r.json.refresh_token, claims, uid: claims.sub, sid: claims.session_id };
  };
  const call = (s, fn, args = []) => rpc(client, verifyJwt(s.token), fn, args);

  describe("real GoTrue sessions", () => {
    it("a real anonymous owner and registered login complete the MVP claim-to-device vertical slice", async () => {
      const owner = await anonymousSignup();
      const acct = await registered();
      const device = await anonymousSignup();
      const inst = instId();
      await fx.resetBudgets();
      assert.equal((await call(owner, "ingest_foreverdb_snapshot_auth", [snapshot(inst, { updatedAt: 4100 })])).ok, true);
      await fx.resetBudgets();
      const claim = await call(owner, "fdb_account_claim_start", [inst]);
      assert.equal(claim.ok, true);
      await fx.resetBudgets();
      assert.equal((await call(acct, "fdb_account_claim_redeem", [claim.code])).ok, true);
      await fx.resetBudgets();
      const ticket = await call(acct, "fdb_account_enrollment_ticket_issue", ["MVP PC"]);
      assert.equal(ticket.ok, true);
      const enrolled = await call(device, "fdb_device_enroll", [ticket.ticket, inst, "MVP PC"]);
      assert.equal(enrolled.ok, true);
      assert.match(enrolled.device_secret, SECRET_RE);
      await fx.resetBudgets();
      assert.equal((await call(device, "fdb_device_ingest", [enrolled.device_secret, snapshot(inst, { updatedAt: 4200 })])).ok, true);

      const row = (await admin.query("select owner_user_id from public.installations where id = $1", [inst])).rows[0];
      assert.equal(row.owner_user_id, acct.uid);
      assert.notEqual(device.uid, acct.uid);
      await fx.resetBudgets();
      await assert.rejects(call(owner, "ingest_foreverdb_snapshot_auth", [snapshot(inst, { updatedAt: 4300 })]), /belongs to another authenticated client/);
    });

    it("registered web session issues the ticket; the Companion's real anonymous identity redeems it, syncs, and the account reads the Guildbook", async () => {
      const acct = await registered();
      const device = await anonymousSignup();
      assert.equal(device.claims.is_anonymous, true);
      assert.notEqual(device.uid, acct.uid);
      await fx.resetBudgets();
      const t = await call(acct, "fdb_account_enrollment_ticket_issue", ["Real PC"]);
      assert.equal(t.ok, true);
      const inst = instId();
      const enrolled = await call(device, "fdb_device_enroll", [t.ticket, inst, "Real PC"]);
      assert.equal(enrolled.ok, true);
      assert.match(enrolled.device_secret, SECRET_RE);
      await fx.resetBudgets();
      const synced = await call(device, "fdb_device_ingest", [enrolled.device_secret, snapshot(inst, { updatedAt: 4242 })]);
      assert.equal(synced.ok, true);
      await fx.resetBudgets();
      const guilds = await call(acct, "fdb_account_guildbook_guilds", [inst]);
      assert.equal(guilds.length, 2);
      assert.equal((await admin.query("select owner_user_id from public.installations where id = $1", [inst])).rows[0].owner_user_id, acct.uid);
    });

    it("the device identity's refresh keeps the same session id and the same credential keeps working across the refreshed token", async () => {
      const acct = await registered();
      const device = await anonymousSignup();
      await fx.resetBudgets();
      const t = await call(acct, "fdb_account_enrollment_ticket_issue", []);
      const inst = instId();
      const enrolled = await call(device, "fdb_device_enroll", [t.ticket, inst, "PC"]);
      await new Promise((r) => setTimeout(r, 1100));
      const refreshed = await gotrue("/token?grant_type=refresh_token", { body: { refresh_token: device.refresh } });
      assert.equal(refreshed.status, 200, refreshed.text);
      const next = { token: refreshed.json.access_token };
      assert.equal(verifyJwt(next.token).session_id, device.sid);
      await fx.resetBudgets();
      assert.equal((await call(next, "fdb_device_ingest", [enrolled.device_secret, snapshot(inst, { updatedAt: 1 })])).ok, true);
    });

    it("after the device's REAL logout the still-unexpired token and the right secret are refused (PT401); the account is unaffected", async () => {
      const acct = await registered();
      const device = await anonymousSignup();
      await fx.resetBudgets();
      const t = await call(acct, "fdb_account_enrollment_ticket_issue", []);
      const inst = instId();
      const enrolled = await call(device, "fdb_device_enroll", [t.ticket, inst, "PC"]);
      const out = await gotrue("/logout?scope=local", { token: device.token });
      assert.equal(out.status, 204);
      assert.doesNotThrow(() => verifyJwt(device.token));
      await fx.resetBudgets();
      await expectCode(call(device, "fdb_device_ingest", [enrolled.device_secret, snapshot(inst, { updatedAt: 2 })]), "PT401");
      await fx.resetBudgets();
      assert.equal((await call(acct, "fdb_account_devices")).length, 1, "the account session and its registry are fine");
    });

    it("the account's REAL logout does not revoke its devices; banning the account stops them; lifting the ban resumes them", async () => {
      const acct = await registered();
      const device = await anonymousSignup();
      await fx.resetBudgets();
      const t = await call(acct, "fdb_account_enrollment_ticket_issue", []);
      const inst = instId();
      const enrolled = await call(device, "fdb_device_enroll", [t.ticket, inst, "PC"]);
      assert.equal((await gotrue("/logout?scope=local", { token: acct.token })).status, 204);
      await fx.resetBudgets();
      assert.equal((await call(device, "fdb_device_ingest", [enrolled.device_secret, snapshot(inst, { updatedAt: 3 })])).ok, true);
      await admin.query("update auth.users set banned_until = now() + interval '1 hour' where id = $1", [acct.uid]);
      await fx.resetBudgets();
      assert.deepEqual(await call(device, "fdb_device_ingest", [enrolled.device_secret, snapshot(inst, { updatedAt: 4 })]), { ok: false, error: "account_unavailable" });
      await admin.query("update auth.users set banned_until = null where id = $1", [acct.uid]);
      await fx.resetBudgets();
      assert.equal((await call(device, "fdb_device_ingest", [enrolled.device_secret, snapshot(inst, { updatedAt: 5 })])).ok, true);
    });

    it("deleting the account through GoTrue's admin API removes the ability to sync; a copy of an unredeemed ticket fails afterwards", async () => {
      const acct = await registered();
      const device = await anonymousSignup();
      await fx.resetBudgets();
      const t = await call(acct, "fdb_account_enrollment_ticket_issue", []);
      const t2 = await call(acct, "fdb_account_enrollment_ticket_issue", []);
      const inst = instId();
      const enrolled = await call(device, "fdb_device_enroll", [t.ticket, inst, "PC"]);
      const del = await gotrue(`/admin/users/${acct.uid}`, { method: "DELETE", token: adminToken(), body: { should_soft_delete: true } });
      assert.ok(del.status === 200 || del.status === 204, del.text);
      await fx.resetBudgets();
      assert.equal((await call(device, "fdb_device_ingest", [enrolled.device_secret, snapshot(inst, { updatedAt: 6 })])).ok, false);
      const other = await anonymousSignup();
      await fx.resetBudgets();
      assert.deepEqual(await call(other, "fdb_device_enroll", [t2.ticket, instId(), "PC"]), { ok: false, error: "account_unavailable" });
    });

    it("a real anonymous user upgraded to a registered account is no longer a device principal (PT403) while a real registered session is refused on device functions", async () => {
      const acct = await registered();
      await fx.resetBudgets();
      await expectCode(call(acct, "fdb_device_enroll", ["fdba1_" + "A".repeat(43), instId(), "x"]), "PT403");
      await expectCode(call(acct, "fdb_device_ingest", ["fdbd1_" + "0".repeat(32) + "_" + "A".repeat(43), snapshot(instId())]), "PT403");
    });
  });
}
