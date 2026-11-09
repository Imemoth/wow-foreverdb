// Ownerless public ingestion uses an authenticated technical identity. A client supplied installation id is not enough to
// claim an existing installation; the migration maps prior anonymous/device credentials and lets a live anonymous session
// bootstrap only a genuinely new id. Guildbook remains behind the 0018 local-only boundary.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { DB, cloneDatabase, dropDatabase, psqlFile, repoRoot, rpc } from "../account/harness.mjs";
import { makeWorld, expectCode, instId, snapshot } from "./world.mjs";

const CLONE = `${DB}_ownerless_ingest`;
const MIG18 = path.join(repoRoot, "database/migrations/0018_disable_guildbook_cloud_sync.sql");
const MIG19 = path.join(repoRoot, "database/migrations/0019_technical_installation_ingest.sql");
let w;
let legacy;
let installation;
let deviceEnrollment;
let deviceInstallation;

before(async () => {
  await cloneDatabase(DB, CLONE);
  let applied = psqlFile(CLONE, MIG18);
  assert.equal(applied.status, 0, applied.out);
  w = await makeWorld({ database: CLONE });
  legacy = await w.device();
  installation = instId();
  await w.fx.installation(installation, legacy.uid);
  await w.fx.guild(installation, "legacy-local", [{ guid: "guild-member", name: "Private Guild Member" }]);
  const account = await w.account();
  const claimId = randomUUID();
  await w.admin.query(
    `insert into private.installation_claims (id, installation_id, initiator_uid, initiator_session_id, code_hash, status, expires_at, consumed_at, consumed_by)
     values ($1, $2, $3, $4, $5, 'consumed', now() + interval '1 day', now(), $6)`,
    [claimId, installation, legacy.uid, legacy.sid, Buffer.alloc(32, 7), account.uid],
  );
  await w.admin.query(
    `insert into private.account_installations (installation_id, account_uid, claim_id, previous_owner_uid) values ($1, $2, $3, $4)`,
    [installation, account.uid, claimId, legacy.uid],
  );
  await w.admin.query("update public.installations set owner_user_id = $2 where id = $1", [installation, account.uid]);

  deviceInstallation = instId();
  const deviceUser = await w.device();
  deviceEnrollment = await w.enrolled(account, { installationId: deviceInstallation, device: deviceUser });
  applied = psqlFile(CLONE, MIG19);
  assert.equal(applied.status, 0, applied.out);
});
after(async () => {
  await w?.close();
  await dropDatabase(CLONE);
});

describe("ownerless public observation ingest", () => {
  it("lets a fresh Companion upload with an anonymous technical Auth session and no website account", async () => {
    const device = await w.device();
    const id = instId();
    const reply = await device.call("ingest_foreverdb_snapshot_auth", [snapshot(id, { sources: 1, updatedAt: 7000 })]);
    assert.equal(reply.ok, true);
    assert.equal((await w.row("select owner_user_id from public.installations where id = $1", [id]))[0].owner_user_id, device.uid);
    assert.equal((await w.row("select auth_uid from private.installation_upload_identities where installation_id = $1", [id]))[0].auth_uid, device.uid);
  });

  it("preserves a pre-migration anonymous credential while keeping historical data", async () => {
    const before = await w.history(installation);
    assert.equal((await legacy.call("ingest_foreverdb_snapshot_auth", [snapshot(installation, { sources: 1, guilds: 1, members: 1, updatedAt: 7001 })])).ok, true);
    const after = await w.history(installation);
    assert.equal(after.guilds, before.guilds);
    assert.equal(after.members, before.members);
    assert.notEqual(after.source, before.source);
    assert.equal((await w.row("select count(*)::int n from private.installation_upload_identities where installation_id = $1", [installation]))[0].n, 2);
  });

  it("allows an account activation ticket only when the same technical identity has already synced that installation", async () => {
    const account = await w.account();
    const technical = await w.device();
    const id = instId();
    const initial = await technical.call("ingest_foreverdb_snapshot_auth", [snapshot(id, { sources: 1, updatedAt: 7010 })]);
    assert.equal(initial.ok, true);
    const historicalOwner = (await w.row("select owner_user_id from public.installations where id = $1", [id]))[0].owner_user_id;
    const ticket = await w.ticket(account);
    const enrolled = await w.enroll(technical, ticket.ticket, id);
    assert.equal(enrolled.ok, true);
    assert.equal((await w.row("select owner_user_id from public.installations where id = $1", [id]))[0].owner_user_id, historicalOwner);
    assert.equal((await w.row("select account_uid from private.devices where id = $1", [enrolled.device_id]))[0].account_uid, account.uid);
  });

  it("does not let an unrelated anonymous identity enroll against a known installation ID", async () => {
    const account = await w.account();
    const unrelated = await w.device();
    const ticket = await w.ticket(account);
    const before = await w.history(installation);
    assert.deepEqual(await w.enroll(unrelated, ticket.ticket, installation), { ok: false, error: "installation_conflict" });
    assert.deepEqual(await w.history(installation), before);
  });

  it("migrates a device secret as a technical credential and no longer checks the current installation owner", async () => {
    const before = await w.history(deviceInstallation);
    const anotherAccount = await w.account();
    await w.admin.query("update public.installations set owner_user_id = $2 where id = $1", [deviceInstallation, anotherAccount.uid]);
    const response = await w.ingest(deviceEnrollment.device, deviceEnrollment.secret, snapshot(deviceInstallation, { sources: 1, updatedAt: 7005 }));
    assert.equal(response.ok, true);
    assert.notEqual((await w.history(deviceInstallation)).source, before.source);
    assert.equal((await w.row("select account_uid from private.devices where installation_id = $1 and status = 'active'", [deviceInstallation]))[0].account_uid, deviceEnrollment.account.uid);
  });

  it("does not let another authenticated installation claim a known id", async () => {
    const attacker = await w.device();
    const before = await w.history(installation);
    await expectCode(attacker.call("ingest_foreverdb_snapshot_auth", [snapshot(installation, { sources: 2, updatedAt: 7002 })]), "PT403");
    assert.deepEqual(await w.history(installation), before);
  });

  it("does not accept a made-up Auth uid or a key-only caller", async () => {
    const id = instId();
    const claims = { ...legacy.claims, sub: "00000000-0000-0000-0000-000000000001", session_id: "00000000-0000-0000-0000-000000000002" };
    await expectCode(rpc(w.client, claims, "ingest_foreverdb_snapshot_auth", [snapshot(id, { sources: 1, updatedAt: 7003 })]), "PT401");
  });

  it("does not persist Guildbook values from a legacy snapshot", async () => {
    const device = await w.device();
    const id = instId();
    const payload = snapshot(id, { sources: 1, guilds: 1, members: 1, updatedAt: 7004 });
    payload.guildbook = [{ name: "Secret Guild", members: [{ name: "Secret Member", professions: ["Secret Profession"] }] }];
    assert.equal((await device.call("ingest_foreverdb_snapshot_auth", [payload])).ok, true);
    assert.deepEqual((await w.row("select count(*)::int g from public.installation_guilds where installation_id = $1", [id]))[0], { g: 0 });
    assert.deepEqual((await w.row("select count(*)::int m from public.installation_guild_members where installation_id = $1", [id]))[0], { m: 0 });
  });
});
