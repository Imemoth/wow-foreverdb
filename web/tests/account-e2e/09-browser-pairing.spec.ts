import { expect, test } from "@playwright/test";
import type pg from "pg";
import { anonymous, admin, fingerprint, ownerOf, resetBudgets, rpc, snapshot } from "./stack";
import {
  companionWithInstallation, json, makePairingDue, nativePairingPost, newClient, openPairing,
  pairingDecision, pairingMaterial, post, webUser,
} from "./world";

// Pairing requests carry bearer, poll and device secrets. Failure artifacts use
// JSON results and stack logs; they must never persist Playwright network traces.
test.use({ trace: "off" });

let db: pg.Client;
test.beforeAll(async () => { db = await admin(); });
test.afterAll(async () => { await db.end(); });
test.beforeEach(async () => { await resetBudgets(db); });

test("new anonymous installation transfers once and registers exactly one pairing device", async ({ playwright }) => {
  const native = await newClient(playwright);
  const initiator = await (await import("./stack")).anonymous();
  const p = pairingMaterial();
  const start = await nativePairingPost(native, "start", initiator, p);
  expect(await json(start)).toMatchObject({ ok: true, state: "pending", pairingId: p.pairingId, intervalSeconds: 5 });
  const account = await webUser(playwright, "pairNew");
  const rendered = await openPairing(account.c, p.pairingId);
  expect(rendered.html).toContain(account.email);
  expect((await pairingDecision(account.c, "approve", p.pairingId, rendered.pageBinding)).status()).toBe(200);
  await makePairingDue(db, p.pairingId);
  const [a, b] = await Promise.all([
    nativePairingPost(native, "poll", initiator, p),
    nativePairingPost(await newClient(playwright), "poll", initiator, p),
  ]);
  const bodies = [await json(a), await json(b)];
  expect(bodies).toEqual([
    { ok: true, state: "connected", deviceId: p.deviceId },
    { ok: true, state: "connected", deviceId: p.deviceId },
  ]);
  expect(await ownerOf(db, p.installationId)).toBe(account.uid);
  expect((await db.query("select count(*)::int n from private.devices where pairing_id=$1", [p.pairingId])).rows[0].n).toBe(1);
  expect((await db.query("select event,count(*)::int n from private.device_pairing_audit where pairing_audit_ref=(select audit_ref from private.device_pairings where id=$1) group by event order by event", [p.pairingId])).rows)
    .toEqual([{ event: "pairing_approved", n: 1 }, { event: "pairing_connected", n: 1 }, { event: "pairing_started", n: 1 }]);
});

test("optional computer name reaches the six-argument RPC as SQL null", async ({ playwright }) => {
  const native = await newClient(playwright);
  const initiator = await anonymous();
  const p = pairingMaterial();
  const start = await native.post("/account/api/device-pair/start", {
    headers: { authorization: `Bearer ${initiator.token}`, "content-type": "application/json" },
    data: JSON.stringify({
      pairingId: p.pairingId,
      pollSecretHash: p.pollSecretHash,
      deviceId: p.deviceId,
      deviceCredentialHash: p.deviceCredentialHash,
      installationId: p.installationId,
    }),
  });
  expect(start.status()).toBe(200);
  expect(await json(start)).toMatchObject({ ok: true, state: "pending", pairingId: p.pairingId });
  expect((await db.query("select computer_label from private.device_pairings where id=$1", [p.pairingId])).rows)
    .toEqual([{ computer_label: null }]);
});

test("anonymous-owned Guildbook/history survives ownership transfer and manual ingest remains usable before redemption", async ({ playwright }) => {
  const native = await newClient(playwright);
  const p = pairingMaterial();
  const companion = await companionWithInstallation({ guilds: 2, members: 4, sources: 3, tag: "BP", installationId: p.installationId });
  const before = await fingerprint(db);
  expect((await nativePairingPost(native, "start", companion.id, p)).status()).toBe(200);
  const account = await webUser(playwright, "pairHistory");
  const rendered = await openPairing(account.c, p.pairingId);
  expect((await pairingDecision(account.c, "approve", p.pairingId, rendered.pageBinding)).status()).toBe(200);
  await makePairingDue(db, p.pairingId);
  expect(await json(await nativePairingPost(native, "poll", companion.id, p))).toEqual({ ok: true, state: "connected", deviceId: p.deviceId });
  expect(await fingerprint(db)).toEqual(before);
  expect(await ownerOf(db, p.installationId)).toBe(account.uid);
});

test("denial, expiry, two-account losing approval and terminal replay are generic and single-use", async ({ playwright }) => {
  const native = await newClient(playwright);
  const initiator = await (await import("./stack")).anonymous();
  const denied = pairingMaterial();
  expect((await nativePairingPost(native, "start", initiator, denied)).status()).toBe(200);
  const first = await webUser(playwright, "pairDenyA");
  const second = await webUser(playwright, "pairDenyB");
  const a = await openPairing(first.c, denied.pairingId);
  const b = await openPairing(second.c, denied.pairingId);
  expect((await pairingDecision(first.c, "deny", denied.pairingId, a.pageBinding)).status()).toBe(200);
  const loser = await pairingDecision(second.c, "approve", denied.pairingId, b.pageBinding);
  expect(loser.status()).toBe(409);
  expect((await json(loser)).error).toBe("already_decided");
  await makePairingDue(db, denied.pairingId);
  expect(await json(await nativePairingPost(native, "poll", initiator, denied))).toEqual({ ok: true, state: "denied" });
  expect(await ownerOf(db, denied.installationId)).toBeNull();

  const expired = pairingMaterial();
  expect((await nativePairingPost(native, "start", initiator, expired)).status()).toBe(200);
  await db.query("update private.device_pairings set created_at=clock_timestamp()-interval '5 minutes',expires_at=clock_timestamp()-interval '1 second',next_poll_at=clock_timestamp()-interval '1 second' where id=$1", [expired.pairingId]);
  expect(await json(await nativePairingPost(native, "poll", initiator, expired))).toEqual({ ok: true, state: "expired" });
  expect(await json(await nativePairingPost(native, "poll", initiator, expired))).toEqual({ ok: true, state: "expired" });
});

test("a registered owner cannot be displaced by an unrelated pairing initiator", async ({ playwright }) => {
  const account = await webUser(playwright, "pairOwnerConflict");
  const initiator = await anonymous();
  const p = pairingMaterial();
  const seeded = await rpc(account.accessToken, "ingest_foreverdb_snapshot_auth", { p_snapshot: snapshot(p.installationId, { updatedAt: 7100, sources: 2, guilds: 1, members: 2, tag: "OWN" }) });
  expect([seeded.status, seeded.body.ok]).toEqual([200, true]);
  const before = await fingerprint(db);
  const refused = await nativePairingPost(await newClient(playwright), "start", initiator, p);
  expect(refused.status()).toBe(409);
  expect(await json(refused)).toEqual({ ok: false, error: "installation_conflict" });
  expect(await ownerOf(db, p.installationId)).toBe(account.uid);
  expect(await fingerprint(db)).toEqual(before);
  expect((await db.query("select count(*)::int n from private.device_pairings where id=$1", [p.pairingId])).rows[0].n).toBe(0);
});

test("the .fdbact fallback, explicit revoke, controlled pairing re-enrollment, status and manual ingest remain compatible", async ({ playwright }) => {
  const account = await webUser(playwright, "pairReenroll");
  const device = await anonymous();
  const p = pairingMaterial();

  const issued = await rpc(account.accessToken, "fdb_account_enrollment_ticket_issue", { p_label: "Fallback PC" });
  expect([issued.status, issued.body.ok]).toEqual([200, true]);
  const enrolled = await rpc(device.token, "fdb_device_enroll", {
    p_ticket: issued.body.ticket, p_installation_id: p.installationId, p_label: "Fallback PC",
  });
  expect([enrolled.status, enrolled.body.ok]).toEqual([200, true]);
  expect((await rpc(device.token, "fdb_device_status", { p_device_secret: enrolled.body.device_secret })).body)
    .toMatchObject({ state: "active", installation_id: p.installationId });

  const native = await newClient(playwright);
  const blocked = await nativePairingPost(native, "start", device, p);
  expect(blocked.status()).toBe(409);
  expect(await json(blocked)).toEqual({ ok: false, error: "device_bound" });

  const revoked = await post(account.c, "/account/api/devices/revoke", { deviceId: enrolled.body.device_id });
  expect(revoked.status()).toBe(200);
  expect(await json(revoked)).toEqual({ ok: true });
  expect((await rpc(device.token, "fdb_device_status", { p_device_secret: enrolled.body.device_secret })).body)
    .toMatchObject({ state: "revoked", installation_id: p.installationId, reason: "owner_revoked" });

  expect((await nativePairingPost(native, "start", device, p)).status()).toBe(200);
  const rendered = await openPairing(account.c, p.pairingId);
  expect((await pairingDecision(account.c, "approve", p.pairingId, rendered.pageBinding)).status()).toBe(200);
  await makePairingDue(db, p.pairingId);
  expect(await json(await nativePairingPost(native, "poll", device, p))).toEqual({ ok: true, state: "connected", deviceId: p.deviceId });
  expect((await rpc(device.token, "fdb_device_status", { p_device_secret: p.deviceCredential })).body)
    .toMatchObject({ state: "active", installation_id: p.installationId });

  await resetBudgets(db);
  const ingested = await rpc(device.token, "fdb_device_ingest", {
    p_device_secret: p.deviceCredential,
    p_snapshot: snapshot(p.installationId, { updatedAt: 7200, sources: 2, guilds: 1, members: 3, tag: "PAIR" }),
  });
  expect([ingested.status, ingested.body.ok]).toEqual([200, true]);
  expect((await db.query("select count(*)::int n from public.installation_guild_members where installation_id=$1", [p.installationId])).rows[0].n).toBe(3);
  expect(await ownerOf(db, p.installationId)).toBe(account.uid);
  expect((await db.query("select count(*)::int n from private.devices where installation_id=$1 and status='active'", [p.installationId])).rows[0].n).toBe(1);
});
