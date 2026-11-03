// Credential lifecycle: persistence, rotation with reuse detection, revocation, account/identity standing, web sign-out independence
// (acceptance test 6: persistence after restart and behaviour after revocation).
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { SECRET_RE, expectCode, makeWorld, sha256, snapshot, dumpPrivateTables } from "./world.mjs";
import { connect, rpc } from "../account/harness.mjs";

let w;
before(async () => {
  w = await makeWorld();
});
after(async () => {
  await w.close();
});

const status = async (e, secret = e.secret) => {
  await w.fx.resetBudgets();
  return e.device.call("fdb_device_status", [secret]);
};
let ts = 10_000;
const sync = (e, secret = e.secret) => w.ingest(e.device, secret, snapshot(e.installationId, { updatedAt: (ts += 10), guilds: 1, members: 2, sources: 1 }));

describe("persistence ('credential survives a Companion restart') and independence from the web session", () => {
  it("the stored credential keeps working from brand-new connections and identities' refreshed tokens; nothing in the database depends on the Companion process", async () => {
    const acct = await w.account();
    const e = await w.enrolled(acct);
    assert.equal((await sync(e)).ok, true);
    // a "restart": new database connections, a token of the SAME identity/session (refresh keeps the session id), same secret
    const fresh = await connect();
    try {
      await w.fx.resetBudgets();
      const refreshed = { ...e.device.claims, iat: e.device.claims.iat + 60, exp: e.device.claims.exp + 60 };
      const out = await rpc(fresh, refreshed, "fdb_device_ingest", [e.secret, snapshot(e.installationId, { updatedAt: (ts += 10) })]);
      assert.equal(out.ok, true);
    } finally {
      await fresh.end();
    }
    assert.equal((await status(e)).state, "active");
  });

  it("signing out of the website (account session deleted) does NOT revoke devices; the device keeps syncing", async () => {
    const acct = await w.account();
    const e = await w.enrolled(acct);
    await w.admin.query("delete from auth.refresh_tokens where session_id = $1", [acct.sid]);
    await w.admin.query("delete from auth.sessions where id = $1", [acct.sid]);
    assert.equal((await sync(e)).ok, true);
    assert.equal((await status(e)).state, "active");
    assert.equal((await w.device_row(e.deviceId)).status, "active");
  });

  it("an account password reset / all-sessions logout leaves device identities alone (they are separate Auth users)", async () => {
    const acct = await w.account();
    const e = await w.enrolled(acct);
    await w.admin.query("delete from auth.sessions where user_id = $1", [acct.uid]);
    assert.equal((await sync(e)).ok, true);
  });
});

describe("rotation", () => {
  it("status asks for rotation after 30 days, never before", async () => {
    const e = await w.enrolled(await w.account());
    assert.equal((await status(e)).needs_rotation, false);
    await w.admin.query("update private.devices set credential_issued_at = now() - interval '29 days' where id = $1", [e.deviceId]);
    assert.equal((await status(e)).needs_rotation, false);
    await w.admin.query("update private.devices set credential_issued_at = now() - interval '31 days' where id = $1", [e.deviceId]);
    assert.equal((await status(e)).needs_rotation, true);
  });

  it("rotate returns a fresh secret; current AND next are valid; first use of the next promotes it and retires the old one", async () => {
    const e = await w.enrolled(await w.account());
    await w.fx.resetBudgets();
    const rot = await e.device.call("fdb_device_rotate_credential", [e.secret]);
    assert.equal(rot.ok, true);
    assert.match(rot.device_secret, SECRET_RE);
    assert.notEqual(rot.device_secret, e.secret);
    assert.equal(rot.device_secret.slice(0, 38), e.secret.slice(0, 38), "same device id prefix");
    let row = await w.device_row(e.deviceId);
    assert.ok(Buffer.from(row.next_credential_hash).equals(sha256(rot.device_secret)));
    assert.ok(Buffer.from(row.credential_hash).equals(sha256(e.secret)));
    // crash window: the client never persisted the new secret and keeps using the old one: nothing breaks
    assert.equal((await sync(e)).ok, true);
    assert.equal((await status(e, e.secret)).state, "active");
    assert.equal((await status(e, rot.device_secret)).state, "active", "next is valid before promotion");
    // first real use of the next promotes it
    assert.equal((await sync(e, rot.device_secret)).ok, true);
    row = await w.device_row(e.deviceId);
    assert.ok(Buffer.from(row.credential_hash).equals(sha256(rot.device_secret)));
    assert.equal(row.next_credential_hash, null);
    assert.ok(Buffer.from(row.retired_hash).equals(sha256(e.secret)));
    assert.equal((await status(e, rot.device_secret)).needs_rotation, false, "promotion reset the age");
    assert.ok(!(await dumpPrivateTables(w.admin)).includes(rot.device_secret), "raw secret never stored");
  });

  it("the superseded credential is refused without penalty inside the 120 s grace window (device_credential_stale), device stays active", async () => {
    const e = await w.enrolled(await w.account());
    await w.fx.resetBudgets();
    const rot = await e.device.call("fdb_device_rotate_credential", [e.secret]);
    assert.equal((await sync(e, rot.device_secret)).ok, true);
    assert.deepEqual(await sync(e, e.secret), { ok: false, error: "device_credential_stale" });
    assert.equal((await w.device_row(e.deviceId)).status, "active");
    assert.equal((await sync(e, rot.device_secret)).ok, true);
  });

  it("reuse of a superseded credential AFTER the grace window revokes the device (credential_reuse) and is audited; the new credential dies with it", async () => {
    const acct = await w.account();
    const e = await w.enrolled(acct);
    await w.fx.resetBudgets();
    const rot = await e.device.call("fdb_device_rotate_credential", [e.secret]);
    await sync(e, rot.device_secret);
    await w.admin.query("update private.devices set retired_at = now() - interval '3 minutes' where id = $1", [e.deviceId]);
    const out = await sync(e, e.secret);
    assert.deepEqual(out, { ok: false, error: "device_revoked" });
    const row = await w.device_row(e.deviceId);
    assert.equal(row.status, "revoked");
    assert.equal(row.revoked_reason, "credential_reuse");
    assert.equal((await w.audit("device_id = $1 and event = 'credential_reuse'", [e.deviceId])).length, 1);
    assert.deepEqual(await sync(e, rot.device_secret), { ok: false, error: "device_revoked" });
    await w.fx.resetBudgets();
    const listed = await acct.call("fdb_account_devices");
    assert.equal(listed[0].revoked_reason, "credential_reuse");
  });

  it("a second rotation before the first next-credential was used replaces it (the lost one stops working)", async () => {
    const e = await w.enrolled(await w.account());
    await w.fx.resetBudgets();
    const r1 = await e.device.call("fdb_device_rotate_credential", [e.secret]);
    const r2 = await e.device.call("fdb_device_rotate_credential", [e.secret]);
    assert.notEqual(r1.device_secret, r2.device_secret);
    assert.deepEqual(await sync(e, r1.device_secret), { ok: false, error: "device_unauthorized" });
    assert.equal((await sync(e, r2.device_secret)).ok, true);
  });
});

describe("revocation", () => {
  it("owner revocation is effective on the very next call even though the identity's access token is still valid; every device function reports it", async () => {
    const acct = await w.account();
    const e = await w.enrolled(acct);
    assert.equal((await sync(e)).ok, true);
    await w.fx.resetBudgets();
    assert.deepEqual(await acct.call("fdb_account_device_revoke", [e.deviceId]), { ok: true });
    assert.deepEqual(await acct.call("fdb_account_device_revoke", [e.deviceId]), { ok: true }, "idempotent");
    assert.equal((await w.audit("device_id = $1 and event = 'device_revoked'", [e.deviceId])).length, 1, "audited once");
    assert.deepEqual(await sync(e), { ok: false, error: "device_revoked" });
    assert.deepEqual(await status(e), { state: "revoked", installation_id: e.installationId, needs_rotation: false, reason: "owner_revoked" });
    await w.fx.resetBudgets();
    assert.deepEqual(await e.device.call("fdb_device_rotate_credential", [e.secret]), { ok: false, error: "device_revoked" });
    // the history of the installation is untouched by the revocation
    assert.equal((await w.row("select owner_user_id from public.installations where id = $1", [e.installationId]))[0].owner_user_id, acct.uid);
    assert.equal((await w.row("select count(*)::int n from public.installation_source_stats where installation_id = $1", [e.installationId]))[0].n > 0, true);
  });

  it("recovery: a NEW ticket re-binds the same installation (account-owned, no live device) with a new credential; history stays; the old credential stays dead", async () => {
    const acct = await w.account();
    const e = await w.enrolled(acct);
    await sync(e);
    const before = await w.history(e.installationId);
    await w.fx.resetBudgets();
    await acct.call("fdb_account_device_revoke", [e.deviceId]);
    const replacement = await w.device(); // e.g. a reinstall: a fresh anonymous identity
    const t = await w.ticket(acct, "Recovered PC");
    const out = await w.enroll(replacement, t.ticket, e.installationId, "Recovered PC");
    assert.equal(out.ok, true);
    assert.notEqual(out.device_secret, e.secret);
    assert.deepEqual(await w.history(e.installationId), before, "history intact through revoke + re-enroll");
    assert.equal((await w.ingest(replacement, out.device_secret, snapshot(e.installationId, { updatedAt: (ts += 10), guilds: 1, members: 2, sources: 1 }))).ok, true);
    assert.deepEqual(await sync(e), { ok: false, error: "device_revoked" }, "old device stays revoked");
    assert.equal((await w.row("select count(*)::int n from private.devices where installation_id = $1 and status <> 'revoked'", [e.installationId]))[0].n, 1);
  });

  it("the SAME identity may replace its own lost credential with a new ticket (status 'replaced'); the old secret is dead", async () => {
    const acct = await w.account();
    const e = await w.enrolled(acct);
    const t = await w.ticket(acct);
    const out = await w.enroll(e.device, t.ticket, e.installationId);
    assert.equal(out.ok, true);
    assert.notEqual(out.device_id, e.deviceId);
    assert.equal((await w.device_row(e.deviceId)).revoked_reason, "replaced");
    assert.deepEqual(await sync(e), { ok: false, error: "device_revoked" });
    assert.equal((await w.ingest(e.device, out.device_secret, snapshot(e.installationId, { updatedAt: (ts += 10) }))).ok, true);
  });
});

describe("account and identity standing", () => {
  it("a banned account's devices stop syncing (account_unavailable) and resume when the ban is lifted; nothing is revoked", async () => {
    const acct = await w.account();
    const e = await w.enrolled(acct);
    await w.admin.query("update auth.users set banned_until = now() + interval '1 day' where id = $1", [acct.uid]);
    assert.deepEqual(await sync(e), { ok: false, error: "account_unavailable" });
    assert.equal((await status(e)).state, "account_unavailable");
    await w.admin.query("update auth.users set banned_until = null where id = $1", [acct.uid]);
    assert.equal((await sync(e)).ok, true);
  });

  it("a deleted account's devices stop syncing; an account that became anonymous or unconfirmed is not an owner either", async () => {
    const acct = await w.account();
    const e = await w.enrolled(acct);
    await w.admin.query("update auth.users set email_confirmed_at = null where id = $1", [acct.uid]);
    assert.equal((await sync(e)).error, "account_unavailable");
    await w.admin.query("update auth.users set email_confirmed_at = now(), deleted_at = now() where id = $1", [acct.uid]);
    assert.equal((await sync(e)).error, "account_unavailable");
  });

  it("the device identity's own Auth session ending (logout/ban/delete) fails closed with PT401 even with the right secret", async () => {
    const e = await w.enrolled(await w.account());
    await w.admin.query("delete from auth.refresh_tokens where session_id = $1", [e.device.sid]);
    await w.admin.query("delete from auth.sessions where id = $1", [e.device.sid]);
    await w.fx.resetBudgets();
    await expectCode(e.device.call("fdb_device_ingest", [e.secret, snapshot(e.installationId, { updatedAt: (ts += 10) })]), "PT401");
    await expectCode(e.device.call("fdb_device_status", [e.secret]), "PT401");
    // a NEW session of the same identity (re-login) works again with the same secret: the secret is bound to the identity, not to a session
    const sid = await w.fx.session(e.device.uid);
    const again = { ...e.device, claims: { ...e.device.claims, session_id: sid } };
    await w.fx.resetBudgets();
    assert.equal((await rpc(w.client, again.claims, "fdb_device_ingest", [e.secret, snapshot(e.installationId, { updatedAt: (ts += 10) })])).ok, true);
  });

  it("status for unknown/malformed secrets is one indistinguishable answer", async () => {
    const e = await w.enrolled(await w.account());
    const other = await w.enrolled(await w.account());
    for (const s of ["garbage", null, "fdbd1_" + "0".repeat(32) + "_" + "A".repeat(43), other.secret, e.secret.slice(0, -1) + (e.secret.endsWith("A") ? "B" : "A")]) {
      assert.deepEqual(await status(e, s), { state: "unknown", installation_id: null, needs_rotation: false, reason: null }, String(s));
    }
  });

  it("budgets: device introspection is rate limited (PT429) per identity", async () => {
    const e = await w.enrolled(await w.account());
    // the 61 calls must share one 60 s budget window (see resetBudgetsInFreshWindow)
    await w.fx.resetBudgetsInFreshWindow(60);
    for (let i = 0; i < 60; i += 1) await e.device.call("fdb_device_status", [e.secret]);
    await expectCode(e.device.call("fdb_device_status", [e.secret]), "PT429");
  });

  it("device ingest is charged to the DEVICE identity's ingest budget (5 per window), exactly like anonymous ingest; the account's budget is untouched", async () => {
    const acct = await w.account();
    const e = await w.enrolled(acct);
    await w.fx.resetBudgetsInFreshWindow(300);
    for (let i = 0; i < 5; i += 1) assert.equal((await e.device.call("fdb_device_ingest", [e.secret, snapshot(e.installationId, { updatedAt: (ts += 10) })])).ok, true);
    await expectCode(e.device.call("fdb_device_ingest", [e.secret, snapshot(e.installationId, { updatedAt: (ts += 10) })]), "PT429");
    const buckets = (await w.row("select bucket from private.foreverdb_api_budgets where bucket like 'ingest:uid:%'")).map((r) => r.bucket);
    assert.deepEqual(buckets, [`ingest:uid:${e.device.uid}`]);
  });
});

describe("payload bounds are enforced before any write", () => {
  it("oversized / malformed snapshots are refused (PT413 / PT400) and write nothing", async () => {
    const e = await w.enrolled(await w.account());
    const big = snapshot(e.installationId, { updatedAt: (ts += 10) });
    big.sources = Array.from({ length: 2501 }, (_, i) => ({ sourceType: "creature", sourceId: i + 1, sourceLevel: 1, buckets: [] }));
    await w.fx.resetBudgets();
    await expectCode(e.device.call("fdb_device_ingest", [e.secret, big]), "PT413");
    await w.fx.resetBudgets();
    await expectCode(e.device.call("fdb_device_ingest", [e.secret, { schemaVersion: 9, updatedAt: 1 }]), "PT400");
    await w.fx.resetBudgets();
    await expectCode(e.device.call("fdb_device_ingest", [e.secret, "[]"]), "PT413");
    assert.equal((await w.row("select count(*)::int n from public.installation_source_stats where installation_id = $1", [e.installationId]))[0].n, 0);
  });
});
