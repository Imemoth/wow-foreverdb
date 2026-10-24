// Migration-order regressions for the local-only Guildbook kill switch.
// Each clone is driven through psql exactly as the migration runner executes
// the SQL body; the ledger row is appended only after a successful body.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { DB, Fixtures, cloneDatabase, connect, dropDatabase, psqlFile, repoRoot, rpc, snapshot, uniq } from "./harness.mjs";
import { makeWorld } from "../enrollment/world.mjs";

const R = (...parts) => path.join(repoRoot, ...parts);
const MIG14 = R("database/migrations/0014_zero_touch_enrollment.sql");
const MIG16 = R("database/migrations/0016_account_scoped_guildbook.sql");
const MIG17 = R("database/migrations/0017_account_independent_collectors.sql");
const MIG18 = R("database/migrations/0018_disable_guildbook_cloud_sync.sql");
const clones = [`${DB}_gb_order_a`, `${DB}_gb_order_b`];

async function recordMigration(admin, version, name) {
  await admin.query(
    "insert into supabase_migrations.schema_migrations (version, name, statements) values ($1, $2, $3)",
    [version, name, [`test migration runner: ${name}`]],
  );
}

async function applyAndRecord(database, admin, file, version, name) {
  const applied = psqlFile(database, file);
  assert.equal(applied.status, 0, `${name}: ${applied.out}`);
  await recordMigration(admin, version, name);
}

async function assertAcl(admin, localOnly) {
  const rows = (await admin.query(
    `select p.oid::regprocedure::text as sig,
            has_function_privilege('public', p.oid, 'execute') as public_exec,
            has_function_privilege('anon', p.oid, 'execute') as anon_exec,
            has_function_privilege('authenticated', p.oid, 'execute') as authenticated_exec,
            has_function_privilege('service_role', p.oid, 'execute') as service_exec
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname like 'fdb_account_guildbook_%'
      order by sig`,
  )).rows;
  assert.ok(rows.length >= 2);
  for (const row of rows) {
    assert.equal(row.public_exec, false, row.sig);
    assert.equal(row.anon_exec, false, row.sig);
    assert.equal(row.service_exec, false, row.sig);
    assert.equal(row.authenticated_exec, !localOnly, row.sig);
  }
}

async function seedBeforeMigration(database) {
  const admin = await connect(database);
  const fx = new Fixtures(admin);
  const identity = await fx.identity({ anonymous: false, confirmed: true });
  const installation = uniq("migration-order");
  await fx.installation(installation, identity.uid);
  await fx.guild(installation, "existing", [{ guid: "existing-member", name: "Existing Member" }]);
  await admin.end();
  return { identity, installation };
}

async function prepare(database, order) {
  await cloneDatabase(DB, database);
  const seeded = await seedBeforeMigration(database);
  const admin = await connect(database);
  await applyAndRecord(database, admin, MIG14, "20990101000001", "zero_touch_enrollment");
  if (order === "kill-first") {
    await applyAndRecord(database, admin, MIG18, "20990101000002", "disable_guildbook_cloud_sync");
    await assertAcl(admin, true);
    await applyAndRecord(database, admin, MIG16, "20990101000003", "account_scoped_guildbook");
    await assertAcl(admin, true);
    await applyAndRecord(database, admin, MIG17, "20990101000004", "account_independent_collectors");
  } else {
    await applyAndRecord(database, admin, MIG16, "20990100000002", "account_scoped_guildbook");
    await assertAcl(admin, false);
    await applyAndRecord(database, admin, MIG17, "20990100000003", "account_independent_collectors");
    await applyAndRecord(database, admin, MIG18, "20990100000004", "disable_guildbook_cloud_sync");
  }
  await assertAcl(admin, true);
  const defs = (await admin.query(
    `select p.oid::regprocedure::text as sig, pg_get_functiondef(p.oid) as definition
       from pg_proc p
      where p.oid in ('private.foreverdb_ingest_snapshot_impl_v1(jsonb)'::regprocedure,
                      'private.foreverdb_ingest_snapshot_impl_v1_legacy(jsonb)'::regprocedure)`,
  )).rows;
  assert.equal(defs.length, 2);
  assert.ok(defs.find((row) => row.sig.includes("foreverdb_ingest_snapshot_impl_v1(jsonb)") && !row.sig.includes("legacy"))?.definition.includes("_legacy"));
  assert.ok(defs.some((row) => row.sig.includes("_legacy(jsonb)")));
  await admin.end();
  return seeded;
}

async function assertIngestPreservesRows(database, seeded) {
  const w = await makeWorld({ database });
  try {
    const before = await w.history(seeded.installation);
    const result = await rpc(w.client, seeded.claims, "ingest_foreverdb_snapshot_auth", [
      snapshot(seeded.installation, { sources: 2, guilds: 4, members: 5, updatedAt: 9000 }),
    ]);
    assert.equal(result.ok, true);
    const after = await w.history(seeded.installation);
    assert.equal(after.guilds, before.guilds);
    assert.equal(after.members, before.members);
    assert.equal(Number(after.source.split(":")[0]) > Number(before.source.split(":")[0]), true);

    const account = {
      uid: seeded.uid,
      sid: seeded.sid,
      claims: seeded.claims,
      kind: "account",
      call: (fn, args = []) => rpc(w.client, seeded.claims, fn, args),
    };
    const enrolled = await w.enrolled(account, { installationId: seeded.installation });
    const deviceResult = await w.ingest(enrolled.device, enrolled.secret, snapshot(seeded.installation, {
      sources: 3,
      guilds: 7,
      members: 8,
      updatedAt: 9001,
    }));
    assert.equal(deviceResult.ok, true);
    const afterDevice = await w.history(seeded.installation);
    assert.equal(afterDevice.guilds, after.guilds);
    assert.equal(afterDevice.members, after.members);
  } finally {
    await w.close();
  }
}

before(async () => {
  await prepare(clones[0], "kill-first");
  await prepare(clones[1], "full");
});

after(async () => {
  for (const clone of clones) await dropDatabase(clone);
});

describe("0018 kill switch migration order", () => {
  it("supports current production -> 0018 -> 0016 -> 0017 without reopening RPCs", async () => {
    const seeded = await seedFromClone(clones[0]);
    await assertIngestPreservesRows(clones[0], seeded);
    const admin = await connect(clones[0]);
    const duplicate = psqlFile(clones[0], MIG18);
    assert.notEqual(duplicate.status, 0);
    assert.match(duplicate.out, /ledger already shows disable_guildbook_cloud_sync/);
    await admin.end();
  });

  it("supports 0016 -> 0017 -> 0018 with the same secure final state", async () => {
    const seeded = await seedFromClone(clones[1]);
    await assertIngestPreservesRows(clones[1], seeded);
  });
});

const seedFromClone = async (database) => {
  const admin = await connect(database);
  const row = (await admin.query(
    "select u.id as uid, s.id as sid, i.id as installation from auth.users u join auth.sessions s on s.user_id = u.id join public.installations i on i.owner_user_id = u.id where i.id like 'migration-order-%' order by i.id limit 1",
  )).rows[0];
  const claims = { sub: row.uid, aud: "authenticated", role: "authenticated", session_id: row.sid, is_anonymous: false, exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000) - 60 };
  await admin.end();
  return { uid: row.uid, sid: row.sid, claims, installation: row.installation };
};
