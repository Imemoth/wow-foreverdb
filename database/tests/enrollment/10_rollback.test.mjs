// Operator procedures for 0014 on disposable CLONES of the integration database: kill switch (+ restore), rollback with data present
// (tables retained, ownership and history untouched, devices survive a re-apply), rollback with empty tables (dropped), re-apply.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { DB, cloneDatabase, connectSuper, dropDatabase, psqlFile, repoRoot } from "../account/harness.mjs";
import { instId, makeWorld, snapshot } from "./world.mjs";

const file = (name) => path.join(repoRoot, "database", name);
const KILL = file("rollback/0014_kill_switch.sql");
const RESTORE = file("rollback/0014_kill_switch_restore.sql");
const ROLLBACK = file("rollback/0014_rollback.sql");
const APPLY = file("migrations/0014_zero_touch_enrollment.sql");
const FUNCS = [
  "public.fdb_account_enrollment_ticket_issue(text)", "public.fdb_account_enrollment_tickets()", "public.fdb_account_enrollment_ticket_revoke(uuid)",
  "public.fdb_account_devices()", "public.fdb_account_device_revoke(uuid)", "public.fdb_device_enroll(text,text,text)",
  "public.fdb_device_status(text)", "public.fdb_device_ingest(text,jsonb)", "public.fdb_device_rotate_credential(text)",
];

async function scenario(name, body) {
  const clone = `${DB}_${name}`;
  await cloneDatabase(DB, clone);
  const w = await makeWorld({ database: clone });
  try {
    await body(w, clone);
  } finally {
    await w.close();
    await dropDatabase(clone);
  }
}
const priv = async (w, sig) => (await w.admin.query("select has_function_privilege('authenticated', $1, 'execute') p", [sig])).rows[0].p;
const counts = async (w) => (await w.row(
  `select (select count(*)::int from private.devices) devices, (select count(*)::int from private.enrollment_tickets) tickets,
          (select count(*)::int from private.device_audit) audit, (select count(*)::int from public.installations) installations,
          (select md5(string_agg(id || ':' || coalesce(owner_user_id::text,''), ',' order by id)) from public.installations) owners`))[0];

describe("kill switch", () => {
  it("revokes EXECUTE on all nine functions without touching data; anonymous ingest, the 0012 account functions and the legacy path keep working; restore re-enables everything", async () => {
    await scenario("kill", async (w, clone) => {
      const acct = await w.account();
      const e = await w.enrolled(acct);
      assert.equal((await w.ingest(e.device, e.secret, snapshot(e.installationId, { updatedAt: 5000 }))).ok, true);
      const before = await counts(w);
      const history = await w.history(e.installationId);

      const r = psqlFile(clone, KILL);
      assert.equal(r.status, 0, r.out);
      for (const f of FUNCS) assert.equal(await priv(w, f), false, f);
      assert.deepEqual(await counts(w), before, "nothing was dropped or changed");
      await w.fx.resetBudgets();
      await assert.rejects(e.device.call("fdb_device_ingest", [e.secret, snapshot(e.installationId, { updatedAt: 6000 })]), (x) => x.code === "42501");
      await assert.rejects(acct.call("fdb_account_enrollment_ticket_issue", []), (x) => x.code === "42501");
      // existing behaviour is unaffected
      assert.ok((await acct.call("fdb_account_installations")).length >= 1, "0012 account RPCs still work");
      const anon = await w.device();
      await w.fx.resetBudgets();
      assert.equal((await anon.call("ingest_foreverdb_snapshot_auth", [snapshot(instId(), { updatedAt: 1 })])).ok, true);

      const back = psqlFile(clone, RESTORE);
      assert.equal(back.status, 0, back.out);
      for (const f of FUNCS) assert.equal(await priv(w, f), true, f);
      assert.equal((await w.ingest(e.device, e.secret, snapshot(e.installationId, { updatedAt: 7000 }))).ok, true, "the device credential survived the kill switch");
      assert.deepEqual(await w.history(e.installationId), history);
    });
  });

  it("is idempotent and the restore is idempotent", async () => {
    await scenario("kill2", async (w, clone) => {
      assert.equal(psqlFile(clone, KILL).status, 0);
      assert.equal(psqlFile(clone, KILL).status, 0);
      assert.equal(psqlFile(clone, RESTORE).status, 0);
      assert.equal(psqlFile(clone, RESTORE).status, 0);
      for (const f of FUNCS) assert.equal(await priv(w, f), true, f);
    });
  });
});

describe("rollback", () => {
  it("with devices present: functions are dropped, the private tables are RETAINED, ownership/history/0012 functions are untouched; re-applying 0014 revives the existing devices", async () => {
    await scenario("rb", async (w, clone) => {
      const acct = await w.account();
      const e = await w.enrolled(acct);
      await w.ingest(e.device, e.secret, snapshot(e.installationId, { updatedAt: 5000 }));
      const before = await counts(w);
      const history = await w.history(e.installationId);

      const r = psqlFile(clone, ROLLBACK);
      assert.equal(r.status, 0, r.out);
      assert.match(r.out, /private tables RETAINED/);
      for (const f of FUNCS) assert.equal((await w.admin.query("select to_regprocedure($1) is null gone", [f])).rows[0].gone, true, f);
      assert.equal((await w.admin.query("select to_regprocedure('private.fdb_device_authorize(text,uuid)') is null gone")).rows[0].gone, true);
      const after = await counts(w);
      assert.deepEqual({ ...after }, { ...before }, "no row changed or disappeared");
      assert.deepEqual(await w.history(e.installationId), history);
      assert.ok((await acct.call("fdb_account_installations")).length >= 1, "0012 account functions untouched");
      const anon = await w.device();
      await w.fx.resetBudgets();
      assert.equal((await anon.call("ingest_foreverdb_snapshot_auth", [snapshot(instId(), { updatedAt: 1 })])).ok, true);

      const re = psqlFile(clone, APPLY);
      assert.equal(re.status, 0, re.out);
      assert.equal((await w.ingest(e.device, e.secret, snapshot(e.installationId, { updatedAt: 8000 }))).ok, true, "retained registry: the device works again after re-apply");
    });
  });

  it("with empty tables: the private tables are dropped too, and a re-apply recreates a working system", async () => {
    await scenario("rb2", async (w, clone) => {
      await w.admin.query("truncate private.device_audit, private.devices, private.enrollment_tickets");
      const r = psqlFile(clone, ROLLBACK);
      assert.equal(r.status, 0, r.out);
      assert.match(r.out, /private tables were empty and have been dropped/);
      for (const t of ["private.devices", "private.enrollment_tickets", "private.device_audit"]) assert.equal((await w.admin.query("select to_regclass($1) is null gone", [t])).rows[0].gone, true, t);
      const re = psqlFile(clone, APPLY);
      assert.equal(re.status, 0, re.out);
      const acct = await w.account();
      assert.equal((await w.enrolled(acct)).deviceId.length, 36);
    });
  });

  it("the migration is refused on a ledger that already records it, and the forward body is re-appliable on a ledger-less database (idempotent objects)", async () => {
    await scenario("rb3", async (w, clone) => {
      const again = psqlFile(clone, APPLY);
      assert.equal(again.status, 0, again.out);
      // the realistic ledger fixture (schema/table as the platform creates them) is part of the stack
      const sup = await connectSuper(clone);
      try {
        await sup.query("insert into supabase_migrations.schema_migrations (version, name) values ('20261013000000', 'zero_touch_enrollment')");
      } finally {
        await sup.end();
      }
      const refused = psqlFile(clone, APPLY);
      assert.notEqual(refused.status, 0);
      assert.match(refused.out, /ledger already shows zero_touch_enrollment/);
    });
  });
});
