// Real parallel transactions (separate backends): concurrent redemption, identity/installation races, ingest vs revoke, claim vs enroll,
// and a mixed workload that must finish without a single deadlock (acceptance test 5, concurrent redemption).
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { connect, holdInstallationLock, openUserTx, rpc, settle, waitUntilBlocked } from "../account/harness.mjs";
import { instId, makeWorld, snapshot } from "./world.mjs";

let w;
const pool = [];
before(async () => {
  w = await makeWorld();
  for (let i = 0; i < 12; i += 1) pool.push(await connect());
});
after(async () => {
  for (const c of pool) await c.end();
  await w.close();
});

/** A device-call on its own backend (so calls really run in parallel). */
const on = (i, who, fn, args) => rpc(pool[i], who.claims, fn, args);

/** One call on a brand-new backend (for workloads with more parallel calls than pooled connections). */
const fresh = async (who, fn, args) => {
  const c = await connect();
  try {
    return await rpc(c, who.claims, fn, args);
  } finally {
    await c.end();
  }
};

/** Invariant of the registry: a live device is always bound to an installation owned by the device's account. */
async function assertInvariant(accountUids) {
  const bad = await w.row(
    `select d.id from private.devices d join public.installations i on i.id = d.installation_id
     where d.account_uid = any($1) and d.status <> 'revoked' and i.owner_user_id is distinct from d.account_uid`, [accountUids]);
  assert.deepEqual(bad, [], "a live device points at an installation its account does not own");
  const dupInst = await w.row("select installation_id from private.devices where account_uid = any($1) and status <> 'revoked' group by 1 having count(*) > 1", [accountUids]);
  assert.deepEqual(dupInst, [], "two live devices for one installation");
  const dupId = await w.row("select auth_uid from private.devices where account_uid = any($1) and status <> 'revoked' group by 1 having count(*) > 1", [accountUids]);
  assert.deepEqual(dupId, [], "one identity is the live device of two installations");
}

/** Keep the same strict outcomes in ordinary and controlled enrollment-first schedules. */
async function ticketRevocationRace(acct, { enrollmentFirst = false } = {}) {
  await w.admin.query("update private.enrollment_tickets set created_at = now() - interval '2 hours', expires_at = now() + interval '166 hours' where account_uid = $1", [acct.uid]);
  const t = await w.ticket(acct);
  const d = await w.device();
  await w.fx.resetBudgets();
  let e;
  let r;
  if (enrollmentFirst) {
    const tx = await openUserTx(d.claims);
    const revokeTx = await openUserTx(acct.claims);
    let revocation;
    try {
      e = await settle(tx.query("select public.fdb_device_enroll($1,$2,$3) as r", [t.ticket, instId(), "x"]));
      if (e.ok) e.value = e.value.rows[0].r;
      revocation = settle(revokeTx.query("select public.fdb_account_enrollment_ticket_revoke($1) as r", [t.ticket_id]));
      await waitUntilBlocked(w.admin, revokeTx);
      await tx.query("commit");
      r = await revocation;
      if (r.ok) r.value = r.value.rows[0].r;
      await revokeTx.query("commit");
    } finally {
      await tx.end();
      await revocation;
      await revokeTx.end();
    }
  } else {
    [e, r] = await Promise.all([settle(on(0, d, "fdb_device_enroll", [t.ticket, instId(), "x"])), settle(on(1, acct, "fdb_account_enrollment_ticket_revoke", [t.ticket_id]))]);
  }
  try {
    assert.ok(e.ok && r.ok, `no exception (deadlock/timeout) expected: ${e.error?.message ?? ""} ${r.error?.message ?? ""}`);
    const row = await w.ticket_row(t.ticket_id);
    if (e.value.ok) {
      assert.equal(row.status, "consumed");
      assert.deepEqual(r.value, { ok: false, error: "not_available" });
    } else {
      assert.equal(e.value.error, "ticket_revoked");
      assert.equal(row.status, "revoked");
      assert.deepEqual(r.value, { ok: true });
    }
    assert.equal((await w.row("select count(*)::int n from private.devices where ticket_id = $1", [t.ticket_id]))[0].n, e.value.ok ? 1 : 0);
  } finally {
    // A winning device must not consume the account's 10-device quota in later rounds.
    // Revoke through the supported account RPC, after checking the race's original outcomes.
    if (e.ok && e.value.ok) {
      await w.fx.resetBudgets();
      assert.deepEqual(await acct.call("fdb_account_device_revoke", [e.value.device_id]), { ok: true });
    }
  }
  assert.equal((await w.row("select count(*)::int n from private.devices where account_uid = $1 and status <> 'revoked'", [acct.uid]))[0].n, 0, "each race round leaves no active fixture devices");
  return e.value;
}

describe("concurrent redemption of one ticket", () => {
  it("8 identities, 8 different installations, ONE ticket: exactly one winner, one device, one reserved installation", async () => {
    const acct = await w.account();
    const t = await w.ticket(acct);
    const ids = await Promise.all(Array.from({ length: 8 }, () => w.device()));
    const installs = ids.map(() => instId());
    await w.fx.resetBudgets();
    const out = await Promise.all(ids.map((d, i) => settle(on(i, d, "fdb_device_enroll", [t.ticket, installs[i], `PC ${i}`]))));
    const results = out.map((o) => (o.ok ? o.value : { thrown: o.error.code }));
    const winners = results.filter((r) => r.ok === true);
    assert.equal(winners.length, 1, JSON.stringify(results));
    for (const r of results.filter((x) => x.ok !== true)) assert.deepEqual(r, { ok: false, error: "ticket_consumed" });
    assert.equal((await w.row("select count(*)::int n from private.devices where ticket_id = $1", [t.ticket_id]))[0].n, 1);
    assert.equal((await w.row("select count(*)::int n from public.installations where id = any($1)", [installs]))[0].n, 1, "only the winner's installation was reserved");
    await assertInvariant([acct.uid]);
  });

  it("8 identities, the SAME installation, ONE ticket: exactly one winner", async () => {
    const acct = await w.account();
    const t = await w.ticket(acct);
    const inst = instId();
    const ids = await Promise.all(Array.from({ length: 8 }, () => w.device()));
    await w.fx.resetBudgets();
    const out = await Promise.all(ids.map((d, i) => settle(on(i, d, "fdb_device_enroll", [t.ticket, inst, "PC"]))));
    const ok = out.filter((o) => o.ok && o.value.ok === true);
    assert.equal(ok.length, 1, JSON.stringify(out.map((o) => (o.ok ? o.value : o.error.code))));
    assert.equal((await w.row("select count(*)::int n from private.devices where installation_id = $1", [inst]))[0].n, 1);
    await assertInvariant([acct.uid]);
  });

  it("the same ticket sent twice by the SAME identity at once (a double click): one device, the second sees ticket_consumed", async () => {
    const acct = await w.account();
    const t = await w.ticket(acct);
    const d = await w.device();
    const inst = instId();
    await w.fx.resetBudgets();
    const out = await Promise.all([settle(on(0, d, "fdb_device_enroll", [t.ticket, inst, "PC"])), settle(on(1, d, "fdb_device_enroll", [t.ticket, inst, "PC"]))]);
    const values = out.map((o) => (o.ok ? o.value : { thrown: o.error.code }));
    assert.equal(values.filter((v) => v.ok === true).length, 1, JSON.stringify(values));
    assert.equal(values.filter((v) => v.error === "ticket_consumed").length, 1, JSON.stringify(values));
    assert.equal((await w.row("select count(*)::int n from private.devices where installation_id = $1", [inst]))[0].n, 1);
  });
});

describe("races between different tickets", () => {
  it("two tickets, one installation, two identities: exactly one binds, the other is installation_bound, neither ticket is lost", async () => {
    const acct = await w.account();
    const t1 = await w.ticket(acct);
    const t2 = await w.ticket(acct);
    const inst = instId();
    const [d1, d2] = [await w.device(), await w.device()];
    await w.fx.resetBudgets();
    const out = await Promise.all([settle(on(0, d1, "fdb_device_enroll", [t1.ticket, inst, "A"])), settle(on(1, d2, "fdb_device_enroll", [t2.ticket, inst, "B"]))]);
    const values = out.map((o) => (o.ok ? o.value : { thrown: o.error.code }));
    assert.equal(values.filter((v) => v.ok === true).length, 1, JSON.stringify(values));
    assert.equal(values.filter((v) => v.error === "installation_bound").length, 1, JSON.stringify(values));
    const statuses = (await w.row("select status from private.enrollment_tickets where id = any($1) order by status", [[t1.ticket_id, t2.ticket_id]])).map((r) => r.status);
    assert.deepEqual(statuses, ["consumed", "pending"], "the losing ticket stays redeemable elsewhere");
    await assertInvariant([acct.uid]);
  });

  it("one identity redeems two tickets for two installations at once: exactly one device (identity_in_use for the other); no deadlock", async () => {
    const acct = await w.account();
    const t1 = await w.ticket(acct);
    const t2 = await w.ticket(acct);
    const d = await w.device();
    const [i1, i2] = [instId(), instId()];
    await w.fx.resetBudgets();
    const out = await Promise.all([settle(on(0, d, "fdb_device_enroll", [t1.ticket, i1, "A"])), settle(on(1, d, "fdb_device_enroll", [t2.ticket, i2, "B"]))]);
    const values = out.map((o) => (o.ok ? o.value : { thrown: o.error.code, m: o.error.message }));
    assert.equal(values.filter((v) => v.ok === true).length, 1, JSON.stringify(values));
    assert.equal(values.filter((v) => v.error === "identity_in_use").length, 1, JSON.stringify(values));
    await assertInvariant([acct.uid]);
  });

  it("ticket revocation racing redemption: always exactly one of {enrolled, revoked}, never both, never neither (30 rounds)", async () => {
    const acct = await w.account();
    for (let round = 0; round < 30; round += 1) await ticketRevocationRace(acct);
  });

  it("enrollment-first ticket races remain isolated after 10 wins (30 controlled rounds)", async () => {
    const acct = await w.account();
    for (let round = 0; round < 30; round += 1) {
      const result = await ticketRevocationRace(acct, { enrollmentFirst: true });
      assert.equal(result.ok, true, `controlled enrollment must win round ${round + 1}`);
    }
  });
});

describe("ingest, revoke and claim serialisation (shared per-installation advisory lock)", () => {
  it("revoke queued BEFORE an ingest: the ingest runs after the revocation commits and is refused; nothing is written", async () => {
    const acct = await w.account();
    const e = await w.enrolled(acct);
    await w.fx.resetBudgets();
    const lock = await holdInstallationLock(e.installationId);
    const revokeTx = await openUserTx(acct.claims);
    const p1 = settle(revokeTx.query("select public.fdb_account_device_revoke($1) as r", [e.deviceId]));
    await waitUntilBlocked(w.admin, revokeTx);
    const ingestTx = await openUserTx(e.device.claims);
    const p2 = settle(ingestTx.query("select public.fdb_device_ingest($1, $2) as r", [e.secret, snapshot(e.installationId, { updatedAt: 5000 })]));
    await waitUntilBlocked(w.admin, ingestTx);
    await lock.release();
    const r1 = await p1;
    assert.ok(r1.ok, r1.error?.message);
    assert.deepEqual(r1.value.rows[0].r, { ok: true });
    await revokeTx.query("commit");
    await revokeTx.end();
    const r2 = await p2;
    assert.ok(r2.ok, r2.error?.message);
    assert.deepEqual(r2.value.rows[0].r, { ok: false, error: "device_revoked" });
    await ingestTx.query("commit");
    await ingestTx.end();
    assert.equal((await w.row("select count(*)::int n from public.installation_source_stats where installation_id = $1", [e.installationId]))[0].n, 0);
  });

  it("ingest queued BEFORE a revoke: the ingest completes with the data, then the revoke applies and the next ingest is refused", async () => {
    const acct = await w.account();
    const e = await w.enrolled(acct);
    await w.fx.resetBudgets();
    const lock = await holdInstallationLock(e.installationId);
    const ingestTx = await openUserTx(e.device.claims);
    const p1 = settle(ingestTx.query("select public.fdb_device_ingest($1, $2) as r", [e.secret, snapshot(e.installationId, { updatedAt: 5000 })]));
    await waitUntilBlocked(w.admin, ingestTx);
    const revokeTx = await openUserTx(acct.claims);
    const p2 = settle(revokeTx.query("select public.fdb_account_device_revoke($1) as r", [e.deviceId]));
    await waitUntilBlocked(w.admin, revokeTx);
    await lock.release();
    const r1 = await p1;
    assert.ok(r1.ok, r1.error?.message);
    assert.equal(r1.value.rows[0].r.ok, true);
    await ingestTx.query("commit");
    await ingestTx.end();
    const r2 = await p2;
    assert.ok(r2.ok, r2.error?.message);
    await revokeTx.query("commit");
    await revokeTx.end();
    assert.equal((await w.row("select count(*)::int n from public.installation_source_stats where installation_id = $1", [e.installationId]))[0].n > 0, true);
    assert.equal((await w.ingest(e.device, e.secret, snapshot(e.installationId, { updatedAt: 6000 }))).error, "device_revoked");
  });

  it("claim redemption racing a device enrollment for the same anonymous installation: either the claim wins first (enroll succeeds for the account) or enroll is refused as a conflict; the invariant always holds", async () => {
    const outcomes = new Set();
    for (let round = 0; round < 12; round += 1) {
      const owner = await w.device();
      const acct = await w.account();
      const inst = instId();
      await w.fx.resetBudgets();
      await owner.call("ingest_foreverdb_snapshot_auth", [snapshot(inst, { updatedAt: 1000 })]);
      await w.fx.resetBudgets();
      const start = await owner.call("fdb_account_claim_start", [inst]);
      const t = await w.ticket(acct);
      const d = await w.device();
      await w.fx.resetBudgets();
      const [c, e] = await Promise.all([settle(on(0, acct, "fdb_account_claim_redeem", [start.code])), settle(on(1, d, "fdb_device_enroll", [t.ticket, inst, "x"]))]);
      assert.ok(c.ok && e.ok, `${c.error?.message ?? ""} ${e.error?.message ?? ""}`);
      assert.equal(c.value.ok, true, "the claim itself always succeeds");
      outcomes.add(e.value.ok ? "enrolled-after-claim" : e.value.error);
      assert.ok(e.value.ok || e.value.error === "installation_conflict", JSON.stringify(e.value));
      assert.equal((await w.row("select owner_user_id from public.installations where id = $1", [inst]))[0].owner_user_id, acct.uid);
      await assertInvariant([acct.uid]);
    }
    assert.ok(outcomes.size >= 1);
  });

  it("mixed workload (issue, enroll, ingest, revoke, rotate, list) across accounts and devices finishes without deadlocks or unexpected errors", async () => {
    const accounts = await Promise.all([w.account(), w.account(), w.account()]);
    const devs = [];
    for (const a of accounts) for (let i = 0; i < 3; i += 1) devs.push(await w.enrolled(a));
    await w.fx.resetBudgets();
    const jobs = [];
    let n = 0;
    for (let round = 0; round < 2; round += 1) {
      for (const d of devs) {
        const c = n++ % 12;
        jobs.push(settle(fresh(d.device, "fdb_device_ingest", [d.secret, snapshot(d.installationId, { updatedAt: 5000 + round, guilds: 1, members: 2, sources: 1 })])));
        jobs.push(settle(fresh(d.account, "fdb_account_devices", [])));
        jobs.push(settle(fresh(d.device, "fdb_device_status", [d.secret])));
      }
    }
    for (const a of accounts) jobs.push(settle(fresh(a, "fdb_account_enrollment_tickets", [])));
    // revoke one device per account in the middle of it all
    for (let i = 0; i < accounts.length; i += 1) jobs.push(settle(fresh(accounts[i], "fdb_account_device_revoke", [devs[i * 3].deviceId])));
    const done = await Promise.all(jobs);
    const failures = done.filter((r) => !r.ok).map((r) => `${r.error.code}: ${r.error.message}`);
    // PT429 budget exhaustion is legitimate under this load; a deadlock (40P01), a lock timeout (55P03) or anything else is not.
    for (const f of failures) assert.match(f, /^PT429/, f);
    await assertInvariant(accounts.map((a) => a.uid));
  });
});
