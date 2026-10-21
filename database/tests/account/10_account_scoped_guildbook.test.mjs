// Prompt A: public observation ingest is Guildbook-free; private Guildbook is
// attributed to the verified registered session and guarded by capture provenance.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Fixtures, connect, expectCode, rpc, snapshot, uniq } from "./harness.mjs";

const admin = await connect();
const client = await connect();
const fx = new Fixtures(admin);
after(async () => {
  await client.end();
  await admin.end();
});

let a;
let b;
let anonymous;
let installation;
let guilds;
let capturedAt;

before(async () => {
  a = await fx.identity();
  b = await fx.identity();
  anonymous = await fx.identity({ anonymous: true });
  installation = uniq("account-guildbook");
  await fx.installation(installation, a.uid);
  guilds = snapshot(installation, { guilds: 1, members: 2, sources: 0 }).guilds;
  capturedAt = Math.floor(Date.now() / 1000) + 1;
  await fx.resetBudgets();
});

describe("account-scoped Guildbook", () => {
  it("public observation ingest ignores Guildbook fields", async () => {
    const publicInstallation = uniq("public-only");
    const out = await rpc(client, anonymous.claims, "ingest_foreverdb_snapshot_auth", [
      snapshot(publicInstallation, { guilds: 1, members: 1, sources: 1 }),
    ]);
    assert.equal(out.ok, true);
    const rows = await admin.query(
      "select count(*)::int as n from public.installation_guilds where installation_id = $1",
      [publicInstallation],
    );
    assert.equal(rows.rows[0].n, 0);
  });

  it("accepts a fresh capture and keeps reads scoped to the registered account", async () => {
    const out = await rpc(client, a.claims, "fdb_account_guildbook_ingest", [
      installation, "capture-a", capturedAt, "A:Main", JSON.stringify(guilds),
    ]);
    assert.deepEqual(out, {
      ok: true,
      status: "applied",
      installation_id: installation,
      capture_id: "capture-a",
      captured_at: capturedAt,
    });

    const owned = await rpc(client, a.claims, "fdb_account_guildbook_guilds_scoped", [installation]);
    assert.equal(owned.length, 1);
    assert.equal(owned[0].guild_key, guilds[0].guildKey);
    assert.deepEqual(await rpc(client, b.claims, "fdb_account_guildbook_guilds_scoped", [installation]), []);
    await expectCode(rpc(client, anonymous.claims, "fdb_account_guildbook_guilds_scoped", [installation]), "PT403");
  });

  it("does not let an anonymous collector session call the account Guildbook ingest", async () => {
    await expectCode(
      rpc(client, anonymous.claims, "fdb_account_guildbook_ingest", [
        installation, "anonymous-capture", 200, "Anonymous:Main", JSON.stringify(guilds),
      ]),
      "PT403",
    );
  });

  it("rejects capture replay and older provenance without changing stored rows", async () => {
    const replay = await rpc(client, a.claims, "fdb_account_guildbook_ingest", [
      installation, "capture-a", capturedAt, "A:Main", JSON.stringify(guilds),
    ]);
    assert.deepEqual(replay, { ok: false, error: "capture_replayed" });

    const crossAccountReplay = await rpc(client, b.claims, "fdb_account_guildbook_ingest", [
      installation, "capture-a", capturedAt, "A:Main", JSON.stringify(guilds),
    ]);
    assert.deepEqual(crossAccountReplay, { ok: false, error: "capture_replayed" });

    const older = await rpc(client, a.claims, "fdb_account_guildbook_ingest", [
      installation, "capture-older", capturedAt - 1, "A:Main", JSON.stringify([]),
    ]);
    assert.deepEqual(older, { ok: false, error: "capture_stale" });
    const crossAccountOlder = await rpc(client, b.claims, "fdb_account_guildbook_ingest", [
      installation, "capture-older-b", capturedAt - 1, "A:Main", JSON.stringify(guilds),
    ]);
    assert.deepEqual(crossAccountOlder, { ok: false, error: "capture_stale" });
    assert.equal((await rpc(client, a.claims, "fdb_account_guildbook_guilds_scoped", [installation])).length, 1);
  });

  it("attributes a new capture to B without transferring installation ownership", async () => {
    const out = await rpc(client, b.claims, "fdb_account_guildbook_ingest", [
      installation, "capture-b", capturedAt + 1, "B:Main", JSON.stringify(guilds),
    ]);
    assert.equal(out.ok, true);
    assert.equal(await fx.owner(installation), a.uid);
    assert.deepEqual(await rpc(client, a.claims, "fdb_account_guildbook_guilds_scoped", [installation]).then((r) => r), [
      {
        guild_key: guilds[0].guildKey,
        guild_name: guilds[0].name,
        realm_name: guilds[0].realmName,
        captured_at: guilds[0].capturedAt,
        member_count: 2,
      },
    ]);
    assert.equal((await rpc(client, b.claims, "fdb_account_guildbook_guilds_scoped", [installation])).length, 1);
  });
});
