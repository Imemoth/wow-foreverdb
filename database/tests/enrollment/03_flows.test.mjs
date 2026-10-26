// End-to-end acceptance scenarios on the database tier (acceptance tests 1-4):
//   1. registered user -> ticket -> first Companion start -> automatic binding -> registered sync -> Private Guildbook
//   2. same account, second computer: independent installation and device credential
//   3. anonymous installation -> later registration -> one-time claim -> registered sync
//   4. wrong account, guessed installation id, unauthorized Guildbook access
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { SECRET_RE, expectCode, instId, makeWorld, snapshot } from "./world.mjs";

let w;
before(async () => {
  w = await makeWorld();
});
after(async () => {
  await w.close();
});

describe("scenario 1: registered website user, brand-new installation, no Companion login", () => {
  it("ticket -> enroll (auto-binding) -> status -> ingest -> account sees installation and the Private Guildbook", async () => {
    const acct = await w.account();
    const device = await w.device(); // the Companion's own anonymous identity: NOT the account uid
    assert.notEqual(device.uid, acct.uid);
    const inst = instId();

    const ticket = await w.ticket(acct, "Home PC");
    const out = await w.enroll(device, ticket.ticket, inst, "Home PC");
    assert.equal(out.ok, true);
    assert.match(out.device_secret, SECRET_RE);
    assert.equal(out.installation_id, inst);

    // the installation was reserved for the ACCOUNT, not for the device identity
    const [row] = await w.row("select owner_user_id, schema_version, snapshot_updated_at from public.installations where id = $1", [inst]);
    assert.equal(row.owner_user_id, acct.uid);
    assert.equal(row.schema_version, 0);
    assert.equal(String(row.snapshot_updated_at ?? 0), "0", "no snapshot yet");
    const dev = await w.device_row(out.device_id);
    assert.deepEqual({ account: dev.account_uid, auth: dev.auth_uid, status: dev.status, inst: dev.installation_id }, { account: acct.uid, auth: device.uid, status: "active", inst });
    const tk = await w.ticket_row(ticket.ticket_id);
    assert.equal(tk.status, "consumed");
    assert.equal(tk.consumed_device_id, out.device_id);

    await w.fx.resetBudgets();
    assert.deepEqual(await device.call("fdb_device_status", [out.device_secret]), { state: "active", installation_id: inst, needs_rotation: false, reason: null });

    // registered manual sync
    const res = await w.ingest(device, out.device_secret, snapshot(inst, { updatedAt: 5000, guilds: 2, members: 4, sources: 3 }));
    assert.equal(res.ok, true);
    assert.equal((await w.row("select owner_user_id from public.installations where id = $1", [inst]))[0].owner_user_id, acct.uid, "ownership never moved to the device identity");
    assert.equal((await w.row("select count(*)::int n from public.installation_source_stats where installation_id = $1", [inst]))[0].n > 0, true);

    // the account (web session) sees it and reads the PRIVATE Guildbook, scoped by its own uid
    await w.fx.resetBudgets();
    const installs = await acct.call("fdb_account_installations");
    assert.deepEqual(installs.map((i) => [i.installation_id, i.guild_count]), [[inst, 2]]);
    const guilds = await acct.call("fdb_account_guildbook_guilds", [inst]);
    assert.equal(guilds.length, 2);
    const members = await acct.call("fdb_account_guildbook_members", [inst, guilds[0].guild_key, 100, 0]);
    assert.equal(members.length, 4);

    // the device registry the website shows
    const devices = await acct.call("fdb_account_devices");
    assert.equal(devices.length, 1);
    assert.deepEqual({ id: devices[0].device_id, inst: devices[0].installation_id, status: devices[0].status, label: devices[0].label }, { id: out.device_id, inst, status: "active", label: "Home PC" });
    assert.ok(devices[0].last_seen_at);
  });

  it("the device identity itself can never read the Guildbook or list installations (PT403) and the account can never ingest as a device", async () => {
    const acct = await w.account();
    const e = await w.enrolled(acct);
    await w.fx.resetBudgets();
    await expectCode(e.device.call("fdb_account_guildbook_guilds", [e.installationId]), "PT403");
    await expectCode(e.device.call("fdb_account_installations"), "PT403");
    await expectCode(e.device.call("fdb_account_devices"), "PT403");
    await w.fx.resetBudgets();
    await expectCode(acct.call("fdb_device_ingest", [e.secret, snapshot(e.installationId)]), "PT403");
  });

  it("the snapshot's installationId must be the device's own installation: a device cannot write any other installation, even an account-owned one", async () => {
    const acct = await w.account();
    const a = await w.enrolled(acct);
    const b = await w.enrolled(acct);
    const res = await w.ingest(a.device, a.secret, snapshot(b.installationId, { updatedAt: 6000 }));
    assert.deepEqual(res, { ok: false, error: "wrong_installation" });
    assert.equal((await w.row("select count(*)::int n from public.installation_source_stats where installation_id = $1", [b.installationId]))[0].n, 0, "nothing was written");
    const refused = await w.audit("device_id = $1 and event = 'ingest_refused'", [a.deviceId]);
    assert.equal(refused.length, 1);
  });

  it("a stale snapshot is ignored by the unchanged ingest implementation, and the registered path reports it", async () => {
    const acct = await w.account();
    const e = await w.enrolled(acct);
    assert.equal((await w.ingest(e.device, e.secret, snapshot(e.installationId, { updatedAt: 9000 }))).ok, true);
    const res = await w.ingest(e.device, e.secret, snapshot(e.installationId, { updatedAt: 100 }));
    assert.equal(res.ok, true);
    assert.equal(res.status, "stale_ignored");
  });

  it("the identity swap used during ingest never leaks: later statements in the same transaction still see the DEVICE identity", async () => {
    const acct = await w.account();
    const e = await w.enrolled(acct);
    await w.fx.resetBudgets();
    await w.admin.query("begin");
    try {
      await w.admin.query("set local role authenticated");
      await w.admin.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(e.device.claims)]);
      await w.admin.query("select public.fdb_device_ingest($1, $2)", [e.secret, snapshot(e.installationId, { updatedAt: 7000 })]);
      const after = (await w.admin.query("select auth.uid() as uid, auth.role() as role, current_setting('request.jwt.claims', true)::jsonb ->> 'sub' as sub")).rows[0];
      assert.equal(after.uid, e.device.uid);
      assert.equal(after.sub, e.device.uid);
      assert.equal(after.role, "authenticated");
    } finally {
      await w.admin.query("rollback");
    }
  });
});

describe("scenario 2: same account, second computer", () => {
  it("two devices, two installations, two independent credentials; each device can sync only its own installation", async () => {
    const acct = await w.account();
    const home = await w.enrolled(acct);
    const work = await w.enrolled(acct);
    assert.notEqual(home.installationId, work.installationId);
    assert.notEqual(home.secret, work.secret);
    assert.notEqual(home.deviceId, work.deviceId);
    assert.notEqual(home.device.uid, work.device.uid);

    assert.equal((await w.ingest(home.device, home.secret, snapshot(home.installationId, { updatedAt: 5000 }))).ok, true);
    assert.equal((await w.ingest(work.device, work.secret, snapshot(work.installationId, { updatedAt: 5000 }))).ok, true);

    // crossing credentials and identities fails in every direction
    assert.deepEqual(await w.ingest(home.device, work.secret, snapshot(work.installationId, { updatedAt: 6000 })), { ok: false, error: "device_unauthorized" }, "home identity + work secret");
    assert.deepEqual(await w.ingest(work.device, home.secret, snapshot(home.installationId, { updatedAt: 6000 })), { ok: false, error: "device_unauthorized" }, "work identity + home secret");
    assert.deepEqual(await w.ingest(home.device, home.secret, snapshot(work.installationId, { updatedAt: 6000 })), { ok: false, error: "wrong_installation" });

    await w.fx.resetBudgets();
    const installs = await acct.call("fdb_account_installations");
    assert.deepEqual(installs.map((i) => i.installation_id).sort(), [home.installationId, work.installationId].sort());
    const devices = await acct.call("fdb_account_devices");
    assert.equal(devices.length, 2);
    assert.equal(devices.every((d) => d.status === "active"), true);

    // revoking ONE device does not affect the other
    assert.deepEqual(await acct.call("fdb_account_device_revoke", [home.deviceId]), { ok: true });
    assert.equal((await w.ingest(home.device, home.secret, snapshot(home.installationId, { updatedAt: 7000 }))).error, "device_revoked");
    assert.equal((await w.ingest(work.device, work.secret, snapshot(work.installationId, { updatedAt: 7000 }))).ok, true);
  });

  it("an installation id that already has an ACTIVE device cannot be bound by another computer (cloned SavedVariables): installation_bound", async () => {
    const acct = await w.account();
    const first = await w.enrolled(acct);
    const clone = await w.device();
    const t = await w.ticket(acct);
    assert.deepEqual(await w.enroll(clone, t.ticket, first.installationId), { ok: false, error: "installation_bound" });
    assert.equal((await w.ticket_row(t.ticket_id)).status, "pending", "the ticket survives a refused attempt");
    assert.equal((await w.device_row(first.deviceId)).status, "active", "the original device is untouched");
    assert.equal((await w.ingest(first.device, first.secret, snapshot(first.installationId, { updatedAt: 5000 }))).ok, true);
  });

  it("one Auth identity cannot be the device of two installations (identity_in_use) and the ticket is not consumed", async () => {
    const acct = await w.account();
    const first = await w.enrolled(acct);
    const t = await w.ticket(acct);
    assert.deepEqual(await w.enroll(first.device, t.ticket, instId()), { ok: false, error: "identity_in_use" });
    assert.equal((await w.ticket_row(t.ticket_id)).status, "pending");
  });

  it("an account may hold 10 live devices; the 11th redemption is refused (device_limit) without consuming the ticket or reserving the installation", async () => {
    const acct = await w.account();
    for (let i = 0; i < 10; i += 1) await w.enrolled(acct);
    // the 10-per-hour issuance cap counts the ten tickets just used: age them, as a real user would after an hour
    await w.admin.query("update private.enrollment_tickets set created_at = now() - interval '2 hours', expires_at = now() + interval '166 hours' where account_uid = $1", [acct.uid]);
    const t = await w.ticket(acct);
    const inst = instId();
    assert.deepEqual(await w.enroll(await w.device(), t.ticket, inst), { ok: false, error: "device_limit" });
    assert.equal((await w.ticket_row(t.ticket_id)).status, "pending");
    assert.equal((await w.row("select count(*)::int n from public.installations where id = $1", [inst]))[0].n, 0);
    // after one revocation there is room again
    const devices = await acct.call("fdb_account_devices");
    await acct.call("fdb_account_device_revoke", [devices[0].device_id]);
    assert.equal((await w.enroll(await w.device(), t.ticket, inst)).ok, true);
  });
});

describe("scenario 3: anonymous installation -> registration -> one-time claim -> registered sync", () => {
  it("a historical anonymous installation keeps all data through claim and device enrollment, and anonymous upload stops for it", async () => {
    const owner = await w.device(); // the historical anonymous Companion identity (an anonymous Auth user)
    const acct = await w.account();
    const claimed = instId();
    const stayAnon = [instId(), instId()];

    await w.fx.resetBudgets();
    for (const id of [claimed, ...stayAnon]) {
      assert.equal((await owner.call("ingest_foreverdb_snapshot_auth", [snapshot(id, { updatedAt: 1000 })])).ok, true);
      await w.fx.resetBudgets();
    }
    const before = Object.fromEntries(await Promise.all([claimed, ...stayAnon].map(async (id) => [id, await w.history(id)])));

    // the existing, already shipped claim workflow (0012)
    const start = await owner.call("fdb_account_claim_start", [claimed]);
    assert.equal(start.ok, true);
    await w.fx.resetBudgets();
    const redeem = await acct.call("fdb_account_claim_redeem", [start.code]);
    assert.equal(redeem.ok, true);
    assert.equal((await w.row("select owner_user_id from public.installations where id = $1", [claimed]))[0].owner_user_id, acct.uid);

    // old anonymous upload for the transferred id is denied by the existing owner check; the other two keep working
    await w.fx.resetBudgets();
    await assert.rejects(owner.call("ingest_foreverdb_snapshot_auth", [snapshot(claimed, { updatedAt: 2000 })]), /belongs to another authenticated client/);
    await w.fx.resetBudgets();
    assert.equal((await owner.call("ingest_foreverdb_snapshot_auth", [snapshot(stayAnon[0], { updatedAt: 2000 })])).ok, true);

    // registered sync for the claimed installation: a ticket + the Companion's NEW device identity. No login, no claim code.
    assert.deepEqual(await w.history(claimed), before[claimed], "claim alone changed no history");
    const companion = await w.device();
    const t = await w.ticket(acct, "Claimed PC");
    const enrolled = await w.enroll(companion, t.ticket, claimed, "Claimed PC");
    assert.equal(enrolled.ok, true);
    assert.deepEqual(await w.history(claimed), before[claimed], "enrollment changed no history");
    assert.equal((await w.row("select owner_user_id from public.installations where id = $1", [claimed]))[0].owner_user_id, acct.uid, "enrollment did not move ownership");

    const res = await w.ingest(companion, enrolled.device_secret, snapshot(claimed, { updatedAt: 3000 }));
    assert.equal(res.ok, true);
    assert.deepEqual(await w.history(claimed), before[claimed], "same content re-synced: history identical (nothing deleted)");

    // the two installations that stayed anonymous are untouched by enrollment and by the claim
    assert.deepEqual(await w.history(stayAnon[1]), before[stayAnon[1]]);
    assert.equal((await w.row("select owner_user_id from public.installations where id = $1", [stayAnon[1]]))[0].owner_user_id, owner.uid);

    await w.fx.resetBudgets();
    const guilds = await acct.call("fdb_account_guildbook_guilds", [claimed]);
    assert.equal(guilds.length, 2, "the registered account reads the claimed installation's Guildbook");
    const links = await w.row("select account_uid, previous_owner_uid from private.account_installations where installation_id = $1", [claimed]);
    assert.deepEqual(links, [{ account_uid: acct.uid, previous_owner_uid: owner.uid }], "claim provenance intact");
  });

  it("the previous anonymous owner's identity is NOT a shortcut: it cannot enroll the claimed installation with its own ticket, and a ticket of another account is refused", async () => {
    const owner = await w.device();
    const acct = await w.account();
    const other = await w.account();
    const inst = instId();
    await w.fx.resetBudgets();
    await owner.call("ingest_foreverdb_snapshot_auth", [snapshot(inst, { updatedAt: 1000 })]);
    await w.fx.resetBudgets();
    const start = await owner.call("fdb_account_claim_start", [inst]);
    await w.fx.resetBudgets();
    await acct.call("fdb_account_claim_redeem", [start.code]);
    // another registered account's ticket does not get the installation
    const t = await w.ticket(other);
    assert.deepEqual(await w.enroll(owner, t.ticket, inst), { ok: false, error: "installation_conflict" });
    assert.equal((await w.row("select owner_user_id from public.installations where id = $1", [inst]))[0].owner_user_id, acct.uid);
    assert.equal((await w.ticket_row(t.ticket_id)).status, "pending");
    // ... while the rightful account's ticket works for the previous owner's machine
    const t2 = await w.ticket(acct);
    assert.equal((await w.enroll(owner, t2.ticket, inst)).ok, true);
  });
});

describe("scenario 4: wrong account, guessed installation id, unauthorized access", () => {
  it("a ticket never takes an installation owned by another account, an anonymous owner, or nobody (legacy): installation_conflict, owner unchanged", async () => {
    const a = await w.account();
    const b = await w.account();
    const anon = await w.device();
    const bOwned = (await w.enrolled(b)).installationId; // reserved for B
    const anonOwned = instId();
    await w.fx.resetBudgets();
    await anon.call("ingest_foreverdb_snapshot_auth", [snapshot(anonOwned, { updatedAt: 1000 })]);
    const legacy = instId();
    await w.admin.query("insert into public.installations (id, owner_user_id, schema_version, addon_version) values ($1, null, 7, 'legacy')", [legacy]);

    for (const [id, expectedOwner] of [[bOwned, b.uid], [anonOwned, anon.uid], [legacy, null]]) {
      const t = await w.ticket(a);
      const res = await w.enroll(await w.device(), t.ticket, id);
      assert.deepEqual(res, { ok: false, error: "installation_conflict" }, id);
      assert.equal((await w.row("select owner_user_id from public.installations where id = $1", [id]))[0].owner_user_id, expectedOwner, "owner unchanged");
      assert.equal((await w.ticket_row(t.ticket_id)).status, "pending");
      await a.call("fdb_account_enrollment_ticket_revoke", [t.ticket_id]);
    }
    assert.equal((await w.row("select count(*)::int n from private.devices where installation_id = any($1)", [[bOwned, anonOwned, legacy]]))[0].n, 1, "only B's own device exists");
  });

  it("knowing an installation id proves nothing: another account cannot read, list, revoke or write it", async () => {
    const a = await w.account();
    const b = await w.account();
    const e = await w.enrolled(a);
    await w.ingest(e.device, e.secret, snapshot(e.installationId, { updatedAt: 5000 }));
    await w.fx.resetBudgets();
    assert.deepEqual(await b.call("fdb_account_guildbook_guilds", [e.installationId]), []);
    assert.deepEqual(await b.call("fdb_account_guildbook_members", [e.installationId, "Realm:Guild1", 100, 0]), []);
    assert.deepEqual(await b.call("fdb_account_installations"), []);
    assert.deepEqual(await b.call("fdb_account_devices"), []);
    assert.deepEqual(await b.call("fdb_account_device_revoke", [e.deviceId]), { ok: false, error: "not_available" });
    assert.equal((await w.device_row(e.deviceId)).status, "active");
    // an unrelated anonymous identity (a stranger who guessed the id) cannot write it through the legacy path either
    const stranger = await w.device();
    await w.fx.resetBudgets();
    await assert.rejects(stranger.call("ingest_foreverdb_snapshot_auth", [snapshot(e.installationId, { updatedAt: 9000 })]), /belongs to another authenticated client/);
    // ... nor through the device path with a guessed secret or with A's secret from another identity
    assert.deepEqual(await w.ingest(stranger, e.secret, snapshot(e.installationId, { updatedAt: 9000 })), { ok: false, error: "device_unauthorized" });
    const guess = e.secret.slice(0, 40) + (e.secret[40] === "A" ? "B" : "A") + e.secret.slice(41);
    assert.deepEqual(await w.ingest(e.device, guess, snapshot(e.installationId, { updatedAt: 9000 })), { ok: false, error: "device_unauthorized" });
    assert.deepEqual(await w.ingest(e.device, "fdbd1_" + "0".repeat(32) + "_" + "A".repeat(43), snapshot(e.installationId, { updatedAt: 9000 })), { ok: false, error: "device_unauthorized" });
    assert.deepEqual(await w.ingest(e.device, "garbage", snapshot(e.installationId, { updatedAt: 9000 })), { ok: false, error: "device_unauthorized" });
  });

  it("stale ownership: if the installation is no longer owned by the device's account, ingest and status fail closed (ownership_conflict) and nothing is written", async () => {
    const a = await w.account();
    const b = await w.account();
    const e = await w.enrolled(a);
    await w.ingest(e.device, e.secret, snapshot(e.installationId, { updatedAt: 5000 }));
    const before = await w.history(e.installationId);
    await w.admin.query("update public.installations set owner_user_id = $2 where id = $1", [e.installationId, b.uid]); // simulated stale/changed ownership
    assert.deepEqual(await w.ingest(e.device, e.secret, snapshot(e.installationId, { updatedAt: 6000, sources: 1 })), { ok: false, error: "ownership_conflict" });
    assert.deepEqual(await w.history(e.installationId), before);
    await w.fx.resetBudgets();
    assert.equal((await e.device.call("fdb_device_status", [e.secret])).state, "ownership_conflict");
    // A cannot see it any more, B owns it but has no device for it
    assert.deepEqual(await a.call("fdb_account_guildbook_guilds", [e.installationId]), []);
  });

  it("registered accounts cannot enroll (PT403) and an anonymous identity cannot issue tickets (PT403)", async () => {
    const a = await w.account();
    const t = await w.ticket(a);
    await w.fx.resetBudgets();
    await expectCode(a.call("fdb_device_enroll", [t.ticket, instId(), "x"]), "PT403");
    const anon = await w.device();
    await expectCode(anon.call("fdb_account_enrollment_ticket_issue", []), "PT403");
  });
});
