// Migration 0017: public collector credentials are independent per installation, while ownership remains account-scoped.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeWorld, instId, snapshot } from "./world.mjs";

const world = await makeWorld();
after(() => world.close());

describe("account-independent collectors", () => {
  it("enrolls multiple installations on one device identity without transferring ownership", async () => {
    const accountA = await world.account();
    const accountB = await world.account();
    const device = await world.device();
    const first = instId();
    const second = instId();

    const firstTicket = await world.ticket(accountA, "A collector");
    const firstEnrollment = await world.enroll(device, firstTicket.ticket, first);
    assert.equal(firstEnrollment.ok, true);

    const secondTicket = await world.ticket(accountA, "A second collector");
    const secondEnrollment = await world.enroll(device, secondTicket.ticket, second);
    assert.equal(secondEnrollment.ok, true);

    assert.equal((await world.row("select count(*)::int as n from private.devices where auth_uid = $1 and status <> 'revoked'", [device.uid]))[0].n, 2);
    assert.equal((await world.row("select owner_user_id from public.installations where id = $1", [first]))[0].owner_user_id, accountA.uid);
    assert.equal((await world.row("select owner_user_id from public.installations where id = $1", [second]))[0].owner_user_id, accountA.uid);

    assert.equal((await world.ingest(device, firstEnrollment.device_secret, snapshot(first, { updatedAt: 100 }))).ok, true);
    assert.equal((await world.ingest(device, secondEnrollment.device_secret, snapshot(second, { updatedAt: 101 }))).ok, true);

    const bTicket = await world.ticket(accountB, "B must not claim A");
    assert.deepEqual(await world.enroll(device, bTicket.ticket, first), { ok: false, error: "installation_conflict" });

    // Revoking one installation's credential does not revoke the other installation's collector path.
    assert.deepEqual(await accountA.call("fdb_account_device_revoke", [firstEnrollment.device_id]), { ok: true });
    assert.equal((await world.ingest(device, secondEnrollment.device_secret, snapshot(second, { updatedAt: 102 }))).ok, true);
    assert.deepEqual(await world.ingest(device, firstEnrollment.device_secret, snapshot(first, { updatedAt: 103 })), { ok: false, error: "device_revoked" });
  });
});
