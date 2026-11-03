# P2-D — Tirisfal Glades interactive map (proof of concept)

Isolated POC at `/poc/maps/tirisfal`. It does **not** replace `/zone/1420`, is not linked from navigation, and is not in the sitemap.

## Status
| Item | State |
| --- | --- |
| Library | Leaflet 1.9.4, `CRS.Simple`, client-only (dynamic import) |
| Data | Synthetic public fixture projection only (`map_id = 1420`); no DB, publisher, addon or Companion change |
| Calibration | **provisional** — projection is exact by construction; landmark registration not yet owner-verified (the fixture markers are synthetic, so they cannot validate landmarks) |
| Heatmap | Not implemented (follow-up) |
| Licensing of the artwork | **Unreviewed.** See below |

## Showing an imported atlas version
`/poc/maps/tirisfal?version=v2` loads that immutable asset version (`v1` = the original POC image, the default). The value must match `^v[1-9]\d{0,3}$`; anything else is ignored and `v1` is used. The page shows which artwork is displayed (`Artwork: full-reveal · v2 · client …`). Unknown versions fall back to the labelled grid. This stays inside the gated, non-indexable POC route.

## Enabling the route
Off by default. Served only in `next dev`, or when a non-production deployment sets `AZERDEX_POC_MAPS=1`. `FOREVERDB_DEPLOYMENT=production` always answers 404. The page is `noindex, nofollow`.

## Coordinate model (same as the Companion)
`pixelX = W·x/100`, `pixelY = H·y/100`, origin top-left. For Leaflet `CRS.Simple` with bounds `[[0,0],[H,W]]`: `lat = H·(1 − y/100)`, `lng = W·x/100`. Out-of-range values are rejected, never clamped. Code: `web/src/lib/maps/coordinates.ts`. Clustering is a port of `MapClusterService.Cluster` (grid cells in %, observation-weighted centroid); the cell size halves with each zoom level.

## Asset layout
`web/public/maps/forever/1420/v1/` — `tirisfal-glades.webp` (as received, unmodified), `manifest.json` (dimensions, sha256, projection, provenance, calibration). No PNG source was supplied, so none is stored; `MapArtID` and client build are `null` (unknown, not invented).

## Asset base URL
`NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL` (unset ⇒ same-origin `/maps`). Accepted values: a same-origin path, or `https://azerdex-assets.pages.dev` / `https://assets.azerdex.com` (exact hosts, no port/credentials/query). Anything else is ignored and falls back to same-origin. When an external base is configured, `proxy.ts` adds **only that origin** to `img-src` and `connect-src`, and only for `/poc/maps/*`; `script-src`/`style-src` are untouched.

## Licensing — owner decision required
`maps-and-assets.md` states Blizzard map art must not be hosted, and the site footer says no Blizzard artwork is redistributed. The supplied image appears to be Blizzard map art. It is committed here for the POC at the owner's instruction, but it must **not** be deployed publicly, published to the CDN, or merged to a public branch until the owner records a licensing decision (or replaces it with an original/licensed map; the manifest/viewer need no change for that).

## Publishing the asset to Cloudflare Pages (NOT done — needs owner approval)
Direct Upload; a GitHub push does not deploy. After the licensing decision:
1. Build a folder `dist/` containing `forever/1420/v1/{manifest.json,tirisfal-glades.webp}` and a `_headers` file:
   ```
   /forever/*
     Access-Control-Allow-Origin: https://<site origin>
     Cache-Control: public, max-age=31536000, immutable
   ```
   (CORS is needed because the manifest is fetched cross-origin; versioned paths are immutable — publish changes as `v2`.)
2. `npx wrangler pages deploy dist --project-name azerdex-assets`
3. Set `NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL=https://azerdex-assets.pages.dev` (later `https://assets.azerdex.com`) on the preview deployment, rebuild.
Custom hostname/DNS is a separate approval.

## Replacing the fixture selector
`web/src/lib/maps/zone-observations.ts` is the only data seam (`zoneObservations(mapId) → MapPoint[]`). A later approved BFF adapter replaces it; the viewer and filters are data-source agnostic.

> **Superseded for ordinary zones by P2-Z1:** the same engine now serves `/zones`, `/zone/<uiMapID>` and source pages behind `AZERDEX_ZONE_MAPS=1`; see [zone-atlas.md](zone-atlas.md). This POC route and its tests are unchanged.
