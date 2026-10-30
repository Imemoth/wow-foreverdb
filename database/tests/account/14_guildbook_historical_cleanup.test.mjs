// database/ops/guildbook_historical_inventory.sql (read-only) and database/ops/guildbook_historical_cleanup.sql (owner-run) on CLONES of the
// integration database. Proves: the dry run deletes nothing (and the database itself refuses a write in it); execute mode refuses without the
// exact confirmation, a backup reference, an operator and an active 0018 kill switch; with them it removes ONLY Guildbook rows of the chosen
// scope and leaves installations, observation statistics, claims, links, audit, devices and tickets byte-identical; it is bounded, skips a
// busy installation, is idempotent; and no output ever contains a name, a guid or an installation id. Only synthetic data is used.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { DB, Fixtures, cloneDatabase, connect, dropDatabase, psqlFile, repoRoot, rpc, snapshot } from "./harness.mjs";
import { instId, makeWorld } from "../enrollment/world.mjs";

const R = (...parts) => path.join(repoRoot, ...parts);
const MIG14 = R("database/migrations/0014_zero_touch_enrollment.sql");
const MIG18 = R("database/migrations/0018_disable_guildbook_cloud_sync.sql");
const CLEANUP = R("database/ops/guildbook_historical_cleanup.sql");
const INVENTORY = R("database/ops/guildbook_historical_inventory.sql");
const CLONES = { main: `${DB}_gb_gc`, noKillSwitch: `${DB}_gb_gc_noks` };
const CONFIRM = "DELETE-HISTORICAL-GUILDBOOK-DATA";
const exec = { mode: "execute", confirm: CONFIRM, backup_ref: "TEST-BACKUP-2099-01-01-verified", operator: "test-operator" };

// ROOT CAUSE of the first CI failures: this clone is a copy of the shared integration database, which the earlier suites have already filled
// with Guildbook rows of ~80 installations (real ingest and fixture paths). The first version of these tests assumed an empty Guildbook
// baseline. That inherited data is a useful realistic background (many unrelated installations that must stay untouched), so it is KEPT:
// the baseline is measured before anything is seeded, strict assertions are made on the SEEDED scope (scope=list), and totals are asserted
// relative to the baseline. Nothing is deleted or reset to make a test pass.
const SEEDED = { guilds: 5, members: 11, professions: 11, installations: 4 }; // A(2 guilds) + B + C + E, see roster() calls in before()
let base; // { guilds, members, professions, installations, anonymous, registered, ownerless, ownerMissing } measured by the read-only inventory
let admin;
let fx;
const outputs = [];
const ids = {};
const secrets = []; // every synthetic string and every installation id that must never appear in any output

async function roster(inst, guilds, members) {
  for (let g = 1; g <= guilds; g += 1) {
    const key = `syn-guild-${g}`;
    const memberRows = Array.from({ length: members }, (_, m) => ({ guid: `syn-guid-${g}-${m}`, name: `Synthetic Character ${g}-${m}` }));
    await fx.guild(inst, key, memberRows);
    secrets.push(`Guild ${key}`, ...memberRows.map((m) => m.name), ...memberRows.map((m) => m.guid));
    for (const m of memberRows) {
      await admin.query(
        `insert into public.installation_guild_professions (installation_id, guild_key, member_guid, skill_line_id, profession_name, skill, max_skill, source, is_secondary)
         values ($1, $2, $3, 164, 'Synthetic Craft', 300, 375, 'scan', false)`,
        [inst, key, m.guid],
      );
    }
  }
}

const guildCounts = async () => (await admin.query(
  `select (select count(*)::int from public.installation_guilds) as guilds,
          (select count(*)::int from public.installation_guild_members) as members,
          (select count(*)::int from public.installation_guild_professions) as professions`,
)).rows[0];
const perInstallation = async (inst) => (await admin.query(
  `select (select count(*)::int from public.installation_guilds where installation_id = $1) as guilds,
          (select count(*)::int from public.installation_guild_members where installation_id = $1) as members,
          (select count(*)::int from public.installation_guild_professions where installation_id = $1) as professions`,
  [inst],
)).rows[0];
const guildFingerprint = async (inst) => (await admin.query(
  `select md5(concat_ws('|',
     (select coalesce(string_agg(to_jsonb(t)::text, '|' order by to_jsonb(t)::text), '') from public.installation_guilds t where installation_id = $1),
     (select coalesce(string_agg(to_jsonb(t)::text, '|' order by to_jsonb(t)::text), '') from public.installation_guild_members t where installation_id = $1),
     (select coalesce(string_agg(to_jsonb(t)::text, '|' order by to_jsonb(t)::text), '') from public.installation_guild_professions t where installation_id = $1))) as h`,
  [inst],
)).rows[0].h;

// Everything the cleanup must NOT touch: a content hash per table.
const UNTOUCHED = ["public.installations", "public.sources", "public.items", "public.installation_source_stats", "public.installation_item_stats",
  "public.installation_location_stats", "private.installation_claims", "private.account_installations", "private.account_audit",
  "private.devices", "private.enrollment_tickets", "private.device_audit", "auth.users"];
async function untouched() {
  const out = {};
  for (const t of UNTOUCHED) {
    const r = await admin.query(`select count(*)::int as n, md5(coalesce(string_agg(to_jsonb(x)::text, '|' order by to_jsonb(x)::text), '')) as h from ${t} x`);
    out[t] = `${r.rows[0].n}:${r.rows[0].h}`;
  }
  return out;
}

const run = (vars, database = CLONES.main) => {
  const r = psqlFile(database, CLEANUP, vars);
  outputs.push(r.out);
  return r;
};
const grab = (out, re) => {
  const m = re.exec(out);
  assert.ok(m, `expected ${re} in the output`);
  return m.slice(1).map(Number);
};
const plus = (a, b) => a.map((n, i) => n + b[i]);
const inventoryBaseline = (out) => {
  const [guilds, members, professions] = grab(out, /INVENTORY guild_rows (\d+) member_rows (\d+) profession_rows (\d+)/);
  const [, installations] = grab(out, /INVENTORY installations_total (\d+) installations_with_guild_rows (\d+)/);
  const [ownerless, anonymous, registered, ownerMissing] = grab(out, /guild_installations_by_owner ownerless=(\d+) anonymous=(\d+) registered=(\d+) owner_user_missing=(\d+)/);
  return { guilds, members, professions, installations, anonymous, registered, ownerless, ownerMissing };
};

before(async () => {
  await cloneDatabase(DB, CLONES.main);
  admin = await connect(CLONES.main);
  fx = new Fixtures(admin);
  // 0014 is part of the RC; add it to this clone when the CI layout does not have it, so devices and tickets are real rows.
  if (!(await admin.query("select to_regprocedure('public.fdb_device_ingest(text,jsonb)') is not null as v")).rows[0].v) {
    const r = psqlFile(CLONES.main, MIG14);
    assert.equal(r.status, 0, r.out);
  }
  // The kill switch first: ingest below then goes through the 0018 wrapper, so the Guildbook rows seeded afterwards are never rewritten.
  const applied = psqlFile(CLONES.main, MIG18);
  assert.equal(applied.status, 0, applied.out);

  const registered = await fx.identity({ anonymous: false });
  const registered2 = await fx.identity({ anonymous: false });
  const anonymous = await fx.identity({ anonymous: true });
  Object.assign(ids, { A: instId(), B: instId(), C: instId(), D: instId(), E: instId() });
  await fx.installation(ids.A, registered.uid);
  await fx.installation(ids.B, anonymous.uid);
  await fx.installation(ids.C, registered2.uid);
  await fx.installation(ids.D, registered.uid);
  await fx.installation(ids.E, anonymous.uid);
  secrets.push(...Object.values(ids));

  const client = await connect(CLONES.main);
  try {
    for (const [inst, who, ts] of [[ids.D, registered, 2000], [ids.A, registered, 2001], [ids.E, anonymous, 2002]]) {
      await fx.resetBudgets();
      assert.equal((await rpc(client, who.claims, "ingest_foreverdb_snapshot_auth", [snapshot(inst, { sources: 2, guilds: 0, updatedAt: ts })])).ok, true);
    }
    // E is claimed by a registered account: a link row, a consumed claim and audit rows exist for it.
    await fx.resetBudgets();
    const { code } = await rpc(client, anonymous.claims, "fdb_account_claim_start", [ids.E]);
    await fx.resetBudgets();
    assert.equal((await rpc(client, registered2.claims, "fdb_account_claim_redeem", [code])).ok, true);
  } finally {
    await client.end();
  }
  // An enrolled device for A (private.devices / enrollment_tickets / device_audit rows).
  const w = await makeWorld({ database: CLONES.main });
  try {
    const account = { ...registered, kind: "account", call: (fn, args = []) => rpc(w.client, registered.claims, fn, args) };
    await w.enrolled(account, { installationId: ids.A });
  } finally {
    await w.close();
  }

  // Baseline BEFORE seeding (read-only inventory; its output is leak-checked like every other output).
  const baselineRun = psqlFile(CLONES.main, INVENTORY);
  outputs.push(baselineRun.out);
  assert.equal(baselineRun.status, 0, baselineRun.out);
  base = inventoryBaseline(baselineRun.out);

  await roster(ids.A, 2, 3); // 2 guilds, 6 members, 6 professions
  await roster(ids.B, 1, 2); // anonymous owner
  await roster(ids.C, 1, 1); // registered owner
  await roster(ids.E, 1, 2); // claimed (account-linked)
});

after(async () => {
  await admin?.end();
  for (const name of Object.values(CLONES)) await dropDatabase(name);
});

describe("inventory (read-only, counts only)", () => {
  it("reports the state and counts, changes nothing and prints no name, guid or installation id", async () => {
    const before = { guild: await guildCounts(), rest: await untouched() };
    const r = psqlFile(CLONES.main, INVENTORY);
    outputs.push(r.out);
    assert.equal(r.status, 0, r.out);
    // Baseline-relative: the inherited data plus exactly what this suite seeded.
    const now = inventoryBaseline(r.out);
    assert.deepEqual(
      [now.guilds, now.members, now.professions, now.installations],
      plus([base.guilds, base.members, base.professions, base.installations], [SEEDED.guilds, SEEDED.members, SEEDED.professions, SEEDED.installations]),
    );
    assert.deepEqual([now.ownerless, now.anonymous, now.registered, now.ownerMissing], [base.ownerless, base.anonymous + 1, base.registered + 3, base.ownerMissing]);
    assert.match(r.out, /INVENTORY kill_switch_guard_rows 1/);
    assert.match(r.out, /INVENTORY ingest_has_observation_only_projection true/);
    assert.match(r.out, /guildbook_rpc public\.fdb_account_guildbook_guilds\(text\) public=false anon=false authenticated=false service_role=false/);
    assert.match(r.out, /INVENTORY account_scoped_guildbook_rows_total 0/);
    assert.deepEqual({ guild: await guildCounts(), rest: await untouched() }, before);
  });
});

describe("dry run (default)", () => {
  it("scope=all reports exactly what would be deleted and deletes nothing", async () => {
    const before = { guild: await guildCounts(), rest: await untouched() };
    const r = run({ scope: "all" });
    assert.equal(r.status, 0, r.out);
    // Whole database: the inherited baseline plus the seeded rows; the batch is bounded by max_installations (default 200).
    const [inScope, batch] = grab(r.out, /installations_in_scope=(\d+) batch_installations=(\d+)/);
    assert.equal(inScope, base.installations + SEEDED.installations);
    assert.equal(batch, Math.min(inScope, 200), "the default batch bound (max_installations=200) applies");
    const wouldDelete = grab(r.out, /would_delete guild_rows=(\d+) member_rows=(\d+) profession_rows=(\d+)/);
    if (batch === inScope) {
      assert.deepEqual(wouldDelete, [before.guild.guilds, before.guild.members, before.guild.professions]); // the whole scope fits one batch
    } else {
      assert.ok(wouldDelete[0] > 0 && wouldDelete[0] <= before.guild.guilds, "a bounded batch reports at most the whole scope");
    }
    assert.deepEqual([before.guild.guilds, before.guild.members, before.guild.professions], plus([base.guilds, base.members, base.professions], [SEEDED.guilds, SEEDED.members, SEEDED.professions]));
    assert.match(r.out, /dry_run: nothing was deleted/);
    assert.match(r.out, /dry run finished: rolled back/);
    assert.deepEqual(await guildCounts(), before.guild);
    assert.deepEqual(await untouched(), before.rest);
    // Exactly the seeded rows, with their owner classes, on a scope the suite fully controls (strict, not baseline-relative).
    const seeded = run({ scope: "list", installation_ids: [ids.A, ids.B, ids.C, ids.E].join(",") });
    assert.equal(seeded.status, 0, seeded.out);
    assert.deepEqual(grab(seeded.out, /would_delete guild_rows=(\d+) member_rows=(\d+) profession_rows=(\d+)/), [SEEDED.guilds, SEEDED.members, SEEDED.professions]);
    assert.deepEqual(grab(seeded.out, /installations_in_scope=(\d+) batch_installations=(\d+)/), [4, 4]);
    assert.deepEqual(grab(seeded.out, /batch_owner_classes anonymous=(\d+) registered=(\d+) ownerless=(\d+) account_linked=(\d+)/), [1, 3, 0, 1]);
    assert.deepEqual(await guildCounts(), before.guild);
  });

  it("scope=list reports only the listed installations, with hashed labels instead of ids", async () => {
    const r = run({ scope: "list", installation_ids: `${ids.A}, ${ids.C},${instId()}` });
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(grab(r.out, /would_delete guild_rows=(\d+) member_rows=(\d+) profession_rows=(\d+)/), [3, 7, 7]);
    assert.equal([...r.out.matchAll(/installation#[0-9a-f]{8} guild_rows=/g)].length, 2);
  });

  it("stays a dry run even when execute-looking variables are supplied with another mode, and an unknown mode is refused", async () => {
    const before = await guildCounts();
    const r = run({ scope: "all", mode: "dry_run", confirm: CONFIRM, backup_ref: exec.backup_ref, operator: exec.operator });
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(await guildCounts(), before);
    const bad = run({ scope: "all", mode: "delete" });
    assert.notEqual(bad.status, 0);
    assert.match(bad.out, /mode must be dry_run or execute/);
    assert.deepEqual(await guildCounts(), before);
  });
});

describe("execute mode refuses unless everything is in place", () => {
  it("refuses without scope, without the exact confirmation, without a backup reference, without an operator and with bad ids", async () => {
    const before = { guild: await guildCounts(), rest: await untouched() };
    const cases = [
      [{ mode: "execute", confirm: CONFIRM, backup_ref: exec.backup_ref, operator: exec.operator }, /missing -v scope/],
      [{ ...exec, scope: "all", confirm: "yes" }, /exact confirmation text/],
      [{ ...exec, scope: "all", confirm: undefined }, /exact confirmation text/],
      [{ ...exec, scope: "all", backup_ref: "short" }, /recorded backup reference/],
      [{ ...exec, scope: "all", backup_ref: undefined }, /recorded backup reference/],
      [{ ...exec, scope: "all", operator: "x" }, /needs -v operator/],
      [{ ...exec, scope: "list" }, /between 1 and 1000 installation ids/],
      [{ ...exec, scope: "list", installation_ids: "bad id;drop table x" }, /malformed installation id/],
      [{ ...exec, scope: "all", installation_ids: ids.A }, /only valid with scope=list/],
      [{ ...exec, scope: "all", max_installations: "0" }, /between 1 and 500/],
      [{ ...exec, scope: "all", max_installations: "501" }, /between 1 and 500/],
    ];
    for (const [vars, pattern] of cases) {
      const clean = Object.fromEntries(Object.entries(vars).filter(([, v]) => v !== undefined));
      const r = run(clean);
      assert.notEqual(r.status, 0, JSON.stringify(Object.keys(clean)));
      assert.match(r.out, pattern);
    }
    assert.deepEqual({ guild: await guildCounts(), rest: await untouched() }, before);
  });

  it("refuses while the 0018 kill switch is not active (old clients would upload the data again), but still allows a dry run", async () => {
    await cloneDatabase(DB, CLONES.noKillSwitch);
    const sub = await connect(CLONES.noKillSwitch);
    try {
      const subFx = new Fixtures(sub);
      const owner = await subFx.identity({ anonymous: false });
      const inst = instId();
      await subFx.installation(inst, owner.uid);
      await subFx.guild(inst, "syn-guild-1", [{ guid: "syn-guid-1-0", name: "Synthetic Character 1-0" }]);
      const dry = run({ scope: "all" }, CLONES.noKillSwitch);
      assert.equal(dry.status, 0, dry.out);
      const refused = run({ ...exec, scope: "all" }, CLONES.noKillSwitch);
      assert.notEqual(refused.status, 0);
      assert.match(refused.out, /kill switch \(migration 0018\) is not active/);
      assert.equal((await sub.query("select count(*)::int as n from public.installation_guilds")).rows[0].n >= 1, true, "nothing deleted");
    } finally {
      await sub.end();
    }
  });

  it("refuses when non-empty account-scoped Guildbook tables exist (a sibling branch's structure) unless acknowledged", async () => {
    await admin.query("create table private.account_guildbook_guilds (installation_id text)");
    try {
      await admin.query("insert into private.account_guildbook_guilds values ('x')");
      const before = await guildCounts();
      const refused = run({ ...exec, scope: "list", installation_ids: ids.C });
      assert.notEqual(refused.status, 0);
      assert.match(refused.out, /account-scoped Guildbook tables exist and are not covered/);
      assert.deepEqual(await guildCounts(), before);
    } finally {
      await admin.query("drop table private.account_guildbook_guilds");
    }
  });
});

describe("execute mode deletes only Guildbook rows of the scope", () => {
  it("scope=list removes exactly the listed installation's Guildbook rows and nothing else", async () => {
    const rest = await untouched();
    const keep = { B: await guildFingerprint(ids.B), C: await guildFingerprint(ids.C), E: await guildFingerprint(ids.E) };
    const r = run({ ...exec, scope: "list", installation_ids: ids.A });
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(grab(r.out, /installations_processed=(\d+) skipped_busy=(\d+) deleted_guild_rows=(\d+) deleted_member_rows=(\d+) deleted_profession_rows=(\d+)/), [1, 0, 2, 6, 6]);
    assert.match(r.out, /backup_ref=TEST-BACKUP-2099-01-01-verified/);
    assert.match(r.out, /irreversible except from the backup/);
    assert.match(r.out, /GUILDBOOK-CLEANUP committed/);
    assert.deepEqual(await perInstallation(ids.A), { guilds: 0, members: 0, professions: 0 });
    assert.deepEqual({ B: await guildFingerprint(ids.B), C: await guildFingerprint(ids.C), E: await guildFingerprint(ids.E) }, keep);
    assert.deepEqual(await untouched(), rest, "installations, statistics, claims, links, audit, devices, tickets and users are byte-identical");
    // Everything inherited and everything else seeded is still there: only A's rows (2 guilds, 6 members, 6 professions) are gone.
    assert.deepEqual(
      await guildCounts(),
      { guilds: base.guilds + SEEDED.guilds - 2, members: base.members + SEEDED.members - 6, professions: base.professions + SEEDED.professions - 6 },
    );
  });

  it("is bounded and re-runnable: max_installations=1 processes one installation per run until none of the listed remain", async () => {
    const rest = await untouched();
    const before = await guildCounts();
    const list = [ids.B, ids.C, ids.E].join(",");
    const processed = [];
    for (let i = 0; i < 6; i += 1) {
      const r = run({ ...exec, scope: "list", installation_ids: list, max_installations: "1" });
      assert.equal(r.status, 0, r.out);
      const [done, , delG] = grab(r.out, /installations_processed=(\d+) skipped_busy=(\d+) deleted_guild_rows=(\d+)/);
      const [remaining] = grab(r.out, /remaining_installations_with_guild_rows_in_scope=(\d+)/);
      processed.push([done, delG, remaining]);
      if (remaining === 0) break;
    }
    assert.deepEqual(processed, [[1, 1, 2], [1, 1, 1], [1, 1, 0]]);
    // B(1/2/2) + C(1/1/1) + E(1/2/2) are gone; every other installation's Guildbook is exactly as it was.
    assert.deepEqual(await guildCounts(), { guilds: before.guilds - 3, members: before.members - 5, professions: before.professions - 5 });
    assert.deepEqual(await untouched(), rest);
  });

  it("is idempotent: a further run over the same scope finds nothing and succeeds", async () => {
    const r = run({ ...exec, scope: "list", installation_ids: [ids.A, ids.B, ids.C, ids.E].join(",") });
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(grab(r.out, /installations_processed=(\d+) skipped_busy=(\d+) deleted_guild_rows=(\d+) deleted_member_rows=(\d+) deleted_profession_rows=(\d+)/), [0, 0, 0, 0, 0]);
  });

  it("skips an installation whose advisory lock is held (never waits for user traffic) and removes it on the next run", async () => {
    await roster(ids.B, 1, 2);
    await roster(ids.C, 1, 1);
    const rest = await untouched();
    const holder = await connect(CLONES.main);
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [ids.B]);
      const r = run({ ...exec, scope: "list", installation_ids: `${ids.B},${ids.C}` });
      assert.equal(r.status, 0, r.out);
      assert.deepEqual(grab(r.out, /installations_processed=(\d+) skipped_busy=(\d+)/), [1, 1]);
      assert.deepEqual(await perInstallation(ids.B), { guilds: 1, members: 2, professions: 2 }, "the busy installation was left alone");
      assert.deepEqual(await perInstallation(ids.C), { guilds: 0, members: 0, professions: 0 });
    } finally {
      await holder.query("commit");
      await holder.end();
    }
    const again = run({ ...exec, scope: "list", installation_ids: ids.B });
    assert.equal(again.status, 0, again.out);
    assert.deepEqual(grab(again.out, /installations_processed=(\d+) skipped_busy=(\d+)/), [1, 0]);
    assert.deepEqual(await untouched(), rest);
  });

  it("scope=all over the realistic inherited data (dozens of unrelated installations) removes every Guildbook row and nothing else, in bounded runs", async () => {
    const rest = await untouched();
    const before = await guildCounts();
    assert.ok(before.guilds >= base.guilds, "the inherited Guildbook rows are still present before this run");
    assert.ok(base.installations >= 10, "the inherited baseline is large enough to be a meaningful background");
    const total = { guilds: 0, members: 0, professions: 0 };
    let runs = 0;
    for (; runs < 20; runs += 1) {
      const r = run({ ...exec, scope: "all", max_installations: "50" }); // bounded: at most 50 installations per run
      assert.equal(r.status, 0, r.out);
      const [done, skipped, g, m, p] = grab(r.out, /installations_processed=(\d+) skipped_busy=(\d+) deleted_guild_rows=(\d+) deleted_member_rows=(\d+) deleted_profession_rows=(\d+)/);
      assert.ok(done <= 50 && skipped === 0);
      total.guilds += g; total.members += m; total.professions += p;
      if (grab(r.out, /remaining_installations_with_guild_rows_in_scope=(\d+)/)[0] === 0) break;
    }
    // Only the inherited installations remain at this point (the seeded ones were removed by the earlier tests): ceil(n / 50) bounded runs.
    assert.equal(runs + 1, Math.ceil(base.installations / 50), "the bound was honoured and the runs converged");
    assert.deepEqual(total, before, "the runs together deleted exactly the Guildbook rows that existed");
    assert.deepEqual(await guildCounts(), { guilds: 0, members: 0, professions: 0 });
    assert.deepEqual(await untouched(), rest, "installations, statistics, claims, links, audit, devices, tickets and users are byte-identical");
    const again = run({ ...exec, scope: "all" });
    assert.equal(again.status, 0, again.out);
    assert.deepEqual(grab(again.out, /installations_processed=(\d+) skipped_busy=(\d+) deleted_guild_rows=(\d+)/), [0, 0, 0]);
  });

  it("after the cleanup the legacy ingest path still works and creates no Guildbook row (the kill switch holds)", async () => {
    const client = await connect(CLONES.main);
    try {
      const identity = await fx.identity({ anonymous: true });
      const inst = instId();
      await fx.resetBudgets();
      assert.equal((await rpc(client, identity.claims, "ingest_foreverdb_snapshot_auth", [snapshot(inst, { sources: 1, guilds: 2, members: 2, updatedAt: 5000 })])).ok, true);
      assert.deepEqual(await perInstallation(inst), { guilds: 0, members: 0, professions: 0 });
    } finally {
      await client.end();
    }
  });
});

describe("output hygiene", () => {
  it("no output of any run contains a synthetic name, a guid, a guild label or an installation id", () => {
    assert.ok(outputs.length > 10 && secrets.length > 20);
    for (const out of outputs) {
      for (const secret of secrets) assert.ok(!out.includes(secret), "an output leaked a synthetic value");
      assert.doesNotMatch(out, /Synthetic Character|syn-guid|syn-guild/);
    }
  });
});
