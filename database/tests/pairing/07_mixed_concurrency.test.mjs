import { after, before, beforeEach, it } from "node:test";
import assert from "node:assert/strict";
import { connect, due, isolatedCall, makePairingWorld, pairRow, pairingInput, startArgs, startPairing } from "./world.mjs";
import { rpc, settle, snapshot, waitUntilBlocked } from "../account/harness.mjs";

let w;
before(async () => { w = await makePairingWorld(); });
after(async () => { await w?.close(); });
beforeEach(async () => { await w.fx.resetBudgets(); });

const bounded = (promise) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error("mixed protocol race timed out")), 10_000)),
]);

async function orderedInstallationRace(installationId, first, second) {
  const hold = await connect(w.database);
  const a = await connect(w.database);
  const b = await connect(w.database);
  await hold.query("begin");
  await hold.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [installationId]);
  try {
    const firstResult = settle(first(a));
    await waitUntilBlocked(w.admin, a);
    const secondResult = settle(second(b));
    await waitUntilBlocked(w.admin, b);
    await hold.query("commit");
    return await bounded(Promise.all([firstResult, secondResult]));
  } catch (error) {
    await hold.query("rollback").catch(() => {});
    throw error;
  } finally {
    await Promise.all([hold.end(), a.end(), b.end()].map((p) => p.catch(() => {})));
  }
}

const call = (client, actor, name, args) => rpc(client, actor.claims, name, args);

it("100 approve/deny races serialize without deadlock or duplicate transition audit", async () => {
  for (let i = 0; i < 100; i += 1) {
    await w.fx.resetBudgets();
    const p = await startPairing(w, await w.device());
    const a = await w.account();
    const b = await w.account();
    await bounded(Promise.all([
      isolatedCall(w, a, "fdb_account_device_pair_approve", [p.id]),
      isolatedCall(w, b, "fdb_account_device_pair_deny", [p.id]),
    ]));
    const row = await pairRow(w, p);
    assert.ok(["approved", "denied"].includes(row.status));
    const n = (await w.admin.query(
      "select count(*)::int n from private.device_pairing_audit where pairing_audit_ref=$1 and event in ('pairing_approved','pairing_denied')",
      [row.audit_ref],
    )).rows[0].n;
    assert.equal(n, 1);
  }
});

it("100 pairing-redemption/claim-transfer races have one ownership winner and no partial provenance", async () => {
  for (let i = 0; i < 100; i += 1) {
    await w.fx.resetBudgets();
    const device = await w.device();
    const pairingAccount = await w.account();
    const claimAccount = await w.account();
    const input = pairingInput();
    await w.fx.installation(input.installationId, device.uid);
    const claim = await device.call("fdb_account_claim_start", [input.installationId]);
    assert.equal(claim.ok, true);
    const p = await startPairing(w, device, input);
    assert.deepEqual(await pairingAccount.call("fdb_account_device_pair_approve", [p.id]), { ok: true, state: "approved" });
    await due(w, p);
    await w.fx.resetBudgets();

    const pairOp = (client) => call(client, device, "fdb_device_pair_poll", [p.id, p.secret]);
    const claimOp = (client) => call(client, claimAccount, "fdb_account_claim_redeem", [claim.code]);
    const ordered = i % 2 === 0 ? [pairOp, claimOp] : [claimOp, pairOp];
    const results = await orderedInstallationRace(input.installationId, ordered[0], ordered[1]);
    const pairResult = results[i % 2 === 0 ? 0 : 1];
    const claimResult = results[i % 2 === 0 ? 1 : 0];
    assert.equal(pairResult.ok, true);
    assert.equal(claimResult.ok, true);
    const pairWon = pairResult.value.state === "connected";
    const claimWon = claimResult.value.ok === true;
    assert.equal(Number(pairWon) + Number(claimWon), 1);

    const row = await pairRow(w, p);
    const devices = (await w.admin.query("select id from private.devices where pairing_id=$1", [p.id])).rows;
    const links = (await w.admin.query("select account_uid,previous_owner_uid from private.account_installations where installation_id=$1", [input.installationId])).rows;
    const terminalAudit = (await w.admin.query(
      "select count(*)::int n from private.device_pairing_audit where pairing_audit_ref=$1 and event in ('pairing_connected','pairing_denied')",
      [row.audit_ref],
    )).rows[0].n;
    assert.equal(terminalAudit, 1);
    if (pairWon) {
      assert.equal(await w.fx.owner(input.installationId), pairingAccount.uid);
      assert.equal(row.status, "connected");
      assert.equal(row.previous_owner_uid, device.uid);
      assert.equal(devices.length, 1);
      assert.equal(links.length, 0);
    } else {
      assert.equal(await w.fx.owner(input.installationId), claimAccount.uid);
      assert.equal(row.status, "denied");
      assert.equal(devices.length, 0);
      assert.deepEqual(links, [{ account_uid: claimAccount.uid, previous_owner_uid: device.uid }]);
    }
  }
});

it("100 pairing-start/ticket-enrollment races preserve one live ticket device in both lock orders", async () => {
  for (let i = 0; i < 100; i += 1) {
    await w.fx.resetBudgets();
    const account = await w.account();
    const device = await w.device();
    const enrolled = await w.enrolled(account, { device });
    assert.deepEqual(await account.call("fdb_account_device_revoke", [enrolled.deviceId]), { ok: true });
    const ticket = await w.ticket(account);
    const p = pairingInput({ installationId: enrolled.installationId });
    await w.fx.resetBudgets();

    const pairOp = (client) => call(client, device, "fdb_device_pair_start", startArgs(p));
    const enrollOp = (client) => call(client, device, "fdb_device_enroll", [ticket.ticket, enrolled.installationId, "Replacement PC"]);
    const ordered = i % 2 === 0 ? [pairOp, enrollOp] : [enrollOp, pairOp];
    const results = await orderedInstallationRace(enrolled.installationId, ordered[0], ordered[1]);
    const pairResult = results[i % 2 === 0 ? 0 : 1];
    const enrollResult = results[i % 2 === 0 ? 1 : 0];
    assert.equal(pairResult.ok, true);
    assert.equal(enrollResult.ok, true);
    assert.equal(enrollResult.value.ok, true);
    if (i % 2 === 0) {
      assert.equal(pairResult.value.ok, true);
      assert.equal(pairResult.value.state, "pending");
      assert.equal(pairResult.value.pairingId, p.id);
    } else {
      assert.deepEqual(pairResult.value, { ok: false, error: "device_bound" });
    }
    const live = (await w.admin.query(
      "select ticket_id,pairing_id from private.devices where installation_id=$1 and status<>'revoked'",
      [enrolled.installationId],
    )).rows;
    assert.equal(await w.fx.owner(enrolled.installationId), account.uid);
    assert.equal(live.length, 1);
    assert.ok(live[0].ticket_id);
    assert.equal(live[0].pairing_id, null);
  }
});

it("100 pairing-redemption/manual-ingest races serialize history before or after ownership transfer", async () => {
  for (let i = 0; i < 100; i += 1) {
    await w.fx.resetBudgets();
    const device = await w.device();
    const account = await w.account();
    const p = pairingInput();
    await w.fx.installation(p.installationId, device.uid);
    await startPairing(w, device, p);
    assert.deepEqual(await account.call("fdb_account_device_pair_approve", [p.id]), { ok: true, state: "approved" });
    await due(w, p);
    await w.fx.resetBudgets();

    const pairOp = (client) => call(client, device, "fdb_device_pair_poll", [p.id, p.secret]);
    const ingestOp = (client) => call(client, device, "ingest_foreverdb_snapshot_auth", [snapshot(p.installationId, { updatedAt: 10_000 + i })]);
    const ordered = i % 2 === 0 ? [ingestOp, pairOp] : [pairOp, ingestOp];
    const results = await orderedInstallationRace(p.installationId, ordered[0], ordered[1]);
    const pairResult = results[i % 2 === 0 ? 1 : 0];
    const ingestResult = results[i % 2 === 0 ? 0 : 1];
    assert.equal(pairResult.ok, true);
    assert.deepEqual(pairResult.value, { ok: true, state: "connected", deviceId: p.deviceId });
    assert.equal(ingestResult.ok, i % 2 === 0);
    const historyRows = (await w.admin.query(
      "select count(*)::int n from public.installation_source_stats where installation_id=$1",
      [p.installationId],
    )).rows[0].n;
    assert.equal(historyRows > 0, i % 2 === 0);
    assert.equal(await w.fx.owner(p.installationId), account.uid);
    assert.equal((await pairRow(w, p)).status, "connected");
  }
});

it("100 redemption/device-revoke races keep one valid live-device serialization and no partial pairing state", async () => {
  for (let i = 0; i < 100; i += 1) {
    await w.fx.resetBudgets();
    const account = await w.account();
    const device = await w.device();
    const p = await startPairing(w, device, pairingInput());
    await account.call("fdb_account_device_pair_approve", [p.id]);
    await due(w, p);
    const [poll] = await bounded(Promise.all([
      isolatedCall(w, device, "fdb_device_pair_poll", [p.id, p.secret]),
      isolatedCall(w, account, "fdb_account_device_revoke", [p.deviceId]),
    ]));
    assert.ok(poll.ok);
    const row = await pairRow(w, p);
    const devices = (await w.admin.query("select status from private.devices where pairing_id=$1", [p.id])).rows;
    assert.ok(["connected", "revoked"].includes(row.status));
    assert.equal(devices.length, 1);
    assert.equal(row.status === "revoked", devices[0].status === "revoked");
  }
});
