// Failed enrollment, interrupted connections, rollback atomicity and recovery (acceptance test 8).
// Faults are injected with disposable triggers on the private tables (created and dropped by the migration role in this test database).
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { openUserTx, settle } from "../account/harness.mjs";
import { instId, makeWorld, snapshot } from "./world.mjs";

const PUBLIC_ENTRY_POINTS = [
  "public.fdb_account_enrollment_ticket_issue(text)",
  "public.fdb_account_enrollment_tickets()",
  "public.fdb_account_enrollment_ticket_revoke(uuid)",
  "public.fdb_account_devices()",
  "public.fdb_account_device_revoke(uuid)",
  "public.fdb_device_enroll(text,text,text)",
  "public.fdb_device_status(text)",
  "public.fdb_device_ingest(text,jsonb)",
  "public.fdb_device_rotate_credential(text)",
].sort();

let w;
before(async () => {
  w = await makeWorld();
});
after(async () => {
  await w.admin.query("drop trigger if exists fdb_it_fail_device on private.devices").catch(() => {});
  await w.admin.query("drop trigger if exists fdb_it_fail_ticket on private.enrollment_tickets").catch(() => {});
  await w.admin.query("drop function if exists private.fdb_it_fail()").catch(() => {});
  await w.close();
});

async function injectFailure(table, trigger, when) {
  await w.admin.query("create or replace function private.fdb_it_fail() returns trigger language plpgsql as $$ begin raise exception 'injected failure'; end $$");
  await w.admin.query(`create trigger ${trigger} ${when} on ${table} for each row execute function private.fdb_it_fail()`);
}
const removeFailure = async (table, trigger) => w.admin.query(`drop trigger if exists ${trigger} on ${table}`);

/** Observe only the backend this case deliberately kills, including both pg idle-client errors. */
async function terminateBeforeCommit(tx) {
  const errors = [];
  const observe = (error) => errors.push(error);
  tx.on("error", observe);
  let timer;
  const closed = Promise.race([
    new Promise((resolve) => tx.once("end", resolve)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("terminated test client did not close")), 8000);
    }),
  ]);
  // Attach a rejection observer immediately, even if the admin query itself stalls.
  const closure = settle(closed);
  try {
    const result = await w.admin.query("select pg_terminate_backend($1) as terminated", [tx.processID]);
    assert.equal(result.rows[0].terminated, true);
    // Force the previously racy idle-client ordering: no COMMIT is submitted until end.
    const ended = await closure;
    assert.ok(ended.ok, ended.error?.message);
    const commit = await settle(tx.query("commit"));
    assert.equal(commit.ok, false, "a terminated connection cannot commit");
    assert.match(commit.error.message, /connection error.*not queryable/);
    assert.deepEqual(errors.map((error) => error.code ?? error.message), ["57P01", "Connection terminated unexpectedly"], "all and only the deliberately injected disconnect errors were observed");
  } finally {
    // Keep the observer installed until the socket and all its notifications have settled.
    await tx.end();
    const ended = await closure;
    clearTimeout(timer);
    tx.removeListener("error", observe);
    assert.ok(ended.ok, ended.error?.message);
  }
}

describe("failed enrollment rolls back completely and can be retried", () => {
  it("a failure while inserting the device leaves the ticket pending, the installation unreserved and no audit of success; the retry then succeeds", async () => {
    const acct = await w.account();
    const t = await w.ticket(acct);
    const inst = instId();
    const d = await w.device();
    await injectFailure("private.devices", "fdb_it_fail_device", "before insert");
    try {
      await assert.rejects(w.enroll(d, t.ticket, inst), /injected failure/);
    } finally {
      await removeFailure("private.devices", "fdb_it_fail_device");
    }
    assert.equal((await w.ticket_row(t.ticket_id)).status, "pending");
    assert.equal((await w.row("select count(*)::int n from public.installations where id = $1", [inst]))[0].n, 0, "installation reservation rolled back");
    assert.equal((await w.row("select count(*)::int n from private.devices where ticket_id = $1", [t.ticket_id]))[0].n, 0);
    assert.equal((await w.audit("ticket_id = $1 and event = 'enroll_succeeded'", [t.ticket_id])).length, 0);
    const retry = await w.enroll(d, t.ticket, inst);
    assert.equal(retry.ok, true, "recovery: the same ticket and identity work after the fault clears");
  });

  it("a failure while consuming the ticket also rolls back the device row and the reservation", async () => {
    const acct = await w.account();
    const t = await w.ticket(acct);
    const inst = instId();
    const d = await w.device();
    await injectFailure("private.enrollment_tickets", "fdb_it_fail_ticket", "before update");
    try {
      await assert.rejects(w.enroll(d, t.ticket, inst), /injected failure/);
    } finally {
      await removeFailure("private.enrollment_tickets", "fdb_it_fail_ticket");
    }
    assert.equal((await w.ticket_row(t.ticket_id)).status, "pending");
    assert.equal((await w.row("select count(*)::int n from private.devices where ticket_id = $1", [t.ticket_id]))[0].n, 0);
    assert.equal((await w.row("select count(*)::int n from public.installations where id = $1", [inst]))[0].n, 0);
    assert.equal((await w.enroll(d, t.ticket, inst)).ok, true);
  });
});

describe("interrupted network requests", () => {
  it("the connection dies after the server did the work but BEFORE commit (request lost in flight): nothing persists and the retry succeeds", async () => {
    const acct = await w.account();
    const t = await w.ticket(acct);
    const inst = instId();
    const d = await w.device();
    await w.fx.resetBudgets();
    const tx = await openUserTx(d.claims);
    try {
      const out = (await tx.query("select public.fdb_device_enroll($1,$2,$3) as r", [t.ticket, inst, "PC"])).rows[0].r;
      assert.equal(out.ok, true, "the server-side work completed inside the transaction");
      await terminateBeforeCommit(tx);
    } finally {
      await tx.end();
    }
    assert.equal((await w.ticket_row(t.ticket_id)).status, "pending");
    assert.equal((await w.row("select count(*)::int n from public.installations where id = $1", [inst]))[0].n, 0);
    assert.equal((await w.row("select count(*)::int n from private.devices where ticket_id = $1", [t.ticket_id]))[0].n, 0);
    assert.equal((await w.enroll(d, t.ticket, inst)).ok, true);
  });

  it("the reply is lost AFTER commit: the retry sees ticket_consumed (never a second device); recovery is a NEW ticket for the same identity and installation", async () => {
    const acct = await w.account();
    const d = await w.device();
    const inst = instId();
    const t = await w.ticket(acct);
    const first = await w.enroll(d, t.ticket, inst); // committed; pretend the response never reached the Companion
    assert.equal(first.ok, true);
    assert.deepEqual(await w.enroll(d, t.ticket, inst), { ok: false, error: "ticket_consumed" });
    assert.equal((await w.row("select count(*)::int n from private.devices where installation_id = $1", [inst]))[0].n, 1);
    // the credential the Companion never received is unusable by anyone but is replaced through the website
    const t2 = await w.ticket(acct);
    const second = await w.enroll(d, t2.ticket, inst);
    assert.equal(second.ok, true);
    assert.notEqual(second.device_secret, first.device_secret);
    assert.deepEqual(await w.ingest(d, first.device_secret, snapshot(inst, { updatedAt: 5000 })), { ok: false, error: "device_revoked" });
    assert.equal((await w.ingest(d, second.device_secret, snapshot(inst, { updatedAt: 5000 }))).ok, true);
  });

  it("a statement timeout / lock timeout configuration exists on every 0014 entry point (a stuck request cannot hold locks forever)", async () => {
    const rows = (await w.admin.query(
      `select n.nspname || '.' || p.proname || '(' || replace(pg_catalog.oidvectortypes(p.proargtypes), ', ', ',') || ')' sig,
              p.proconfig
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where p.pronamespace = 'public'::regnamespace
          and (p.proname like 'fdb_device_%' or p.proname like 'fdb_account_enrollment_%'
            or p.proname in ('fdb_account_devices','fdb_account_device_revoke'))
        order by sig`)).rows;
    assert.deepEqual(rows.map((r) => r.sig), PUBLIC_ENTRY_POINTS);
    for (const r of rows) assert.ok(r.proconfig.some((c) => c.startsWith("lock_timeout=")), r.sig);
  });
});

describe("ingest failure atomicity", () => {
  it("an unsupported schema version is refused before anything is touched", async () => {
    const e = await w.enrolled(await w.account());
    assert.equal((await w.ingest(e.device, e.secret, snapshot(e.installationId, { updatedAt: 5000 }))).ok, true);
    const before = await w.history(e.installationId);
    const bad = snapshot(e.installationId, { updatedAt: 6000 });
    bad.schemaVersion = 3;
    await assert.rejects(w.ingest(e.device, e.secret, bad), /Unsupported ForeverDB schema version/);
    assert.deepEqual(await w.history(e.installationId), before);
  });

  it("a failure AFTER the implementation already deleted the old rows (corrupt item id mid-snapshot) rolls everything back: the previous history survives", async () => {
    const e = await w.enrolled(await w.account());
    assert.equal((await w.ingest(e.device, e.secret, snapshot(e.installationId, { updatedAt: 5000 }))).ok, true);
    const before = await w.history(e.installationId);
    assert.ok(before.source.startsWith("3:"), "baseline has data");
    const bad = snapshot(e.installationId, { updatedAt: 6000 });
    bad.sources[2].buckets[0].items[0].itemId = "not-a-number";
    await assert.rejects(w.ingest(e.device, e.secret, bad));
    assert.deepEqual(await w.history(e.installationId), before, "nothing deleted, nothing half-written");
    // and the device still works afterwards
    assert.equal((await w.ingest(e.device, e.secret, snapshot(e.installationId, { updatedAt: 7000 }))).ok, true);
  });

  it("disconnect before COMMIT of a device ingest leaves history untouched", async () => {
    const e = await w.enrolled(await w.account());
    assert.equal((await w.ingest(e.device, e.secret, snapshot(e.installationId, { updatedAt: 5000, sources: 1 }))).ok, true);
    const before = await w.history(e.installationId);
    await w.fx.resetBudgets();
    const tx = await openUserTx(e.device.claims);
    try {
      const r = (await tx.query("select public.fdb_device_ingest($1,$2) as r", [e.secret, snapshot(e.installationId, { updatedAt: 6000, sources: 3 })])).rows[0].r;
      assert.equal(r.ok, true);
      await terminateBeforeCommit(tx);
    } finally {
      await tx.end();
    }
    assert.deepEqual(await w.history(e.installationId), before);
  });
});

describe("registry invariants survive every failure above", () => {
  it("every consumed ticket has exactly one device, and no installation has two live devices", async () => {
    const orphanConsumed = await w.row("select t.id from private.enrollment_tickets t where t.status = 'consumed' and not exists (select 1 from private.devices d where d.ticket_id = t.id)");
    assert.deepEqual(orphanConsumed, [], "a consumed ticket always has its device");
    const dupTicket = await w.row("select ticket_id from private.devices group by 1 having count(*) > 1");
    assert.deepEqual(dupTicket, [], "a ticket never produces two devices");
    const dupLive = await w.row("select installation_id from private.devices where status <> 'revoked' group by 1 having count(*) > 1");
    assert.deepEqual(dupLive, []);
  });
});
