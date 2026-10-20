import { z } from "zod";

/** Versioned map asset manifest (public/maps/forever/<zoneId>/<version>/manifest.json). */
const Manifest = z.object({
  schemaVersion: z.literal(1),
  zoneId: z.number().int().positive(),
  slug: z.string().regex(/^[a-z0-9-]+$/),
  zoneName: z.string().min(1),
  version: z.string().regex(/^v\d{1,4}$/),
  image: z.object({
    file: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    format: z.enum(["webp", "png"]),
    width: z.number().int().positive().max(16384),
    height: z.number().int().positive().max(16384),
    bytes: z.number().int().positive().optional(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  }),
  projection: z.object({
    type: z.literal("normalized-percent"),
    origin: z.literal("top-left"),
    xDirection: z.literal("right"),
    yDirection: z.literal("down"),
    range: z.tuple([z.literal(0), z.literal(100)]),
  }).passthrough(),
  provenance: z.object({ source: z.string().min(1) }).passthrough(),
  calibration: z.object({ status: z.enum(["provisional", "validated"]) }).passthrough(),
});

export type MapManifest = z.infer<typeof Manifest>;

export type ManifestResult = { ok: true; manifest: MapManifest } | { ok: false; error: "invalid_json" | "invalid_manifest" };

export function parseManifest(raw: unknown): ManifestResult {
  const r = Manifest.safeParse(raw);
  return r.success ? { ok: true, manifest: r.data } : { ok: false, error: "invalid_manifest" };
}

export type LoadResult = ManifestResult | { ok: false; error: "unavailable" };

/** Fetches and validates a manifest. Never throws: a missing/blocked/garbled asset becomes an error result. */
export async function loadManifest(url: string, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<LoadResult> {
  let res: Response;
  try { res = await fetchImpl(url, { signal, credentials: "omit" }); } catch { return { ok: false, error: "unavailable" }; }
  if (!res.ok) return { ok: false, error: "unavailable" };
  let json: unknown;
  try { json = await res.json(); } catch { return { ok: false, error: "invalid_json" }; }
  return parseManifest(json);
}
