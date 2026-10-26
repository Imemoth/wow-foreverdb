import { z } from "../../zod";

/**
 * Schema of the PUBLISHED atlas catalog `atlas/index.json` (azerdex-atlas-index, schemaVersion 1) as served from the
 * Cloudflare Pages CDN. Only the fields the website uses are modelled; unknown fields are ignored, never forwarded.
 * Identity is `uiMapId` (UiMap.ID). `internalMapId` (the client's Map.ID) is a different identifier and is never a join key.
 * Slugs are labels, not identifiers: several maps share one.
 */
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PATH = /^forever\/[1-9]\d{0,5}\/v[1-9]\d{0,3}\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const VERSION = /^v[1-9]\d{0,3}$/;
const Sha = z.string().regex(/^[0-9a-f]{64}$/);

const Variant = z.object({
  variant: z.string().regex(/^[a-z0-9-]{1,41}$/),
  kind: z.string().max(40).optional(),
  path: z.string().regex(PATH),
  width: z.number().int().positive().max(16384),
  height: z.number().int().positive().max(16384),
  bytes: z.number().int().positive().optional(),
  sha256: Sha.optional(),
  isDefault: z.boolean().optional(),
});

export const AtlasCategory = z.enum(["zone", "city", "continent", "world", "instance", "dungeon", "raid", "battleground", "other"]);
export type AtlasCategory = z.infer<typeof AtlasCategory>;

const AtlasMapSchema = z.object({
  uiMapId: z.number().int().min(1).max(999_999),
  internalMapId: z.number().int().nullable().optional(),
  name: z.string().min(1).max(120),
  slug: z.string().regex(/^[a-z0-9-]{1,120}$/),
  // Unknown future categories degrade to "other" instead of failing the whole catalog.
  category: AtlasCategory.catch("other"),
  typeName: z.string().max(40).optional(),
  parentUiMapId: z.number().int().min(1).max(999_999).nullable().optional(),
  availability: z.string().max(40),
  latestVersion: z.string().regex(VERSION).nullable().optional(),
  versions: z.array(z.string().regex(VERSION)).max(200).default([]),
  hasFullReveal: z.boolean().default(false),
  defaultVariant: z.string().max(41).nullable().optional(),
  image: Variant.nullable().optional(),
  variants: z.array(Variant).max(20).default([]),
  manifest: z.string().regex(/^forever\/[1-9]\d{0,5}\/v[1-9]\d{0,3}\/manifest\.json$/).nullable().optional(),
});

export const AtlasIndexSchema = z.object({
  kind: z.literal("azerdex-atlas-index"),
  schemaVersion: z.literal(1),
  currentBuild: z.object({ version: z.string().max(40), buildNumber: z.number().int().optional(), product: z.string().max(40).optional() }).passthrough(),
  maps: z.array(AtlasMapSchema).min(1).max(2000),
});

export type AtlasMap = z.infer<typeof AtlasMapSchema>;
export type AtlasIndex = z.infer<typeof AtlasIndexSchema>;

export type AtlasParse = { ok: true; index: AtlasIndex } | { ok: false; error: "invalid_atlas_index" | "duplicate_ui_map_id" | "version_not_published" | "path_mismatch" };

/** Parses and cross-checks a catalog. A catalog that fails ANY check is rejected as a whole (never partially trusted). */
export function parseAtlasIndex(raw: unknown): AtlasParse {
  const r = AtlasIndexSchema.safeParse(raw);
  if (!r.success) return { ok: false, error: "invalid_atlas_index" };
  const seen = new Set<number>();
  for (const m of r.data.maps) {
    if (seen.has(m.uiMapId)) return { ok: false, error: "duplicate_ui_map_id" };
    seen.add(m.uiMapId);
    if (m.latestVersion && !m.versions.includes(m.latestVersion)) return { ok: false, error: "version_not_published" };
    // Every referenced asset path must belong to THIS map and its latest version: a map can never point at another zone's art.
    for (const v of [m.image, ...m.variants]) {
      if (!v) continue;
      const [, id, ver, file] = v.path.split("/");
      if (Number(id) !== m.uiMapId || ver !== m.latestVersion || !FILE.test(file ?? "")) return { ok: false, error: "path_mismatch" };
    }
    if (m.manifest) {
      const [, id, ver] = m.manifest.split("/");
      if (Number(id) !== m.uiMapId || ver !== m.latestVersion) return { ok: false, error: "path_mismatch" };
    }
  }
  return { ok: true, index: r.data };
}
