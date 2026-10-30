// Migration 0018 (Guildbook is Companion-local only) on the RC shape: 0012 present, legacy ingest body from 0005/0009 in place, and NO
// account-scoped Guildbook migration (the RC does not contain one and must not get one).
//
// Everything runs on CLONES of the integration database. The shared database never receives 0018: the older suites in this directory pin the
// exact function set of 0012 (and the enrollment suite that of 0014), and a clone keeps those assertions valid in every CI job layout
// (0012 only; 0012 + 0015; 0012 + 0014 + 0015). Only obviously synthetic names are used and no test prints one.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DB, Fixtures, asUser, cloneDatabase, connect, dropDatabase, expectCode, psqlFile, repoRoot, rpc, snapshot, uniq } from "./harness.mjs";

const MIG18 = path.join(repoRoot, "database/migrations/0018_disable_guildbook_cloud_sync.sql");
const CLONES = { main: `${DB}_gb18_main`, refusals: `${DB}_gb18_refuse`, ledger: `${DB}_gb18_ledger` };
const IMPL = "private.foreverdb_ingest_snapshot_impl_v1(jsonb)";
const LEGACY = "private.foreverdb_ingest_snapshot_impl_v1_legacy(jsonb)";

let admin;
let client;
let fx;
const seed = {};

const guildTablesFingerprint = async (q) => (await q(
  `select (select count(*)::int from public.installation_guilds) as guilds,
          (select count(*)::int from public.installation_guild_members) as members,
          (select count(*)::int from public.installation_guild_professions) as professions,
          md5(concat_ws('|',
            (select coalesce(string_agg(to_jsonb(t)::text, '|' order by to_jsonb(t)::text), '') from public.installation_guilds t),
            (select coalesce(string_agg(to_jsonb(t)::text, '|' order by to_jsonb(t)::text), '') from public.installation_guild_members t),
            (select coalesce(string_agg(to_jsonb(t)::text, '|' order by to_jsonb(t)::text), '') from public.installation_guild_professions t))) as h`,
)).rows[0];

// Rows of ONE installation INCLUDING updated_at: a preserved row must be the very same row, not a rebuilt equivalent.
const installationGuildHash = async (inst) => (await admin.query(
  `select md5(concat_ws('|',
     (select coalesce(string_agg(to_jsonb(t)::text, '|' order by to_jsonb(t)::text), '') from public.installation_guilds t where installation_id = $1),
     (select coalesce(string_agg(to_jsonb(t)::text, '|' order by to_jsonb(t)::text), '') from public.installation_guild_members t where installation_id = $1),
     (select coalesce(string_agg(to_jsonb(t)::text, '|' order by to_jsonb(t)::text), '') from public.installation_guild_professions t where installation_id = $1))) as h,
   (select count(*)::int from public.installation_guilds where installation_id = $1) as guilds,
   (select count(*)::int from public.installation_guild_members where installation_id = $1) as members,
   (select count(*)::int from public.installation_guild_professions where installation_id = $1) as professions`,
  [inst],
)).rows[0];

const observations = async (inst) => (await admin.query(
  `select (select count(*)::int from public.installation_source_stats where installation_id = $1) as sources,
          (select count(*)::int from public.installation_item_stats where installation_id = $1) as items,
          (select count(*)::int from public.installation_location_stats where installation_id = $1) as locations`,
  [inst],
)).rows[0];

const ingest = async (identity, snap) => {
  await fx.resetBudgets();
  return rpc(client, identity.claims, "ingest_foreverdb_snapshot_auth", [snap]);
};

async function seedGuild(inst) {
  await fx.guild(inst, "synthetic-guild", [
    { guid: "synthetic-member-1", name: "Synthetic Member One" },
    { guid: "synthetic-member-2", name: "Synthetic Member Two" },
  ]);
  await admin.query(
    `insert into public.installation_guild_professions (installation_id, guild_key, member_guid, skill_line_id, profession_name, skill, max_skill, source, is_secondary)
     values ($1, 'synthetic-guild', 'synthetic-member-1', 164, 'Synthetic Craft', 300, 375, 'scan', false)`,
    [inst],
  );
}

before(async () => {
  await cloneDatabase(DB, CLONES.main);
  admin = await connect(CLONES.main);
  client = await connect(CLONES.main);
  fx = new Fixtures(admin);

  // Production-shaped history BEFORE the migration: one registered-owned and one anonymous-owned installation with Guildbook rows.
  seed.registered = await fx.identity({ anonymous: false });
  seed.anonymous = await fx.identity({ anonymous: true });
  seed.regInst = uniq("gb-pre-reg");
  seed.anonInst = uniq("gb-pre-anon");
  await fx.installation(seed.regInst, seed.registered.uid);
  await fx.installation(seed.anonInst, seed.anonymous.uid);
  await seedGuild(seed.regInst);
  await seedGuild(seed.anonInst);
  seed.beforeAll = await guildTablesFingerprint((sql) => admin.query(sql));
  seed.implMd5 = (await admin.query("select md5(prosrc) as h, proconfig as c, pg_get_userbyid(proowner) as o from pg_proc where oid = $1::regprocedure", [IMPL])).rows[0];

  const applied = psqlFile(CLONES.main, MIG18);
  assert.equal(applied.status, 0, applied.out);
  // The runner records the ledger separately; the body is idempotent on a ledger-less disposable clone (a real ledger refuses a rerun, see below).
  const reapplied = psqlFile(CLONES.main, MIG18);
  assert.equal(reapplied.status, 0, reapplied.out);
});

after(async () => {
  await client?.end();
  await admin?.end();
  for (const name of Object.values(CLONES)) await dropDatabase(name);
});

describe("0018 migration file (static)", () => {
  const text = fs.readFileSync(MIG18, "utf8");
  const code = text.replace(/--.*$/gm, "");

  it("is not an account migration for the web conformance linter (it lints every migration that names an account function as one unit)", () => {
    // Mirrors the `mentions` filter in web/tests/unit/account-migration-conformance.test.ts. If this fails, the linter would try to treat the kill
    // switch as an account function definition and report unregistered functions / dynamic DDL.
    assert.doesNotMatch(text, /fdb_account_|fdb_installation_link_status|fdb_caller|fdb_anonymous_caller|fdb_registered_caller/);
    assert.doesNotMatch(text, /azerdex-retention-(run|check)/);
  });

  it("deletes, truncates and updates nothing, and does not redefine a public entrypoint", () => {
    assert.doesNotMatch(code, /\bdelete\s+from\b|\bupdate\s+public\.|\btruncate\s+(table\s+)?[a-z_]+\.|\balter\s+table\s+public\./i);
    assert.doesNotMatch(code, /create\s+(or\s+replace\s+)?function\s+public\./i);
    assert.doesNotMatch(code, /\bdrop\s+(table|function|schema)\b(?!\s+if\s+exists\s+pg_temp\._fdb0018_)/i);
  });

  it("neither grants anything nor writes the migration ledger", () => {
    assert.doesNotMatch(code, /\bgrant\b/i);
    assert.doesNotMatch(code, /insert\s+into\s+supabase_migrations/i);
  });
});

describe("0018 on the RC shape: nothing is lost, the legacy ingest is observation-only", () => {
  it("the migration itself changed not one Guildbook row", async () => {
    assert.deepEqual(await guildTablesFingerprint((sql) => admin.query(sql)), seed.beforeAll);
  });

  it("anonymous and registered legacy ingest with a Guildbook payload persists observations and NO new Guildbook row", async () => {
    for (const anonymous of [true, false]) {
      const identity = await fx.identity({ anonymous });
      const inst = uniq(anonymous ? "gb-new-anon" : "gb-new-reg");
      const result = await ingest(identity, snapshot(inst, { sources: 2, guilds: 3, members: 4, updatedAt: 2000 }));
      assert.equal(result.ok, true);
      assert.equal(result.status, "applied");
      assert.equal(result.sourceCount, 2);
      assert.equal(result.guildCount, 0, "the legacy body never saw the guilds");
      const g = await installationGuildHash(inst);
      assert.deepEqual([g.guilds, g.members, g.professions], [0, 0, 0]);
      const o = await observations(inst);
      assert.ok(o.sources > 0 && o.items > 0 && o.locations > 0, "sources, items and locations are still ingested");
    }
  });

  it("pre-existing Guildbook rows are neither erased nor rebuilt by a public ingest, whatever the payload carries", async () => {
    for (const [identity, inst] of [[seed.registered, seed.regInst], [seed.anonymous, seed.anonInst]]) {
      const baseline = await installationGuildHash(inst);
      assert.ok(baseline.guilds === 1 && baseline.members === 2 && baseline.professions === 1);
      let ts = 3000;
      const variants = [
        snapshot(inst, { sources: 1, guilds: 2, members: 3, updatedAt: (ts += 1) }),
        snapshot(inst, { sources: 1, guilds: 0, members: 0, updatedAt: (ts += 1) }),
        (() => { const s = snapshot(inst, { sources: 1, guilds: 0, updatedAt: (ts += 1) }); delete s.guilds; return s; })(),
        { ...snapshot(inst, { sources: 1, guilds: 1, updatedAt: (ts += 1) }), guildbook: { x: 1 }, guildbookCapture: "c", guildbookCaptureId: "c1", guildbookCapturedAt: 1, guildbookSourceCharacter: "x" },
      ];
      for (const snap of variants) {
        const result = await ingest(identity, snap);
        assert.equal(result.ok, true);
        assert.deepEqual(await installationGuildHash(inst), baseline, "same rows, same updated_at");
      }
      assert.ok((await observations(inst)).sources > 0);
    }
  });

  it("a stale snapshot is still ignored cleanly while Guildbook rows exist (no duplicate-key failure from the preservation step)", async () => {
    const baseline = await installationGuildHash(seed.regInst);
    const result = await ingest(seed.registered, snapshot(seed.regInst, { sources: 1, guilds: 1, updatedAt: 5 }));
    assert.equal(result.ok, true);
    assert.equal(result.status, "stale_ignored");
    assert.deepEqual(await installationGuildHash(seed.regInst), baseline);
  });

  it("a snapshot that fails AFTER the legacy body deleted the old rows rolls back everything, Guildbook included", async () => {
    const inst = seed.regInst;
    const baseline = await installationGuildHash(inst);
    const obsBefore = await observations(inst);
    const bad = snapshot(inst, { sources: 3, updatedAt: 9000 });
    bad.sources[2].buckets[0].items[0].itemId = "not-a-number";
    await fx.resetBudgets();
    await assert.rejects(rpc(client, seed.registered.claims, "ingest_foreverdb_snapshot_auth", [bad]));
    assert.deepEqual(await installationGuildHash(inst), baseline);
    assert.deepEqual(await observations(inst), obsBefore);
  });

  it("another account cannot write a pre-existing installation (owner check unchanged) and the rows survive the attempt", async () => {
    const intruder = await fx.identity({ anonymous: false });
    const baseline = await installationGuildHash(seed.regInst);
    await fx.resetBudgets();
    await expectCode(rpc(client, intruder.claims, "ingest_foreverdb_snapshot_auth", [snapshot(seed.regInst, { updatedAt: 9500 })]), "P0001");
    assert.deepEqual(await installationGuildHash(seed.regInst), baseline);
  });

  it("payload bounds of the public entrypoint are unchanged: non-array and oversized guilds are refused with PT413, unauthenticated roles with 42501", async () => {
    const identity = await fx.identity({ anonymous: true });
    const inst = uniq("gb-bounds");
    const nonArray = snapshot(inst, { guilds: 0 });
    nonArray.guilds = { guildKey: "x" };
    await fx.resetBudgets();
    await expectCode(rpc(client, identity.claims, "ingest_foreverdb_snapshot_auth", [nonArray]), "PT413");
    const tooMany = snapshot(inst, { guilds: 0 });
    tooMany.guilds = Array.from({ length: 101 }, (_, i) => ({ guildKey: `k${i}`, name: "n", members: [] }));
    await fx.resetBudgets();
    await expectCode(rpc(client, identity.claims, "ingest_foreverdb_snapshot_auth", [tooMany]), "PT413");
    // Exactly 100 guilds is accepted by the bounds check, and none of them is stored.
    const hundred = snapshot(inst, { sources: 1, guilds: 0, updatedAt: 2500 });
    hundred.guilds = Array.from({ length: 100 }, (_, i) => ({ guildKey: `k${i}`, name: "n", members: [{ guid: `g${i}`, name: "m", professions: [{ skillLineId: 164, name: "p", skill: 1, maxSkill: 2 }] }] }));
    assert.equal((await ingest(identity, hundred)).ok, true);
    assert.deepEqual((({ guilds, members, professions }) => [guilds, members, professions])(await installationGuildHash(inst)), [0, 0, 0]);
    await fx.resetBudgets();
    await expectCode(asUser(client, identity.claims, (q) => q("select public.ingest_foreverdb_snapshot_auth($1::jsonb)", [JSON.stringify(snapshot(inst))]), { role: "anon" }), "42501");
  });
});

describe("0018 closes every Guildbook RPC", () => {
  it("is not executable by public, anon, authenticated or service_role; definitions and bodies are retained", async () => {
    const rows = (await admin.query(
      `select p.oid::regprocedure::text as sig,
              has_function_privilege('public', p.oid, 'execute') as pub, has_function_privilege('anon', p.oid, 'execute') as anon_x,
              has_function_privilege('authenticated', p.oid, 'execute') as auth_x, has_function_privilege('service_role', p.oid, 'execute') as svc_x
         from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname ~* 'guildbook' order by 1`,
    )).rows;
    assert.ok(rows.length >= 2, "the 0012 read pair exists");
    for (const row of rows) {
      assert.deepEqual([row.pub, row.anon_x, row.auth_x, row.svc_x], [false, false, false, false], row.sig);
    }
  });

  it("PostgREST-style calls fail with 42501 for a verified registered owner, the anon role and the service role", async () => {
    const owner = seed.registered;
    await expectCode(rpc(client, owner.claims, "fdb_account_guildbook_guilds", [seed.regInst]), "42501");
    await expectCode(rpc(client, owner.claims, "fdb_account_guildbook_members", [seed.regInst, "synthetic-guild", 100, 0]), "42501");
    for (const role of ["anon", "service_role"]) {
      await expectCode(asUser(client, owner.claims, (q) => q("select * from public.fdb_account_guildbook_guilds($1)", [seed.regInst]), { role }), "42501");
      await expectCode(asUser(client, owner.claims, (q) => q("select * from public.fdb_account_guildbook_members($1, $2, 100, 0)", [seed.regInst, "synthetic-guild"]), { role }), "42501");
    }
  });

  it("the raw tables stay closed to API roles", async () => {
    for (const t of ["installation_guilds", "installation_guild_members", "installation_guild_professions"]) {
      for (const role of ["anon", "authenticated", "service_role"]) {
        const r = (await admin.query("select has_table_privilege($1, $2, 'select,insert,update,delete,truncate') as v", [role, `public.${t}`])).rows[0].v;
        assert.equal(r, false, `${role} ${t}`);
      }
    }
  });

  it("the installation list RPC keeps working and returns only a per-installation COUNT (pinned decision: not redefined by 0018)", async () => {
    await fx.resetBudgets();
    const rows = await rpc(client, seed.registered.claims, "fdb_account_installations", []);
    const mine = rows.find((r) => r.installation_id === seed.regInst);
    assert.ok(mine);
    assert.deepEqual(Object.keys(mine).sort(), ["guild_count", "installation_id", "last_seen_at", "linked_at"]);
    assert.equal(mine.guild_count, 1);
  });
});

describe("0018 marker table and private functions", () => {
  it("guard table: exactly one 'disabled' row, RLS on, no API-role privilege, no other guard name accepted", async () => {
    const rows = (await admin.query("select guard_name from private.guildbook_cloud_sync_guard")).rows;
    assert.deepEqual(rows, [{ guard_name: "disabled" }]);
    assert.equal((await admin.query("select relrowsecurity from pg_class where oid = 'private.guildbook_cloud_sync_guard'::regclass")).rows[0].relrowsecurity, true);
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      assert.equal((await admin.query("select has_table_privilege($1, 'private.guildbook_cloud_sync_guard', 'select,insert,update,delete,truncate,references,trigger') as v", [role])).rows[0].v, false, role);
    }
    await assert.rejects(admin.query("insert into private.guildbook_cloud_sync_guard (guard_name) values ('enabled')"), (e) => e.code === "23514");
    await expectCode(asUser(client, seed.registered.claims, (q) => q("select * from private.guildbook_cloud_sync_guard")), "42501");
  });

  it("helper, wrapper and legacy body are callable by no API role", async () => {
    for (const sig of ["private.fdb_public_snapshot(jsonb)", IMPL, LEGACY]) {
      for (const role of ["public", "anon", "authenticated", "service_role"]) {
        assert.equal((await admin.query("select has_function_privilege($1, $2, 'execute') as v", [role, sig])).rows[0].v, false, `${role} ${sig}`);
      }
    }
    await expectCode(asUser(client, seed.registered.claims, (q) => q("select private.foreverdb_ingest_snapshot_impl_v1($1::jsonb)", ["{}"])), "42501");
  });

  it("the legacy body is byte-identical to the pre-0018 implementation (same owner, same config) and the wrapper sits in front of it", async () => {
    const legacy = (await admin.query("select md5(prosrc) as h, proconfig as c, pg_get_userbyid(proowner) as o from pg_proc where oid = $1::regprocedure", [LEGACY])).rows[0];
    assert.deepEqual(legacy, seed.implMd5);
    const wrapper = (await admin.query("select prosrc, prosecdef, proconfig from pg_proc where oid = $1::regprocedure", [IMPL])).rows[0];
    assert.equal(wrapper.prosecdef, true);
    assert.ok(wrapper.proconfig.includes('search_path=""'));
    assert.match(wrapper.prosrc, /foreverdb_ingest_snapshot_impl_v1_legacy\(\s*private\.fdb_public_snapshot\(p_snapshot\)\s*\)/);
    // The 0012 pre-flight pins the legacy body: re-running 0012 on top of 0018 is refused (fail closed) instead of re-granting the Guildbook RPCs.
    assert.doesNotMatch(wrapper.prosrc, /Installation belongs to another authenticated client/);
  });

  it("the projection strips exactly the Guildbook keys and keeps everything else", async () => {
    const out = (await admin.query(
      `select private.fdb_public_snapshot('{"installationId":"a","sources":[1],"guilds":[1],"guildbook":{},"guildbookCapture":"c","guildbookCaptureId":"c","guildbookCapturedAt":1,"guildbookSourceCharacter":"x","updatedAt":5}'::jsonb) as j`,
    )).rows[0].j;
    assert.deepEqual(out, { installationId: "a", sources: [1], updatedAt: 5 });
  });
});

describe("0018 refuses an unsafe starting point and a second run against a real ledger", () => {
  it("fails closed when no legacy ingest implementation exists, or when the function is not the original body (and applies nothing)", async () => {
    await cloneDatabase(DB, CLONES.refusals);
    const sub = await connect(CLONES.refusals);
    try {
      await sub.query(`drop function ${IMPL} cascade`);
      const missing = psqlFile(CLONES.refusals, MIG18);
      assert.notEqual(missing.status, 0);
      assert.match(missing.out, /legacy private ingest implementation is missing/);

      await sub.query(`create function ${IMPL.replace("(jsonb)", "(p jsonb)")} returns jsonb language sql as $$ select p $$`);
      const foreign = psqlFile(CLONES.refusals, MIG18);
      assert.notEqual(foreign.status, 0);
      assert.match(foreign.out, /legacy ingest implementation is not the expected one/);

      assert.equal((await sub.query("select to_regclass('private.guildbook_cloud_sync_guard') is null as v")).rows[0].v, true, "nothing was applied");
      assert.equal((await sub.query("select to_regprocedure($1) is null as v", [LEGACY])).rows[0].v, true, "nothing was renamed");
    } finally {
      await sub.end();
    }
  });

  it("refuses a second run when the ledger already records it", async () => {
    await cloneDatabase(DB, CLONES.ledger);
    const sub = await connect(CLONES.ledger);
    try {
      assert.equal(psqlFile(CLONES.ledger, MIG18).status, 0);
      await sub.query("insert into supabase_migrations.schema_migrations (version, name, statements) values ('20990101000000', 'disable_guildbook_cloud_sync', array['test migration runner'])");
      const again = psqlFile(CLONES.ledger, MIG18);
      assert.notEqual(again.status, 0);
      assert.match(again.out, /ledger already shows disable_guildbook_cloud_sync/);
    } finally {
      await sub.end();
    }
  });
});
