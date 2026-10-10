/**
 * Pure projection builder: validated private export -> public read model rows.
 * No I/O. Throws PublicationError to fail the whole run closed.
 */
import { createHash } from "node:crypto";
import {
  PrivateExport,
  type LootKind,
  type PublicationConfig,
  type SourceType,
} from "./contract.js";
import { sanitizeName, sanitizeOptionalName } from "./sanitize.js";
import { confidenceFor, round6, wilson, type Confidence } from "./stats.js";

export class PublicationError extends Error {
  constructor(message: string, readonly detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "PublicationError";
  }
}

export type DisplayKind = "creature" | "object" | "fishing_pool" | "fishing" | "item";

export interface PubItem {
  item_id: number; name: string; name_norm: string; source_count: number; total_drops: number;
  last_observed_at: string | null; indexable: boolean;
}
export interface PubSource {
  source_type: SourceType; source_id: number; source_level: number; name: string; name_norm: string;
  display_kind: DisplayKind; total_observations: number; last_observed_at: string | null; indexable: boolean;
}
export interface PubBucket {
  source_type: SourceType; source_id: number; source_level: number; loot_kind: LootKind;
  observations: number; confidence: Confidence;
}
export interface PubDrop {
  source_type: SourceType; source_id: number; source_level: number; loot_kind: LootKind; item_id: number;
  drops: number; quantity: number; observations: number; rate: number | null; rate_lower: number | null;
  rate_upper: number | null; confidence: Confidence; dominated: boolean;
}
export interface PubZone { map_id: number; zone_name: string; observations: number; source_count: number; item_count: number }
export interface PubZoneEntity {
  map_id: number; entity_kind: "item" | "source"; item_id: number | null; source_type: SourceType | null;
  source_id: number | null; source_level: number | null; display_kind: DisplayKind; name: string; name_norm: string;
  loot_kinds: LootKind[];
  /**
   * Zone-specific MEASURED count. Sources: observations of that source in the zone.
   * Items: ALWAYS null (not measured) - the data does not establish how often an
   * item dropped inside a zone; the item's global drop count must never stand in.
   */
  observations: number | null;
  /** 'observed' = the source itself was seen in the zone; 'inferred' = item linked via such a source. */
  association: "observed" | "inferred";
  /** Items only: number of distinct sources observed in this zone that drop the item (structural count, not a drop count). */
  associated_source_count: number | null;
}
export interface PubLocation {
  source_type: SourceType; source_id: number; source_level: number; loot_kind: LootKind; map_id: number;
  subzone_name: string; x: number; y: number; observations: number;
}
export interface PubSearchEntry {
  entity_kind: "item" | "source"; display_kind: DisplayKind; item_id: number | null; source_type: SourceType | null;
  source_id: number | null; source_level: number | null; name: string; name_norm: string; loot_kinds: LootKind[];
  map_ids: number[]; observations: number;
}

export interface Projection {
  contractVersion: 1;
  sourceDataUpdatedAt: string | null;
  items: PubItem[];
  sources: PubSource[];
  buckets: PubBucket[];
  drops: PubDrop[];
  zones: PubZone[];
  zone_entities: PubZoneEntity[];
  locations: PubLocation[];
  search_index: PubSearchEntry[];
}

export interface BuildReport {
  exportedAt: string | null;
  input: Record<string, number>;
  output: Record<string, number>;
  rejected: Record<string, number>;
  anomalies: Record<string, number>;
  contentSha256: string;
}

const sk = (t: string, id: number, lvl: number) => `${t}|${id}|${lvl}`;
const bk = (t: string, id: number, lvl: number, k: string) => `${t}|${id}|${lvl}|${k}`;

export function displayKindOf(type: SourceType, id: number): DisplayKind {
  if (type === "creature") return "creature";
  if (type === "fishing") return "fishing";
  if (type === "item") return "item";
  return id < 0 ? "fishing_pool" : "object"; // synthetic fishing-pool IDs are negative GameObject IDs
}

export function buildProjection(rawExport: unknown, config: PublicationConfig): { projection: Projection; report: BuildReport } {
  const parsed = PrivateExport.safeParse(rawExport);
  if (!parsed.success) {
    // Fail closed. Report only paths/codes, never values (they may be private).
    throw new PublicationError("export_contract_violation", {
      issues: parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), code: i.code })),
    });
  }
  const ex = parsed.data;
  if (ex.meta.contract_version !== config.contractVersion) {
    throw new PublicationError("export_contract_version_mismatch", { got: ex.meta.contract_version });
  }
  const t = config.thresholds;
  const allowedTypes = new Set<string>(config.allowedSourceTypes);
  const allowedKinds = new Set<string>(config.allowedLootKinds);
  const rejected: Record<string, number> = {};
  const anomalies: Record<string, number> = {};
  const reject = (reason: string) => (rejected[reason] = (rejected[reason] ?? 0) + 1);
  const anomaly = (reason: string) => (anomalies[reason] = (anomalies[reason] ?? 0) + 1);

  // ---- Items -----------------------------------------------------------
  const itemName = new Map<number, { name: string; norm: string; last: string | null }>();
  for (const it of ex.items) {
    if (!Number.isSafeInteger(it.item_id) || it.item_id <= 0 || it.item_id > 999_999_999) { reject("item_invalid_id"); continue; }
    const n = sanitizeName(it.name);
    if (!n.ok) { reject(`item_${n.reason}`); continue; }
    itemName.set(it.item_id, { name: n.value, norm: n.norm, last: it.last_seen_at });
  }

  // ---- Sources ---------------------------------------------------------
  const sources = new Map<string, PubSource>();
  for (const s of ex.sources) {
    if (!allowedTypes.has(s.source_type)) { reject("source_type_not_allowlisted"); continue; }
    if (!Number.isSafeInteger(s.source_id) || s.source_level < 0 || s.source_level > 255) { reject("source_invalid_key"); continue; }
    const n = sanitizeName(s.name);
    if (!n.ok) { reject(`source_${n.reason}`); continue; }
    const type = s.source_type as SourceType;
    sources.set(sk(type, s.source_id, s.source_level), {
      source_type: type, source_id: s.source_id, source_level: s.source_level, name: n.value, name_norm: n.norm,
      display_kind: displayKindOf(type, s.source_id), total_observations: 0, last_observed_at: s.last_seen_at,
      indexable: false,
    });
  }

  // ---- Buckets ---------------------------------------------------------
  const buckets = new Map<string, PubBucket & { dominated: boolean }>();
  for (const b of ex.buckets) {
    const key = sk(b.source_type, b.source_id, b.source_level);
    const src = sources.get(key);
    if (!src) { reject("bucket_without_published_source"); continue; }
    if (!allowedKinds.has(b.loot_kind)) { reject("loot_kind_not_allowlisted"); continue; }
    if (!(b.observations > 0)) { anomaly("bucket_nonpositive_observations"); continue; }
    const dominated = b.installations <= 1 || (b.max_installation_share ?? 1) >= t.dominatedShare;
    buckets.set(bk(b.source_type, b.source_id, b.source_level, b.loot_kind), {
      source_type: src.source_type, source_id: src.source_id, source_level: src.source_level,
      loot_kind: b.loot_kind as LootKind, observations: b.observations,
      confidence: confidenceFor(b.observations, dominated, t), dominated,
    });
    src.total_observations += b.observations;
  }

  // ---- Drops -----------------------------------------------------------
  const drops: PubDrop[] = [];
  for (const d of ex.drops) {
    const bucket = buckets.get(bk(d.source_type, d.source_id, d.source_level, d.loot_kind));
    if (!bucket) { reject("drop_without_published_bucket"); continue; }
    if (!itemName.has(d.item_id)) { reject("drop_without_published_item"); continue; }
    if (!(d.drops > 0) || d.quantity < d.drops || d.drops > bucket.observations) { anomaly("drop_invariant_violation"); continue; }
    const dominated = bucket.dominated || d.installations <= 1 || (d.max_installation_share ?? 1) >= t.dominatedShare;
    const confidence = confidenceFor(bucket.observations, dominated, t);
    let rate: number | null = null, lo: number | null = null, hi: number | null = null;
    if (confidence !== "insufficient") {
      rate = round6(d.drops / bucket.observations);
      [lo, hi] = wilson(d.drops, bucket.observations).map(round6) as [number, number];
    }
    drops.push({
      source_type: bucket.source_type, source_id: bucket.source_id, source_level: bucket.source_level,
      loot_kind: bucket.loot_kind, item_id: d.item_id, drops: d.drops, quantity: d.quantity,
      observations: bucket.observations, rate, rate_lower: lo, rate_upper: hi, confidence, dominated,
    });
  }

  // Fail-closed ratios.
  const inputEntities = ex.items.length + ex.sources.length + ex.buckets.length + ex.drops.length;
  const rejectedTotal = Object.values(rejected).reduce((a, b) => a + b, 0);
  const anomalyTotal = Object.values(anomalies).reduce((a, b) => a + b, 0);
  if (inputEntities === 0) throw new PublicationError("empty_export");
  if (rejectedTotal / inputEntities > t.maxRejectedRatio) {
    throw new PublicationError("rejection_ratio_exceeded", { rejected, inputEntities });
  }
  if (anomalyTotal / inputEntities > t.maxAnomalyRatio) {
    throw new PublicationError("anomaly_ratio_exceeded", { anomalies, inputEntities });
  }

  // ---- Items that are actually referenced ------------------------------
  const itemAgg = new Map<number, { sources: Set<string>; drops: number; publishable: boolean }>();
  for (const d of drops) {
    const a = itemAgg.get(d.item_id) ?? { sources: new Set(), drops: 0, publishable: false };
    a.sources.add(sk(d.source_type, d.source_id, d.source_level));
    a.drops += d.drops;
    if (d.confidence !== "insufficient") a.publishable = true;
    itemAgg.set(d.item_id, a);
  }
  const items: PubItem[] = [...itemAgg.entries()].map(([id, a]) => {
    const n = itemName.get(id)!;
    return {
      item_id: id, name: n.name, name_norm: n.norm, source_count: a.sources.size, total_drops: a.drops,
      last_observed_at: n.last, indexable: a.publishable,
    };
  });

  // Sources must have at least one bucket.
  const sourcesWithBuckets = new Set([...buckets.values()].map((b) => sk(b.source_type, b.source_id, b.source_level)));
  for (const [key, s] of sources) {
    if (!sourcesWithBuckets.has(key)) { sources.delete(key); continue; }
    s.indexable = s.total_observations >= t.minBucketObservationsForRate;
  }

  // ---- Zones & locations ----------------------------------------------
  const zoneNames = new Map<number, Map<string, number>>();
  const cell = new Map<string, PubLocation>();
  const zoneBucketObs = new Map<string, number>(); // map|bucketKey -> observations in zone
  const grid = config.locationGrid;
  for (const l of ex.locations) {
    const bkey = bk(l.source_type, l.source_id, l.source_level, l.loot_kind);
    const bucket = buckets.get(bkey);
    if (!bucket) continue; // location of an unpublished bucket: silently not published
    if (!Number.isSafeInteger(l.map_id) || l.map_id <= 0 || l.map_id > 999_999) { anomaly("location_invalid_map"); continue; }
    if (!(l.x >= 0 && l.x <= 100 && l.y >= 0 && l.y <= 100)) { anomaly("location_out_of_range"); continue; }
    const zn = sanitizeName(l.zone_name);
    if (!zn.ok) { reject("zone_invalid_name"); continue; }
    const names = zoneNames.get(l.map_id) ?? new Map<string, number>();
    names.set(zn.value, (names.get(zn.value) ?? 0) + l.observations);
    zoneNames.set(l.map_id, names);
    const zbk = `${l.map_id}|${bkey}`;
    zoneBucketObs.set(zbk, (zoneBucketObs.get(zbk) ?? 0) + l.observations);
    // Re-quantize defensively in case the export used a finer grid.
    const x = Math.round(l.x / grid) * grid, y = Math.round(l.y / grid) * grid;
    const sub = sanitizeOptionalName(l.subzone_name);
    const ck = `${bkey}|${l.map_id}|${sub}|${x}|${y}`;
    const existing = cell.get(ck);
    if (existing) existing.observations += l.observations;
    else cell.set(ck, {
      source_type: bucket.source_type, source_id: bucket.source_id, source_level: bucket.source_level,
      loot_kind: bucket.loot_kind, map_id: l.map_id, subzone_name: sub, x: round1(x), y: round1(y),
      observations: l.observations,
    });
  }
  const locations = [...cell.values()].filter((c) => c.observations >= t.minLocationCellObservations);

  // Zone membership (honest association): a source is "observed" in a zone when
  // location data places it there; an item is "inferred" to belong to the zone
  // through such a source. The data cannot show in which zone an individual
  // drop happened, so items carry NO zone-specific drop count (observations =
  // null). Global drop counts are never allocated, divided or copied to zones.
  const itemSources = new Map<string, Set<string>>();
  const itemById = new Map(items.map((i) => [i.item_id, i]));
  const zoneEntities = new Map<string, PubZoneEntity>();
  const dropsByBucket = new Map<string, PubDrop[]>();
  for (const d of drops) {
    const key = bk(d.source_type, d.source_id, d.source_level, d.loot_kind);
    (dropsByBucket.get(key) ?? dropsByBucket.set(key, []).get(key)!).push(d);
  }
  for (const [zbk, obs] of zoneBucketObs) {
    const [mapStr, type, idStr, lvlStr, kind] = zbk.split("|") as [string, SourceType, string, string, LootKind];
    const mapId = Number(mapStr);
    const src = sources.get(sk(type, Number(idStr), Number(lvlStr)));
    if (!src) continue;
    const sKey = `${mapId}|source|${src.source_type}|${src.source_id}|${src.source_level}`;
    const se = zoneEntities.get(sKey) ?? {
      map_id: mapId, entity_kind: "source" as const, item_id: null, source_type: src.source_type,
      source_id: src.source_id, source_level: src.source_level, display_kind: src.display_kind,
      name: src.name, name_norm: src.name_norm, loot_kinds: [] as LootKind[], observations: 0,
      association: "observed" as const, associated_source_count: null,
    };
    if (!se.loot_kinds.includes(kind)) se.loot_kinds.push(kind);
    se.observations = (se.observations ?? 0) + obs;
    zoneEntities.set(sKey, se);
    for (const d of dropsByBucket.get(bk(type, src.source_id, src.source_level, kind)) ?? []) {
      const it = itemById.get(d.item_id);
      if (!it) continue;
      const iKey = `${mapId}|item|${d.item_id}`;
      const ie = zoneEntities.get(iKey) ?? {
        map_id: mapId, entity_kind: "item" as const, item_id: d.item_id, source_type: null, source_id: null,
        source_level: null, display_kind: "item" as const, name: it.name, name_norm: it.name_norm,
        loot_kinds: [] as LootKind[], observations: null,
        association: "inferred" as const, associated_source_count: 0,
      };
      if (!ie.loot_kinds.includes(kind)) ie.loot_kinds.push(kind);
      const srcSet = itemSources.get(iKey) ?? itemSources.set(iKey, new Set()).get(iKey)!;
      srcSet.add(`${src.source_type}|${src.source_id}|${src.source_level}`);
      ie.associated_source_count = srcSet.size;
      zoneEntities.set(iKey, ie);
    }
  }
  const zones: PubZone[] = [...zoneNames.entries()].map(([mapId, names]) => {
    const [name] = [...names.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]!;
    const ents = [...zoneEntities.values()].filter((e) => e.map_id === mapId);
    return {
      map_id: mapId, zone_name: name,
      observations: [...names.values()].reduce((a, b) => a + b, 0),
      source_count: ents.filter((e) => e.entity_kind === "source").length,
      item_count: ents.filter((e) => e.entity_kind === "item").length,
    };
  });

  // ---- Search index ----------------------------------------------------
  const search: PubSearchEntry[] = [];
  const entsBy = (pred: (e: PubZoneEntity) => boolean) => [...zoneEntities.values()].filter(pred);
  for (const it of items) {
    const kinds = new Set<LootKind>(drops.filter((d) => d.item_id === it.item_id).map((d) => d.loot_kind));
    const maps = new Set(entsBy((e) => e.entity_kind === "item" && e.item_id === it.item_id).map((e) => e.map_id));
    search.push({
      entity_kind: "item", display_kind: "item", item_id: it.item_id, source_type: null, source_id: null,
      source_level: null, name: it.name, name_norm: it.name_norm, loot_kinds: sorted(kinds), map_ids: sortedNum(maps),
      observations: it.total_drops,
    });
  }
  for (const s of sources.values()) {
    const kinds = new Set<LootKind>([...buckets.values()]
      .filter((b) => b.source_type === s.source_type && b.source_id === s.source_id && b.source_level === s.source_level)
      .map((b) => b.loot_kind));
    const maps = new Set(entsBy((e) => e.entity_kind === "source" && e.source_type === s.source_type
      && e.source_id === s.source_id && e.source_level === s.source_level).map((e) => e.map_id));
    search.push({
      entity_kind: "source", display_kind: s.display_kind, item_id: null, source_type: s.source_type,
      source_id: s.source_id, source_level: s.source_level, name: s.name, name_norm: s.name_norm,
      loot_kinds: sorted(kinds), map_ids: sortedNum(maps), observations: s.total_observations,
    });
  }

  const projection: Projection = {
    contractVersion: 1,
    sourceDataUpdatedAt: ex.meta.data_updated_at,
    items: items.sort((a, b) => a.item_id - b.item_id),
    sources: [...sources.values()].sort(cmpSource),
    buckets: [...buckets.values()].map(({ dominated: _d, ...b }) => b).sort((a, b) => cmpSource(a, b) || a.loot_kind.localeCompare(b.loot_kind)),
    drops: drops.sort((a, b) => cmpSource(a, b) || a.loot_kind.localeCompare(b.loot_kind) || a.item_id - b.item_id),
    zones: zones.sort((a, b) => a.map_id - b.map_id),
    zone_entities: [...zoneEntities.values()]
      .map((e) => ({ ...e, loot_kinds: sorted(new Set(e.loot_kinds)) }))
      .sort((a, b) => a.map_id - b.map_id || a.entity_kind.localeCompare(b.entity_kind)
        || (a.item_id ?? 0) - (b.item_id ?? 0) || cmpSource(a as never, b as never)),
    locations: locations.sort((a, b) => cmpSource(a, b) || a.loot_kind.localeCompare(b.loot_kind) || a.map_id - b.map_id
      || a.subzone_name.localeCompare(b.subzone_name) || a.x - b.x || a.y - b.y),
    search_index: search.sort((a, b) => a.entity_kind.localeCompare(b.entity_kind) || (a.item_id ?? 0) - (b.item_id ?? 0)
      || cmpSource(a as never, b as never)),
  };

  const report: BuildReport = {
    exportedAt: ex.meta.exported_at,
    input: {
      items: ex.items.length, sources: ex.sources.length, buckets: ex.buckets.length,
      drops: ex.drops.length, locations: ex.locations.length,
    },
    output: countsOf(projection),
    rejected,
    anomalies,
    contentSha256: contentHash(projection),
  };
  return { projection, report };
}

export function countsOf(p: Projection): Record<string, number> {
  return {
    items: p.items.length, sources: p.sources.length, buckets: p.buckets.length, drops: p.drops.length,
    zones: p.zones.length, zone_entities: p.zone_entities.length, locations: p.locations.length,
    search_index: p.search_index.length,
  };
}

/** Deterministic hash over the published content (canonical JSON, sorted keys). */
export function contentHash(p: Projection): string {
  return createHash("sha256").update(canonicalJson(p)).digest("hex");
}

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

function cmpSource(
  a: { source_type: string | null; source_id: number | null; source_level: number | null },
  b: { source_type: string | null; source_id: number | null; source_level: number | null },
): number {
  return (a.source_type ?? "").localeCompare(b.source_type ?? "") || (a.source_id ?? 0) - (b.source_id ?? 0)
    || (a.source_level ?? 0) - (b.source_level ?? 0);
}
const sorted = <T extends string>(s: Set<T>) => [...s].sort();
const sortedNum = (s: Set<number>) => [...s].sort((a, b) => a - b);
const round1 = (v: number) => Math.round(v * 10) / 10;
