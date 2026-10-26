import type { ZoneSummary } from "@/lib/data/types";
import type { AtlasCatalog } from "./catalog-loader";
import type { AtlasMap } from "./schema";

/** Categories of the ordinary zone directory. Battlegrounds/instances, continents and the world map are deliberately excluded. */
export const ZONE_DIRECTORY_CATEGORIES: ReadonlySet<string> = new Set(["zone", "city"]);

export type ArtworkState = "available" | "unavailable";

export interface ZoneCatalogEntry {
  uiMapId: number;
  name: string;
  category: "zone" | "city";
  parentUiMapId: number | null;
  /** Verified continent grouping (parent that is itself a continent-category map in the catalog); null otherwise. */
  continentId: number | null;
  continentName: string | null;
  /** Name is shared with another directory entry: show the uiMapID next to it. */
  ambiguousName: boolean;
  artwork: ArtworkState;
  latestVersion: string | null;
  hasFullReveal: boolean;
  /** Dimensions of the default image (from the catalog); null when no artwork. */
  image: { width: number; height: number; variant: string } | null;
  /** Observation figures come from the public read model ONLY; null means "not measured / no published data", never 0 by assumption. */
  observed: { observations: number; sourceCount: number; itemCount: number } | null;
}

export interface ZoneGroup { key: string; label: string; continentId: number | null; entries: ZoneCatalogEntry[] }

export function isDirectoryMap(m: AtlasMap): boolean {
  return ZONE_DIRECTORY_CATEGORIES.has(m.category);
}

/** An atlas map has usable artwork only if it is available AND names a published version AND has a default image. */
export function artworkOf(m: AtlasMap): { version: string; image: NonNullable<AtlasMap["image"]> } | null {
  if (m.availability !== "available" || !m.latestVersion || !m.image) return null;
  return { version: m.latestVersion, image: m.image };
}

export function buildZoneEntries(catalog: AtlasCatalog, observed: readonly ZoneSummary[]): ZoneCatalogEntry[] {
  const obs = new Map(observed.map((z) => [z.mapId, z]));
  const maps = catalog.maps.filter(isDirectoryMap);
  const nameCount = new Map<string, number>();
  for (const m of maps) nameCount.set(m.name.toLowerCase(), (nameCount.get(m.name.toLowerCase()) ?? 0) + 1);
  return maps.map((m) => {
    const parent = m.parentUiMapId != null ? catalog.byId.get(m.parentUiMapId) : undefined;
    const art = artworkOf(m);
    const z = obs.get(m.uiMapId);
    return {
      uiMapId: m.uiMapId,
      name: m.name,
      category: m.category as "zone" | "city",
      parentUiMapId: m.parentUiMapId ?? null,
      continentId: parent?.category === "continent" ? parent.uiMapId : null,
      continentName: parent?.category === "continent" ? parent.name : null,
      ambiguousName: (nameCount.get(m.name.toLowerCase()) ?? 0) > 1,
      artwork: (art ? "available" : "unavailable") as ArtworkState,
      latestVersion: art?.version ?? null,
      hasFullReveal: m.hasFullReveal,
      image: art ? { width: art.image.width, height: art.image.height, variant: art.image.variant } : null,
      observed: z ? { observations: z.observations, sourceCount: z.sourceCount, itemCount: z.itemCount } : null,
    };
  }).sort((a, b) => a.name.localeCompare(b.name) || a.uiMapId - b.uiMapId);
}

/** Observed zones the atlas does not catalog as an ordinary zone/city (e.g. a dungeon floor or an unmapped id): kept visible, never dropped. */
export function observedOutsideCatalog(catalog: AtlasCatalog, observed: readonly ZoneSummary[]): ZoneSummary[] {
  return observed.filter((z) => { const m = catalog.byId.get(z.mapId); return !m || !isDirectoryMap(m); });
}

const UNGROUPED = "Other maps (no verified continent)";

export function groupByContinent(entries: readonly ZoneCatalogEntry[]): ZoneGroup[] {
  const groups = new Map<string, ZoneGroup>();
  for (const e of entries) {
    const key = e.continentId != null ? `c${e.continentId}` : "none";
    const g = groups.get(key) ?? { key, label: e.continentName ?? UNGROUPED, continentId: e.continentId, entries: [] };
    g.entries.push(e);
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => (a.continentId == null ? 1 : 0) - (b.continentId == null ? 1 : 0) || a.label.localeCompare(b.label));
}

export function findDirectoryEntry(entries: readonly ZoneCatalogEntry[], uiMapId: number): ZoneCatalogEntry | undefined {
  return entries.find((e) => e.uiMapId === uiMapId);
}
