import { resolveMapAssetUrl } from "./asset-url";
import { artworkOf } from "./atlas/zone-catalog";
import type { AtlasMap } from "./atlas/schema";

/**
 * Central zone-artwork configuration for the ZoneCinematicHero (the only consumer).
 *
 * Resolution order, always keyed by the stable uiMapID:
 *   1. `cinematic` - an approved, zone-specific hero image from CINEMATIC_ZONE_ARTWORK (same-origin, web/public/zones/hero).
 *   2. `map`       - the zone's published atlas map (CDN), shown with a darkened/blurred treatment.
 *   3. `fallback`  - the AzerDex fantasy backdrop (the vector ArcaneSurveyBanner); needs no asset, so it can never be empty or broken.
 *
 * Adding a zone (e.g. Duskwood, Tanaris) = add one entry below + its files under web/public/zones/hero. No UI change.
 * The existing atlas map files are never touched or replaced by hero artwork.
 */

export interface ArtworkSource { src: string; width: number }

export interface CinematicArtwork {
  /** Wide panorama (desktop/tablet) renditions, smallest first; the LAST is the `src` fallback. Must carry no baked-in text or UI. */
  desktop: readonly ArtworkSource[];
  /** Separately art-directed crop for phones (< 640px), smallest first. */
  mobile: readonly ArtworkSource[];
  /** Intrinsic size of the largest desktop rendition (reserves space, avoids layout shift). */
  intrinsic: { width: number; height: number };
  /** CSS object-position of the desktop crop; the subject sits on the right, so the crop is right-weighted. */
  objectPosition: string;
}

export const CINEMATIC_ZONE_ARTWORK: Readonly<Record<number, CinematicArtwork>> = {
  // Hillsbrad Foothills
  1424: {
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

export type ResolvedZoneArtwork =
  | { kind: "cinematic"; art: CinematicArtwork }
  | { kind: "map"; src: string; width: number; height: number }
  | { kind: "fallback" };

/** `atlasMap` / `assetBase` are only available with the zone-map experience on; both being absent is the normal fallback path. */
export function resolveZoneArtwork(
  uiMapId: number,
  atlasMap?: AtlasMap | null,
  assetBase?: string | null,
): ResolvedZoneArtwork {
  const cinematic = Object.hasOwn(CINEMATIC_ZONE_ARTWORK, uiMapId) ? CINEMATIC_ZONE_ARTWORK[uiMapId] : undefined;
  if (cinematic) return { kind: "cinematic", art: cinematic };
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
