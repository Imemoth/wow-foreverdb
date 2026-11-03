// Retention cleanup (database/ops/retention_cleanup_install.sql) rehearsal on an isolated CLONE of the integration database.
// The script is OWNER-RUN and is not applied to any real project; this suite is its only executor. It proves the rules match the stated
// retention (7 / 180 / 90 days / 24 h), that every run is bounded, non-overlapping and non-blocking, that a failing task is isolated and
// made visible, that the log holds no personal data, and that no API role can reach any of it.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { DB, HOST, PORT, connect, connectSuper, repoRoot, uniq } from "./harness.mjs";

const CLONE = `${DB}_ret`;
const INSTALL = path.join(repoRoot, "database/ops/retention_cleanup_install.sql");
const M0014 = path.join(repoRoot, "database/migrations/0014_zero_touch_enrollment.sql");

function psql(db, file) {
  const args = ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-h", HOST, "-p", String(PORT), "-U", "fdb_migrator", "-d", db, "-f", file];
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

let admin;
const q = (sql, params) => admin.query(sql, params);
const run = async (...args) => (await q("select private.azerdex_retention_run($1, $2, $3) r", [args[0] ?? 100, args[1] ?? 5, args[2] ?? false])).rows[0].r;
const count = async (table, where = "true", params = []) => (await q(`select count(*)::int n from ${table} where ${where}`, params)).rows[0].n;

async function installation(id) {
  await q(
    `insert into public.installations (id, owner_user_id, schema_version, addon_version, snapshot_updated_at, first_seen_at, last_seen_at)
     values ($1, $2, 9, 'it-test', 1000, now(), now())`,
    [id, randomUUID()],
  );
  return id;
}
async function claim(inst, status, { ageDays, expiredDays = ageDays }) {
  const id = randomUUID();
  await q(
    `insert into private.installation_claims (id, installation_id, initiator_uid, initiator_session_id, code_hash, status, created_at, expires_at)
     values ($1, $2, $3, $4, $5, $6, now() - make_interval(days => $7::int), now() - make_interval(days => $8::int))`,
    [id, inst, randomUUID(), randomUUID(), Buffer.from(randomUUID().replaceAll("-", ""), "hex"), status, ageDays, expiredDays],
  );
  return id;
}
const auditRow = (ageDays) =>
  q("insert into private.account_audit (at, event, account_uid) values (now() - make_interval(days => $1::int), 'claim_started', $2)", [ageDays, randomUUID()]);
const resetData = async () => {
  await q("truncate private.account_audit, private.account_installations, private.installation_claims, private.enrollment_tickets, private.foreverdb_api_budgets, private.retention_run_log cascade");
};

before(async () => {
  await cloneDatabase(DB, CLONE);
  const sup = await connectSuper(CLONE);
  const has14 = (await sup.query("select to_regclass('private.enrollment_tickets') r")).rows[0].r !== null;
  await sup.end();
  if (!has14) {
    const r = psql(CLONE, M0014);
    assert.equal(r.status, 0, r.out);
  }
  const first = psql(CLONE, INSTALL);
  assert.equal(first.status, 0, first.out);
  const again = psql(CLONE, INSTALL);
  assert.equal(again.status, 0, `idempotent re-run: ${again.out}`);
  admin = await connect(CLONE);
});

after(async () => {
  await admin?.end();
  const sup = await connectSuper("postgres");
  await sup.query(`drop database if exists ${CLONE} with (force)`);
  await sup.end();
});

describe("privileges: the cleanup is reachable by nobody but the owner", () => {
  const sigs = [
    "private.azerdex_retention_run(integer,integer,boolean)",
    "private.azerdex_retention_batch(text,integer,boolean)",
    "private.azerdex_retention_assert_healthy(interval)",
  ];
  it("no API role can execute any function or read/write the run log", async () => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      for (const sig of sigs) {
        const r = await q(`select has_function_privilege($1, $2, 'execute') v`, [role, sig]);
        assert.equal(r.rows[0].v, false, `${role} executes ${sig}`);
      }
      const t = await q("select has_table_privilege($1, 'private.retention_run_log', 'select,insert,update,delete,truncate,references,trigger') v", [role]);
      assert.equal(t.rows[0].v, false, `${role} on retention_run_log`);
    }
  });
  it("functions are SECURITY DEFINER with an empty search_path and a lock_timeout; the log has RLS enabled", async () => {
    const f = await q(
      `select p.proname, p.prosecdef, p.proconfig from pg_proc p where p.pronamespace = 'private'::regnamespace and p.proname like 'azerdex_retention_%'`,
    );
    assert.equal(f.rows.length, 3);
    for (const row of f.rows) {
      assert.equal(row.prosecdef, true, row.proname);
      assert.ok(row.proconfig.includes("search_path=\"\""), `${row.proname} search_path`);
      assert.ok(row.proconfig.includes("lock_timeout=5s"), `${row.proname} lock_timeout`);
    }
    assert.equal((await q("select relrowsecurity v from pg_class where oid = 'private.retention_run_log'::regclass")).rows[0].v, true);
  });
});

describe("rules: exactly the stated retention, nothing else", () => {
  before(resetData);

  it("deletes revoked / expired-pending claims older than 7 days; never recent, consumed or linked claims", async () => {
    const [iRevOld, iPendOld, iRevNew, iPendNew, iConsumed, iLinked] = await Promise.all(["rev-old", "pend-old", "rev-new", "pend-new", "consumed", "linked"].map((p) => installation(uniq(p))));
    const revOld = await claim(iRevOld, "revoked", { ageDays: 8 });
    const pendOld = await claim(iPendOld, "pending", { ageDays: 9, expiredDays: 8 });
    const revNew = await claim(iRevNew, "revoked", { ageDays: 6 });
    const pendNew = await claim(iPendNew, "pending", { ageDays: 9, expiredDays: 6 });
    const consumed = await claim(iConsumed, "consumed", { ageDays: 400 });
    const linkedClaim = await claim(iLinked, "revoked", { ageDays: 30 });
    await q("insert into private.account_installations (installation_id, account_uid, claim_id, previous_owner_uid) values ($1, $2, $3, $4)", [iLinked, randomUUID(), linkedClaim, randomUUID()]);

    const out = await run();
    assert.equal(out.ok, true);
    assert.equal(out.tasks.claims.rows, 2);
    const left = (await q("select id from private.installation_claims")).rows.map((r) => r.id);
    assert.ok(!left.includes(revOld) && !left.includes(pendOld), "old revoked and old expired-pending removed");
    for (const id of [revNew, pendNew, consumed, linkedClaim]) assert.ok(left.includes(id), `kept ${id}`);
    assert.equal(await count("private.account_installations"), 1, "link row untouched");
  });

  it("deletes audit rows older than 180 days only", async () => {
    await resetData();
    await auditRow(181); await auditRow(200); await auditRow(179); await auditRow(1);
    const out = await run();
    assert.equal(out.tasks.account_audit.rows, 2);
    assert.equal(await count("private.account_audit"), 2);
  });

  it("deletes terminal/expired enrollment tickets older than 90 days that no device references", async () => {
    await resetData();
    const ticket = async (status, ageDays, expiresInDays) => {
      const id = randomUUID();
      await q(
        `insert into private.enrollment_tickets (id, account_uid, ticket_hash, status, created_at, expires_at)
         values ($1, $2, $3, $4, now() - make_interval(days => $5::int), now() - make_interval(days => $5::int) + make_interval(hours => $6::int))`,
        [id, randomUUID(), Buffer.from(randomUUID().replaceAll("-", ""), "hex"), status, ageDays, expiresInDays],
      );
      return id;
    };
    const oldConsumed = await ticket("consumed", 100, 1);
    const oldRevoked = await ticket("revoked", 95, 1);
    const oldExpiredPending = await ticket("pending", 120, 1);
    const recent = await ticket("consumed", 30, 1);
    const referenced = await ticket("consumed", 200, 1);
    const inst = await installation(uniq("dev"));
    await q(
      `insert into private.devices (account_uid, installation_id, auth_uid, status, ticket_id, credential_hash)
       values ($1, $2, $3, 'active', $4, $5)`,
      [randomUUID(), inst, randomUUID(), referenced, Buffer.from("00", "hex")],
    );
    const out = await run();
    assert.equal(out.tasks.enrollment_tickets.rows, 3);
    const left = (await q("select id from private.enrollment_tickets")).rows.map((r) => r.id);
    for (const id of [oldConsumed, oldRevoked, oldExpiredPending]) assert.ok(!left.includes(id));
    for (const id of [recent, referenced]) assert.ok(left.includes(id));
    assert.equal(await count("private.devices"), 1, "devices are never touched");
  });

  it("deletes API budget counters older than 24 hours only", async () => {
    await resetData();
    await q("insert into private.foreverdb_api_budgets (bucket, window_started, calls) values ('t:old', now() - interval '25 hours', 1), ('t:new', now() - interval '1 hour', 1)");
    const out = await run();
    assert.equal(out.tasks.api_budgets.rows, 1);
    assert.deepEqual((await q("select bucket from private.foreverdb_api_budgets")).rows.map((r) => r.bucket), ["t:new"]);
  });

  it("never touches device_audit, devices, installations or Guildbook data (no rule exists for them)", async () => {
    await resetData();
    const inst = await installation(uniq("keep"));
    await q("insert into private.device_audit (at, event, account_uid) values (now() - interval '2000 days', 'ticket_issued', $1)", [randomUUID()]);
    await run();
    assert.equal(await count("private.device_audit"), 1);
    assert.equal(await count("public.installations", "id = $1", [inst]), 1);
  });
});

describe("dry run", () => {
  before(resetData);
  it("counts what would be deleted, deletes nothing and is logged as a dry run", async () => {
    for (let i = 0; i < 3; i += 1) await auditRow(300);
    await q("insert into private.foreverdb_api_budgets (bucket, window_started, calls) values ('d:old', now() - interval '30 hours', 1)");
    const out = await run(100, 5, true);
    assert.equal(out.dry_run, true);
    assert.equal(out.tasks.account_audit.rows, 3);
    assert.equal(out.tasks.api_budgets.rows, 1);
    assert.equal(await count("private.account_audit"), 3, "nothing deleted");
    assert.equal(await count("private.foreverdb_api_budgets"), 1);
    assert.equal(await count("private.retention_run_log", "dry_run and run_id = $1", [out.run_id]), 4);
  });
});

describe("bounded operations", () => {
  before(resetData);
  it("never deletes more than batch_rows x max_batches per task per run, reports more_pending, and drains over successive runs", async () => {
    for (let i = 0; i < 12; i += 1) await auditRow(400);
    const first = await run(5, 2);
    assert.equal(first.tasks.account_audit.rows, 10);
    assert.equal(first.tasks.account_audit.more_pending, true);
    assert.equal(await count("private.account_audit"), 2);
    const second = await run(5, 2);
    assert.equal(second.tasks.account_audit.rows, 2);
    assert.equal(second.tasks.account_audit.more_pending, false);
    assert.equal(await count("private.account_audit"), 0);
  });
  it("rejects out-of-range bounds", async () => {
    for (const args of [[0, 5], [1001, 5], [100, 0], [100, 101]]) {
      await assert.rejects(() => run(...args), /batch bounds out of range/);
    }
  });
  it("the run log is itself bounded to the newest 5000 entries", async () => {
    await resetData();
    await q(`insert into private.retention_run_log (run_id, task, status) select gen_random_uuid(), 'run', 'ok' from generate_series(1, 5100)`);
    await run();
    assert.equal(await count("private.retention_run_log"), 5000);
  });
});

describe("concurrency protections", () => {
  before(resetData);

  it("skips a claim whose installation lock is busy (no waiting), deletes the rest, and picks it up on the next run", async () => {
    const busy = await installation(uniq("busy"));
    const free = await installation(uniq("free"));
    const busyClaim = await claim(busy, "revoked", { ageDays: 20 });
    const freeClaim = await claim(free, "revoked", { ageDays: 20 });
    const holder = await connect(CLONE);
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [busy]); // what ingest / claim / transfer hold
      const t0 = Date.now();
      const out = await run();
      assert.ok(Date.now() - t0 < 4000, "cleanup did not wait for the busy installation");
      assert.equal(out.tasks.claims.rows, 1);
      const ids = (await q("select id from private.installation_claims")).rows.map((r) => r.id);
      assert.deepEqual(ids, [busyClaim]);
      assert.ok(!ids.includes(freeClaim));
    } finally {
      await holder.query("rollback");
      await holder.end();
    }
    const next = await run();
    assert.equal(next.tasks.claims.rows, 1);
    assert.equal(await count("private.installation_claims"), 0);
  });

  it("a second overlapping run exits immediately with skipped_locked and deletes nothing", async () => {
    await resetData();
    await auditRow(400);
    const holder = await connect(CLONE);
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(hashtextextended('azerdex-retention-run', 0))");
      const t0 = Date.now();
      const out = await run();
      assert.ok(Date.now() - t0 < 4000);
      assert.equal(out.skipped, "locked");
      assert.equal(await count("private.account_audit"), 1);
      assert.equal(await count("private.retention_run_log", "run_id = $1 and status = 'skipped_locked'", [out.run_id]), 1);
    } finally {
      await holder.query("rollback");
      await holder.end();
    }
  });
});

describe("failure isolation and visibility", () => {
  before(resetData);

  it("one failing task is rolled back and logged with its SQLSTATE while the other tasks still run; the health check raises", async () => {
    await auditRow(400);
    const inst = await installation(uniq("iso"));
    const old = await claim(inst, "revoked", { ageDays: 20 });
    await q(`create function private.it_boom() returns trigger language plpgsql as $$ begin raise exception 'it-boom'; end $$`);
    await q("create trigger it_boom before delete on private.account_audit for each row execute function private.it_boom()");
    try {
      const out = await run();
      assert.equal(out.ok, false);
      assert.equal(out.tasks.account_audit.status, "error");
      assert.equal(out.tasks.claims.status, "ok");
      assert.equal(await count("private.account_audit"), 1, "the failed task was rolled back");
      assert.ok(!(await q("select id from private.installation_claims")).rows.some((r) => r.id === old), "the other task still ran and committed");
      const logged = (await q("select task, status, sqlstate, error_message from private.retention_run_log where run_id = $1 and status = 'error'", [out.run_id])).rows;
      assert.deepEqual(logged, [{ task: "account_audit", status: "error", sqlstate: "P0001", error_message: "it-boom" }]);
      await assert.rejects(() => q("select private.azerdex_retention_assert_healthy()"), /failing task\(s\): account_audit:P0001/);
    } finally {
      await q("drop trigger it_boom on private.account_audit");
      await q("drop function private.it_boom()");
    }
  });

  it("recovers: the next clean run makes the health check pass; a stale or missing run raises", async () => {
    const out = await run();
    assert.equal(out.ok, true);
    assert.equal(await count("private.account_audit"), 0);
    const healthy = (await q("select private.azerdex_retention_assert_healthy() r")).rows[0].r;
    assert.equal(healthy.ok, true);
    await q("update private.retention_run_log set started_at = now() - interval '48 hours'");
    await assert.rejects(() => q("select private.azerdex_retention_assert_healthy()"), /last run is stale/);
    await q("truncate private.retention_run_log");
    await assert.rejects(() => q("select private.azerdex_retention_assert_healthy()"), /no retention run has been recorded/);
  });

  it("a dry run never satisfies the health check", async () => {
    await resetData();
    await run(100, 5, true);
    await assert.rejects(() => q("select private.azerdex_retention_assert_healthy()"), /no retention run has been recorded/);
  });
});

describe("the run log holds no personal data", () => {
  it("contains only counts, statuses and codes: no installation id, account uid or error detail", async () => {
    await resetData();
    const inst = await installation(uniq("pii"));
    const uid = randomUUID();
    await q("insert into private.account_audit (at, event, account_uid, installation_id) values (now() - interval '400 days', 'claim_started', $1, $2)", [uid, inst]);
    await claim(inst, "revoked", { ageDays: 20 });
    await run();
    const dump = JSON.stringify((await q("select * from private.retention_run_log")).rows);
    assert.ok(!dump.includes(inst) && !dump.includes(uid));
    const cols = (await q("select column_name from information_schema.columns where table_schema = 'private' and table_name = 'retention_run_log' order by 1")).rows.map((r) => r.column_name);
    assert.deepEqual(cols, ["batches", "dry_run", "error_message", "finished_at", "id", "more_pending", "row_count", "run_id", "sqlstate", "started_at", "status", "task"]);
  });
});
