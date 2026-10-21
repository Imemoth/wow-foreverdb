import "server-only";
import { parseAssetBase } from "../asset-url";
import snapshot from "./atlas-index.snapshot.json";
import { createAtlasCatalogLoader } from "./catalog-loader";

export type { AtlasCatalog } from "./catalog-loader";

let loader: ReturnType<typeof createAtlasCatalogLoader> | null = null;

/** Process-wide atlas catalog (CDN with verified-snapshot fallback). Configured from the same env as the map assets. */
export function atlasCatalog() {
  // AZERDEX_ATLAS_CATALOG=snapshot pins the bundled snapshot (hermetic CI / offline previews); anything else = CDN with snapshot fallback.
  const base = process.env.AZERDEX_ATLAS_CATALOG === "snapshot" ? null : parseAssetBase(process.env.NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL);
  loader ??= createAtlasCatalogLoader({ base, snapshot });
  return loader();
}
