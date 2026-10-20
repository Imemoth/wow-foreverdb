// Regenerates src/lib/maps/atlas/atlas-index.snapshot.json from a published atlas/index.json.
//   node scripts/refresh-atlas-snapshot.mjs <path-to-index.json> [approved-zip-sha256]
// Reads a LOCAL file only (download the index first, e.g. with curl or Invoke-WebRequest, and compare its sha256 with the published one).
// The snapshot is only the OFFLINE FALLBACK of the runtime catalog loader (lib/maps/atlas/catalog.ts). It never replaces the CDN as
// source of truth; tests/unit/atlas-snapshot.test.ts validates it with the same schema the runtime uses. Output is deterministic.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const [src, zipSha = null] = process.argv.slice(2);
if (!src) { console.error("usage: refresh-atlas-snapshot.mjs <index.json> [zip-sha256]"); process.exit(2); }
if (zipSha && !/^[0-9a-f]{64}$/.test(zipSha)) { console.error("zip sha256 must be 64 lowercase hex chars"); process.exit(2); }
const bytes = readFileSync(src);
const index = JSON.parse(bytes.toString("utf8"));
const pick = (v) => v && { variant: v.variant, kind: v.kind, path: v.path, width: v.width, height: v.height, bytes: v.bytes, sha256: v.sha256, isDefault: v.isDefault };
const maps = index.maps.map((m) => ({
  uiMapId: m.uiMapId, internalMapId: m.internalMapId, name: m.name, slug: m.slug, category: m.category, typeName: m.typeName,
  parentUiMapId: m.parentUiMapId ?? null, availability: m.availability, latestVersion: m.latestVersion ?? null, versions: m.versions,
  hasFullReveal: m.hasFullReveal, defaultVariant: m.defaultVariant ?? null, image: pick(m.image) ?? null, variants: (m.variants ?? []).map(pick), manifest: m.manifest ?? null,
})).sort((a, b) => a.uiMapId - b.uiMapId);
const out = {
  kind: "azerdex-atlas-index", schemaVersion: 1, currentBuild: index.currentBuild,
  snapshot: {
    note: "Offline fallback copy of the published atlas/index.json. The CDN catalog is the source of truth; this is used only when it cannot be fetched.",
    indexJsonSha256: createHash("sha256").update(bytes).digest("hex"), approvedDistributionZipSha256: zipSha,
  },
  maps,
};
writeFileSync(fileURLToPath(new URL("../src/lib/maps/atlas/atlas-index.snapshot.json", import.meta.url)), JSON.stringify(out, null, 1) + "\n");
console.log(`snapshot written: ${maps.length} maps, index sha256 ${out.snapshot.indexJsonSha256}`);
