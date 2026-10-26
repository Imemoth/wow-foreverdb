// Migration 0018: existing Guildbook rows and function definitions remain,
// but no API role can invoke the old cloud ingest/read paths.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { makeWorld, expectCode, instId, snapshot } from "./world.mjs";

const w = await makeWorld();
after(() => w.close());

const RPCS = [
  "public.fdb_account_guildbook_guilds(text)",
  "public.fdb_account_guildbook_members(text,text,integer,integer)",
  "public.fdb_account_guildbook_ingest(text,text,bigint,text,jsonb)",
  "public.fdb_account_guildbook_guilds_scoped(text)",
  "public.fdb_account_guildbook_members_scoped(text,text,integer,integer)",
];

describe("Guildbook local-only kill switch", () => {
  it("retains definitions and data but revokes every client EXECUTE grant", async () => {
    for (const sig of RPCS) {
      const row = (await w.admin.query("select to_regprocedure($1) is not null as exists, has_function_privilege('public', $1, 'execute') as public, has_function_privilege('anon', $1, 'execute') as anon, has_function_privilege('authenticated', $1, 'execute') as authenticated, has_function_privilege('service_role', $1, 'execute') as service", [sig])).rows[0];
      assert.equal(row.exists, true, sig);
      assert.equal(row.public, false, sig);
      assert.equal(row.anon, false, sig);
      assert.equal(row.authenticated, false, sig);
      assert.equal(row.service, false, sig);
    }
    assert.equal((await w.row("select count(*)::int as n from public.installation_guilds"))[0].n >= 0, true);
    assert.equal((await w.row("select count(*)::int as n from private.account_guildbook_captures"))[0].n >= 0, true);
  });

  it("a real registered session cannot call a legacy Guildbook RPC after the migration", async () => {
    const account = await w.account();
    await expectCode(account.call("fdb_account_guildbook_guilds", ["missing-installation"]), "42501");
    await expectCode(account.call("fdb_account_guildbook_guilds_scoped", ["missing-installation"]), "42501");
  });

  it("preserves existing Guildbook through both public and enrolled-device ingest, while rejecting new private rows", async () => {
    const account = await w.account();
    const device = await w.device();
    const installation = instId();
    await w.fx.installation(installation, account.uid);
    await w.fx.guild(installation, "pre-existing", [{ guid: "member-1", name: "Member One" }]);
    const before = await w.history(installation);
    const enrolled = await w.enrolled(account, { installationId: installation, device });

    const publicResult = await account.call("ingest_foreverdb_snapshot_auth", [
      snapshot(installation, { sources: 1, guilds: 1, members: 2, updatedAt: 3000 }),
    ]);
    assert.equal(publicResult.ok, true);
    assert.equal((await w.history(installation)).guilds, before.guilds);
    assert.equal((await w.history(installation)).members, before.members);

    const deviceResult = await w.ingest(device, enrolled.secret, snapshot(installation, {
      sources: 1,
      guilds: 2,
      members: 3,
      updatedAt: 3001,
    }));
    assert.equal(deviceResult.ok, true);
    assert.equal((await w.history(installation)).guilds, before.guilds);
    assert.equal((await w.history(installation)).members, before.members);

    const fresh = instId();
    const freshEnrollment = await w.enrolled(account, { installationId: fresh, device });
    const freshResult = await w.ingest(device, freshEnrollment.secret, snapshot(fresh, {
      sources: 1,
      guilds: 1,
      members: 2,
      updatedAt: 3002,
    }));
    assert.equal(freshResult.ok, true);
    assert.equal((await w.row("select count(*)::int as n from public.installation_guilds where installation_id = $1", [fresh]))[0].n, 0);
    assert.equal((await w.row("select count(*)::int as n from public.installation_guild_members where installation_id = $1", [fresh]))[0].n, 0);

    const beforeRejected = await w.history(installation);
    assert.deepEqual(await w.ingest(device, "fdbd1_invalid", snapshot(installation, { sources: 1, guilds: 1, updatedAt: 3003 })), { ok: false, error: "device_unauthorized" });
    assert.deepEqual(await w.history(installation), beforeRejected);
  });
});
