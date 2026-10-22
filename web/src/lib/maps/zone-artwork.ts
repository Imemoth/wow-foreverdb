import { resolveMapAssetUrl, resolveZoneHeroUrl } from "./asset-url";
import { artworkOf } from "./atlas/zone-catalog";
import type { AtlasMap } from "./atlas/schema";

/**
 * Central zone-artwork configuration for the ZoneCinematicHero (the only consumer).
 *
 * Resolution order, always keyed by the stable uiMapID:
 *   1. `cinematic` - an approved, zone-specific hero image from CINEMATIC_ZONE_ARTWORK: same-origin files in web/public/zones/hero by default
 *                    (the rollback path), or the versioned CDN namespace `<asset host>/zone-heroes/<id>/<version>/` when AZERDEX_ZONE_HERO_SOURCE=cdn.
 *   2. `map`       - the zone's published atlas map (CDN), shown with a darkened/blurred treatment.
 *   3. `fallback`  - the AzerDex fantasy backdrop (the vector ArcaneSurveyBanner); needs no asset, so it can never be empty or broken.
 *
 * Adding a zone (e.g. Duskwood, Tanaris) = add one entry below + its files under web/public/zones/hero. No UI change.
 * The existing atlas map files are never touched or replaced by hero artwork.
 */

export interface ArtworkSource { src: string; width: number }

/** What the hero component renders (unchanged shape): resolved URLs for the chosen source. */
export interface CinematicArtwork {
  /** Wide panorama (desktop/tablet) renditions, smallest first; the LAST is the `src` fallback. Must carry no baked-in text or UI. */
  desktop: readonly ArtworkSource[];
  /** Separately art-directed crop for phones (< 640px), smallest first. */
  mobile: readonly ArtworkSource[];
  /** Intrinsic size of the largest desktop rendition (reserves space, avoids layout shift). */
  intrinsic: { width: number; height: number };
  /** CSS object-position of the desktop crop; the subject sits on the right, so the crop is right-weighted. */
  objectPosition: string;
  /** Where these URLs point: the same-origin rollback files or the versioned CDN namespace. */
  origin: "local" | "cdn";
}

/** One rendition. `src` is the same-origin file (rollback path); its CDN twin is `<role>-<width>.webp` under zone-heroes/<id>/<version>/. */
export interface HeroRendition { width: number; src: string }

/** Registry entry. `version` is the immutable CDN artwork version: a changed artwork gets a NEW entry version, never an edit in place. */
export interface CinematicArtworkDefinition {
  version: string;
  desktop: readonly HeroRendition[];
  mobile: readonly HeroRendition[];
  intrinsic: { width: number; height: number };
  objectPosition: string;
}

/**
 * Keep in step with scripts/map-atlas/heroes/zone-heroes.json (the auditable inventory of what is published): tests/unit/zone-artwork.test.ts
 * fails if versions, widths or the same-origin file names drift from it.
 */
export const CINEMATIC_ZONE_ARTWORK: Readonly<Record<number, CinematicArtworkDefinition>> = {
  // Hillsbrad Foothills
  1424: {
    version: "v1",
    desktop: [
      { src: "/zones/hero/1424-hillsbrad-foothills-1280.webp", width: 1280 },
      { src: "/zones/hero/1424-hillsbrad-foothills-2000.webp", width: 2000 },
    ],
    mobile: [
      { src: "/zones/hero/1424-hillsbrad-foothills-mobile-600.webp", width: 600 },
      { src: "/zones/hero/1424-hillsbrad-foothills-mobile-900.webp", width: 900 },
    ],
    intrinsic: { width: 2000, height: 667 },
    objectPosition: "85% 50%",
  },
  // Duskwood (the 1916 px master is not upscaled: the largest rendition is its native width)
  1431: {
    version: "v1",
    desktop: [
      { src: "/zones/hero/1431-duskwood-1280.webp", width: 1280 },
      { src: "/zones/hero/1431-duskwood-1916.webp", width: 1916 },
    ],
    mobile: [
      { src: "/zones/hero/1431-duskwood-mobile-600.webp", width: 600 },
      { src: "/zones/hero/1431-duskwood-mobile-900.webp", width: 900 },
    ],
    intrinsic: { width: 1916, height: 821 },
    objectPosition: "85% 45%",
  },
};

/** CDN file name of a rendition: derived, never typed twice. */
export const heroFileName = (role: "desktop" | "mobile", width: number) => `${role}-${width}.webp`;

/**
 * Resolves the registry entry to concrete URLs. `heroBase` is a validated https asset base (see heroCdnBase) to use the CDN namespace;
 * null/undefined (the default), an invalid base or any URL-construction failure yields the same-origin files, so the hero can never end up
 * without a source. Pure and synchronous: no request is made to resolve artwork.
 */
function materialize(zoneId: number, def: CinematicArtworkDefinition, heroBase?: string | null): CinematicArtwork {
  const local = (list: readonly HeroRendition[]): ArtworkSource[] => list.map((r) => ({ src: r.src, width: r.width }));
  const base = { intrinsic: def.intrinsic, objectPosition: def.objectPosition };
  if (heroBase) {
    try {
      const cdn = (role: "desktop" | "mobile", list: readonly HeroRendition[]): ArtworkSource[] =>
        list.map((r) => ({ src: resolveZoneHeroUrl(heroBase, zoneId, def.version, heroFileName(role, r.width)), width: r.width }));
      return { ...base, desktop: cdn("desktop", def.desktop), mobile: cdn("mobile", def.mobile), origin: "cdn" };
    } catch {
      /* invalid base/version: keep the same-origin files */
    }
  }
  return { ...base, desktop: local(def.desktop), mobile: local(def.mobile), origin: "local" };
}

export type ResolvedZoneArtwork =
  | { kind: "cinematic"; art: CinematicArtwork }
  | { kind: "map"; src: string; width: number; height: number }
  | { kind: "fallback" };

/**
 * `atlasMap` / `assetBase` are only available with the zone-map experience on; both being absent is the normal fallback path.
 * `heroBase` (see heroCdnBase) is only set when the heroes are explicitly switched to the CDN; omitted = same-origin files.
 */
export function resolveZoneArtwork(
  uiMapId: number,
  atlasMap?: AtlasMap | null,
  assetBase?: string | null,
  heroBase?: string | null,
): ResolvedZoneArtwork {
  const cinematic = Object.hasOwn(CINEMATIC_ZONE_ARTWORK, uiMapId) ? CINEMATIC_ZONE_ARTWORK[uiMapId] : undefined;
  if (cinematic) return { kind: "cinematic", art: materialize(uiMapId, cinematic, heroBase) };
  const a = atlasMap ? artworkOf(atlasMap) : null;
  if (a) {
    try {
      const file = a.image.path.split("/").pop() ?? "";
      return { kind: "map", src: resolveMapAssetUrl(assetBase, uiMapId, a.version, file), width: a.image.width, height: a.image.height };
    } catch {
      /* malformed catalog entry: fall through to the fallback backdrop */
    }
  }
  return { kind: "fallback" };
}
