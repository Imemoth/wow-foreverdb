# Zone Cinematic Hero (V1)

Every `/zone/[id]` page renders `web/src/components/zones/ZoneCinematicHero.tsx`. It is presentation only: it reads the same
`ZoneDetail` figures and atlas catalog as before, adds no data model, API, migration or Supabase access, and never renders the
internal uiMapID (that stays in routing, the map system and queries).

## What it shows
Zone name (Cinzel, gold), `<continent> · Zone|City` eyebrow (continent = the catalog parent map when it is a verified continent;
needs `AZERDEX_ZONE_MAPS=1`, otherwise just `Zone`), a short description, and three borderless stats (Sources, Items (inferred),
Located obs.). Stats are the real read-model values. A zone without published observations (atlas-only) has no figures: each stat
shows an en dash with a screen-reader "Not available" - nothing is invented or defaulted to 0.

## Artwork resolution (`web/src/lib/maps/zone-artwork.ts`, keyed by uiMapID)
1. **cinematic** - an entry in `CINEMATIC_ZONE_ARTWORK` (same-origin files in `web/public/zones/hero/`): art-directed `<picture>`
   (phones < 640px get a right-weighted crop), `srcset`, intrinsic width/height (no layout shift), `fetchpriority=high`.
2. **map** - the zone's published atlas map (CDN, validated host) as a darkened, softened mood layer.
3. **fallback** - the vector `ArcaneSurveyBanner` backdrop. Needs no asset, so a missing/failed image can never leave an empty hero
   (the vector backdrop is always rendered underneath the image layers).

### Adding a zone (Duskwood, Tanaris, ...)
1. Export the panorama without any text/UI; make renditions (~1280 and ~2000 wide) and a phone crop (~600 and ~900 wide) as WebP;
   save as `web/public/zones/hero/<uiMapId>-<slug>-<width>.webp`.
2. Add one entry to `CINEMATIC_ZONE_ARTWORK`. `tests/unit/zone-artwork.test.ts` fails if a referenced file is missing.
3. Record provenance in `docs/azerdex-hero-art/provenance.md`. No UI change, no zone-specific component.

Hillsbrad Foothills is `1424` (`1415` is the Eastern Kingdoms continent map).

Published hero files must be **watermarked derivatives only**; never commit a master/source file under `web/public/` (guarded by
`tests/unit/zone-artwork.test.ts`). Method and the private master's hash: `docs/azerdex-hero-art/provenance.md`.

## "Map artwork unavailable" - what it means (smoke-test findings, 2026-10-21)
The notice in `ZoneMap` appears when the map cannot get its manifest/image (`ZoneMap.tsx`). Classification of what was seen:
1. **Local/synthetic preview (cause of the PR screenshots):** the local build had no `NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL`, so no https
   artwork origin is configured and the map says so ("No map artwork origin is configured for this deployment") - by design.
   Fixture limitation, not a product defect. Built with the origin and the synthetic CDN the map loads (screenshot
   `hillsbrad-desktop-map-synthetic-cdn.webp`).
2. **PR #93 Vercel preview** (publication preview, synthetic sample data): `AZERDEX_ZONE_MAPS` is not set on it, so `/zone/1424`
   (an atlas-only zone) answers 404 there - the documented gate, not a regression. Zones with synthetic observations render the hero.
3. **Actual beta deployment** (`web/azerdex-beta` @ `6b33ebe`, real published data, deployment `dpl_J6SBoiSe...`): server-rendered
   `/zone/1424` carries `data-artwork="available"`, `assetBase=https://azerdex-assets.pages.dev`, `version=v1`, catalog size 1002x668
   and a CSP allowing exactly that origin in `img-src`/`connect-src`. **Not verified from this environment:** the actual HTTP
   response of the CDN files and the in-browser image render, because this sandbox cannot reach `azerdex-assets.pages.dev`
   (proxy 403 / DNS failure). Run once from an unrestricted machine:
   `python scripts/map-atlas/atlas.py verify-remote --base-url https://azerdex-assets.pages.dev --dist <approved dist>` and open
   `https://beta.azerdex.com/zone/1424` and `/zone/1420` (network tab: manifest + image HTTP 200, no CSP/CORS errors).
Automated evidence of the integration path (real Chromium, CDN host mapped to a local HTTPS server, CORS and CSP enforced):
`tests/zone-maps/zone-hero.spec.ts` (1424, 1426, 1420; CDN outage is surfaced, not hidden).

## Accessibility / motion
Artwork is `alt=""` + `aria-hidden`; the `<section>` is labelled by the `h1`; stats are a `<dl>`. Text sits on dark gradient layers
(gold-300/parchment on ink-950). No animation is used, so `prefers-reduced-motion` needs no special casing.

## Known limitations
- Continent label only appears with the zone-map experience enabled (the catalog is only read then).
- `images.unoptimized` is site-wide, so responsive sizes are pre-generated files, not on-the-fly.
- The artwork is served from the app (`/zones/hero`), not the atlas CDN: the CDN publishes the immutable atlas export, which hero art must not mix into.
