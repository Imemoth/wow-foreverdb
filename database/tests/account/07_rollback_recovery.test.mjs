// Rollback and incident-recovery REHEARSAL on isolated clones of the integration database (clones are dropped at the end).
// Rehearses: kill switch, safe rollback (tables retained / dropped), forward re-apply, operator-approved ownership recovery with its
// refusals, and pruning. Nothing here ever moves ownership automatically or deletes observations.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { DB, HOST, PORT, Fixtures, connect, connectSuper, expectCode, repoRoot, rpc, snapshot, uniq } from "./harness.mjs";

const ROLLBACK = (f) => path.join(repoRoot, "database/rollback", f);
const MIGRATION = path.join(repoRoot, "database/migrations/0012_account_ownership_claims.sql");
const PRUNE = path.join(repoRoot, "database/ops/0012_prune_account_claims.sql");
const CLONES = [`${DB}_rb1`, `${DB}_rb2`];

function psql(db, file, vars = {}) {
  const args = ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-h", HOST, "-p", String(PORT), "-U", "fdb_migrator", "-d", db, "-f", file, ...Object.entries(vars).flatMap(([k, v]) => ["-v", `${k}=${v}`])];
  const r = spawnSync("psql", args, { env: { ...process.env, PGPASSWORD: "local-test-password" }, encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

async function cloneDatabase(source, target) {
  const sup = await connectSuper("postgres");
  try {
    await sup.query(`drop database if exists ${target} with (force)`);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await sup.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()", [source]);
      try {
        await sup.query(`create database ${target} template ${source}`);
        return;
      } catch (error) {
        if (!/being accessed by other users/.test(error.message)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    throw new Error("could not clone the template database");
  } finally {
    await sup.end();
  }
}

after(async () => {
  const sup = await connectSuper("postgres");
  for (const c of CLONES) await sup.query(`drop database if exists ${c} with (force)`);
  await sup.end();
});

async function world(db) {
  const admin = await connect(db);
  const client = await connect(db);
  const fx = new Fixtures(admin);
  return { admin, client, fx, close: async () => { await client.end(); await admin.end(); } };
}

const dataHash = async (admin, inst) => (await admin.query(
  `select md5(concat_ws('|',
     (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.installation_item_stats t where installation_id = $1),
     (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.installation_source_stats t where installation_id = $1),
     (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.installation_location_stats t where installation_id = $1),
     (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.installation_guild_members t where installation_id = $1),
     (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.installation_guild_professions t where installation_id = $1))) h`, [inst])).rows[0].h;
const allOwners = async (admin) => (await admin.query("select md5(coalesce(string_agg(id || ':' || coalesce(owner_user_id::text, ''), ',' order by id), '')) h, count(*)::int n from public.installations")).rows[0];

async function transferred(w) {
  // anonymous Companion owner with real ingested data -> claim -> registered account
  const owner = await w.fx.identity({ anonymous: true });
  const reg = await w.fx.identity();
  const inst = uniq("rb");
  await w.fx.resetBudgets();
  await rpc(w.client, owner.claims, "ingest_foreverdb_snapshot_auth", [snapshot(inst, { updatedAt: 1000 })]);
  const { code } = await rpc(w.client, owner.claims, "fdb_account_claim_start", [inst]);
  const out = await rpc(w.client, reg.claims, "fdb_account_claim_redeem", [code]);
  assert.equal(out.ok, true);
  return { owner, reg, inst };
}

describe("kill switch, rollback with transfers present, re-apply, recovery, prune (clone 1: tables hold transfers)", async () => {
  let w;
  let t;
  before(async () => {
    await cloneDatabase(DB, CLONES[0]);
    w = await world(CLONES[0]);
    t = await transferred(w);
  });
  after(() => w.close());

  it("kill switch: every account RPC stops for clients; ownership, link rows and data are untouched; ingest keeps working; restore re-enables", async () => {
    const owners = await allOwners(w.admin);
    const hash = await dataHash(w.admin, t.inst);
    const counts = async () => (await w.admin.query("select (select count(*) from private.installation_claims)::int c, (select count(*) from private.account_installations)::int l, (select count(*) from private.account_audit)::int a")).rows[0];
    const before = await counts();

    const ks = psql(CLONES[0], ROLLBACK("0012_kill_switch.sql"));
    assert.equal(ks.status, 0, ks.out);
    await w.fx.resetBudgets();
    for (const [fn, args] of [["fdb_account_claim_start", [t.inst]], ["fdb_account_claim_redeem", ["A".repeat(32)]], ["fdb_installation_link_status", [t.inst]], ["fdb_account_installations", []], ["fdb_account_guildbook_guilds", [t.inst]], ["fdb_account_guildbook_members", [t.inst, "Realm:Guild1", 10, 0]]]) {
      await expectCode(rpc(w.client, t.reg.claims, fn, args), "42501");
    }
    assert.deepEqual(await allOwners(w.admin), owners);
    assert.equal(await dataHash(w.admin, t.inst), hash);
    assert.deepEqual(await counts(), before);
    // existing features still work: the registered owner ingests, search works
    const ing = await rpc(w.client, t.reg.claims, "ingest_foreverdb_snapshot_auth", [snapshot(t.inst, { updatedAt: 2000 })]);
    assert.equal(ing.ok, true);
    assert.ok(Array.isArray(await rpc(w.client, t.reg.claims, "get_foreverdb_search_global", ["Item"])));

    const restore = psql(CLONES[0], ROLLBACK("0012_kill_switch_restore.sql"));
    assert.equal(restore.status, 0, restore.out);
    assert.deepEqual(await rpc(w.client, t.reg.claims, "fdb_installation_link_status", [t.inst]), { state: "owned" });
  });

  it("full rollback with a transfer present: functions removed, private tables RETAINED, ownership and every row unchanged", async () => {
    const owners = await allOwners(w.admin);
    const hash = await dataHash(w.admin, t.inst);
    const rb = psql(CLONES[0], ROLLBACK("0012_rollback.sql"));
    assert.equal(rb.status, 0, rb.out);
    assert.match(rb.out, /private tables RETAINED/);
    const fns = await w.admin.query("select count(*)::int n from pg_proc where proname ~ '^fdb_(account|installation|caller|anonymous|registered)'");
    assert.equal(fns.rows[0].n, 0);
    assert.equal((await w.admin.query("select count(*)::int n from private.account_installations where installation_id = $1", [t.inst])).rows[0].n, 1, "link row retained");
    assert.deepEqual(await allOwners(w.admin), owners);
    assert.equal(await dataHash(w.admin, t.inst), hash);
    assert.equal(await w.fx.owner(t.inst), t.reg.uid, "the registered account still owns the installation (never auto-reversed)");
    await w.fx.resetBudgets();
    assert.equal((await rpc(w.client, t.reg.claims, "ingest_foreverdb_snapshot_auth", [snapshot(t.inst, { updatedAt: 3000 })])).ok, true);
    await expectCode(rpc(w.client, t.owner.claims, "ingest_foreverdb_snapshot_auth", [snapshot(t.inst, { updatedAt: 4000 })]), "P0001");
  });

  it("forward re-apply after a rollback is safe and reconnects to the retained provenance", async () => {
    const re = psql(CLONES[0], MIGRATION);
    assert.equal(re.status, 0, re.out);
    await w.fx.resetBudgets();
    assert.deepEqual(await rpc(w.client, t.owner.claims, "fdb_installation_link_status", [t.inst]), { state: "transferred" });
    assert.deepEqual(await rpc(w.client, t.reg.claims, "fdb_installation_link_status", [t.inst]), { state: "owned" });
    assert.ok((await rpc(w.client, t.reg.claims, "fdb_account_installations")).some((r) => r.installation_id === t.inst));
  });

  it("recovery refuses unsafe requests and changes nothing", async () => {
    const stranger = await w.fx.identity();
    const unclaimed = uniq("rb-unclaimed");
    await w.fx.installation(unclaimed, (await w.fx.identity({ anonymous: true })).uid);
    const base = { installation_id: t.inst, expected_account_uid: t.reg.uid, operator: "ops-test", approval_ref: "TEST-1" };
    const owners = await allOwners(w.admin);
    const linkCount = async () => (await w.admin.query("select count(*)::int n from private.account_installations")).rows[0].n;
    const links = await linkCount();
    const cases = [
      [{ ...base, expected_account_uid: stranger.uid }, /do not all agree/],
      [{ ...base, installation_id: unclaimed }, /no link row/],
      [{ ...base, installation_id: "no-such-installation" }, /no link row/],
      [{ ...base, installation_id: "bad id'; drop table x;--" }, /malformed/],
      [{ ...base, operator: "x" }, /malformed/],
      [{ ...base, approval_ref: "" }, /malformed/],
      [{ ...base, expected_account_uid: "not-a-uuid" }, /malformed/],
    ];
    for (const [vars, pattern] of cases) {
      const r = psql(CLONES[0], ROLLBACK("0012_recovery_restore_owner.sql"), vars);
      assert.notEqual(r.status, 0, `expected refusal for ${JSON.stringify(vars)}`);
      assert.match(r.out, pattern);
    }
    // previous owner deleted -> refuse
    const deadOwner = await transferred(w);
    await w.admin.query("delete from auth.users where id = $1", [deadOwner.owner.uid]);
    const r = psql(CLONES[0], ROLLBACK("0012_recovery_restore_owner.sql"), { ...base, installation_id: deadOwner.inst, expected_account_uid: deadOwner.reg.uid });
    assert.notEqual(r.status, 0);
    assert.match(r.out, /no longer exists as an active anonymous user/);
    assert.equal(await w.fx.owner(deadOwner.inst), deadOwner.reg.uid);
    // missing variables
    assert.notEqual(psql(CLONES[0], ROLLBACK("0012_recovery_restore_owner.sql"), { installation_id: t.inst }).status, 0);
    assert.equal(await linkCount() - links, 1, `links added during this test (only the dead-owner fixture)`);
    assert.equal((await allOwners(w.admin)).n, owners.n + 1, "only the dead-owner fixture installation was added");
    assert.equal(await w.fx.owner(t.inst), t.reg.uid);
  });

  it("operator-approved recovery restores the previous owner, audits it, deletes the link, and proves no historical row changed", async () => {
    const hash = await dataHash(w.admin, t.inst);
    const claimBefore = (await w.fx.claimRows(t.inst)).map((c) => c.status);
    const ok = psql(CLONES[0], ROLLBACK("0012_recovery_restore_owner.sql"), {
      installation_id: t.inst, expected_account_uid: t.reg.uid, operator: "Test Operator", approval_ref: "INC-2026-001 owner approved",
    });
    assert.equal(ok.status, 0, ok.out);
    assert.match(ok.out, /recovery done/);
    assert.equal(await w.fx.owner(t.inst), t.owner.uid, "restored to the previous (anonymous) owner");
    assert.equal((await w.admin.query("select count(*)::int n from private.account_installations where installation_id = $1", [t.inst])).rows[0].n, 0, "link removed");
    assert.deepEqual((await w.fx.claimRows(t.inst)).map((c) => c.status), claimBefore, "the claim row stays as history");
    assert.equal(await dataHash(w.admin, t.inst), hash, "observations, items, locations, Guildbook untouched");
    const audit = (await w.admin.query("select event, account_uid, detail from private.account_audit where installation_id = $1 and event = 'ownership_restored'", [t.inst])).rows;
    assert.equal(audit.length, 1);
    assert.equal(audit[0].account_uid, t.reg.uid);
    assert.match(audit[0].detail, /operator=Test Operator; approval=INC-2026-001 owner approved/);
    // behaviour after recovery
    await w.fx.resetBudgets();
    assert.deepEqual(await rpc(w.client, t.owner.claims, "fdb_installation_link_status", [t.inst]), { state: "owned" });
    assert.deepEqual(await rpc(w.client, t.reg.claims, "fdb_installation_link_status", [t.inst]), { state: "unknown" });
    assert.ok(!(await rpc(w.client, t.reg.claims, "fdb_account_installations")).some((r) => r.installation_id === t.inst));
    assert.deepEqual(await rpc(w.client, t.reg.claims, "fdb_account_guildbook_guilds", [t.inst]), []);
    assert.equal((await rpc(w.client, t.owner.claims, "ingest_foreverdb_snapshot_auth", [snapshot(t.inst, { updatedAt: 5000 })])).ok, true);
    await assert.rejects(rpc(w.client, t.reg.claims, "ingest_foreverdb_snapshot_auth", [snapshot(t.inst, { updatedAt: 6000 })]), /belongs to another/);
    // and the installation can be claimed again (clean state machine)
    const { code } = await rpc(w.client, t.owner.claims, "fdb_account_claim_start", [t.inst]);
    assert.equal((await rpc(w.client, t.reg.claims, "fdb_account_claim_redeem", [code])).ok, true);
  });

  it("recovery cannot be replayed once the link is gone, and a mismatched concurrent state is refused", async () => {
    const t2 = await transferred(w);
    const vars = { installation_id: t2.inst, expected_account_uid: t2.reg.uid, operator: "Test Operator", approval_ref: "INC-2" };
    assert.equal(psql(CLONES[0], ROLLBACK("0012_recovery_restore_owner.sql"), vars).status, 0);
    const again = psql(CLONES[0], ROLLBACK("0012_recovery_restore_owner.sql"), vars);
    assert.notEqual(again.status, 0);
    assert.match(again.out, /no link row/);
  });

  it("pruning deletes old revoked/expired-pending claims and old audit rows, never a consumed claim", async () => {
    const o1 = await w.fx.identity({ anonymous: true });
    const inst = uniq("prune");
    await w.fx.installation(inst, o1.uid);
    await w.fx.resetBudgets();
    await rpc(w.client, o1.claims, "fdb_account_claim_start", [inst]);
    await rpc(w.client, o1.claims, "fdb_account_claim_start", [inst]); // first is now revoked
    await w.admin.query("update private.installation_claims set created_at = now() - interval '8 days', expires_at = now() - interval '8 days' where installation_id = $1", [inst]);
    const consumedBefore = (await w.admin.query("select count(*)::int n from private.installation_claims where status = 'consumed'")).rows[0].n;
    await w.admin.query("update private.account_audit set at = now() - interval '200 days' where installation_id = $1", [inst]);
    // an old pending claim that a (stale) link row references must be skipped, not abort the whole run
    const o2 = await w.fx.identity({ anonymous: true });
    const inst2 = uniq("prune-linked");
    await w.fx.installation(inst2, o2.uid);
    await rpc(w.client, o2.claims, "fdb_account_claim_start", [inst2]);
    const linkedClaim = (await w.fx.claimRows(inst2))[0];
    await w.admin.query("insert into private.account_installations (installation_id, account_uid, claim_id, previous_owner_uid) values ($1, $2, $3, $4)", [inst2, (await w.fx.identity()).uid, linkedClaim.id, o2.uid]);
    await w.admin.query("update private.installation_claims set created_at = now() - interval '8 days', expires_at = now() - interval '8 days' where id = $1", [linkedClaim.id]);
    const r = psql(CLONES[0], PRUNE);
    assert.equal(r.status, 0, r.out);
    assert.equal((await w.fx.claimRows(inst2)).length, 1, "a claim referenced by a link row is never pruned");
    assert.equal((await w.fx.claimRows(inst)).length, 0, "revoked and expired-pending claims removed");
    assert.equal((await w.admin.query("select count(*)::int n from private.installation_claims where status = 'consumed'")).rows[0].n, consumedBefore, "consumed claims are never pruned");
    assert.equal((await w.fx.audit(inst)).length, 0, "old audit rows removed");
    assert.ok((await w.admin.query("select count(*)::int n from private.account_installations")).rows[0].n >= 1, "link rows untouched");
  });
});

describe("rollback on a database with no transfers (clone 2): private tables are dropped; forward re-apply restores them", async () => {
  let w;
  before(async () => {
    await cloneDatabase(DB, CLONES[1]);
    const sup = await connectSuper(CLONES[1]);
    await sup.query("truncate private.account_installations, private.installation_claims, private.account_audit");
    await sup.end();
    w = await world(CLONES[1]);
  });
  after(() => w.close());

  it("rollback drops functions and the empty tables, changes no ownership and no data; re-apply recreates everything", async () => {
    const owners = await allOwners(w.admin);
    const rb = psql(CLONES[1], ROLLBACK("0012_rollback.sql"));
    assert.equal(rb.status, 0, rb.out);
    assert.match(rb.out, /private tables were empty and have been dropped/);
    for (const t of ["installation_claims", "account_installations", "account_audit"]) {
      assert.equal((await w.admin.query("select to_regclass($1) r", [`private.${t}`])).rows[0].r, null);
    }
    assert.deepEqual(await allOwners(w.admin), owners);
    const re = psql(CLONES[1], MIGRATION);
    assert.equal(re.status, 0, re.out);
    const o = await w.fx.identity({ anonymous: true });
    const inst = uniq("after-rb");
    await w.fx.installation(inst, o.uid);
    assert.equal((await rpc(w.client, o.claims, "fdb_account_claim_start", [inst])).ok, true);
  });

  it("the forward migration refuses to run when its pre-flight fails (missing dependency), and applies nothing", async () => {
    const sup = await connectSuper(CLONES[1]);
    await sup.query("alter function private.foreverdb_api_gate(text) rename to foreverdb_api_gate_tmp");
    await sup.end();
    const before = (await w.admin.query("select md5(prosrc) h from pg_proc where proname = 'fdb_account_claim_start'")).rows[0].h;
    const r = psql(CLONES[1], MIGRATION);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /pre-flight/);
    assert.equal((await w.admin.query("select md5(prosrc) h from pg_proc where proname = 'fdb_account_claim_start'")).rows[0].h, before, "nothing was applied");
    const sup2 = await connectSuper(CLONES[1]);
    await sup2.query("alter function private.foreverdb_api_gate_tmp(text) rename to foreverdb_api_gate");
    await sup2.end();
  });
});
