// Ledger-backed rollback and restoration (migration-history semantics). The databases here carry a realistic
// supabase_migrations.schema_migrations ledger (04_migration_ledger.sql). The ledger is only ever APPENDED to:
//   0012 applied + recorded -> full rollback (ledger keeps 0012) -> record rollback -> restore migration 0013 -> record restore.
// Re-running 0012 while its ledger entry exists is refused by its (unchanged) pre-flight.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { DB, Fixtures, cloneDatabase, connect, connectSuper, dropDatabase, expectCode, psqlFile, repoRoot, rpc, snapshot, uniq } from "./harness.mjs";

const R = (...p) => path.join(repoRoot, ...p);
const MIGRATION = R("database/migrations/0012_account_ownership_claims.sql");
const ROLLBACK = R("database/rollback/0012_rollback.sql");
const KILL = R("database/rollback/0012_kill_switch.sql");
const KILL_RESTORE = R("database/rollback/0012_kill_switch_restore.sql");
const RESTORE = R("database/restore/0013_account_ownership_claims_restore.sql");
const LEDGER = R("database/ops/0012_record_migration_ledger.sql");
const CLONES = { A: `${DB}_lga`, B: `${DB}_lgb` };

const NINE = [
  "public.fdb_account_claim_start(text)", "public.fdb_account_claim_redeem(text)", "public.fdb_installation_link_status(text)",
  "public.fdb_account_installations()", "public.fdb_account_guildbook_guilds(text)", "public.fdb_account_guildbook_members(text,text,integer,integer)",
  "private.fdb_caller()", "private.fdb_anonymous_caller()", "private.fdb_registered_caller()",
];

const ledgerRows = async (admin) => (await admin.query("select version, name, statements from supabase_migrations.schema_migrations order by version")).rows;
const record = (db, name) => psqlFile(db, LEDGER, { name });

async function srcHashes(admin) {
  const r = await admin.query(`select p.oid::regprocedure::text sig, md5(p.prosrc) h from pg_proc p where p.oid = any($1::regprocedure[])`, [NINE]);
  return Object.fromEntries(r.rows.map((x) => [x.sig, x.h]));
}

async function assertFeatureRestored(admin, expectedHashes) {
  for (const sig of NINE) {
    const p = (await admin.query("select prosecdef, provolatile, proconfig, pg_get_userbyid(proowner) o from pg_proc where oid = $1::regprocedure", [sig])).rows[0];
    assert.ok(p, `${sig} exists`);
    assert.equal(p.prosecdef, true);
    assert.equal(p.provolatile, "v");
    assert.equal(p.o, "fdb_migrator");
    assert.ok(p.proconfig.includes('search_path=""'));
    const priv = async (role) => (await admin.query("select has_function_privilege($1, $2, 'execute') v", [role, sig])).rows[0].v;
    for (const role of ["public", "anon", "service_role"]) assert.equal(await priv(role), false, `${sig} ${role}`);
    assert.equal(await priv("authenticated"), !sig.startsWith("private."), `${sig} authenticated`);
    if (!sig.startsWith("private.")) assert.ok(p.proconfig.some((c) => c.startsWith("lock_timeout=5s")));
  }
  assert.deepEqual(await srcHashes(admin), expectedHashes, "restored function bodies are byte-identical to 0012's");
  for (const t of ["installation_claims", "account_installations", "account_audit"]) {
    assert.equal((await admin.query("select relrowsecurity from pg_class where oid = $1::regclass", [`private.${t}`])).rows[0].relrowsecurity, true);
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      assert.equal((await admin.query("select has_table_privilege($1, $2, 'select,insert,update,delete') v", [role, `private.${t}`])).rows[0].v, false, `${t} ${role}`);
    }
  }
}

async function world(db) {
  const admin = await connect(db);
  const client = await connect(db);
  return { admin, client, fx: new Fixtures(admin), close: async () => { await client.end(); await admin.end(); } };
}

const dataHash = async (admin, inst) => (await admin.query(
  `select md5(concat_ws('|',
     (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.installation_item_stats t where installation_id = $1),
     (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.installation_source_stats t where installation_id = $1),
     (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.installation_location_stats t where installation_id = $1),
     (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.installation_guilds t where installation_id = $1),
     (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.installation_guild_members t where installation_id = $1),
     (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.installation_guild_professions t where installation_id = $1))) h`, [inst])).rows[0].h;

const fullState = async (admin, insts) => {
  const q = async (sql, p = []) => (await admin.query(sql, p)).rows;
  return {
    owners: await q("select id, owner_user_id from public.installations order by id"),
    data: Object.fromEntries(await Promise.all(insts.map(async (i) => [i, await dataHash(admin, i)]))),
    links: await q("select * from private.account_installations order by installation_id"),
    claims: await q("select * from private.installation_claims order by id"),
    audit: await q("select * from private.account_audit order by id"),
  };
};

const hashesFromSource = async () => {
  const admin = await connect(DB);
  try {
    return await srcHashes(admin);
  } finally {
    await admin.end();
  }
};

describe("Scenario A: no ownership transfers", () => {
  let w;
  let expected;
  const events = {};
  before(async () => {
    expected = await hashesFromSource();
    await cloneDatabase(DB, CLONES.A);
    const sup = await connectSuper(CLONES.A);
    await sup.query("truncate private.account_installations, private.installation_claims, private.account_audit");
    await sup.end();
    w = await world(CLONES.A);
  });
  after(async () => {
    await w.close();
    await dropDatabase(CLONES.A);
  });

  it("recording 0012 in the ledger works once, in order; duplicates and out-of-order steps are refused", async () => {
    const before = await ledgerRows(w.admin);
    assert.equal(record(CLONES.A, "account_ownership_claims_restore").status !== 0, true, "restore cannot be recorded before the rollback");
    assert.equal(record(CLONES.A, "rollback_account_ownership_claims").status !== 0, true, "rollback cannot be recorded before 0012");
    assert.equal(record(CLONES.A, "nonsense").status !== 0, true);
    const ok = record(CLONES.A, "account_ownership_claims");
    assert.equal(ok.status, 0, ok.out);
    assert.notEqual(record(CLONES.A, "account_ownership_claims").status, 0, "duplicate refused");
    const after = await ledgerRows(w.admin);
    assert.deepEqual(after.slice(0, before.length), before, "existing entries untouched");
    assert.deepEqual(after.slice(before.length).map((r) => r.name), ["account_ownership_claims"]);
  });

  it("re-running the ORIGINAL 0012 while its ledger entry is present is refused by its pre-flight, and applies nothing", async () => {
    const before = await srcHashes(w.admin);
    const r = psqlFile(CLONES.A, MIGRATION);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /ledger already shows account_ownership_claims/);
    assert.deepEqual(await srcHashes(w.admin), before);
  });

  it("the restoration migration refuses to run while the feature still exists (nothing to restore)", async () => {
    const r = psqlFile(CLONES.A, RESTORE);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /rollback_account_ownership_claims|still exists/);
  });

  it("full rollback: functions and the EMPTY private tables are dropped; the 0012 ledger entry remains; installations untouched", async () => {
    const ledger = await ledgerRows(w.admin);
    const owners = (await w.admin.query("select md5(string_agg(id || coalesce(owner_user_id::text, ''), ',' order by id)) h from public.installations")).rows[0].h;
    const r = psqlFile(CLONES.A, ROLLBACK);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /private tables were empty and have been dropped/);
    for (const sig of NINE) assert.equal((await w.admin.query("select to_regprocedure($1) r", [sig])).rows[0].r, null, sig);
    for (const t of ["installation_claims", "account_installations", "account_audit"]) assert.equal((await w.admin.query("select to_regclass($1) r", [`private.${t}`])).rows[0].r, null);
    assert.deepEqual(await ledgerRows(w.admin), ledger, "the rollback script does not touch the ledger");
    assert.equal((await w.admin.query("select md5(string_agg(id || coalesce(owner_user_id::text, ''), ',' order by id)) h from public.installations")).rows[0].h, owners);
  });

  it("restoration is refused until the rollback is recorded, and refused for partially present private tables", async () => {
    let r = psqlFile(CLONES.A, RESTORE);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /ledger does not show rollback_account_ownership_claims/);
    const sup = await connectSuper(CLONES.A);
    await sup.query("create table private.account_audit (id int)");
    assert.equal(record(CLONES.A, "rollback_account_ownership_claims").status, 0);
    r = psqlFile(CLONES.A, RESTORE);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /partially present/);
    await sup.query("drop table private.account_audit");
    await sup.end();
  });

  it("restores through 0013: nine functions with identical bodies and ACLs, empty private tables; ledger only appended; then the feature works", async () => {
    const ledger = await ledgerRows(w.admin);
    const r = psqlFile(CLONES.A, RESTORE);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(await ledgerRows(w.admin), ledger, "0013 never writes the ledger itself");
    assert.equal(record(CLONES.A, "account_ownership_claims_restore").status, 0);
    assert.deepEqual((await ledgerRows(w.admin)).map((x) => x.name).slice(-3), ["account_ownership_claims", "rollback_account_ownership_claims", "account_ownership_claims_restore"]);
    await assertFeatureRestored(w.admin, expected);
    for (const t of ["installation_claims", "account_installations", "account_audit"]) assert.equal((await w.admin.query(`select count(*)::int n from private.${t}`)).rows[0].n, 0, `private.${t} must be empty after restore`);

    const owner = await w.fx.identity({ anonymous: true });
    const reg = await w.fx.identity();
    const inst = uniq("restored-a");
    await w.fx.installation(inst, owner.uid);
    await w.fx.resetBudgets();
    const { code } = await rpc(w.client, owner.claims, "fdb_account_claim_start", [inst]);
    assert.equal((await rpc(w.client, reg.claims, "fdb_account_claim_redeem", [code])).ok, true);
    assert.deepEqual(await rpc(w.client, owner.claims, "fdb_installation_link_status", [inst]), { state: "transferred" });
    await expectCode(rpc(w.client, (await w.fx.identity({ confirmed: false })).claims, "fdb_account_installations"), "PT403");
    events.restored = true;
  });

  it("a second restore is refused (ledger and live objects)", () => {
    const r = psqlFile(CLONES.A, RESTORE);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /account_ownership_claims_restore|still exists/);
  });

  it("the ledger history is append-only across the whole scenario: the original entries are unchanged, exactly three account entries exist", async () => {
    const rows = await ledgerRows(w.admin);
    assert.deepEqual(rows.filter((x) => /account_ownership_claims/.test(x.name)).map((x) => x.name), ["account_ownership_claims", "rollback_account_ownership_claims", "account_ownership_claims_restore"]);
    assert.ok(rows.some((x) => x.name === "fix_observed_drop_rate_denominator" && x.version === "20261010151518"));
  });
});

describe("Scenario B: existing ownership transfers (tables retained; nothing lost)", () => {
  let w;
  let expected;
  let t;
  before(async () => {
    expected = await hashesFromSource();
    await cloneDatabase(DB, CLONES.B);
    w = await world(CLONES.B);
    await w.fx.resetBudgets();
    // real transfers through the authenticated RPCs, with real ingested history and Guildbook rows
    t = [];
    const reg = await w.fx.identity();
    for (let i = 0; i < 2; i += 1) {
      const owner = await w.fx.identity({ anonymous: true });
      const inst = uniq("lg-b");
      await rpc(w.client, owner.claims, "ingest_foreverdb_snapshot_auth", [snapshot(inst, { updatedAt: 1000, sources: 2 + i, guilds: 2, members: 4 })]);
      const { code } = await rpc(w.client, owner.claims, "fdb_account_claim_start", [inst]);
      assert.equal((await rpc(w.client, reg.claims, "fdb_account_claim_redeem", [code])).ok, true);
      t.push({ owner, inst });
    }
    // a still-pending claim and an untransferred installation, so claims/audit hold more than redeemed rows
    const pendingOwner = await w.fx.identity({ anonymous: true });
    const pendingInst = uniq("lg-b-pending");
    await rpc(w.client, pendingOwner.claims, "ingest_foreverdb_snapshot_auth", [snapshot(pendingInst, { updatedAt: 1000 })]);
    await rpc(w.client, pendingOwner.claims, "fdb_account_claim_start", [pendingInst]);
    t.reg = reg;
    t.pending = { owner: pendingOwner, inst: pendingInst };
  });
  after(async () => {
    await w.close();
    await dropDatabase(CLONES.B);
  });

  it("record 0012; rollback with transfers present RETAINS the private tables and changes no ownership, observation, Guildbook row, provenance or audit record", async () => {
    assert.equal(record(CLONES.B, "account_ownership_claims").status, 0);
    const insts = [t[0].inst, t[1].inst, t.pending.inst];
    const before = await fullState(w.admin, insts);
    assert.equal(before.links.length >= 2, true);
    const ledger = await ledgerRows(w.admin);
    const r = psqlFile(CLONES.B, ROLLBACK);
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /private tables RETAINED/);
    assert.deepEqual(await ledgerRows(w.admin), ledger);
    for (const sig of NINE) assert.equal((await w.admin.query("select to_regprocedure($1) r", [sig])).rows[0].r, null);
    assert.deepEqual(await fullState(w.admin, insts), before, "owners, data hashes, links, claims, audit identical after the rollback");
    assert.equal(await w.fx.owner(t[0].inst), t.reg.uid, "ownership never reversed");
    t.before = before;
  });

  it("the original 0012 is refused while its ledger entry exists; restoration is refused until the rollback is recorded", () => {
    let r = psqlFile(CLONES.B, MIGRATION);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /ledger already shows account_ownership_claims/);
    r = psqlFile(CLONES.B, RESTORE);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /ledger does not show rollback_account_ownership_claims/);
  });

  it("while rolled back the account API is gone but existing ingest still works for the registered owner and is closed to the former owner", async () => {
    await w.fx.resetBudgets();
    await expectCode(rpc(w.client, t.reg.claims, "fdb_account_installations"), "42883");
    assert.equal((await rpc(w.client, t.reg.claims, "ingest_foreverdb_snapshot_auth", [snapshot(t[0].inst, { updatedAt: 1000, sources: 2, guilds: 2, members: 4 })])).ok, true);
    await assert.rejects(rpc(w.client, t[0].owner.claims, "ingest_foreverdb_snapshot_auth", [snapshot(t[0].inst, { updatedAt: 9999 })]), /belongs to another/);
  });

  it("record the rollback, restore through 0013, record the restore: objects, ACLs and bodies identical; all rows and hashes identical", async () => {
    assert.equal(record(CLONES.B, "rollback_account_ownership_claims").status, 0);
    const insts = [t[0].inst, t[1].inst, t.pending.inst];
    const before = await fullState(w.admin, insts);
    const r = psqlFile(CLONES.B, RESTORE);
    assert.equal(r.status, 0, r.out);
    assert.equal(record(CLONES.B, "account_ownership_claims_restore").status, 0);
    await assertFeatureRestored(w.admin, expected);
    const after = await fullState(w.admin, insts);
    // the ingest performed while rolled back refreshed the registered owner's rows (same snapshot), so compare owners/links/claims/audit exactly
    assert.deepEqual(after.owners, before.owners);
    assert.deepEqual(after.links, before.links);
    assert.deepEqual(after.claims, before.claims);
    assert.deepEqual(after.audit, before.audit);
    assert.deepEqual(after.links, t.before.links, "provenance identical to the state before the rollback");
    assert.deepEqual(after.audit, t.before.audit, "audit identical to the state before the rollback");
    assert.equal(after.data[t.pending.inst], t.before.data[t.pending.inst]);
    assert.equal(after.data[t[1].inst], t.before.data[t[1].inst], "untouched installations: data hashes identical to the pre-rollback snapshot");
  });

  it("after restoration: authorization, Guildbook, ingest and claim operations work again", async () => {
    await w.fx.resetBudgets();
    assert.deepEqual(await rpc(w.client, t[0].owner.claims, "fdb_installation_link_status", [t[0].inst]), { state: "transferred" });
    assert.deepEqual(await rpc(w.client, t.reg.claims, "fdb_installation_link_status", [t[0].inst]), { state: "owned" });
    const mine = await rpc(w.client, t.reg.claims, "fdb_account_installations");
    assert.deepEqual(mine.map((r) => r.installation_id).sort(), [t[0].inst, t[1].inst].sort());
    const guilds = await rpc(w.client, t.reg.claims, "fdb_account_guildbook_guilds", [t[0].inst]);
    assert.equal(guilds.length, 2);
    assert.equal((await rpc(w.client, t.reg.claims, "fdb_account_guildbook_members", [t[0].inst, guilds[0].guild_key, 200, 0])).length, 4);
    assert.deepEqual(await rpc(w.client, (await w.fx.identity()).claims, "fdb_account_guildbook_guilds", [t[0].inst]), [], "unrelated account sees nothing");
    assert.equal((await rpc(w.client, t.reg.claims, "ingest_foreverdb_snapshot_auth", [snapshot(t[1].inst, { updatedAt: 5000, sources: 3, guilds: 2, members: 4 })])).ok, true);
    await assert.rejects(rpc(w.client, t[1].owner.claims, "ingest_foreverdb_snapshot_auth", [snapshot(t[1].inst, { updatedAt: 9999 })]), /belongs to another/);
    // the claim that was pending before the rollback survived (retained table) but its code is only in the hash: a NEW claim works
    const { code } = await rpc(w.client, t.pending.owner.claims, "fdb_account_claim_start", [t.pending.inst]);
    assert.equal((await rpc(w.client, t.reg.claims, "fdb_account_claim_redeem", [code])).ok, true);
    assert.equal(await w.fx.owner(t.pending.inst), t.reg.uid);
  });

  it("the kill switch and its restore are a SEPARATE procedure: no ledger entry, nothing dropped, objects intact", async () => {
    const ledger = await ledgerRows(w.admin);
    assert.equal(psqlFile(CLONES.B, KILL).status, 0);
    await w.fx.resetBudgets();
    await expectCode(rpc(w.client, t.reg.claims, "fdb_account_installations"), "42501");
    for (const sig of NINE) assert.notEqual((await w.admin.query("select to_regprocedure($1) r", [sig])).rows[0].r, null);
    assert.equal(psqlFile(CLONES.B, KILL_RESTORE).status, 0);
    assert.ok((await rpc(w.client, t.reg.claims, "fdb_account_installations")).length >= 2);
    assert.deepEqual(await ledgerRows(w.admin), ledger, "no ledger change for a kill switch");
    // and the restoration migration refuses to run over a live feature
    assert.notEqual(psqlFile(CLONES.B, RESTORE).status, 0);
  });

  it("historical migration-ledger entries were never deleted or rewritten", async () => {
    const rows = await ledgerRows(w.admin);
    assert.deepEqual(rows.slice(0, 3).map((x) => x.name), ["restrict_legacy_public_stats", "api_security_rate_limits", "fix_observed_drop_rate_denominator"]);
    assert.deepEqual(rows.filter((x) => /account_ownership_claims/.test(x.name)).map((x) => x.name), ["account_ownership_claims", "rollback_account_ownership_claims", "account_ownership_claims_restore"]);
  });
});
