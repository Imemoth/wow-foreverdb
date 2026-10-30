// Migration 0018 against the zero-touch enrollment surface (0014): existing Guildbook rows and the Guildbook function definitions remain, but no
// API role can invoke an old cloud read path, and the enrolled-device ingest (fdb_device_ingest) as well as the public registered/anonymous ingest
// persist observations only. All 0014 device checks keep working unchanged.
//
// Runs on a CLONE of the enrollment database with 0018 applied: the shared database never receives 0018 (01_privileges.test.mjs in this directory
// pins that every pre-0012 function is byte-identical, and the enrollment suite is run against the shared database in several CI layouts).
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { DB, cloneDatabase, dropDatabase, psqlFile, repoRoot } from "../account/harness.mjs";
import { makeWorld, expectCode, instId, snapshot } from "./world.mjs";

const CLONE = `${DB}_enr_gb18`;
const MIG18 = path.join(repoRoot, "database/migrations/0018_disable_guildbook_cloud_sync.sql");
let w;

before(async () => {
  await cloneDatabase(DB, CLONE);
  const applied = psqlFile(CLONE, MIG18);
  assert.equal(applied.status, 0, applied.out);
  w = await makeWorld({ database: CLONE });
});
after(async () => {
  await w?.close();
  await dropDatabase(CLONE);
});

const guildCount = async (installation) => (await w.row(
  "select (select count(*)::int from public.installation_guilds where installation_id = $1) as g, (select count(*)::int from public.installation_guild_members where installation_id = $1) as m",
  [installation],
))[0];

describe("Guildbook local-only kill switch (enrollment surface)", () => {
  it("has no account-scoped Guildbook cloud storage, and the ingest boundary remains observation-only", async () => {
    const shape = (await w.row(`
      select to_regclass('private.account_guildbook_guilds') is null as no_account_guilds,
             to_regclass('private.account_guildbook_members') is null as no_account_members,
             to_regclass('private.account_guildbook_captures') is null as no_account_captures,
             to_regclass('private.account_guildbook_professions') is null as no_account_professions,
             to_regprocedure('private.fdb_public_snapshot(jsonb)') is not null as has_projection,
             has_function_privilege('anon', 'private.foreverdb_ingest_snapshot_impl_v1(jsonb)', 'execute') as anon_impl,
             has_function_privilege('authenticated', 'private.foreverdb_ingest_snapshot_impl_v1(jsonb)', 'execute') as auth_impl
    `))[0];
    assert.deepEqual(shape, {
      no_account_guilds: true,
      no_account_members: true,
      no_account_captures: true,
      no_account_professions: true,
      has_projection: true,
      anon_impl: false,
      auth_impl: false,
    });
  });

  it("retains the definitions and the data but revokes every client EXECUTE grant", async () => {
    const rows = await w.row(
      `select p.oid::regprocedure::text as sig,
              has_function_privilege('public', p.oid, 'execute') as pub, has_function_privilege('anon', p.oid, 'execute') as anon_x,
              has_function_privilege('authenticated', p.oid, 'execute') as auth_x, has_function_privilege('service_role', p.oid, 'execute') as svc_x
         from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname ~* 'guildbook' order by 1`,
    );
    assert.deepEqual(rows.map((r) => r.sig), [
      "fdb_account_guildbook_guilds(text)",
      "fdb_account_guildbook_members(text,text,integer,integer)",
    ]);
    for (const row of rows) assert.deepEqual([row.pub, row.anon_x, row.auth_x, row.svc_x], [false, false, false, false], row.sig);
    assert.equal((await w.row("select count(*)::int as n from private.guildbook_cloud_sync_guard"))[0].n, 1);
  });

  it("a real registered session cannot call an old Guildbook RPC after the migration", async () => {
    const account = await w.account();
    await expectCode(account.call("fdb_account_guildbook_guilds", ["missing-installation"]), "42501");
    await expectCode(account.call("fdb_account_guildbook_members", ["missing-installation", "k", 10, 0]), "42501");
  });

  it("preserves existing Guildbook through public and enrolled-device ingest and persists no new Guildbook row; observations still ingest", async () => {
    const account = await w.account();
    const installation = instId();
    await w.fx.installation(installation, account.uid);
    await w.fx.guild(installation, "synthetic-guild", [{ guid: "synthetic-member-1", name: "Synthetic Member One" }]);
    const before = await w.history(installation);
    const enrolled = await w.enrolled(account, { installationId: installation });

    await w.fx.resetBudgets();
    const publicResult = await account.call("ingest_foreverdb_snapshot_auth", [snapshot(installation, { sources: 1, guilds: 1, members: 2, updatedAt: 3000 })]);
    assert.equal(publicResult.ok, true);
    const afterPublic = await w.history(installation);
    assert.equal(afterPublic.guilds, before.guilds);
    assert.equal(afterPublic.members, before.members);
    assert.notEqual(afterPublic.source, before.source, "observations were ingested");

    const deviceResult = await w.ingest(enrolled.device, enrolled.secret, snapshot(installation, { sources: 2, guilds: 2, members: 3, updatedAt: 3001 }));
    assert.equal(deviceResult.ok, true);
    const afterDevice = await w.history(installation);
    assert.equal(afterDevice.guilds, before.guilds);
    assert.equal(afterDevice.members, before.members);
    assert.ok(Number(afterDevice.source.split(":")[0]) >= 2);

    // a brand-new installation reached by a device creates no Guildbook row at all
    const fresh = instId();
    const freshEnrollment = await w.enrolled(account, { installationId: fresh });
    const freshResult = await w.ingest(freshEnrollment.device, freshEnrollment.secret, snapshot(fresh, { sources: 1, guilds: 1, members: 2, updatedAt: 3002 }));
    assert.equal(freshResult.ok, true);
    assert.deepEqual(await guildCount(fresh), { g: 0, m: 0 });
  });

  it("the 0014 device checks are unchanged: unknown secret, wrong installation, revoked device and a registered caller are all refused without a write", async () => {
    const account = await w.account();
    const installation = instId();
    await w.fx.installation(installation, account.uid);
    await w.fx.guild(installation, "synthetic-guild", [{ guid: "synthetic-member-1", name: "Synthetic Member One" }]);
    const other = instId();
    const e = await w.enrolled(account, { installationId: installation });
    const e2 = await w.enrolled(account, { installationId: other });
    const baseline = await w.history(installation);

    assert.deepEqual(await w.ingest(e.device, "fdbd1_invalid", snapshot(installation, { sources: 1, guilds: 1, updatedAt: 4000 })), { ok: false, error: "device_unauthorized" });
    assert.deepEqual(await w.ingest(e2.device, e2.secret, snapshot(installation, { sources: 1, guilds: 1, updatedAt: 4001 })), { ok: false, error: "wrong_installation" });
    await w.fx.resetBudgets();
    await expectCode(account.call("fdb_device_ingest", [e.secret, snapshot(installation, { sources: 1, guilds: 1, updatedAt: 4002 })]), "PT403");
    assert.deepEqual(await w.history(installation), baseline);

    await w.fx.resetBudgets();
    assert.equal((await account.call("fdb_account_device_revoke", [e.deviceId])).ok, true);
    assert.deepEqual(await w.ingest(e.device, e.secret, snapshot(installation, { sources: 1, guilds: 1, updatedAt: 4003 })), { ok: false, error: "device_revoked" });
    assert.deepEqual(await w.history(installation), baseline);
  });

  it("an old client whose payload still carries Guildbook (including oversize and malformed shapes) cannot restore cloud sync", async () => {
    const account = await w.account();
    const e = await w.enrolled(account);
    const nonArray = snapshot(e.installationId, { sources: 1, guilds: 0, updatedAt: 5000 });
    nonArray.guilds = { guildKey: "x" };
    await expectCode(w.ingest(e.device, e.secret, nonArray), "PT413");
    const tooMany = snapshot(e.installationId, { sources: 1, guilds: 0, updatedAt: 5001 });
    tooMany.guilds = Array.from({ length: 101 }, (_, i) => ({ guildKey: `k${i}`, name: "n", members: [] }));
    await expectCode(w.ingest(e.device, e.secret, tooMany), "PT413");
    const hundred = snapshot(e.installationId, { sources: 1, guilds: 0, updatedAt: 5002 });
    hundred.guilds = Array.from({ length: 100 }, (_, i) => ({ guildKey: `k${i}`, name: "n", members: [{ guid: `g${i}`, name: "m" }] }));
    assert.equal((await w.ingest(e.device, e.secret, hundred)).ok, true);
    assert.deepEqual(await guildCount(e.installationId), { g: 0, m: 0 });
  });
});
