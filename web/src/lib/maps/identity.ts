import type { AtlasCatalog } from "./atlas/catalog-loader";
import { isDirectoryMap } from "./atlas/zone-catalog";
import type { AtlasMap } from "./atlas/schema";

/**
 * Identifier bridge between the PUBLIC READ MODEL and the ATLAS.
 *
 * VERIFIED SEMANTICS (evidence in docs/web/zone-atlas.md): `pub.zones.map_id`, `pub.locations.map_id`, `ZoneSummary.mapId`,
 * `LocationPoint.mapId` and `/zone/<id>` all carry the client's **UiMapID**: the addon records `C_Map.GetBestMapForUnit("player")`
 * (addon/ForeverDB/LocationTracker.lua) and the website names it "uiMapID". The atlas keys its maps by the same `uiMapId`.
 * The bridge is therefore the identity: `uiMapId === mapId`. It is explicit here (one function, one place) and never touches the
 * atlas `internalMapId` (the client's Map.ID, a different identifier) nor a slug (not unique: e.g. two "Zephras Isle" maps).
 *
 * A published map id that the atlas does not know (or knows as a non-zone map) is reported as such; it is never replaced by
 * the artwork of another map.
 */
export type ObservedMapResolution =
  | { kind: "atlas-zone"; map: AtlasMap; nameMatches: boolean | null }
  | { kind: "atlas-other"; map: AtlasMap }
  | { kind: "not-in-atlas" };

const norm = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[’'`]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export function resolveObservedMap(catalog: AtlasCatalog, mapId: number, observedZoneName?: string): ObservedMapResolution {
  const map = Number.isInteger(mapId) ? catalog.byId.get(mapId) : undefined;
  if (!map) return { kind: "not-in-atlas" };
  if (!isDirectoryMap(map)) return { kind: "atlas-other", map };
  // The observed zone name (GetZoneText at observation time) is corroborating evidence only; a mismatch is surfaced, not "fixed".
  return { kind: "atlas-zone", map, nameMatches: observedZoneName == null ? null : norm(observedZoneName) === norm(map.name) };
}
