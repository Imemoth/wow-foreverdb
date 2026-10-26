// Production-shape Guildbook kill-switch rehearsal: ONLY a disposable clone.
// CI base: real GoTrue, migrations through 0012 and 0014. Neither 0016 nor 0017 is required.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { DB, cloneDatabase, dropDatabase, psqlFile, repoRoot } from "../account/harness.mjs";
import { makeWorld, expectCode, instId, snapshot } from "./world.mjs";

const clone = `${DB}_guildbook_0018_prod`;
const migration = path.join(repoRoot, "database/migrations/0018_disable_guildbook_cloud_sync.sql");
let w;

before(async () => {
  await cloneDatabase(DB, clone);
  const applied = psqlFile(clone, migration);
  assert.equal(applied.status, 0, applied.out);
  w = await makeWorld({ database: clone });
});

after(async () => {
  await w?.close();
  await dropDatabase(clone);
});

describe("0018 local-only Guildbook on current production (0014) schema", () => {
  it("closes all legacy Guildbook read RPC privileges but keeps other API entrypoints", async () => {
    const rows = await w.row(`select p.oid::regprocedure::text as signature,
         has_function_privilege('public', p.oid, 'EXECUTE') as public_exec,
         has_function_privilege('anon', p.oid, 'EXECUTE') as anon_exec,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_exec,
         has_function_privilege('service_role', p.oid, 'EXECUTE') as service_exec
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname like 'fdb_account_guildbook_%'
      order by signature`);
    assert.equal(rows.length, 2, "current production exposes exactly two legacy Guildbook read RPC signatures");
    for (const r of rows) {
      assert.equal(r.public_exec, false, r.signature);
      assert.equal(r.anon_exec, false, r.signature);
      assert.equal(r.auth_exec, false, r.signature);
      assert.equal(r.service_exec, false, r.signature);
    }
    const guard = await w.row("select guard_name from private.guildbook_cloud_sync_guard");
    assert.deepEqual(guard.map((x) => x.guard_name), ["disabled"]);
    const impl = await w.row(`select to_regprocedure('private.foreverdb_ingest_snapshot_impl_v1(jsonb)') is not null as wrapper,
       to_regprocedure('private.foreverdb_ingest_snapshot_impl_v1_legacy(jsonb)') is not null as old_impl,
       to_regprocedure('private.fdb_public_snapshot(jsonb)') is not null as projection`);
    assert.deepEqual(impl[0], { wrapper: true, old_impl: true, projection: true });
    const account = await w.account();
    await expectCode(account.call("fdb_account_guildbook_guilds", ["unrelated"]), "42501");
    await expectCode(account.call("fdb_account_guildbook_members", ["unrelated", "guild", 10, 0]), "42501");
  });

  it("retains historical guild rows while legacy public and device ingest continue observations", async () => {
    const account = await w.account();
    const installationId = instId();
    await w.fx.installation(installationId, account.uid);
    await w.fx.guild(installationId, "existing-guild", [{ guid: "existing-member", name: "Existing Member" }]);
    const before = await w.history(installationId);
    const pub = await account.call("ingest_foreverdb_snapshot_auth", [snapshot(installationId, {
      sources: 2, guilds: 3, members: 4, updatedAt: 2000,
    })]);
    assert.equal(pub.ok, true);
    const afterPublic = await w.history(installationId);
    assert.equal(afterPublic.guilds, before.guilds);
    assert.equal(afterPublic.members, before.members);
    assert.notEqual(afterPublic.source, before.source, "public observation ingest must remain functional");

    const enrolled = await w.enrolled(account, { installationId });
    const device = await w.ingest(enrolled.device, enrolled.secret, snapshot(installationId, {
      sources: 3, guilds: 4, members: 5, updatedAt: 3000,
    }));
    assert.equal(device.ok, true);
    const afterDevice = await w.history(installationId);
    assert.equal(afterDevice.guilds, before.guilds);
    assert.equal(afterDevice.members, before.members);
    assert.notEqual(afterDevice.source, afterPublic.source, "device observation ingest must remain functional");

    const fresh = await w.enrolled(account);
    const first = await w.ingest(fresh.device, fresh.secret, snapshot(fresh.installationId, {
      sources: 1, guilds: 2, members: 4, updatedAt: 4000,
    }));
    assert.equal(first.ok, true);
    const counts = await w.row(`select
        (select count(*)::int from public.installation_guilds where installation_id=$1) as guilds,
        (select count(*)::int from public.installation_guild_members where installation_id=$1) as members,
        (select count(*)::int from public.installation_guild_professions where installation_id=$1) as professions,
        (select count(*)::int from public.installation_source_stats where installation_id=$1) as sources`, [fresh.installationId]);
    assert.deepEqual({ guilds: counts[0].guilds, members: counts[0].members, professions: counts[0].professions },
      { guilds: 0, members: 0, professions: 0 });
    assert.ok(counts[0].sources > 0);
  });
});
