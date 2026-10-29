/**
 * Publication allowlist - the ONLY fields that may cross from the private
 * aggregate export into the public projection.
 *
 * Every export row is parsed with a `.strict()` schema: an unexpected column
 * (for example an installation identifier added to an export function by
 * mistake) makes the whole run fail closed instead of being silently dropped
 * or, worse, published. Expanding this file IS expanding the public data
 * allowlist and requires review (docs/web/data-classification.md).
 */
import { z } from "zod";

// zod 4: z.number() already rejects NaN/Infinity (and .int() is bounded to safe integers), so no .finite().
const int = z.coerce.number().int();
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
    installations: int, // threshold input only - NEVER published
    max_installation_share: share, // threshold input only - NEVER published
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

/**
 * Safety threshold for the TOTAL number of input rows (sum of the five collections below). It protects memory, it is not a
 * promise that an export of that size completes inside the Edge CPU budget (measured ceiling is far lower, see
 * docs/web/public-publication-benchmarks.md). Overridable with `limits.maxExportRows` in the publication config.
 */
export const DEFAULT_MAX_EXPORT_ROWS = 120_000;
/**
 * Hard ceiling for the configured limit: equal to the default, so a config can only LOWER the threshold. Measured (Node, V8 heap
 * limits as a proxy for the 256 MB Edge isolate, synthetic compact rows with raw + validated + projected data in memory): 36k rows fit
 * 128 MB, 87k fit 192 MB, 120k fit 256 MB (212 MB used), 145k barely (229 MB), 181k do not; real rows are wider. Going above this is a
 * code change that needs a fresh memory benchmark on the hosted runtime, never a config edit.
 */
export const MAX_CONFIGURABLE_EXPORT_ROWS = DEFAULT_MAX_EXPORT_ROWS;
/** A failing export reports at most this many validation issues; validation stops as soon as the cap is reached. */
export const MAX_VALIDATION_ISSUES = 20;

export const EXPORT_SECTIONS = ["sources", "items", "buckets", "drops", "locations"] as const;
export type ExportSection = (typeof EXPORT_SECTIONS)[number];
const ROW_SCHEMAS = { sources: ExportSource, items: ExportItem, buckets: ExportBucket, drops: ExportDrop, locations: ExportLocation } as const;

/** Row counts per collection of a raw (unvalidated) export. Reads array lengths only, never an element. */
export function exportRowCounts(raw: unknown): { total: number; sections: Record<ExportSection, number> } {
  const sections = { sources: 0, items: 0, buckets: 0, drops: 0, locations: 0 };
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    for (const k of EXPORT_SECTIONS) {
      const v = (raw as Record<string, unknown>)[k];
      sections[k] = Array.isArray(v) ? v.length : 0;
    }
  }
  return { total: EXPORT_SECTIONS.reduce((n, k) => n + sections[k], 0), sections };
}

export interface ValidationIssue {
  path: string;
  code: string;
}
export type BoundedParse =
  | { success: true; data: PrivateExport }
  | { success: false; issues: ValidationIssue[]; /** true: validation stopped at the cap, more problems may exist */ truncated: boolean };

/**
 * Same strict contract as `PrivateExport`, validated row by row so that the work and the memory spent on a failing export are
 * bounded: it stops at `maxIssues` issues instead of building one issue set per failing row. The result for a valid export is
 * identical to `PrivateExport.parse`; a failing one carries only `{path, code}` (never a value, a message or a key name).
 */
export function parsePrivateExportBounded(raw: unknown, maxIssues: number = MAX_VALIDATION_ISSUES): BoundedParse {
  const issues: ValidationIssue[] = [];
  const full = () => issues.length >= maxIssues;
  const add = (path: string, code: string) => {
    if (!full()) issues.push({ path, code });
  };
  const fail = (): BoundedParse => ({ success: false, issues, truncated: full() });

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    add("", "invalid_type");
    return fail();
  }
  const obj = raw as Record<string, unknown>;
  if (Object.keys(obj).some((k) => k !== "meta" && !(EXPORT_SECTIONS as readonly string[]).includes(k))) add("", "unrecognized_keys");

  // One row. A throwing transform (an unparseable timestamp) is a violation too, reported without its message.
  const parseRow = (schema: { safeParse(v: unknown): { success: boolean; data?: unknown; error?: { issues: { path: PropertyKey[]; code: string }[] } } }, value: unknown, base: string) => {
    let r;
    try {
      r = schema.safeParse(value);
    } catch {
      add(base, "exception");
      return { ok: false as const };
    }
    if (r.success) return { ok: true as const, data: r.data };
    for (const i of r.error?.issues ?? []) add([base, ...i.path.map(String)].filter((x) => x !== "").join("."), i.code);
    return { ok: false as const };
  };

  const meta = parseRow(ExportMeta, obj.meta, "meta");
  const data: Record<string, unknown> = { meta: meta.ok ? meta.data : undefined };
  for (const section of EXPORT_SECTIONS) {
    if (full()) return fail();
    const rows = obj[section];
    if (!Array.isArray(rows)) {
      add(section, "invalid_type");
      continue;
    }
    const out: unknown[] = [];
    for (let i = 0; i < rows.length; i++) {
      const r = parseRow(ROW_SCHEMAS[section], rows[i], `${section}.${i}`);
      if (r.ok) out.push(r.data);
      if (full()) return fail();
    }
    data[section] = out;
  }
  if (issues.length > 0) return fail();
  return { success: true, data: data as PrivateExport };
}

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
    /** Optional. Absent = DEFAULT_MAX_EXPORT_ROWS. Can only lower the threshold (max MAX_CONFIGURABLE_EXPORT_ROWS). Never changes published content. */
    limits: z.object({ maxExportRows: z.number().int().min(1).max(MAX_CONFIGURABLE_EXPORT_ROWS) }).strict().optional(),
  })
  .strict();
export type PublicationConfig = z.infer<typeof PublicationConfig>;

/** The effective total-row safety threshold of a parsed config. */
export const maxExportRows = (config: PublicationConfig): number =>
  Math.min(config.limits?.maxExportRows ?? DEFAULT_MAX_EXPORT_ROWS, MAX_CONFIGURABLE_EXPORT_ROWS); // clamped again: a hand-built, unparsed config cannot exceed the ceiling
