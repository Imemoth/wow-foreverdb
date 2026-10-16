// Preservation of historical anonymous installations (acceptance test 7), modelled on production: one anonymous owner holding seven
// installations, one of which is later linked to a registered account (the owner-tested installation), six staying anonymous.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { instId, makeWorld, snapshot } from "./world.mjs";

let w;
before(async () => {
  w = await makeWorld();
});
after(async () => {
  await w.close();
});

describe("historical anonymous installations survive the whole enrollment lifecycle", () => {
  it("six anonymous installations and one claimed installation: rows, owners and history are byte-identical after enrollments, syncs, rotations, revocations and replacements", async () => {
    const owner = await w.device(); // the historical anonymous Companion identity
    const acct = await w.account();
    const hist = Array.from({ length: 7 }, () => instId());
    const linked = hist[0];
    const anon = hist.slice(1);

    for (const [i, id] of hist.entries()) {
      await w.fx.resetBudgets();
      assert.equal((await owner.call("ingest_foreverdb_snapshot_auth", [snapshot(id, { updatedAt: 1000 + i, sources: 2 + (i % 3), guilds: 1 + (i % 2), members: 3 })])).ok, true);
    }
    await w.fx.resetBudgets();
    const start = await owner.call("fdb_account_claim_start", [linked]);
    await w.fx.resetBudgets();
    assert.equal((await acct.call("fdb_account_claim_redeem", [start.code])).ok, true);

    const fingerprint = async () => {
      const out = {};
      for (const id of hist) {
        out[id] = { history: await w.history(id), row: (await w.row("select id, owner_user_id, schema_version, addon_version, snapshot_updated_at, first_seen_at, last_seen_at from public.installations where id = $1", [id]))[0] };
      }
      return out;
    };
    const baseline = await fingerprint();
    const links = await w.row("select * from private.account_installations order by installation_id");

    // ---- the lifecycle: new installations for the account, syncs, rotation, revocation, replacement; enrolment of the CLAIMED id
    const other = await w.account();
    const a1 = await w.enrolled(acct);
    const a2 = await w.enrolled(other);
    await w.ingest(a1.device, a1.secret, snapshot(a1.installationId, { updatedAt: 5000 }));
    await w.ingest(a2.device, a2.secret, snapshot(a2.installationId, { updatedAt: 5000 }));
    await w.fx.resetBudgets();
    const rot = await a1.device.call("fdb_device_rotate_credential", [a1.secret]);
    await w.ingest(a1.device, rot.device_secret, snapshot(a1.installationId, { updatedAt: 5001 }));
    await w.fx.resetBudgets();
    await acct.call("fdb_account_device_revoke", [a1.deviceId]);
    const companion = await w.device();
    const t = await w.ticket(acct);
    const claimedDevice = await w.enroll(companion, t.ticket, linked);
    assert.equal(claimedDevice.ok, true);

    // enrolment of the claimed installation changed NOTHING about it
    const afterEnroll = await fingerprint();
    assert.deepEqual(afterEnroll, baseline, "installation rows (incl. last_seen_at and timestamps) and every history table are byte-identical");
    assert.deepEqual(await w.row("select * from private.account_installations order by installation_id"), links, "claim provenance untouched");

    // the six anonymous installations still belong to the anonymous owner and still sync anonymously, unchanged in content
    for (const id of anon) assert.equal(afterEnroll[id].row.owner_user_id, owner.uid);
    await w.fx.resetBudgets();
    assert.equal((await owner.call("ingest_foreverdb_snapshot_auth", [snapshot(anon[0], { updatedAt: 9000, sources: 3, guilds: 1, members: 3 })])).ok, true);
    // ... and the claimed one no longer accepts the anonymous owner
    await w.fx.resetBudgets();
    await assert.rejects(owner.call("ingest_foreverdb_snapshot_auth", [snapshot(linked, { updatedAt: 9000 })]), /belongs to another authenticated client/);
    // ... while the registered device syncs it (re-sync of identical content keeps every row)
    const synced = await w.ingest(companion, claimedDevice.device_secret, snapshot(linked, { updatedAt: 9001, sources: 2, guilds: 1, members: 3 }));
    assert.equal(synced.ok, true);
    assert.deepEqual((await w.history(linked)), baseline[linked].history);

    // other accounts and other anonymous installations are not affected by any of it
    for (const id of anon.slice(1)) assert.deepEqual((await fingerprint())[id], baseline[id]);
  });

  it("enrolment never touches an existing installation's data: whole-table digest of history rows for pre-existing installations is identical before and after a burst of enrollments", async () => {
    const owner = await w.device();
    const ids = [instId(), instId(), instId()];
    for (const id of ids) {
      await w.fx.resetBudgets();
      await owner.call("ingest_foreverdb_snapshot_auth", [snapshot(id, { updatedAt: 1000 })]);
    }
    const digest = async () => (await w.row(
      `select (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.installation_source_stats t where installation_id = any($1)) s,
              (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.installation_item_stats t where installation_id = any($1)) i,
              (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.installation_location_stats t where installation_id = any($1)) l,
              (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.installation_guild_members t where installation_id = any($1)) m,
              (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.installations t where id = any($1)) r`, [ids]))[0];
    const before = await digest();
    const acct = await w.account();
    for (let i = 0; i < 4; i += 1) {
      const e = await w.enrolled(acct);
      await w.ingest(e.device, e.secret, snapshot(e.installationId, { updatedAt: 5000 }));
    }
    assert.deepEqual(await digest(), before);
  });
});

describe("what enrollment writes outside its own tables", () => {
  it("the only public-schema write is INSERT of a reserved installation row (schema_version 0, owner = account); no other public table gains rows from enroll alone", async () => {
    const counts = async () => (await w.row(
      `select (select count(*)::int from public.installations) installations,
              (select count(*)::int from public.installation_source_stats) source_stats,
              (select count(*)::int from public.installation_item_stats) item_stats,
              (select count(*)::int from public.installation_location_stats) location_stats,
              (select count(*)::int from public.installation_guilds) guilds,
              (select count(*)::int from public.installation_guild_members) members,
              (select count(*)::int from public.installation_guild_professions) professions`))[0];
    const acct = await w.account();
    const before = await counts();
    const e = await w.enrolled(acct);
    const after = await counts();
    assert.deepEqual({ ...after, installations: after.installations - 1 }, before);
    const [row] = await w.row("select owner_user_id, schema_version, addon_version from public.installations where id = $1", [e.installationId]);
    assert.deepEqual(row, { owner_user_id: acct.uid, schema_version: 0, addon_version: "enrolled" });
  });
});
