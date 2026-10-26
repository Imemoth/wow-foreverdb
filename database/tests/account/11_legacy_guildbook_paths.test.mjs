// Migration 0018 compatibility against the current production shape:
// 0012 is present, but 0014/0016/0017 account-scoped and device additions are
// absent. The migration must be independently deployable and must protect
// existing Guildbook rows from legacy public ingest.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { DB, Fixtures, cloneDatabase, connect, dropDatabase, psqlFile, repoRoot, rpc, snapshot, uniq } from "./harness.mjs";

const clone = `${DB}_legacy_0018`;
const missingImplementationClone = `${DB}_legacy_0018_missing`;
const migration = path.join(repoRoot, "database/migrations/0018_disable_guildbook_cloud_sync.sql");

let admin;
let client;
let fx;

before(async () => {
  await cloneDatabase(DB, clone);
  const applied = psqlFile(clone, migration);
  assert.equal(applied.status, 0, applied.out);
  // The migration runner records the ledger separately. Re-applying the body
  // on a ledger-less disposable clone is intentionally idempotent.
  const reapplied = psqlFile(clone, migration);
  assert.equal(reapplied.status, 0, reapplied.out);
  admin = await connect(clone);
  client = await connect(clone);
  fx = new Fixtures(admin);
});

after(async () => {
  await client?.end();
  await admin?.end();
  await dropDatabase(clone);
  await dropDatabase(missingImplementationClone);
});

const counts = async (installation) => (await admin.query(
  `select
     (select count(*)::int from public.installation_guilds where installation_id = $1) as guilds,
     (select count(*)::int from public.installation_guild_members where installation_id = $1) as members,
     (select count(*)::int from public.installation_guild_professions where installation_id = $1) as professions,
     (select count(*)::int from public.installation_source_stats where installation_id = $1) as sources`,
  [installation],
)).rows[0];

describe("0018 current-production compatibility and legacy ingest separation", () => {
  it("fails closed when neither legacy ingest implementation exists", async () => {
    await cloneDatabase(DB, missingImplementationClone);
    const disposable = await connect(missingImplementationClone);
    await disposable.query("drop function private.foreverdb_ingest_snapshot_impl_v1(jsonb) cascade");
    await disposable.end();

    const failed = psqlFile(missingImplementationClone, migration);
    assert.notEqual(failed.status, 0);
    assert.match(failed.out, /legacy private ingest implementation is missing/);
  });

  it("preserves pre-existing Guildbook while public ingest continues observations and ignores private fields", async () => {
    const identity = await fx.identity({ anonymous: true });
    const installation = uniq("legacy-preserve");
    await fx.installation(installation, identity.uid);
    await fx.guild(installation, "pre-existing", [{ guid: "member-1", name: "Member One" }]);
    const before = await counts(installation);

    const result = await rpc(client, identity.claims, "ingest_foreverdb_snapshot_auth", [
      snapshot(installation, { sources: 1, guilds: 2, members: 3, updatedAt: 2000 }),
    ]);
    assert.equal(result.ok, true);
    assert.equal((await counts(installation)).guilds, before.guilds);
    assert.equal((await counts(installation)).members, before.members);
    assert.equal((await counts(installation)).professions, before.professions);
    assert.ok((await counts(installation)).sources > 0, "public observations still ingest");
  });

  it("does not persist Guildbook from a legacy payload and rolls back invalid requests", async () => {
    const identity = await fx.identity({ anonymous: true });
    const installation = uniq("legacy-drop");
    const before = await counts(installation);
    const result = await rpc(client, identity.claims, "ingest_foreverdb_snapshot_auth", [
      snapshot(installation, { sources: 1, guilds: 1, members: 2, updatedAt: 2001 }),
    ]);
    assert.equal(result.ok, true);
    const after = await counts(installation);
    assert.equal(after.guilds, 0);
    assert.equal(after.members, 0);
    assert.equal(after.professions, 0);
    assert.ok(after.sources > before.sources, "unrelated public data was retained");

    const stateBeforeInvalid = await admin.query(
      "select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by to_jsonb(t)::text), '')) as hash from public.installation_source_stats t where installation_id = $1",
      [installation],
    );
    await assert.rejects(
      rpc(client, identity.claims, "ingest_foreverdb_snapshot_auth", [{ schemaVersion: 9, guilds: [{ secret: "private" }] }]),
    );
    const stateAfterInvalid = await admin.query(
      "select md5(coalesce(string_agg(to_jsonb(t)::text, '|' order by to_jsonb(t)::text), '')) as hash from public.installation_source_stats t where installation_id = $1",
      [installation],
    );
    assert.equal(stateAfterInvalid.rows[0].hash, stateBeforeInvalid.rows[0].hash);
  });
});
