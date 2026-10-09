/** Public read-model DTOs. These mirror web_api.* outputs (database/public-read). */

export const SOURCE_TYPES = ["creature", "gameobject", "fishing", "item"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const LOOT_KINDS = [
  "mob", "skinning", "mining", "herbalism", "fishing", "fishing_pool", "chest", "gameobject", "disenchant",
] as const;
export type LootKind = (typeof LOOT_KINDS)[number];

export const DISPLAY_KINDS = ["item", "creature", "object", "fishing_pool", "fishing"] as const;
export type DisplayKind = (typeof DISPLAY_KINDS)[number];

export type Confidence = "insufficient" | "low" | "medium" | "high";
export type DatasetMode = "synthetic-sample" | "published";

export interface DatasetMeta {
  mode: DatasetMode;
  publicationId: number | null;
  publishedAt: string | null;
  dataUpdatedAt: string | null;
  counts: Record<string, number> | null;
  thresholds: { minBucketObservationsForRate?: number; lowConfidenceBelow?: number; highConfidenceAtLeast?: number } | null;
}

export interface EntityRef {
  entityKind: "item" | "source";
  displayKind: DisplayKind;
  itemId: number | null;
  sourceType: SourceType | null;
  sourceId: number | null;
  sourceLevel: number | null;
  name: string;
}

export interface SearchRow extends EntityRef {
  lootKinds: LootKind[];
  mapIds: number[];
  observations: number;
}

export interface SearchQuery {
  q: string;
  category: DisplayKind | null;
  zone: number | null;
  kind: LootKind | null;
  sort: "relevance" | "name" | "observations";
  page: number;
  pageSize: number;
}

export interface Page<T> { rows: T[]; total: number }

export interface DropRow {
  source: { type: SourceType; id: number; level: number; name: string; displayKind: DisplayKind };
  item: { id: number; name: string };
  lootKind: LootKind;
  drops: number;
  quantity: number;
  observations: number;
  rate: number | null;
  rateLower: number | null;
  rateUpper: number | null;
  confidence: Confidence;
  dominated: boolean;
}

export interface ZoneRef { mapId: number; zoneName: string; observations: number }

export interface ItemDetail {
  item: { id: number; name: string; sourceCount: number; totalDrops: number; lastObservedAt: string | null; indexable: boolean };
  drops: DropRow[];
  disenchantsInto: DropRow[];
  zones: ZoneRef[];
}

export interface SourceVariant {
  level: number;
  name: string;
  displayKind: DisplayKind;
  totalObservations: number;
  lastObservedAt: string | null;
  indexable: boolean;
  buckets: { lootKind: LootKind; observations: number; confidence: Confidence }[];
  drops: DropRow[];
}

export interface LocationPoint {
  level: number; lootKind: LootKind; mapId: number; subzone: string; x: number; y: number; observations: number;
}

export interface SourceDetail {
  type: SourceType;
  id: number;
  variants: SourceVariant[];
  zones: ZoneRef[];
  locations: LocationPoint[];
}

export interface ZoneSummary { mapId: number; zoneName: string; observations: number; sourceCount: number; itemCount: number }

export interface ZoneDetail extends ZoneSummary {
  displayKinds: Partial<Record<DisplayKind, number>>;
  lootKinds: Partial<Record<LootKind, number>>;
}

export interface ZoneEntityQuery {
  mapId: number; displayKind: DisplayKind | null; lootKind: LootKind | null; q: string; page: number; pageSize: number;
}

export interface RecentRow extends EntityRef { lastObservedAt: string | null }

export interface SitemapRow { itemId: number | null; sourceType: SourceType | null; sourceId: number | null; mapId: number | null; updatedAt: string | null }

/** The ONLY data interface the website uses. No generic query capability. */
export interface PublicDataAdapter {
  readonly mode: DatasetMode;
  meta(): Promise<DatasetMeta>;
  search(q: SearchQuery): Promise<Page<SearchRow>>;
  item(id: number): Promise<ItemDetail | null>;
  source(type: SourceType, id: number): Promise<SourceDetail | null>;
  zones(): Promise<ZoneSummary[]>;
  zone(mapId: number): Promise<ZoneDetail | null>;
  zoneEntities(q: ZoneEntityQuery): Promise<Page<SearchRow>>;
  recent(limit: number): Promise<RecentRow[]>;
  sitemap(entity: "item" | "source" | "zone", offset: number, limit: number): Promise<SitemapRow[]>;
}

export class InvalidQueryError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "InvalidQueryError";
  }
}
