/**
 * Pure projection builder: validated private export -> public read model rows.
 * No I/O. Throws PublicationError to fail the whole run closed.
 */
import { createHash } from "node:crypto";
import {
  exportRowCounts,
  maxExportRows,
  parsePrivateExportBounded,
  type LootKind,
  type PublicationConfig,
  type SourceType,
} from "./contract.ts";
import { sanitizeName, sanitizeOptionalName } from "./sanitize.ts";
import { confidenceFor, round6, wilson, type Confidence } from "./stats.ts";

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
  // Size guard BEFORE any validation: reads array lengths only. Counts, never values.
  const limit = maxExportRows(config);
  const counts = exportRowCounts(rawExport);
  if (counts.total > limit) throw new PublicationError("export_too_large", { limit, rows: counts.total, sections: counts.sections });

  // Bounded, strict validation: stops at MAX_VALIDATION_ISSUES. Fail closed; report only paths/codes, never values (they may be private).
  const parsed = parsePrivateExportBounded(rawExport);
  if (!parsed.success) {
    throw new PublicationError("export_contract_violation", { issues: parsed.issues, truncated: parsed.truncated });
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
  // Single-pass indexes (the original per-zone / per-item / per-source filters over every entity were O(n^2): 10x the
  // measured volume already cost ~1.5 s of CPU, 100x would not fit an Edge Function's 2 s CPU budget).
  const zoneSourceCount = new Map<number, number>();
  const zoneItemCount = new Map<number, number>();
  const sourceMaps = new Map<string, Set<number>>(); // source key -> maps where the source entity exists
  const itemMaps = new Map<number, Set<number>>(); // item id -> maps where the item entity exists
  for (const e of zoneEntities.values()) {
    if (e.entity_kind === "source") {
      zoneSourceCount.set(e.map_id, (zoneSourceCount.get(e.map_id) ?? 0) + 1);
      const k = sk(e.source_type!, e.source_id!, e.source_level!);
      (sourceMaps.get(k) ?? sourceMaps.set(k, new Set()).get(k)!).add(e.map_id);
    } else {
      zoneItemCount.set(e.map_id, (zoneItemCount.get(e.map_id) ?? 0) + 1);
      (itemMaps.get(e.item_id!) ?? itemMaps.set(e.item_id!, new Set()).get(e.item_id!)!).add(e.map_id);
    }
  }
  const zones: PubZone[] = [...zoneNames.entries()].map(([mapId, names]) => {
    const [name] = [...names.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]!;
    return {
      map_id: mapId, zone_name: name,
      observations: [...names.values()].reduce((a, b) => a + b, 0),
      source_count: zoneSourceCount.get(mapId) ?? 0,
      item_count: zoneItemCount.get(mapId) ?? 0,
    };
  });

  // ---- Search index ----------------------------------------------------
  const itemKinds = new Map<number, Set<LootKind>>();
  for (const d of drops) (itemKinds.get(d.item_id) ?? itemKinds.set(d.item_id, new Set()).get(d.item_id)!).add(d.loot_kind);
  const sourceKinds = new Map<string, Set<LootKind>>();
  for (const b of buckets.values()) {
    const k = sk(b.source_type, b.source_id, b.source_level);
    (sourceKinds.get(k) ?? sourceKinds.set(k, new Set()).get(k)!).add(b.loot_kind);
  }
  const search: PubSearchEntry[] = [];
  const NONE = new Set<never>();
  for (const it of items) {
    search.push({
      entity_kind: "item", display_kind: "item", item_id: it.item_id, source_type: null, source_id: null,
      source_level: null, name: it.name, name_norm: it.name_norm,
      loot_kinds: sorted(itemKinds.get(it.item_id) ?? (NONE as Set<LootKind>)),
      map_ids: sortedNum(itemMaps.get(it.item_id) ?? NONE as Set<number>),
      observations: it.total_drops,
    });
  }
  for (const s of sources.values()) {
    const key = sk(s.source_type, s.source_id, s.source_level);
    search.push({
      entity_kind: "source", display_kind: s.display_kind, item_id: null, source_type: s.source_type,
      source_id: s.source_id, source_level: s.source_level, name: s.name, name_norm: s.name_norm,
      loot_kinds: sorted(sourceKinds.get(key) ?? (NONE as Set<LootKind>)),
      map_ids: sortedNum(sourceMaps.get(key) ?? NONE as Set<number>),
      observations: s.total_observations,
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

/**
 * Deterministic hash over the published content: the canonical JSON (sorted keys, no whitespace) fed to SHA-256 in pieces.
 * Uses the engine's native JSON.stringify with an ARRAY replacer, which both allow-lists and ORDERS property names; the sorted
 * union of all property names therefore yields exactly the per-object sorted-key text of `canonicalJson`, at a fraction of
 * the CPU of a JS-level writer. (test/golden-hash.test.ts proves the two agree.)
 */
export function contentHash(p: Projection): string {
  const keys = sortedKeyUnion(p);
  const h = createHash("sha256");
  const top = Object.keys(p).sort();
  h.update("{");
  top.forEach((k, i) => {
    h.update(`${i > 0 ? "," : ""}${JSON.stringify(k)}:`);
    const v = (p as unknown as Record<string, unknown>)[k];
    if (!Array.isArray(v)) {
      h.update(JSON.stringify(v, keys));
      return;
    }
    h.update("[");
    for (let at = 0; at < v.length; at += 2000) {
      const piece = JSON.stringify(v.slice(at, at + 2000), keys);
      h.update(`${at > 0 ? "," : ""}${piece.slice(1, -1)}`);
    }
    h.update("]");
  });
  h.update("}");
  return h.digest("hex");
}

/** Every property name that occurs anywhere in the projection (rows of one table share their shape), sorted. */
function sortedKeyUnion(p: Projection): string[] {
  const names = new Set<string>(Object.keys(p));
  const visit = (v: unknown): void => {
    if (v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const e of v) visit(e);
      return;
    }
    for (const k of Object.keys(v as object)) {
      names.add(k);
      visit((v as Record<string, unknown>)[k]);
    }
  };
  for (const k of Object.keys(p)) {
    const v = (p as unknown as Record<string, unknown>)[k];
    if (!Array.isArray(v)) visit(v);
    else for (const row of v) visit(row);
  }
  return [...names].sort();
}

export function canonicalJson(v: unknown): string {
  let out = "";
  writeCanonical(v, (piece) => {
    out += piece;
  });
  return out;
}

// Rows of one table share a key order; remember the sorted order per distinct (unsorted) key sequence.
const SORTED_KEYS = new Map<string, string[]>();
function sortedKeysOf(o: Record<string, unknown>): string[] {
  const keys = Object.keys(o);
  const sig = keys.join("\u0000");
  let sorted = SORTED_KEYS.get(sig);
  if (!sorted) {
    sorted = [...keys].sort();
    if (SORTED_KEYS.size < 256) SORTED_KEYS.set(sig, sorted);
  }
  return sorted;
}

/** Writes exactly the text `{"k":v,...}` / `[a,b]` / JSON scalars that the previous recursive string concatenation produced. */
function writeCanonical(v: unknown, emit: (s: string) => void): void {
  if (v === null || typeof v !== "object") {
    emit(JSON.stringify(v));
    return;
  }
  if (Array.isArray(v)) {
    emit("[");
    for (let i = 0; i < v.length; i += 1) {
      if (i > 0) emit(",");
      writeCanonical(v[i], emit);
    }
    emit("]");
    return;
  }
  const o = v as Record<string, unknown>;
  emit("{");
  const keys = sortedKeysOf(o);
  for (let i = 0; i < keys.length; i += 1) {
    const k = keys[i]!;
    if (i > 0) emit(",");
    emit(JSON.stringify(k));
    emit(":");
    writeCanonical(o[k], emit);
  }
  emit("}");
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
