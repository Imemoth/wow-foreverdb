// Operator scripts around 0018, on clones: database/rollback/0018_restore.sql (explicit, narrow, refuses without a confirmation) and
// database/ops/guildbook_local_only_reassert.sql (tightening only). Nothing here touches the shared integration database.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { DB, Fixtures, cloneDatabase, connect, dropDatabase, expectCode, psqlFile, repoRoot, rpc, snapshot, uniq } from "./harness.mjs";

const R = (...parts) => path.join(repoRoot, ...parts);
const MIG18 = R("database/migrations/0018_disable_guildbook_cloud_sync.sql");
const RESTORE = R("database/rollback/0018_restore.sql");
const REASSERT = R("database/ops/guildbook_local_only_reassert.sql");
const CLONES = { main: `${DB}_gb_restore`, none: `${DB}_gb_restore_none` };
const CONFIRM = "REOPEN-GUILDBOOK-CLOUD-PATHS";
const READS = ["public.fdb_account_guildbook_guilds(text)", "public.fdb_account_guildbook_members(text,text,integer,integer)"];

let admin;
let client;
let fx;
const seed = {};

const restore = (vars) => psqlFile(CLONES.main, RESTORE, vars);
const ok = { confirm: CONFIRM, operator: "test-operator", approval_ref: "TEST-APPROVAL-1" };

const acl = async (sig, role) => (await admin.query("select has_function_privilege($1, $2, 'execute') as v", [role, sig])).rows[0].v;
async function readsState() {
  const out = {};
  for (const sig of READS) for (const role of ["public", "anon", "authenticated", "service_role"]) out[`${sig}:${role}`] = await acl(sig, role);
  return out;
}
const closed = Object.fromEntries(READS.flatMap((sig) => ["public", "anon", "authenticated", "service_role"].map((role) => [`${sig}:${role}`, false])));
const guildHash = async (inst) => (await admin.query(
  `select md5(concat_ws('|',
     (select coalesce(string_agg(to_jsonb(t)::text, '|' order by to_jsonb(t)::text), '') from public.installation_guilds t where installation_id = $1),
     (select coalesce(string_agg(to_jsonb(t)::text, '|' order by to_jsonb(t)::text), '') from public.installation_guild_members t where installation_id = $1))) as h,
   (select count(*)::int from public.installation_guilds where installation_id = $1) as guilds`,
  [inst],
)).rows[0];
const ingest = async (identity, snap) => {
  await fx.resetBudgets();
  return rpc(client, identity.claims, "ingest_foreverdb_snapshot_auth", [snap]);
};

before(async () => {
  await cloneDatabase(DB, CLONES.main);
  admin = await connect(CLONES.main);
  client = await connect(CLONES.main);
  fx = new Fixtures(admin);
  seed.owner = await fx.identity({ anonymous: false });
  seed.inst = uniq("gb-restore");
  await fx.installation(seed.inst, seed.owner.uid);
  await fx.guild(seed.inst, "synthetic-guild", [{ guid: "synthetic-member-1", name: "Synthetic Member One" }]);
  const applied = psqlFile(CLONES.main, MIG18);
  assert.equal(applied.status, 0, applied.out);
  seed.baseline = await guildHash(seed.inst);
  assert.equal(seed.baseline.guilds, 1);
});

after(async () => {
  await client?.end();
  await admin?.end();
  for (const name of Object.values(CLONES)) await dropDatabase(name);
});

describe("0018_restore.sql refuses unless explicitly and fully confirmed", () => {
  it("refuses a missing confirmation, a wrong confirmation text, a bad scope and malformed operator data; nothing changes", async () => {
    const cases = [
      [{ scope: "reads", operator: "t-op", approval_ref: "ref-1" }, /missing -v confirm/],
      [{ confirm: "yes", scope: "reads", operator: "t-op", approval_ref: "ref-1" }, /confirmation text does not match/],
      [{ confirm: CONFIRM, scope: "everything", operator: "t-op", approval_ref: "ref-1" }, /scope must be reads, ingest or all/],
      [{ confirm: CONFIRM, scope: "reads", operator: "t-op" }, /missing -v approval_ref/],
      [{ confirm: CONFIRM, scope: "reads", approval_ref: "ref-1" }, /missing -v operator/],
      [{ confirm: CONFIRM, scope: "reads", operator: "x", approval_ref: "ref-1" }, /malformed operator or approval reference/],
    ];
    for (const [vars, pattern] of cases) {
      const r = restore(vars);
      assert.notEqual(r.status, 0, JSON.stringify(Object.keys(vars)));
      assert.match(r.out, pattern);
    }
    assert.deepEqual(await readsState(), closed);
    assert.equal((await admin.query("select count(*)::int as n from private.guildbook_cloud_sync_guard")).rows[0].n, 1);
  });
});

describe("scope=reads, then the re-assert script", () => {
  it("grants EXECUTE to authenticated on exactly the two read RPCs, nothing to anyone else, and leaves the ingest projection and guard in place", async () => {
    const r = restore({ ...ok, scope: "reads" });
    assert.equal(r.status, 0, r.out);
    const state = await readsState();
    for (const sig of READS) {
      assert.equal(state[`${sig}:authenticated`], true, sig);
      for (const role of ["public", "anon", "service_role"]) assert.equal(state[`${sig}:${role}`], false, `${sig} ${role}`);
    }
    assert.equal((await admin.query("select count(*)::int as n from private.guildbook_cloud_sync_guard")).rows[0].n, 1);

    await fx.resetBudgets();
    const guilds = await rpc(client, seed.owner.claims, "fdb_account_guildbook_guilds", [seed.inst]);
    assert.equal(guilds.length, 1, "the historical rows are readable by their verified owner again");

    // writes stay closed: an old client still cannot create a Guildbook row
    const fresh = uniq("gb-restore-fresh");
    const result = await ingest(seed.owner, snapshot(fresh, { sources: 1, guilds: 2, members: 2, updatedAt: 2000 }));
    assert.equal(result.ok, true);
    assert.equal((await guildHash(fresh)).guilds, 0);
    assert.deepEqual(await guildHash(seed.inst), seed.baseline);
  });

  it("guildbook_local_only_reassert.sql closes them again, is idempotent, and changes no data", async () => {
    for (let i = 0; i < 2; i += 1) {
      const r = psqlFile(CLONES.main, REASSERT);
      assert.equal(r.status, 0, r.out);
    }
    assert.deepEqual(await readsState(), closed);
    await fx.resetBudgets();
    await expectCode(rpc(client, seed.owner.claims, "fdb_account_guildbook_guilds", [seed.inst]), "42501");
    assert.deepEqual(await guildHash(seed.inst), seed.baseline);
  });

  it("the re-assert script refuses on a database where 0018 is not active", async () => {
    await cloneDatabase(DB, CLONES.none);
    const r = psqlFile(CLONES.none, REASSERT);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /kill switch \(0018\) is not active/);
    // A controlled refusal, not a catalog error: the missing guard table must never surface as "relation ... does not exist".
    assert.doesNotMatch(r.out, /does not exist/);
  });

  it("the restore script refuses the same way (controlled message) when 0018 is not active, and changes no privilege", async () => {
    await cloneDatabase(DB, CLONES.none);
    const sub = await connect(CLONES.none);
    const fnAcl = `select p.oid::regprocedure::text as sig, coalesce(p.proacl::text, '') as acl
                   from pg_proc p where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace) order by 1`;
    try {
      const before = (await sub.query(fnAcl)).rows;
      const r = psqlFile(CLONES.none, RESTORE, { ...ok, scope: "all" });
      assert.notEqual(r.status, 0);
      assert.match(r.out, /kill switch is not active here/);
      assert.doesNotMatch(r.out, /does not exist/);
      assert.deepEqual((await sub.query(fnAcl)).rows, before);
    } finally {
      await sub.end();
    }
  });
});

describe("scope=ingest and scope=all", () => {
  it("scope=ingest removes the projection (original body restored under its original name, guard row deleted) and nothing else", async () => {
    const r = restore({ ...ok, scope: "ingest" });
    assert.equal(r.status, 0, r.out);
    const fns = (await admin.query(
      `select to_regprocedure('private.fdb_public_snapshot(jsonb)') is null as helper_gone,
              to_regprocedure('private.foreverdb_ingest_snapshot_impl_v1_legacy(jsonb)') is null as legacy_gone,
              (select prosrc from pg_proc where oid = 'private.foreverdb_ingest_snapshot_impl_v1(jsonb)'::regprocedure) as src`,
    )).rows[0];
    assert.equal(fns.helper_gone, true);
    assert.equal(fns.legacy_gone, true);
    assert.match(fns.src, /Installation belongs to another authenticated client/, "the original body is back (the 0012 pre-flight accepts it again)");
    assert.equal((await admin.query("select count(*)::int as n from private.guildbook_cloud_sync_guard")).rows[0].n, 0);
    assert.deepEqual(await readsState(), closed, "scope=ingest never opens the reads");
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      assert.equal(await acl("private.foreverdb_ingest_snapshot_impl_v1(jsonb)", role), false, role);
    }
    assert.deepEqual(await guildHash(seed.inst), seed.baseline, "no row was touched");

    // This is exactly the reopening the policy forbids: a legacy payload writes Guildbook to the cloud again.
    const fresh = uniq("gb-restore-open");
    assert.equal((await ingest(seed.owner, snapshot(fresh, { sources: 1, guilds: 2, members: 2, updatedAt: 3000 }))).ok, true);
    seed.reopenedInst = fresh;
    assert.equal((await guildHash(fresh)).guilds, 2);
  });

  it("with the guard gone a restore refuses, and re-applying 0018 closes the paths again while keeping every row", async () => {
    const refused = restore({ ...ok, scope: "reads" });
    assert.notEqual(refused.status, 0);
    assert.match(refused.out, /kill switch is not active here/);

    const reopened = await guildHash(seed.reopenedInst);
    const again = psqlFile(CLONES.main, MIG18);
    assert.equal(again.status, 0, again.out);
    assert.deepEqual(await readsState(), closed);
    assert.deepEqual(await guildHash(seed.reopenedInst), reopened, "rows written while reopened are preserved, not deleted");
    const fresh = uniq("gb-restore-closed");
    assert.equal((await ingest(seed.owner, snapshot(fresh, { sources: 1, guilds: 2, members: 2, updatedAt: 3100 }))).ok, true);
    assert.equal((await guildHash(fresh)).guilds, 0);
  });

  it("scope=all restores both parts, and refuses when account-scoped Guildbook tables exist", async () => {
    const r = restore({ ...ok, scope: "all" });
    assert.equal(r.status, 0, r.out);
    for (const sig of READS) assert.equal(await acl(sig, "authenticated"), true);
    assert.equal((await admin.query("select to_regprocedure('private.fdb_public_snapshot(jsonb)') is null as v")).rows[0].v, true);

    // Re-close, then simulate the sibling branch's account-scoped table: the ingest restore must refuse (that shape depends on the wrapper).
    assert.equal(psqlFile(CLONES.main, MIG18).status, 0);
    await admin.query("create table private.account_guildbook_captures (installation_id text)");
    const refused = restore({ ...ok, scope: "ingest" });
    assert.notEqual(refused.status, 0);
    assert.match(refused.out, /account-scoped Guildbook tables exist/);
    assert.equal((await admin.query("select to_regprocedure('private.fdb_public_snapshot(jsonb)') is not null as v")).rows[0].v, true, "refusal applied nothing");
  });
});
