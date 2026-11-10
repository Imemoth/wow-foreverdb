// C0c disposable SQL/PostgREST preflight: nonempty PUBLIC Schema 9 only.
// Runs exclusively in GitHub's ephemeral PostgreSQL 16 + real GoTrue test stack.
// No hosted Supabase project, external installation or private SavedVariables involved.
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { instId, makeWorld } from "./world.mjs";

let w;
before(async () => { w = await makeWorld(); });
after(async () => { await w.close(); });

function publicSnapshot(installationId, updatedAt = 5000) {
  return {
    installationId,
    schemaVersion: 9,
    addonVersion: "0.7.1-alpha",
    updatedAt,
    sources: [{
      sourceType: "creature",
      sourceId: 164662,
      sourceLevel: 60,
      name: "Synthetic Equipment Boxes",
      buckets: [{
        kind: "mob",
        observations: 3,
        locations: [{
          mapId: 1,
          zoneName: "Tirisfal Glades",
          subZoneName: "Brill",
          x: "40.25",
          y: "53.75",
          observations: 3,
        }],
        items: [
          { itemId: 11127, name: "Scavenged Goods", drops: 2, quantity: 3, questDrops: 1, questIds: [] },
          { itemId: 22222, name: "Verified Quest Token", drops: 1, quantity: 1, questDrops: 1, questIds: [12345] },
        ],
      }],
    }],
    maps: [{
      mapId: 1,
      name: "Tirisfal Glades",
      parentMapId: 0,
      mapArtId: 111,
      layers: [{
        layerIndex: 0,
        layerWidth: 1024,
        layerHeight: 1024,
        tileWidth: 256,
        tileHeight: 256,
        minScale: 1,
        maxScale: 2,
        additionalZoomSteps: 0,
        textureRefs: ["synthetic-tile"],
      }],
    }],
  };
}

async function readBack(installationId) {
  const [installation] = await w.row(
    "select owner_user_id, snapshot_updated_at::text, schema_version from public.installations where id = $1",
    [installationId],
  );
  const source = await w.row(
    "select source_type, source_id::text, source_level, loot_kind, observations::text from public.installation_source_stats where installation_id = $1",
    [installationId],
  );
  const items = await w.row(
    "select item_id::text, drop_count::text as drops, quantity::text, quest_drop_count::text as quest_drops, quest_ids from public.installation_item_stats where installation_id = $1 order by item_id",
    [installationId],
  );
  const locations = await w.row(
    "select map_id::text, zone_name, subzone_name, x::text, y::text, observations::text from public.installation_location_stats where installation_id = $1",
    [installationId],
  );
  const [privateGuilds] = await w.row(
    "select count(*)::int as n from public.installation_guilds where installation_id = $1",
    [installationId],
  );
  return { installation, source, items, locations, privateGuilds: privateGuilds.n };
}

describe("C0c: nonempty synthetic Schema 9 with actual disposable SQL read-back", () => {
  it("registered-device ingest preserves public observations, retries without doubling, and rejects stale/wrong owner", async () => {
    const account = await w.account();
    const otherAccount = await w.account();
    const device = await w.enrolled(account, { installationId: instId() });
    const snap = publicSnapshot(device.installationId);

    // No private Guildbook / journal / character fields in this public transport.
    assert.deepEqual(Object.keys(snap).sort(), ["addonVersion", "installationId", "maps", "schemaVersion", "sources", "updatedAt"]);
    assert.equal(snap.sources[0].buckets[0].items[0].questIds.length, 0);

    await w.fx.resetBudgets();
    const first = await w.ingest(device.device, device.secret, snap);
    assert.equal(first.ok, true);
    assert.equal(first.status, "applied");

    const initial = await readBack(device.installationId);
    assert.equal(initial.installation.owner_user_id, account.uid);
    assert.equal(initial.installation.snapshot_updated_at, "5000");
    assert.equal(initial.installation.schema_version, 9);
    assert.deepEqual(initial.source, [{
      source_type: "creature", source_id: "164662", source_level: 60, loot_kind: "mob", observations: "3",
    }]);
    assert.deepEqual(initial.items, [
      { item_id: "11127", drops: "2", quantity: "3", quest_drops: "1", quest_ids: [] },
      { item_id: "22222", drops: "1", quantity: "1", quest_drops: "1", quest_ids: ["12345"] },
    ]);
    // The public SQL schema stores coordinates as numeric(5,1), an intentional
    // one-decimal quantization of the more precise outbound JSON.
    assert.deepEqual(initial.locations, [{
      map_id: "1", zone_name: "Tirisfal Glades", subzone_name: "Brill", x: "40.3", y: "53.8", observations: "3",
    }]);
    assert.equal(initial.privateGuilds, 0);

    // Simulates an acknowledgment lost AFTER the first commit: the same snapshot
    // arrives twice more. Equal-timestamp SQL replaces rows, it does not increment counts.
    await w.fx.resetBudgets();
    assert.equal((await w.ingest(device.device, device.secret, snap)).ok, true);
    assert.equal((await w.ingest(device.device, device.secret, snap)).ok, true);
    const repeated = await readBack(device.installationId);
    assert.deepEqual(repeated, initial);

    // An earlier source generation is acknowledged as stale but must not overwrite data.
    await w.fx.resetBudgets();
    const stale = await w.ingest(device.device, device.secret, publicSnapshot(device.installationId, 4000));
    assert.equal(stale.ok, true);
    assert.equal(stale.status, "stale_ignored");
    assert.deepEqual(await readBack(device.installationId), initial);

    // An unrelated account cannot write an already owned installation through the
    // normal session endpoint, even if it knows the installation ID.
    await w.fx.resetBudgets();
    await assert.rejects(
      otherAccount.call("ingest_foreverdb_snapshot_auth", [publicSnapshot(device.installationId, 6000)]),
      /belongs to another authenticated client/,
    );
    assert.deepEqual(await readBack(device.installationId), initial);

    // Map art is intentionally an input DTO field but the current SQL ingest only
    // persists locations (mapId) here. Do not claim atlas map-art SQL read-back.
  });
});
