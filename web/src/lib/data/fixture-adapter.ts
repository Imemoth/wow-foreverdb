import "server-only";
import { aggregateSourceMapPoints, aggregateZoneMapPoints } from "./zone-map-points";
import defaultSample from "./fixture/public-projection.sample.json";
import {
  InvalidQueryError,
  type DatasetMeta,
  type DisplayKind,
  type DropRow,
  type ItemDetail,
  type LootKind,
  type Page,
  type PublicDataAdapter,
  type NewsEntry,
  type NewsPage,
  type NewsQuery,
  type RecentRow,
  type SearchQuery,
  type SearchRow,
  type SitemapRow,
  type SourceDetail,
  type SourceType,
  type ZoneDetail,
  type ZoneEntityQuery,
  type ZoneEntityRow,
  type SourceMapPoints,
  type SourceMapPointsQuery,
  type ZoneMapPoints,
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

type Sample = typeof defaultSample;
type P = Sample["projection"];
type Src = P["sources"][number];
type Drop = P["drops"][number];
type SI = P["search_index"][number];
type ItemMap = Map<number, P["items"][number]>;
type SourceMap = Map<string, Src>;

const sKey = (t: string, id: number, l: number) => `${t}|${id}|${l}`;

const confRank = (c: string) => (c === "high" ? 0 : c === "medium" ? 1 : c === "low" ? 2 : 3);

function dropRow(itemsById: ItemMap, sourcesByKey: SourceMap, d: Drop): DropRow {
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

type FixtureNewsEntry = NewsEntry & { authoritative?: boolean };

/**
 * Deterministic News fixtures exercise the same public-read contract as the
 * beta database. The two replies and the player-created topic are retained in
 * this raw fixture set so E2E tests prove that the adapter exposes only an
 * authoritative Bluepost opener. The edited US opener deliberately keeps its
 * original publication time while carrying a later modifiedAt value.
 */
const NEWS_FIXTURE_ENTRIES: FixtureNewsEntry[] = [
  {
    id: 9001, slug: "us-bluepost-opener-forever-beta", sourceType: "bluepost", sourceKey: "blizzard-bluepost-us",
    sourceEntryId: "post:9001", sourceTopicId: "topic:us-forever-beta", sourcePostNumber: 1, threadKey: "us:topic:us-forever-beta",
    canonicalUrl: "https://us.forums.blizzard.com/en/wow/t/forever-beta/9001/1", title: "US Bluepost opener — Forever Beta",
    author: "Kaivax", region: "us", publishedAt: "2026-10-22T00:00:00.000Z", modifiedAt: "2026-10-22T03:00:00.000Z",
    ingestedAt: "2026-10-22T03:01:00.000Z", excerpt: "The edited Blizzard announcement for the Forever beta.", category: "bluepost", importance: 90, featured: true,
  },
  {
    id: 9002, slug: "eu-bluepost-opener-forever-beta", sourceType: "bluepost", sourceKey: "blizzard-bluepost-eu",
    sourceEntryId: "post:9002", sourceTopicId: "topic:eu-forever-beta", sourcePostNumber: 1, threadKey: "eu:topic:eu-forever-beta",
    canonicalUrl: "https://eu.forums.blizzard.com/en/wow/t/forever-beta/9002/1", title: "EU Bluepost opener — Forever Beta",
    author: "Kaivax", region: "eu", publishedAt: "2026-10-21T23:00:00.000Z", modifiedAt: null,
    ingestedAt: "2026-10-21T23:01:00.000Z", excerpt: "The European Blizzard announcement for the Forever beta.", category: "bluepost", importance: 80, featured: false,
  },
  ...Array.from({ length: 12 }, (_, index): FixtureNewsEntry => {
    const number = index + 3;
    const day = String(21 - Math.floor(index / 2)).padStart(2, "0");
    const region = index % 2 === 0 ? "us" : "eu";
    return {
      id: 9000 + number, slug: `${region}-bluepost-opener-${number}`, sourceType: "bluepost", sourceKey: `blizzard-bluepost-${region}`,
      sourceEntryId: `post:${9000 + number}`, sourceTopicId: `topic:${region}-fixture-${number}`, sourcePostNumber: 1,
      threadKey: `${region}:topic:${region}-fixture-${number}`, canonicalUrl: `https://${region}.forums.blizzard.com/en/wow/t/fixture/${9000 + number}/1`,
      title: `${region.toUpperCase()} Bluepost opener — Fixture ${number}`, author: "Blizzard Tracker", region,
      publishedAt: `2026-10-${day}T${String(index + 1).padStart(2, "0")}:00:00.000Z`, modifiedAt: null,
      ingestedAt: `2026-10-${day}T${String(index + 1).padStart(2, "0")}:01:00.000Z`, excerpt: `A deterministic ${region.toUpperCase()} Blizzard Tracker opener fixture.`,
      category: "bluepost", importance: 10, featured: false,
    };
  }),
  {
    id: 9015, slug: "official-news-fixture", sourceType: "official_news", sourceKey: "blizzard-news-us",
    sourceEntryId: "article:9015", sourceTopicId: null, sourcePostNumber: null, threadKey: null,
    canonicalUrl: "https://worldofwarcraft.blizzard.com/en-us/news/9015/forever-news-fixture", title: "Official News fixture — Forever update",
    author: "Blizzard Entertainment", region: "global", publishedAt: "2026-10-20T12:00:00.000Z", modifiedAt: null,
    ingestedAt: "2026-10-20T12:01:00.000Z", excerpt: "A deterministic official news fixture.", category: "official_news", importance: 20, featured: false,
  },
  {
    id: 9016, slug: "azerdex-news-fixture", sourceType: "azerdex", sourceKey: "azerdex-news",
    sourceEntryId: "article:9016", sourceTopicId: null, sourcePostNumber: null, threadKey: null,
    canonicalUrl: "https://beta.azerdex.com/news/azerdex-news-fixture", title: "AzerDex News fixture — archive improvements",
    author: "AzerDex", region: "global", publishedAt: "2026-10-19T12:00:00.000Z", modifiedAt: null,
    ingestedAt: "2026-10-19T12:01:00.000Z", excerpt: "A deterministic AzerDex editorial fixture.", category: "azerdex", importance: 15, featured: false,
  },
  // This topic has a Blizzard reply but its opener was never in the authoritative
  // tracker feed. It must remain absent from every public News query.
  {
    id: 9017, slug: "user-created-topic-opener", sourceType: "bluepost", sourceKey: "blizzard-bluepost-us",
    sourceEntryId: "post:9017", sourceTopicId: "topic:user-created", sourcePostNumber: 1, threadKey: "us:topic:user-created",
    canonicalUrl: "https://us.forums.blizzard.com/en/wow/t/user-created/9017/1", title: "User-created topic opener",
    author: "ordinary-player", region: "us", publishedAt: "2026-10-18T12:00:00.000Z", modifiedAt: null,
    ingestedAt: "2026-10-18T12:01:00.000Z", excerpt: "A player topic with a later Blizzard reply.", category: "bluepost", importance: 100, featured: true,
    authoritative: false,
  },
  {
    id: 9018, slug: "player-reply-must-not-appear", sourceType: "bluepost", sourceKey: "blizzard-bluepost-us",
    sourceEntryId: "post:9018", sourceTopicId: "topic:us-forever-beta", sourcePostNumber: 2, threadKey: "us:topic:us-forever-beta",
    canonicalUrl: "https://us.forums.blizzard.com/en/wow/t/forever-beta/9001/2", title: "Player reply must not appear",
    author: "ordinary-player", region: "us", publishedAt: "2026-10-23T00:00:00.000Z", modifiedAt: null,
    ingestedAt: "2026-10-23T00:01:00.000Z", excerpt: "A reply that must never become a news item.", category: "bluepost", importance: 100, featured: true,
  },
  {
    id: 9019, slug: "staff-reply-must-not-appear", sourceType: "bluepost", sourceKey: "blizzard-bluepost-us",
    sourceEntryId: "post:9019", sourceTopicId: "topic:us-forever-beta", sourcePostNumber: 3, threadKey: "us:topic:us-forever-beta",
    canonicalUrl: "https://us.forums.blizzard.com/en/wow/t/forever-beta/9001/3", title: "Blizzard staff reply must not appear",
    author: "Blizzard Tracker", region: "us", publishedAt: "2026-10-23T01:00:00.000Z", modifiedAt: null,
    ingestedAt: "2026-10-23T01:01:00.000Z", excerpt: "A staff reply that is not an independent news item.", category: "bluepost", importance: 100, featured: true,
  },
  {
    id: 9020, slug: "user-topic-blizzard-reply", sourceType: "bluepost", sourceKey: "blizzard-bluepost-us",
    sourceEntryId: "post:9020", sourceTopicId: "topic:user-created", sourcePostNumber: 2, threadKey: "us:topic:user-created",
    canonicalUrl: "https://us.forums.blizzard.com/en/wow/t/user-created/9017/2", title: "Blizzard reply to user topic",
    author: "Kaivax", region: "us", publishedAt: "2026-10-18T13:00:00.000Z", modifiedAt: null,
    ingestedAt: "2026-10-18T13:01:00.000Z", excerpt: "A reply in a user-created topic.", category: "bluepost", importance: 100, featured: true,
  },
];

function visibleNewsFixtures(): NewsEntry[] {
  return NEWS_FIXTURE_ENTRIES
    .filter((entry) => entry.authoritative !== false)
    .filter((entry) => entry.sourceType !== "bluepost" || entry.sourcePostNumber === 1)
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || b.id - a.id);
}

export class FixtureAdapter implements PublicDataAdapter {
  readonly mode = "synthetic-sample" as const;
  private readonly sample: Sample;
  private readonly proj: P;
  private readonly itemsById: ItemMap;
  private readonly sourcesByKey: SourceMap;

  /** `sample` is injectable so tests can serve a different deterministic synthetic projection. */
  constructor(sample: Sample = defaultSample) {
    this.sample = sample;
    this.proj = sample.projection;
    this.itemsById = new Map(this.proj.items.map((i) => [i.item_id, i]));
    this.sourcesByKey = new Map(this.proj.sources.map((x) => [sKey(x.source_type, x.source_id, x.source_level), x]));
  }

  private dr = (d: Drop): DropRow => dropRow(this.itemsById, this.sourcesByKey, d);

  async meta(): Promise<DatasetMeta> {
    return {
      mode: this.mode, publicationId: 0, publishedAt: this.sample.publishedAt,
      dataUpdatedAt: this.proj.sourceDataUpdatedAt, counts: this.sample.report.output,
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
    const matched = this.proj.search_index.filter((si) =>
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
    const pageRows = matched.slice(start, start + q.pageSize).map(searchRow);
    // Parity with web_api.search: the total travels on each returned row (count(*) over ()),
    // so an out-of-range page reports 0.
    return { rows: pageRows, total: pageRows.length ? matched.length : 0 };
  }

  async item(id: number): Promise<ItemDetail | null> {
    const i = this.itemsById.get(id);
    if (!i) return null;
    const zones = this.proj.zone_entities
      .filter((z) => z.entity_kind === "item" && z.item_id === id)
      .map((z) => ({
        mapId: z.map_id, zoneName: this.proj.zones.find((x) => x.map_id === z.map_id)!.zone_name,
        observations: null, association: "inferred" as const, sourceCount: z.associated_source_count,
      }))
      .sort((a, b) => (b.sourceCount ?? 0) - (a.sourceCount ?? 0) || a.zoneName.localeCompare(b.zoneName) || a.mapId - b.mapId);
    return {
      item: { id: i.item_id, name: i.name, sourceCount: i.source_count, totalDrops: i.total_drops, lastObservedAt: i.last_observed_at, indexable: i.indexable },
      drops: this.proj.drops.filter((d) => d.item_id === id).map(this.dr).sort(byDropOrder).slice(0, 200),
      disenchantsInto: this.proj.drops.filter((d) => d.source_type === "item" && d.source_id === id).map(this.dr)
        .sort((a, b) => b.drops - a.drops).slice(0, 50),
      zones,
    };
  }

  async source(type: SourceType, id: number): Promise<SourceDetail | null> {
    const variants = this.proj.sources.filter((s) => s.source_type === type && s.source_id === id).sort((a, b) => a.source_level - b.source_level);
    if (variants.length === 0) return null;
    const zoneObs = new Map<number, number>();
    for (const z of this.proj.zone_entities) {
      if (z.entity_kind === "source" && z.source_type === type && z.source_id === id) zoneObs.set(z.map_id, (zoneObs.get(z.map_id) ?? 0) + (z.observations ?? 0));
    }
    return {
      type, id,
      variants: variants.map((s) => ({
        level: s.source_level, name: s.name, displayKind: s.display_kind as DisplayKind,
        totalObservations: s.total_observations, lastObservedAt: s.last_observed_at, indexable: s.indexable,
        buckets: this.proj.buckets.filter((b) => b.source_type === type && b.source_id === id && b.source_level === s.source_level)
          .map((b) => ({ lootKind: b.loot_kind as LootKind, observations: b.observations, confidence: b.confidence as DropRow["confidence"] }))
          .sort((a, b) => b.observations - a.observations),
        drops: this.proj.drops.filter((d) => d.source_type === type && d.source_id === id && d.source_level === s.source_level)
          .map(this.dr).sort((a, b) => byDropOrder(a, b) || b.drops - a.drops).slice(0, 300),
      })),
      zones: [...zoneObs.entries()].map(([mapId, observations]) => ({
        mapId, zoneName: this.proj.zones.find((z) => z.map_id === mapId)!.zone_name, observations, association: "observed" as const,
      })).sort((a, b) => b.observations - a.observations),
      locations: this.proj.locations.filter((l) => l.source_type === type && l.source_id === id)
        .sort((a, b) => b.observations - a.observations).slice(0, 2000)
        .map((l) => ({ level: l.source_level, lootKind: l.loot_kind as LootKind, mapId: l.map_id, subzone: l.subzone_name, x: l.x, y: l.y, observations: l.observations })),
    };
  }

  async zones(): Promise<ZoneSummary[]> {
    return this.proj.zones.map((z) => ({ mapId: z.map_id, zoneName: z.zone_name, observations: z.observations, sourceCount: z.source_count, itemCount: z.item_count }))
      .sort((a, b) => a.zoneName.localeCompare(b.zoneName)).slice(0, 500);
  }

  async zone(mapId: number): Promise<ZoneDetail | null> {
    const z = this.proj.zones.find((x) => x.map_id === mapId);
    if (!z) return null;
    const ents = this.proj.zone_entities.filter((e) => e.map_id === mapId);
    const displayKinds: Record<string, number> = {};
    const lootKinds: Record<string, number> = {};
    for (const e of ents) {
      displayKinds[e.display_kind] = (displayKinds[e.display_kind] ?? 0) + 1;
      if (e.entity_kind === "source") for (const k of e.loot_kinds) lootKinds[k] = (lootKinds[k] ?? 0) + 1;
    }
    return { mapId, zoneName: z.zone_name, observations: z.observations, sourceCount: z.source_count, itemCount: z.item_count, displayKinds, lootKinds };
  }

  async zoneMapPoints(mapId: number, lootKind: LootKind | null, limit: number): Promise<ZoneMapPoints> {
    if (!Number.isInteger(mapId) || mapId < 1 || mapId > 999_999 || !Number.isInteger(limit) || limit < 1 || limit > 3000 || lootKind === "disenchant") {
      throw new InvalidQueryError("invalid_parameters");
    }
    const names = new Map(this.proj.sources.map((s) => [sKey(s.source_type, s.source_id, s.source_level), s.name]));
    return aggregateZoneMapPoints(this.proj.locations, (t, i, l) => names.get(sKey(t, i, l)), mapId, lootKind, limit);
  }

  async sourceMapPoints(q: SourceMapPointsQuery): Promise<SourceMapPoints> {
    if (!["creature", "gameobject", "fishing"].includes(q.sourceType) || !Number.isInteger(q.sourceId) || q.sourceId < -2_147_483_648 || q.sourceId > 999_999_999
        || (q.mapId != null && (!Number.isInteger(q.mapId) || q.mapId < 1 || q.mapId > 999_999))
        || (q.sourceLevel != null && (!Number.isInteger(q.sourceLevel) || q.sourceLevel < 0 || q.sourceLevel > 255))
        || !Number.isInteger(q.limit) || q.limit < 1 || q.limit > 3000 || q.lootKind === "disenchant") {
      throw new InvalidQueryError("invalid_parameters");
    }
    const names = new Map(this.proj.sources.map((s) => [sKey(s.source_type, s.source_id, s.source_level), s.name]));
    return aggregateSourceMapPoints(this.proj.locations, (t, i, l) => names.get(sKey(t, i, l)), q);
  }

  async zoneEntities(q: ZoneEntityQuery): Promise<Page<ZoneEntityRow>> {
    const text = q.q.toLowerCase();
    // Mirrors web_api.zone_entities: measured source observations first, then items
    // (not measured per zone) by in-zone source count. Units are never mixed.
    const nullsLast = (a: number | null, b: number | null) => (a == null ? 1 : 0) - (b == null ? 1 : 0) || (a ?? 0) - (b ?? 0);
    const rows = this.proj.zone_entities.filter((e) => e.map_id === q.mapId
      && (q.displayKind == null || e.display_kind === q.displayKind)
      && (q.lootKind == null || e.loot_kinds.includes(q.lootKind))
      && (text === "" || e.name_norm.includes(text)))
      .sort((a, b) => Number(b.entity_kind === "source") - Number(a.entity_kind === "source")
        || (a.observations == null ? 1 : 0) - (b.observations == null ? 1 : 0) || (b.observations ?? 0) - (a.observations ?? 0)
        || (a.associated_source_count == null ? 1 : 0) - (b.associated_source_count == null ? 1 : 0)
        || (b.associated_source_count ?? 0) - (a.associated_source_count ?? 0)
        || a.name_norm.localeCompare(b.name_norm) || a.entity_kind.localeCompare(b.entity_kind)
        || nullsLast(a.item_id, b.item_id) || (a.source_type == null ? 1 : 0) - (b.source_type == null ? 1 : 0)
        || (a.source_type ?? "").localeCompare(b.source_type ?? "")
        || nullsLast(a.source_id, b.source_id) || nullsLast(a.source_level, b.source_level));
    const start = (q.page - 1) * q.pageSize;
    const pageRows = rows.slice(start, start + q.pageSize);
    return {
      rows: pageRows.map((e) => ({
        ...searchRow({ ...e, observations: 0, map_ids: [e.map_id] }),
        observations: e.observations, association: e.association as ZoneEntityRow["association"],
        associatedSourceCount: e.associated_source_count,
      })),
      // Parity with web_api.zone_entities: out-of-range page reports total 0.
      total: pageRows.length ? rows.length : 0,
    };
  }

  async recent(limit: number): Promise<RecentRow[]> {
    const rows: RecentRow[] = [
      ...this.proj.sources.filter((s) => s.indexable && s.last_observed_at).map((s) => ({
        entityKind: "source" as const, displayKind: s.display_kind as DisplayKind, itemId: null, sourceType: s.source_type as SourceType,
        sourceId: s.source_id, sourceLevel: s.source_level, name: s.name, lastObservedAt: s.last_observed_at })),
      ...this.proj.items.filter((i) => i.indexable && i.last_observed_at).map((i) => ({
        entityKind: "item" as const, displayKind: "item" as const, itemId: i.item_id, sourceType: null, sourceId: null,
        sourceLevel: null, name: i.name, lastObservedAt: i.last_observed_at })),
    ];
    return rows.sort((a, b) => (b.lastObservedAt ?? "").localeCompare(a.lastObservedAt ?? "") || a.name.localeCompare(b.name)).slice(0, limit);
  }

  async newsList(query: NewsQuery): Promise<NewsPage> {
    const text = query.query.trim().toLowerCase();
    const rows = visibleNewsFixtures().filter((entry) =>
      (query.category == null || entry.category === query.category)
      && (text === "" || `${entry.title} ${entry.excerpt}`.toLowerCase().includes(text)));
    const start = (query.page - 1) * query.pageSize;
    const pageRows = rows.slice(start, start + query.pageSize);
    return { rows: pageRows, total: pageRows.length ? rows.length : 0 };
  }

  async newsFeatured(limit: number): Promise<NewsEntry[]> {
    return [...visibleNewsFixtures()]
      .sort((a, b) => Number(b.featured) - Number(a.featured) || b.importance - a.importance
        || b.publishedAt.localeCompare(a.publishedAt) || b.id - a.id)
      .slice(0, Math.min(Math.max(limit, 1), 12));
  }

  async newsEntry(slug: string): Promise<NewsEntry | null> {
    return visibleNewsFixtures().find((entry) => entry.slug === slug) ?? null;
  }

  async sitemap(entity: "item" | "source" | "zone", offset: number, limit: number): Promise<SitemapRow[]> {
    if (entity === "item") return this.proj.items.filter((i) => i.indexable).slice(offset, offset + limit)
      .map((i) => ({ itemId: i.item_id, sourceType: null, sourceId: null, mapId: null, updatedAt: i.last_observed_at }));
    if (entity === "zone") return this.proj.zones.slice(offset, offset + limit)
      .map((z) => ({ itemId: null, sourceType: null, sourceId: null, mapId: z.map_id, updatedAt: null }));
    const seen = new Set<string>();
    return this.proj.sources.filter((s) => s.indexable && !seen.has(`${s.source_type}|${s.source_id}`) && seen.add(`${s.source_type}|${s.source_id}`))
      .slice(offset, offset + limit)
      .map((s) => ({ itemId: null, sourceType: s.source_type as SourceType, sourceId: s.source_id, mapId: null, updatedAt: s.last_observed_at }));
  }
}
