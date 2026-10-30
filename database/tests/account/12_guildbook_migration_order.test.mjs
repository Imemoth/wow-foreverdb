// Migration-order regressions for the Guildbook local-only kill switch (0018) on the RC migration set (0012, 0014, 0015; the RC has no
// account-scoped Guildbook migration). Three orders must end in the SAME final privilege state:
//   (a) 0012 -> 0014 -> 0015 -> 0018     (the order a real project is in, kill switch last)
//   (b) 0012 -> 0014 -> 0018 -> 0015
//   (c) 0012 -> 0018 -> 0014 -> 0015     (kill switch directly after 0012)
// Each order is built on a CLONE of the integration database, which is whatever the CI job layout provides (0012 only; or 0012 + 0015;
// or 0012 + 0014 + 0015). Migrations already present on the clone are skipped, the missing ones are applied in the scenario's order, so
// a layout that already contains 0015 still exercises "0014 after 0018" in (c) and "0014 then 0018" in (a)/(b). The shared database never
// receives 0018. Each clone is seeded with production-shaped Guildbook history BEFORE any scenario migration runs.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { DB, Fixtures, cloneDatabase, connect, dropDatabase, expectCode, psqlFile, repoRoot, rpc, snapshot } from "./harness.mjs";
import { instId, makeWorld } from "../enrollment/world.mjs";

const R = (...parts) => path.join(repoRoot, ...parts);
const STEPS = {
  "0012": { file: R("database/migrations/0012_account_ownership_claims.sql") },
  "0014": {
    file: R("database/migrations/0014_zero_touch_enrollment.sql"),
    present: "select to_regprocedure('public.fdb_device_ingest(text,jsonb)') is not null as v",
  },
  "0015": {
    file: R("database/migrations/0015_azerdex_welcome_outbox.sql"),
    present: "select to_regclass('private.azerdex_welcome_outbox') is not null as v",
  },
  "0018": {
    file: R("database/migrations/0018_disable_guildbook_cloud_sync.sql"),
    present: "select to_regclass('private.guildbook_cloud_sync_guard') is not null as v",
  },
};
const SCENARIOS = {
  a: ["0014", "0015", "0018"],
  b: ["0014", "0018", "0015"],
  c: ["0018", "0014", "0015"],
};
const CLONES = { a: `${DB}_gb_ord_a`, b: `${DB}_gb_ord_b`, c: `${DB}_gb_ord_c` };
const state = {};

async function guildHash(admin, inst) {
  return (await admin.query(
    `select md5(concat_ws('|',
       (select coalesce(string_agg(to_jsonb(t)::text, '|' order by to_jsonb(t)::text), '') from public.installation_guilds t where installation_id = $1),
       (select coalesce(string_agg(to_jsonb(t)::text, '|' order by to_jsonb(t)::text), '') from public.installation_guild_members t where installation_id = $1),
       (select coalesce(string_agg(to_jsonb(t)::text, '|' order by to_jsonb(t)::text), '') from public.installation_guild_professions t where installation_id = $1))) as h,
     (select count(*)::int from public.installation_guilds where installation_id = $1) as guilds,
     (select count(*)::int from public.installation_guild_members where installation_id = $1) as members`,
    [inst],
  )).rows[0];
}

async function fingerprint(admin) {
  const functions = (await admin.query(
    `select p.oid::regprocedure::text as sig, coalesce(p.proacl::text, '') as acl, md5(p.prosrc) as src,
            pg_get_userbyid(p.proowner) as owner, coalesce(p.proconfig, '{}') as config
       from pg_proc p
      where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
        and (p.proname ~* 'guildbook'
             or p.proname in ('fdb_public_snapshot', 'foreverdb_ingest_snapshot_impl_v1', 'foreverdb_ingest_snapshot_impl_v1_legacy', 'ingest_foreverdb_snapshot_auth')
             or p.proname like 'fdb\\_device\\_%' or p.proname like 'fdb\\_account\\_%')
      order by 1`,
  )).rows;
  const guard = (await admin.query("select guard_name from private.guildbook_cloud_sync_guard")).rows;
  const tableAcl = (await admin.query(
    `select c.relname, coalesce(c.relacl::text, '') as acl, c.relrowsecurity
       from pg_class c where c.oid in ('public.installation_guilds'::regclass, 'public.installation_guild_members'::regclass,
                                       'public.installation_guild_professions'::regclass, 'private.guildbook_cloud_sync_guard'::regclass)
      order by 1`,
  )).rows;
  return { functions, guard, tableAcl };
}

async function assertGuildbookRpcsClosed(admin) {
  const rows = (await admin.query(
    `select p.oid::regprocedure::text as sig,
            has_function_privilege('public', p.oid, 'execute') as pub, has_function_privilege('anon', p.oid, 'execute') as anon_x,
            has_function_privilege('authenticated', p.oid, 'execute') as auth_x, has_function_privilege('service_role', p.oid, 'execute') as svc_x
       from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname ~* 'guildbook'`,
  )).rows;
  assert.ok(rows.length >= 2, "the 0012 read pair exists");
  for (const row of rows) assert.deepEqual([row.pub, row.anon_x, row.auth_x, row.svc_x], [false, false, false, false], row.sig);
}

async function prepare(key) {
  const database = CLONES[key];
  await cloneDatabase(DB, database);
  const admin = await connect(database);
  const fx = new Fixtures(admin);
  const identity = await fx.identity({ anonymous: false, confirmed: true });
  const installation = instId();
  await fx.installation(installation, identity.uid);
  await fx.guild(installation, "synthetic-guild", [{ guid: "synthetic-member-1", name: "Synthetic Member One" }, { guid: "synthetic-member-2", name: "Synthetic Member Two" }]);
  await admin.query(
    `insert into public.installation_guild_professions (installation_id, guild_key, member_guid, skill_line_id, profession_name, skill, max_skill, source, is_secondary)
     values ($1, 'synthetic-guild', 'synthetic-member-1', 164, 'Synthetic Craft', 300, 375, 'scan', false)`,
    [installation],
  );
  const baseline = await guildHash(admin, installation);
  assert.deepEqual([baseline.guilds, baseline.members], [1, 2]);

  const applied = [];
  for (const step of SCENARIOS[key]) {
    const spec = STEPS[step];
    if ((await admin.query(spec.present)).rows[0].v) continue; // already part of the CI layout
    const result = psqlFile(database, spec.file);
    assert.equal(result.status, 0, `${key}: ${step}\n${result.out}`);
    applied.push(step);
    if (step === "0018") await assertGuildbookRpcsClosed(admin);
  }
  await assertGuildbookRpcsClosed(admin);
  assert.deepEqual(await guildHash(admin, installation), baseline, `${key}: the whole migration sequence left the Guildbook rows untouched`);
  state[key] = { database, identity, installation, baseline, applied, fingerprint: await fingerprint(admin) };
  await admin.end();
}

async function assertLegacyPathsAreObservationOnly(key) {
  const { database, identity, installation, baseline } = state[key];
  const w = await makeWorld({ database });
  try {
    const account = { ...identity, kind: "account", call: (fn, args = []) => rpc(w.client, identity.claims, fn, args) };
    const sourcesOf = async (inst) => (await w.row("select count(*)::int as n from public.installation_source_stats where installation_id = $1", [inst]))[0].n;

    // 1. registered public ingest on the pre-existing installation: Guildbook rows are the very same rows
    await w.fx.resetBudgets();
    const publicResult = await account.call("ingest_foreverdb_snapshot_auth", [snapshot(installation, { sources: 2, guilds: 4, members: 5, updatedAt: 9000 })]);
    assert.equal(publicResult.ok, true);
    assert.deepEqual(await guildHash(w.admin, installation), baseline);
    assert.ok((await sourcesOf(installation)) > 0);

    // 2. an anonymous Companion identity on a fresh installation
    const anon = await w.device();
    const freshAnon = instId();
    await w.fx.resetBudgets();
    assert.equal((await anon.call("ingest_foreverdb_snapshot_auth", [snapshot(freshAnon, { sources: 1, guilds: 2, members: 3, updatedAt: 9001 })])).ok, true);
    assert.deepEqual(((h) => [h.guilds, h.members])(await guildHash(w.admin, freshAnon)), [0, 0]);
    assert.ok((await sourcesOf(freshAnon)) > 0);

    // 3. an enrolled device (0014): existing installation, then a new one
    const enrolled = await w.enrolled(account, { installationId: installation });
    const deviceResult = await w.ingest(enrolled.device, enrolled.secret, snapshot(installation, { sources: 3, guilds: 7, members: 8, updatedAt: 9002 }));
    assert.equal(deviceResult.ok, true);
    assert.deepEqual(await guildHash(w.admin, installation), baseline);
    const fresh = instId();
    const freshEnrollment = await w.enrolled(account, { installationId: fresh });
    assert.equal((await w.ingest(freshEnrollment.device, freshEnrollment.secret, snapshot(fresh, { sources: 1, guilds: 3, members: 3, updatedAt: 9003 }))).ok, true);
    assert.deepEqual(((h) => [h.guilds, h.members])(await guildHash(w.admin, fresh)), [0, 0]);
    assert.ok((await sourcesOf(fresh)) > 0);

    // 4. the device and public entrypoint checks themselves are unchanged
    assert.deepEqual(await w.ingest(enrolled.device, "fdbd1_invalid", snapshot(installation, { sources: 1, guilds: 1, updatedAt: 9004 })), { ok: false, error: "device_unauthorized" });
    assert.deepEqual(await w.ingest(freshEnrollment.device, freshEnrollment.secret, snapshot(installation, { sources: 1, guilds: 1, updatedAt: 9005 })), { ok: false, error: "wrong_installation" });
    assert.deepEqual(await guildHash(w.admin, installation), baseline);

    // 5. no Guildbook RPC is callable by the owner
    await w.fx.resetBudgets();
    await expectCode(account.call("fdb_account_guildbook_guilds", [installation]), "42501");
    await expectCode(account.call("fdb_account_guildbook_members", [installation, "synthetic-guild", 100, 0]), "42501");
  } finally {
    await w.close();
  }
}

before(async () => {
  for (const key of Object.keys(SCENARIOS)) await prepare(key);
});

after(async () => {
  for (const name of Object.values(CLONES)) await dropDatabase(name);
});

describe("0018 migration order on the RC set", () => {
  it("(a) 0012 -> 0014 -> 0015 -> 0018: closed RPCs, wrapper over the retained legacy body", async () => {
    assert.ok(state.a.applied.includes("0018"));
    const rows = state.a.fingerprint.functions;
    const impl = rows.find((r) => r.sig.endsWith("foreverdb_ingest_snapshot_impl_v1(jsonb)"));
    const legacy = rows.find((r) => r.sig.endsWith("foreverdb_ingest_snapshot_impl_v1_legacy(jsonb)"));
    assert.ok(impl && legacy && impl.src !== legacy.src);
    assert.deepEqual(state.a.fingerprint.guard, [{ guard_name: "disabled" }]);
  });

  it("(a) re-applying 0014, 0015 and 0018 is idempotent and re-opens nothing; re-applying 0012 is refused (it pins the legacy ingest body)", async () => {
    const before = state.a.fingerprint;
    for (const step of ["0014", "0015", "0018"]) {
      const again = psqlFile(CLONES.a, STEPS[step].file);
      assert.equal(again.status, 0, `${step}: ${again.out}`);
    }
    let admin = await connect(CLONES.a);
    try {
      assert.deepEqual(await fingerprint(admin), before);
      await assertGuildbookRpcsClosed(admin);
    } finally {
      await admin.end();
    }
    const rerun12 = psqlFile(CLONES.a, STEPS["0012"].file);
    assert.notEqual(rerun12.status, 0, "a re-run of 0012 would re-grant the Guildbook read RPCs");
    assert.match(rerun12.out, /ingest no longer takes the shared advisory lock/);
    admin = await connect(CLONES.a);
    try {
      assert.deepEqual(await fingerprint(admin), before, "the refused 0012 re-run changed nothing");
    } finally {
      await admin.end();
    }
  });

  it("(a) legacy public, anonymous and enrolled-device ingest are observation-only; existing Guildbook rows are preserved", async () => {
    await assertLegacyPathsAreObservationOnly("a");
  });

  it("(b) 0012 -> 0014 -> 0018 -> 0015: same behaviour", async () => {
    assert.ok(state.b.applied.includes("0018"));
    await assertLegacyPathsAreObservationOnly("b");
  });

  it("(c) 0012 -> 0018 -> 0014 -> 0015: same behaviour (0014 and 0015 are applied on top of the wrapper)", async () => {
    assert.ok(state.c.applied.includes("0018"));
    await assertLegacyPathsAreObservationOnly("c");
  });

  it("all three orders end in the same privilege state (function ACLs, bodies, owners, configs; table ACLs; guard row)", () => {
    assert.deepEqual(state.b.fingerprint, state.a.fingerprint);
    assert.deepEqual(state.c.fingerprint, state.a.fingerprint);
  });
});
