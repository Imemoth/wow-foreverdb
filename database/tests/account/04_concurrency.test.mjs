// Ownership concurrency against REAL concurrent transactions (separate backends). At most one registered account may become
// the owner, history stays intact, nothing deadlocks, and session revocation can never be overtaken by a claim.
import { after, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Fixtures, connect, expectCode, holdInstallationLock, openUserTx, rpc, settle, sleep, snapshot, uniq, waitUntilBlocked,
} from "./harness.mjs";

const admin = await connect();
const fx = new Fixtures(admin);
const pool = [];
async function conn() {
  const c = await connect();
  pool.push(c);
  return c;
}
after(async () => {
  for (const c of pool) await c.end().catch(() => {});
  await admin.end();
});
beforeEach(() => fx.resetBudgets());

const INVALID = { ok: false, error: "invalid_claim" };
async function setup() {
  const owner = await fx.identity({ anonymous: true });
  const inst = uniq("cc");
  await fx.installation(inst, owner.uid);
  return { owner, inst };
}
const A = await conn();
const B = await conn();
const C = await conn();
const D = await conn();

const redeem = (client, id, code) => rpc(client, id.claims, "fdb_account_claim_redeem", [code]);
const start = (client, id, inst) => rpc(client, id.claims, "fdb_account_claim_start", [inst]);

async function assertConsistent(inst, origOwner) {
  const claims = await fx.claimRows(inst);
  const pending = claims.filter((c) => c.status === "pending");
  const consumed = claims.filter((c) => c.status === "consumed");
  const links = (await admin.query("select * from private.account_installations where installation_id = $1", [inst])).rows;
  const owner = await fx.owner(inst);
  assert.ok(pending.length <= 1, "at most one pending claim");
  assert.ok(consumed.length <= 1, "a claim chain consumes at most once");
  if (owner === origOwner) {
    assert.equal(consumed.length, 0);
    assert.equal(links.length, 0);
  } else {
    assert.equal(consumed.length, 1);
    assert.equal(links.length, 1);
    assert.equal(links[0].account_uid, owner);
    assert.equal(links[0].previous_owner_uid, origOwner);
    assert.equal(consumed[0].consumed_by, owner);
    assert.equal(pending.length, 0, "no pending claim survives a transfer");
  }
}

describe("simultaneous redemption", () => {
  it("two registered users race for one code: exactly one wins (queued behind the installation lock, released together)", async () => {
    const { owner, inst } = await setup();
    const r1 = await fx.identity();
    const r2 = await fx.identity();
    const { code } = await start(A, owner, inst);
    const hold = await holdInstallationLock(inst);
    const p1 = settle(redeem(B, r1, code));
    const p2 = settle(redeem(C, r2, code));
    await waitUntilBlocked(admin, B);
    await waitUntilBlocked(admin, C);
    await hold.release();
    const [x, y] = await Promise.all([p1, p2]);
    assert.ok(x.ok && y.ok, JSON.stringify([x.error?.message, y.error?.message]));
    const results = [x.value, y.value];
    assert.equal(results.filter((r) => r.ok === true).length, 1);
    assert.deepEqual(results.find((r) => r.ok !== true), INVALID);
    const winner = x.value.ok ? r1 : r2;
    assert.equal(await fx.owner(inst), winner.uid);
    await assertConsistent(inst, owner.uid);
  });

  it("100 unsynchronised rounds of two accounts racing: never two owners, never two links", async () => {
    for (let i = 0; i < 100; i += 1) {
      await fx.resetBudgets();
      const { owner, inst } = await setup();
      const r1 = await fx.identity();
      const r2 = await fx.identity();
      const { code } = await start(A, owner, inst);
      const [x, y] = await Promise.all([settle(redeem(B, r1, code)), settle(redeem(C, r2, code))]);
      assert.ok(x.ok && y.ok, JSON.stringify([x.error?.message, y.error?.message]));
      assert.equal([x.value, y.value].filter((r) => r.ok === true).length, 1);
      await assertConsistent(inst, owner.uid);
    }
  });

  it("the same account redeeming twice at once: one success, one replay failure", async () => {
    const { owner, inst } = await setup();
    const reg = await fx.identity();
    const { code } = await start(A, owner, inst);
    const [x, y] = await Promise.all([settle(redeem(B, reg, code)), settle(redeem(C, reg, code))]);
    assert.ok(x.ok && y.ok);
    assert.equal([x.value, y.value].filter((r) => r.ok === true).length, 1);
    assert.deepEqual([x.value, y.value].find((r) => r.ok !== true), INVALID);
    assert.equal(await fx.owner(inst), reg.uid);
    await assertConsistent(inst, owner.uid);
  });
});

describe("claim issuance races", () => {
  it("parallel claim issuance for one installation: both succeed serially, exactly one pending claim remains, the loser's code is dead", async () => {
    const { owner, inst } = await setup();
    const hold = await holdInstallationLock(inst);
    const p1 = settle(start(A, owner, inst));
    const p2 = settle(start(B, owner, inst));
    await waitUntilBlocked(admin, A);
    await waitUntilBlocked(admin, B);
    await hold.release();
    const [x, y] = await Promise.all([p1, p2]);
    assert.ok(x.ok && y.ok && x.value.ok && y.value.ok);
    const claims = await fx.claimRows(inst);
    assert.equal(claims.filter((c) => c.status === "pending").length, 1);
    assert.equal(claims.filter((c) => c.status === "revoked").length, 1);
    const reg = await fx.identity();
    const codes = [x.value.code, y.value.code];
    const results = [];
    for (const code of codes) results.push(await redeem(D, reg, code));
    assert.equal(results.filter((r) => r.ok).length, 1, "exactly one of the two codes still works");
  });

  it("claim replacement during redemption, replacement first: the redeem fails, the new code works", async () => {
    const { owner, inst } = await setup();
    const reg = await fx.identity();
    const { code: oldCode } = await start(A, owner, inst);
    const hold = await holdInstallationLock(inst);
    const s = settle(start(B, owner, inst));
    await waitUntilBlocked(admin, B);
    const r = settle(redeem(C, reg, oldCode)); // queued SECOND on the advisory lock
    await waitUntilBlocked(admin, C);
    await hold.release();
    const [sr, rr] = await Promise.all([s, r]);
    assert.equal(sr.value.ok, true);
    assert.deepEqual(rr.value, INVALID);
    assert.equal((await redeem(D, reg, sr.value.code)).ok, true);
    await assertConsistent(inst, owner.uid);
  });

  it("claim replacement during redemption, redeem first: the redeem wins and the late start is refused (owner is no longer anonymous)", async () => {
    const { owner, inst } = await setup();
    const reg = await fx.identity();
    const { code } = await start(A, owner, inst);
    const hold = await holdInstallationLock(inst);
    const r = settle(redeem(C, reg, code)); // queued FIRST
    await waitUntilBlocked(admin, C);
    const s = settle(start(B, owner, inst));
    await waitUntilBlocked(admin, B);
    await hold.release();
    const [rr, sr] = await Promise.all([r, s]);
    assert.equal(rr.value.ok, true);
    assert.deepEqual(sr.value, { ok: false, error: "not_available" });
    assert.equal(await fx.owner(inst), reg.uid);
    await assertConsistent(inst, owner.uid);
  });

  it("owner changes while a claim is pending and a redeem is queued: the redeem fails and nothing moves", async () => {
    const { owner, inst } = await setup();
    const reg = await fx.identity();
    const newOwner = await fx.identity({ anonymous: true });
    const { code } = await start(A, owner, inst);
    const hold = await holdInstallationLock(inst);
    const r = settle(redeem(B, reg, code));
    await waitUntilBlocked(admin, B);
    await admin.query("update public.installations set owner_user_id = $2 where id = $1", [inst, newOwner.uid]);
    await hold.release();
    assert.deepEqual((await r).value, INVALID);
    assert.equal(await fx.owner(inst), newOwner.uid);
    assert.equal((await fx.claimRows(inst))[0].status, "pending");
  });
});

describe("ownership transfer racing ingestion (same advisory lock as ingest)", () => {
  it("ingest in flight, redeem arrives: the redeem waits for the ingest, the snapshot lands under the OLD owner, then ownership flips; no rows lost or duplicated", async () => {
    const { owner, inst } = await setup();
    const reg = await fx.identity();
    const { code } = await start(A, owner, inst);
    const ingestTx = await openUserTx(owner.claims);
    pool.push(ingestTx);
    const snap = snapshot(inst, { updatedAt: 2000 });
    await ingestTx.query("select public.ingest_foreverdb_snapshot_auth($1::jsonb)", [JSON.stringify(snap)]);
    const r = settle(redeem(B, reg, code));
    await waitUntilBlocked(admin, B);
    assert.equal(await fx.owner(inst), owner.uid, "still the old owner while the ingest transaction is open");
    await ingestTx.query("commit");
    const result = await r;
    assert.equal(result.value.ok, true);
    assert.equal(await fx.owner(inst), reg.uid);
    const counts = await admin.query(
      `select (select count(*)::int from public.installation_source_stats where installation_id = $1) s,
              (select count(*)::int from public.installation_item_stats where installation_id = $1) i,
              (select count(*)::int from public.installation_guild_members where installation_id = $1) m`,
      [inst],
    );
    assert.deepEqual(counts.rows[0], { s: 3, i: 6, m: 8 });
    await assertConsistent(inst, owner.uid);
  });

  it("redeem in flight, the old owner's ingest arrives: it waits, then fails closed ('belongs to another') and writes nothing", async () => {
    const { owner, inst } = await setup();
    const reg = await fx.identity();
    const { code } = await start(A, owner, inst);
    const redeemTx = await openUserTx(reg.claims);
    pool.push(redeemTx);
    const rr = await redeemTx.query("select public.fdb_account_claim_redeem($1) as r", [code]);
    assert.equal(rr.rows[0].r.ok, true);
    const ingest = settle(rpc(C, owner.claims, "ingest_foreverdb_snapshot_auth", [snapshot(inst, { updatedAt: 3000 })]));
    await waitUntilBlocked(admin, C);
    await redeemTx.query("commit");
    const out = await ingest;
    assert.equal(out.ok, false);
    assert.match(out.error.message, /belongs to another authenticated client/);
    const n = await admin.query("select count(*)::int n from public.installation_source_stats where installation_id = $1", [inst]);
    assert.equal(n.rows[0].n, 0, "the rejected ingest wrote nothing");
    // the new owner can now ingest
    const ok = await rpc(D, reg.claims, "ingest_foreverdb_snapshot_auth", [snapshot(inst, { updatedAt: 3000 })]);
    assert.equal(ok.ok, true);
  });
});

describe("session revocation races (LS-11)", () => {
  it("LS-11 (window): revocation committing AFTER the guard and BEFORE the row lock makes claim_start fail; no claim exists", async () => {
    const { owner, inst } = await setup();
    const hold = await holdInstallationLock(inst);
    const s = settle(start(A, owner, inst)); // passes the guard, then blocks on the advisory lock
    await waitUntilBlocked(admin, A);
    await admin.query("delete from auth.sessions where id = $1", [owner.sid]); // sign-out commits first
    await hold.release();
    const out = await s;
    assert.equal(out.ok, false);
    assert.equal(out.error.code, "PT401");
    assert.equal((await fx.claimRows(inst)).length, 0);
    assert.equal((await fx.audit(inst)).length, 0);
    assert.equal(await fx.owner(inst), owner.uid);
  });

  it("LS-11 (row lock): a sign-out arriving while claim_start holds the session row WAITS for it; the claim was issued strictly before the revocation", async () => {
    const { owner, inst } = await setup();
    const tx = await openUserTx(owner.claims);
    pool.push(tx);
    const out = await tx.query("select public.fdb_account_claim_start($1) as r", [inst]);
    assert.equal(out.rows[0].r.ok, true);
    const revoker = await conn();
    const revoke = settle(revoker.query("delete from auth.sessions where id = $1", [owner.sid]));
    await waitUntilBlocked(admin, revoker);
    assert.equal((await admin.query("select 1 from auth.sessions where id = $1", [owner.sid])).rowCount, 1, "revocation has not happened yet");
    await tx.query("commit");
    assert.ok((await revoke).ok);
    assert.equal((await admin.query("select 1 from auth.sessions where id = $1", [owner.sid])).rowCount, 0);
    // the code exists but its issuing session is gone: it cannot be redeemed
    const reg = await fx.identity();
    assert.deepEqual(await redeem(D, reg, await (async () => { /* code is only in the committed response */ return out.rows[0].r.code; })()), INVALID);
    assert.equal(await fx.owner(inst), owner.uid);
  });

  it("LS-11 (stress): 150 unsynchronised start-vs-sign-out races; a claim exists ONLY if it committed before the sign-out committed", async () => {
    const E = await conn();
    let issued = 0;
    let refused = 0;
    for (let i = 0; i < 150; i += 1) {
      await fx.resetBudgets();
      const { owner, inst } = await setup();
      const started = settle(start(A, owner, inst));
      await sleep(Math.random() * 4);
      await E.query("begin");
      const revokeXid = (await E.query("select txid_current()::text as x")).rows[0].x;
      await E.query("delete from auth.sessions where id = $1", [owner.sid]);
      await E.query("commit");
      const out = await started;
      const claims = await fx.claimRows(inst);
      if (claims.length === 1) {
        issued += 1;
        assert.ok(out.ok && out.value.ok, "a stored claim implies a successful response");
        const claimXid = (await admin.query("select xmin::text as x from private.installation_claims where id = $1", [claims[0].id])).rows[0].x;
        const claimTs = (await admin.query("select pg_xact_commit_timestamp($1::xid) as t", [claimXid])).rows[0].t;
        const revokeTs = (await admin.query("select pg_xact_commit_timestamp($1::xid) as t", [revokeXid])).rows[0].t;
        assert.ok(claimTs <= revokeTs, `claim committed ${claimTs.toISOString()} after the revocation ${revokeTs.toISOString()}`);
      } else {
        refused += 1;
        assert.equal(claims.length, 0);
        assert.ok(!out.ok && out.error.code === "PT401", `refusal must be PT401, got ${out.error?.code ?? JSON.stringify(out.value)}`);
        assert.equal((await fx.audit(inst)).length, 0);
      }
      assert.equal(await fx.owner(inst), owner.uid);
    }
    console.log(`# LS-11 stress: ${issued} claims issued strictly before revocation, ${refused} refused with PT401`);
  });
});

describe("issuing-session revocation racing redemption", () => {
  it("revocation committing while the redeem is queued: invalid_claim, claim not consumed", async () => {
    const { owner, inst } = await setup();
    const reg = await fx.identity();
    const { code } = await start(A, owner, inst);
    const hold = await holdInstallationLock(inst);
    const r = settle(redeem(B, reg, code));
    await waitUntilBlocked(admin, B);
    await admin.query("delete from auth.sessions where id = $1", [owner.sid]);
    await hold.release();
    assert.deepEqual((await r).value, INVALID);
    assert.equal(await fx.owner(inst), owner.uid);
    assert.equal((await fx.claimRows(inst))[0].status, "pending");
  });

  it("a sign-out of the issuing session arriving while the redeem holds its row lock waits for the redeem (the transfer completed first)", async () => {
    const { owner, inst } = await setup();
    const reg = await fx.identity();
    const { code } = await start(A, owner, inst);
    const tx = await openUserTx(reg.claims);
    pool.push(tx);
    assert.equal((await tx.query("select public.fdb_account_claim_redeem($1) as r", [code])).rows[0].r.ok, true);
    const revoker = await conn();
    const revoke = settle(revoker.query("delete from auth.sessions where id = $1", [owner.sid]));
    await waitUntilBlocked(admin, revoker);
    await tx.query("commit");
    assert.ok((await revoke).ok);
    assert.equal(await fx.owner(inst), reg.uid);
  });

  it("the redeemer's own sign-out racing its redeem: either the redeem completed first or it fails with PT401, never a transfer after revocation", async () => {
    const E = await conn();
    for (let i = 0; i < 60; i += 1) {
      await fx.resetBudgets();
      const { owner, inst } = await setup();
      const reg = await fx.identity();
      const { code } = await start(A, owner, inst);
      const redeeming = settle(redeem(B, reg, code));
      await sleep(Math.random() * 4);
      await E.query("begin");
      const revokeXid = (await E.query("select txid_current()::text as x")).rows[0].x;
      await E.query("delete from auth.sessions where id = $1", [reg.sid]);
      await E.query("commit");
      const out = await redeeming;
      if ((await fx.owner(inst)) === reg.uid) {
        const link = (await admin.query("select xmin::text as x from private.account_installations where installation_id = $1", [inst])).rows[0];
        const ts = (await admin.query("select pg_xact_commit_timestamp($1::xid) as t", [link.x])).rows[0].t;
        const revokeTs = (await admin.query("select pg_xact_commit_timestamp($1::xid) as t", [revokeXid])).rows[0].t;
        assert.ok(ts <= revokeTs, "transfer committed before the redeemer's sign-out");
      } else {
        assert.ok(!out.ok && out.error.code === "PT401");
        assert.equal((await fx.claimRows(inst))[0].status, "pending");
      }
      await assertConsistent(inst, owner.uid);
    }
  });
});

describe("lock timeouts", () => {
  it("redeem and start queue behind a long ingest-style lock and fail cleanly with 55P03 after ~5 s, leaving no state behind", async () => {
    const { owner, inst } = await setup();
    const reg = await fx.identity();
    const { code } = await start(A, owner, inst);
    const before = await fx.claimRows(inst);
    const hold = await holdInstallationLock(inst);
    const t0 = Date.now();
    const [r, s] = await Promise.all([settle(redeem(B, reg, code)), settle(start(C, owner, inst))]);
    const elapsed = Date.now() - t0;
    assert.ok(!r.ok && r.error.code === "55P03", r.error?.message);
    assert.ok(!s.ok && s.error.code === "55P03", s.error?.message);
    assert.ok(elapsed >= 4500 && elapsed < 9000, `elapsed ${elapsed}ms`);
    await hold.release();
    assert.deepEqual(await fx.claimRows(inst), before, "claim rows untouched");
    assert.equal(await fx.owner(inst), owner.uid);
    assert.equal((await redeem(D, reg, code)).ok, true, "the code still works after the timeout");
  });
});

describe("failure after commit but before the response is delivered", () => {
  it("protocol recovery: after a lost response the replay is refused, the old owner sees 'transferred', the new owner lists the installation", async () => {
    const { owner, inst } = await setup();
    const reg = await fx.identity();
    const { code } = await start(A, owner, inst);
    await redeem(B, reg, code); // the response is "lost": the client never saw it
    assert.deepEqual(await redeem(B, reg, code), INVALID);
    assert.deepEqual(await rpc(C, owner.claims, "fdb_installation_link_status", [inst]), { state: "transferred" });
    assert.deepEqual(await rpc(C, reg.claims, "fdb_installation_link_status", [inst]), { state: "owned" });
    assert.ok((await rpc(C, reg.claims, "fdb_account_installations")).some((r) => r.installation_id === inst));
    assert.deepEqual(await rpc(C, owner.claims, "fdb_account_claim_start", [inst]), { ok: false, error: "not_available" }, "the former owner can no longer issue claims");
  });

  it("client disconnects at a random moment during redeem: the outcome is all-or-nothing in every one of 40 rounds", async () => {
    let committed = 0;
    let rolledBack = 0;
    for (let i = 0; i < 40; i += 1) {
      await fx.resetBudgets();
      const { owner, inst } = await setup();
      const reg = await fx.identity();
      const { code } = await start(A, owner, inst);
      const victim = await connect();
      const pid = victim.processID;
      victim.on("error", () => {});
      const run = (async () => {
        await victim.query("begin");
        await victim.query("set local role authenticated");
        await victim.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(reg.claims)]);
        await victim.query("select public.fdb_account_claim_redeem($1)", [code]);
        await victim.query("commit");
      })().catch(() => {});
      await sleep(Math.random() * 12);
      victim.connection.stream.destroy();
      await run;
      for (let k = 0; k < 200; k += 1) {
        const alive = await admin.query("select 1 from pg_stat_activity where pid = $1", [pid]);
        if (alive.rowCount === 0) break;
        await sleep(10);
      }
      const owned = (await fx.owner(inst)) === reg.uid;
      await assertConsistent(inst, owner.uid);
      if (owned) {
        committed += 1;
        assert.equal((await fx.claimRows(inst))[0].status, "consumed");
        assert.deepEqual((await fx.audit(inst)).map((a) => a.event), ["claim_started", "claim_redeemed"]);
      } else {
        rolledBack += 1;
        assert.equal((await fx.claimRows(inst))[0].status, "pending", "rolled back entirely: claim still pending");
        assert.equal((await fx.claimRows(inst))[0].attempts, 0);
        assert.deepEqual((await fx.audit(inst)).map((a) => a.event), ["claim_started"]);
        assert.equal((await redeem(B, reg, code)).ok, true, "and the code is still redeemable");
      }
    }
    console.log(`# disconnect rounds: ${committed} committed, ${rolledBack} rolled back (both atomic)`);
  });
});

describe("mixed workload: no deadlocks, invariants hold", () => {
  it("up to 16 parallel jobs (starts, redeems, ingests, sign-outs, status calls) over shared installations for 25 rounds", async () => {
    const clients = [];
    for (let i = 0; i < 20; i += 1) clients.push(await conn()); // one connection per concurrent job (a connection runs one transaction at a time)
    const deadlocks = [];
    const unexpected = [];
    const note = (out) => {
      if (out.ok) return;
      if (out.error.code === "40P01") deadlocks.push(out.error.message);
      else if (!["PT401", "PT403", "PT429", "55P03"].includes(out.error.code) && !/belongs to another/.test(out.error.message)) unexpected.push(`${out.error.code} ${out.error.message}`);
    };
    for (let round = 0; round < 25; round += 1) {
      await fx.resetBudgets();
      const owners = [];
      const regs = [await fx.identity(), await fx.identity()];
      for (let k = 0; k < 3; k += 1) {
        const owner = await fx.identity({ anonymous: true });
        const inst = uniq("mix");
        await fx.installation(inst, owner.uid);
        owners.push({ owner, inst });
      }
      const codes = [];
      for (const { owner, inst } of owners) codes.push((await start(A, owner, inst)).code);
      const jobs = [];
      let c = 0;
      const next = () => clients[c++];
      owners.forEach(({ owner, inst }, k) => {
        jobs.push(settle(redeem(next(), regs[0], codes[k])));
        jobs.push(settle(redeem(next(), regs[1], codes[k])));
        jobs.push(settle(start(next(), owner, inst)));
        jobs.push(settle(rpc(next(), owner.claims, "ingest_foreverdb_snapshot_auth", [snapshot(inst, { updatedAt: 5000 + round })])));
        jobs.push(settle(rpc(next(), owner.claims, "fdb_installation_link_status", [inst])));
        if (k === 1) jobs.push(settle(admin.query("delete from auth.sessions where id = $1", [owner.sid])));
      });
      for (const out of await Promise.all(jobs)) note(out);
      for (const { owner, inst } of owners) await assertConsistent(inst, owner.uid);
    }
    assert.deepEqual(deadlocks, [], "no deadlock_detected (40P01)");
    assert.deepEqual(unexpected, [], "no unexpected error class");
  });
});
