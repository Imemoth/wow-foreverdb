import "server-only";
import sample from "./fixture/public-projection.sample.json";
import {
  InvalidQueryError,
  type DatasetMeta,
  type DisplayKind,
  type DropRow,
  type ItemDetail,
  type LootKind,
  type Page,
  type PublicDataAdapter,
  type RecentRow,
  type SearchQuery,
  type SearchRow,
  type SitemapRow,
  type SourceDetail,
  type SourceType,
  type ZoneDetail,
  type ZoneEntityQuery,
  type ZoneSummary,
} from "./types";

/**
 * EXPLICITLY LABELED MOCK ADAPTER.
 *
 * Serves the synthetic sample projection produced by the real publisher from
 * invented test data (database/tests/fixtures). It is used only when no
 * isolated public database is provisioned, and every page renders a
 * "synthetic sample data" banner while it is active. env.ts forbids this
 * adapter in production deployments.
 *
 * Semantics deliberately mirror web_api.* in database/public-read.
 */

type P = typeof sample.projection;
type Src = P["sources"][number];
type Drop = P["drops"][number];
type SI = P["search_index"][number];

const proj: P = sample.projection;
const itemsById = new Map(proj.items.map((i) => [i.item_id, i]));
const sKey = (t: string, id: number, l: number) => `${t}|${id}|${l}`;
const sourcesByKey = new Map(proj.sources.map((s) => [sKey(s.source_type, s.source_id, s.source_level), s]));

const confRank = (c: string) => (c === "high" ? 0 : c === "medium" ? 1 : c === "low" ? 2 : 3);

function dropRow(d: Drop): DropRow {
  const s = sourcesByKey.get(sKey(d.source_type, d.source_id, d.source_level)) as Src;
  const i = itemsById.get(d.item_id)!;
  return {
    source: { type: s.source_type as SourceType, id: s.source_id, level: s.source_level, name: s.name, displayKind: s.display_kind as DisplayKind },
    item: { id: i.item_id, name: i.name },
    lootKind: d.loot_kind as LootKind,
    drops: d.drops, quantity: d.quantity, observations: d.observations,
    rate: d.rate, rateLower: d.rate_lower, rateUpper: d.rate_upper,
    confidence: d.confidence as DropRow["confidence"], dominated: d.dominated,
  };
}

function searchRow(si: Pick<SI, "entity_kind" | "display_kind" | "item_id" | "source_type" | "source_id" | "source_level" | "name" | "loot_kinds" | "observations"> & { map_ids?: number[] }): SearchRow {
  return {
    entityKind: si.entity_kind as "item" | "source",
    displayKind: si.display_kind as DisplayKind,
    itemId: si.item_id, sourceType: si.source_type as SourceType | null, sourceId: si.source_id,
    sourceLevel: si.source_level, name: si.name, lootKinds: si.loot_kinds as LootKind[],
    mapIds: si.map_ids ?? [], observations: si.observations,
  };
}

const byDropOrder = (a: DropRow, b: DropRow) =>
  confRank(a.confidence) - confRank(b.confidence) || (b.rateLower ?? -1) - (a.rateLower ?? -1) || b.observations - a.observations;

export class FixtureAdapter implements PublicDataAdapter {
  readonly mode = "synthetic-sample" as const;

  async meta(): Promise<DatasetMeta> {
    return {
      mode: this.mode, publicationId: 0, publishedAt: sample.publishedAt,
      dataUpdatedAt: proj.sourceDataUpdatedAt, counts: sample.report.output,
      thresholds: { minBucketObservationsForRate: 10, lowConfidenceBelow: 30, highConfidenceAtLeast: 100 },
    };
  }

  async search(q: SearchQuery): Promise<Page<SearchRow>> {
    const text = q.q.toLowerCase();
    if (text === "" && q.zone == null && q.kind == null) throw new InvalidQueryError("query_or_filter_required");
    const id = /^-?\d{1,12}$/.test(text) ? Number(text) : null;
    const rankOf = (si: SI) =>
      id != null && (si.item_id === id || si.source_id === id) ? 0
        : text === "" ? 3 : si.name_norm === text ? 1 : si.name_norm.startsWith(text) ? 2 : 3;
    const matched = proj.search_index.filter((si) =>
      (q.category == null || si.display_kind === q.category)
      && (q.zone == null || si.map_ids.includes(q.zone))
      && (q.kind == null || si.loot_kinds.includes(q.kind))
      && (text === "" || (id != null ? si.item_id === id || si.source_id === id : si.name_norm.includes(text))));
    matched.sort((a, b) => {
      const r = q.sort === "relevance" ? rankOf(a) - rankOf(b) : q.sort === "observations" ? b.observations - a.observations : 0;
      return r || a.name_norm.localeCompare(b.name_norm) || a.display_kind.localeCompare(b.display_kind)
        || (a.item_id ?? 0) - (b.item_id ?? 0) || (a.source_id ?? 0) - (b.source_id ?? 0) || (a.source_level ?? 0) - (b.source_level ?? 0);
    });
    const start = (q.page - 1) * q.pageSize;
    return { rows: matched.slice(start, start + q.pageSize).map(searchRow), total: matched.length };
  }

  async item(id: number): Promise<ItemDetail | null> {
    const i = itemsById.get(id);
    if (!i) return null;
    const zones = proj.zone_entities
      .filter((z) => z.entity_kind === "item" && z.item_id === id)
      .map((z) => ({ mapId: z.map_id, zoneName: proj.zones.find((x) => x.map_id === z.map_id)!.zone_name, observations: z.observations }))
      .sort((a, b) => b.observations - a.observations);
    return {
      item: { id: i.item_id, name: i.name, sourceCount: i.source_count, totalDrops: i.total_drops, lastObservedAt: i.last_observed_at, indexable: i.indexable },
      drops: proj.drops.filter((d) => d.item_id === id).map(dropRow).sort(byDropOrder).slice(0, 200),
      disenchantsInto: proj.drops.filter((d) => d.source_type === "item" && d.source_id === id).map(dropRow)
        .sort((a, b) => b.drops - a.drops).slice(0, 50),
      zones,
    };
  }

  async source(type: SourceType, id: number): Promise<SourceDetail | null> {
    const variants = proj.sources.filter((s) => s.source_type === type && s.source_id === id).sort((a, b) => a.source_level - b.source_level);
    if (variants.length === 0) return null;
    const zoneObs = new Map<number, number>();
    for (const z of proj.zone_entities) {
      if (z.entity_kind === "source" && z.source_type === type && z.source_id === id) zoneObs.set(z.map_id, (zoneObs.get(z.map_id) ?? 0) + z.observations);
    }
    return {
      type, id,
      variants: variants.map((s) => ({
        level: s.source_level, name: s.name, displayKind: s.display_kind as DisplayKind,
        totalObservations: s.total_observations, lastObservedAt: s.last_observed_at, indexable: s.indexable,
        buckets: proj.buckets.filter((b) => b.source_type === type && b.source_id === id && b.source_level === s.source_level)
          .map((b) => ({ lootKind: b.loot_kind as LootKind, observations: b.observations, confidence: b.confidence as DropRow["confidence"] }))
          .sort((a, b) => b.observations - a.observations),
        drops: proj.drops.filter((d) => d.source_type === type && d.source_id === id && d.source_level === s.source_level)
          .map(dropRow).sort((a, b) => byDropOrder(a, b) || b.drops - a.drops).slice(0, 300),
      })),
      zones: [...zoneObs.entries()].map(([mapId, observations]) => ({
        mapId, zoneName: proj.zones.find((z) => z.map_id === mapId)!.zone_name, observations,
      })).sort((a, b) => b.observations - a.observations),
      locations: proj.locations.filter((l) => l.source_type === type && l.source_id === id)
        .sort((a, b) => b.observations - a.observations).slice(0, 2000)
        .map((l) => ({ level: l.source_level, lootKind: l.loot_kind as LootKind, mapId: l.map_id, subzone: l.subzone_name, x: l.x, y: l.y, observations: l.observations })),
    };
  }

  async zones(): Promise<ZoneSummary[]> {
    return proj.zones.map((z) => ({ mapId: z.map_id, zoneName: z.zone_name, observations: z.observations, sourceCount: z.source_count, itemCount: z.item_count }))
      .sort((a, b) => a.zoneName.localeCompare(b.zoneName)).slice(0, 500);
  }

  async zone(mapId: number): Promise<ZoneDetail | null> {
    const z = proj.zones.find((x) => x.map_id === mapId);
    if (!z) return null;
    const ents = proj.zone_entities.filter((e) => e.map_id === mapId);
    const displayKinds: Record<string, number> = {};
    const lootKinds: Record<string, number> = {};
    for (const e of ents) {
      displayKinds[e.display_kind] = (displayKinds[e.display_kind] ?? 0) + 1;
      if (e.entity_kind === "source") for (const k of e.loot_kinds) lootKinds[k] = (lootKinds[k] ?? 0) + 1;
    }
    return { mapId, zoneName: z.zone_name, observations: z.observations, sourceCount: z.source_count, itemCount: z.item_count, displayKinds, lootKinds };
  }

  async zoneEntities(q: ZoneEntityQuery): Promise<Page<SearchRow>> {
    const text = q.q.toLowerCase();
    const rows = proj.zone_entities.filter((e) => e.map_id === q.mapId
      && (q.displayKind == null || e.display_kind === q.displayKind)
      && (q.lootKind == null || e.loot_kinds.includes(q.lootKind))
      && (text === "" || e.name_norm.includes(text)))
      .sort((a, b) => b.observations - a.observations || a.name_norm.localeCompare(b.name_norm)
        || a.entity_kind.localeCompare(b.entity_kind) || (a.item_id ?? 0) - (b.item_id ?? 0) || (a.source_id ?? 0) - (b.source_id ?? 0));
    const start = (q.page - 1) * q.pageSize;
    return { rows: rows.slice(start, start + q.pageSize).map((e) => searchRow({ ...e, map_ids: [e.map_id] })), total: rows.length };
  }

  async recent(limit: number): Promise<RecentRow[]> {
    const rows: RecentRow[] = [
      ...proj.sources.filter((s) => s.indexable && s.last_observed_at).map((s) => ({
        entityKind: "source" as const, displayKind: s.display_kind as DisplayKind, itemId: null, sourceType: s.source_type as SourceType,
        sourceId: s.source_id, sourceLevel: s.source_level, name: s.name, lastObservedAt: s.last_observed_at })),
      ...proj.items.filter((i) => i.indexable && i.last_observed_at).map((i) => ({
        entityKind: "item" as const, displayKind: "item" as const, itemId: i.item_id, sourceType: null, sourceId: null,
        sourceLevel: null, name: i.name, lastObservedAt: i.last_observed_at })),
    ];
    return rows.sort((a, b) => (b.lastObservedAt ?? "").localeCompare(a.lastObservedAt ?? "") || a.name.localeCompare(b.name)).slice(0, limit);
  }

  async sitemap(entity: "item" | "source" | "zone", offset: number, limit: number): Promise<SitemapRow[]> {
    if (entity === "item") return proj.items.filter((i) => i.indexable).slice(offset, offset + limit)
      .map((i) => ({ itemId: i.item_id, sourceType: null, sourceId: null, mapId: null, updatedAt: i.last_observed_at }));
    if (entity === "zone") return proj.zones.slice(offset, offset + limit)
      .map((z) => ({ itemId: null, sourceType: null, sourceId: null, mapId: z.map_id, updatedAt: null }));
    const seen = new Set<string>();
    return proj.sources.filter((s) => s.indexable && !seen.has(`${s.source_type}|${s.source_id}`) && seen.add(`${s.source_type}|${s.source_id}`))
      .slice(offset, offset + limit)
      .map((s) => ({ itemId: null, sourceType: s.source_type as SourceType, sourceId: s.source_id, mapId: null, updatedAt: s.last_observed_at }));
  }
}
