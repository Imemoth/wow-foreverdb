/**
 * Deterministic SYNTHETIC export generator, for scale rehearsals ONLY.
 *
 * Output has the exact shape of the private aggregate export (contract.ts), so it exercises the real
 * validation/projection/write path. It is never publishable: the orchestrator refuses a synthetic source
 * unless the run rolls back or writes nothing (see run.ts), and names/ids are visibly artificial.
 *
 * `scale` multiplies the volumes measured in the private database on 2026-10-21 (read-only counts):
 * 134 sources, 138 items, 167 source buckets, 395 item-drop aggregates, 615 location rows.
 */
export const BASELINE = { sources: 134, items: 138, buckets: 167, drops: 395, locations: 615 } as const;

const ZONES = [1411, 1412, 1413, 1414, 1415, 1416, 1417, 1418, 1419, 1420, 1421, 1422, 1423, 1424, 1425, 1426, 1427, 1428, 1429, 1430, 1431, 1432, 1433, 1434, 1435, 1436, 1437, 1438, 1439, 1440, 1441, 1442, 1443, 1444, 1445, 1446, 1447, 1448, 1449, 1450, 1451, 1452, 1453, 1454, 1455];
const KINDS_CREATURE = ["mob", "skinning"] as const;
const KINDS_OBJECT = ["mining", "herbalism", "chest", "gameobject"] as const;

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function syntheticExport(scale: number, seed = 20261021): unknown {
  if (!Number.isFinite(scale) || scale < 1 || scale > 200) throw new Error("synthetic scale must be 1..200");
  const r = rng(seed);
  const ri = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const nSources = Math.round(BASELINE.sources * scale);
  const nItems = Math.round(BASELINE.items * scale);
  const nBuckets = Math.round(BASELINE.buckets * scale);
  const nDrops = Math.round(BASELINE.drops * scale);
  const nLocations = Math.round(BASELINE.locations * scale);
  const at = "2026-10-21T00:00:00.000Z";

  const sources = Array.from({ length: nSources }, (_, i) => {
    const creature = i % 2 === 0;
    return {
      source_type: creature ? "creature" : "gameobject",
      source_id: 900_000_000 + i,
      source_level: creature ? ri(1, 60) : 0,
      name: `Synthetic ${creature ? "Creature" : "Object"} ${i}`,
      first_seen_at: at,
      last_seen_at: at,
    };
  });
  const items = Array.from({ length: nItems }, (_, i) => ({ item_id: 800_000_000 + i, name: `Synthetic Item ${i}`, first_seen_at: at, last_seen_at: at }));

  // One bucket per (source, kind) until nBuckets is reached; every source gets at least one.
  const buckets: Record<string, unknown>[] = [];
  const bucketRefs: { s: number; kind: string; obs: number }[] = [];
  for (let b = 0; b < nBuckets; b += 1) {
    const s = b % nSources;
    const src = sources[s]!;
    const kinds = src.source_type === "creature" ? KINDS_CREATURE : KINDS_OBJECT;
    const kind = kinds[Math.floor(b / nSources) % kinds.length]!;
    const obs = ri(5, 500);
    const installations = ri(1, 9);
    const share = Math.min(1, Math.round((1 / installations + r() * 0.4) * 10000) / 10000);
    buckets.push({
      source_type: src.source_type, source_id: src.source_id, source_level: src.source_level, loot_kind: kind,
      observations: obs, installations, max_installation_share: share, last_updated_at: at,
    });
    bucketRefs.push({ s, kind, obs });
  }

  const drops: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (let d = 0; drops.length < nDrops && d < nDrops * 4; d += 1) {
    const b = bucketRefs[d % bucketRefs.length]!;
    const src = sources[b.s]!;
    const item = items[ri(0, nItems - 1)]!;
    const key = `${b.s}|${b.kind}|${item.item_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const count = ri(1, Math.max(1, b.obs));
    drops.push({
      source_type: src.source_type, source_id: src.source_id, source_level: src.source_level, loot_kind: b.kind,
      item_id: item.item_id, drops: count, quantity: count + ri(0, count), quest_drops: 0,
      installations: ri(1, 9), max_installation_share: Math.round((0.1 + r() * 0.7) * 10000) / 10000,
    });
  }

  const locations: Record<string, unknown>[] = [];
  const cells = new Set<string>();
  for (let l = 0; locations.length < nLocations && l < nLocations * 4; l += 1) {
    const b = bucketRefs[l % bucketRefs.length]!;
    const src = sources[b.s]!;
    const map = ZONES[ri(0, ZONES.length - 1)]!;
    const x = ri(0, 100);
    const y = ri(0, 100);
    const key = `${b.s}|${b.kind}|${map}|${x}|${y}`;
    if (cells.has(key)) continue;
    cells.add(key);
    locations.push({
      source_type: src.source_type, source_id: src.source_id, source_level: src.source_level, loot_kind: b.kind,
      map_id: map, zone_name: `Synthetic Zone ${map}`, subzone_name: "", x, y, observations: ri(1, 12), installations: ri(1, 5),
    });
  }

  return {
    meta: { contract_version: 1, exported_at: at, data_updated_at: at },
    sources, items, buckets, drops, locations,
  };
}
