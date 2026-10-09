/**
 * Publication allowlist — the ONLY fields that may cross from the private
 * aggregate export into the public projection.
 *
 * Every export row is parsed with a `.strict()` schema: an unexpected column
 * (for example an installation identifier added to an export function by
 * mistake) makes the whole run fail closed instead of being silently dropped
 * or, worse, published. Expanding this file IS expanding the public data
 * allowlist and requires review (docs/web/data-classification.md).
 */
import { z } from "zod";

const int = z.coerce.number().int().finite();
const bigintLike = z.union([z.string().regex(/^-?\d{1,18}$/), z.number().int()]).transform(Number);
const ts = z.union([z.string(), z.date()]).nullable().transform((v) => (v == null ? null : new Date(v).toISOString()));
const share = z.union([z.string(), z.number()]).nullable().transform((v) => (v == null ? null : Number(v)));

export const SOURCE_TYPES = ["creature", "gameobject", "fishing", "item"] as const;
export const LOOT_KINDS = [
  "mob", "skinning", "mining", "herbalism", "fishing", "fishing_pool", "chest", "gameobject", "disenchant",
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];
export type LootKind = (typeof LOOT_KINDS)[number];

export const ExportMeta = z
  .object({ contract_version: int, exported_at: ts, data_updated_at: ts })
  .strict();

export const ExportSource = z
  .object({
    source_type: z.string(),
    source_id: bigintLike,
    source_level: int,
    name: z.string().nullable(),
    first_seen_at: ts,
    last_seen_at: ts,
  })
  .strict();

export const ExportItem = z
  .object({ item_id: bigintLike, name: z.string().nullable(), first_seen_at: ts, last_seen_at: ts })
  .strict();

export const ExportBucket = z
  .object({
    source_type: z.string(),
    source_id: bigintLike,
    source_level: int,
    loot_kind: z.string(),
    observations: bigintLike,
    installations: int, // threshold input only — NEVER published
    max_installation_share: share, // threshold input only — NEVER published
    last_updated_at: ts,
  })
  .strict();

export const ExportDrop = z
  .object({
    source_type: z.string(),
    source_id: bigintLike,
    source_level: int,
    loot_kind: z.string(),
    item_id: bigintLike,
    drops: bigintLike,
    quantity: bigintLike,
    quest_drops: bigintLike, // read for contract completeness; not published (not allowlisted)
    installations: int,
    max_installation_share: share,
  })
  .strict();

export const ExportLocation = z
  .object({
    source_type: z.string(),
    source_id: bigintLike,
    source_level: int,
    loot_kind: z.string(),
    map_id: bigintLike,
    zone_name: z.string().nullable(),
    subzone_name: z.string().nullable(),
    x: z.union([z.string(), z.number()]).transform(Number),
    y: z.union([z.string(), z.number()]).transform(Number),
    observations: bigintLike,
    installations: int,
  })
  .strict();

export const PrivateExport = z
  .object({
    meta: ExportMeta,
    sources: z.array(ExportSource),
    items: z.array(ExportItem),
    buckets: z.array(ExportBucket),
    drops: z.array(ExportDrop),
    locations: z.array(ExportLocation),
  })
  .strict();

export type PrivateExport = z.infer<typeof PrivateExport>;

export const PublicationConfig = z
  .object({
    contractVersion: z.literal(1),
    locationGrid: z.union([z.literal(0.5), z.literal(1), z.literal(2), z.literal(2.5), z.literal(5)]),
    thresholds: z
      .object({
        minBucketObservationsForRate: z.number().int().min(1).max(10000),
        lowConfidenceBelow: z.number().int().min(1),
        highConfidenceAtLeast: z.number().int().min(1),
        dominatedShare: z.number().gt(0).max(1),
        minLocationCellObservations: z.number().int().min(1),
        maxRejectedRatio: z.number().min(0).max(0.5),
        maxAnomalyRatio: z.number().min(0).max(0.5),
      })
      .strict()
      .refine((t) => t.minBucketObservationsForRate <= t.lowConfidenceBelow && t.lowConfidenceBelow <= t.highConfidenceAtLeast, {
        message: "confidence thresholds must be ordered",
      }),
    allowedSourceTypes: z.array(z.enum(SOURCE_TYPES)).min(1),
    allowedLootKinds: z.array(z.enum(LOOT_KINDS)).min(1),
    retainPublications: z.number().int().min(2).max(10),
  })
  .strict();
export type PublicationConfig = z.infer<typeof PublicationConfig>;
