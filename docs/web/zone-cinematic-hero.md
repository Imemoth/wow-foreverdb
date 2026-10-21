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

## Accessibility / motion
Artwork is `alt=""` + `aria-hidden`; the `<section>` is labelled by the `h1`; stats are a `<dl>`. Text sits on dark gradient layers
(gold-300/parchment on ink-950). No animation is used, so `prefers-reduced-motion` needs no special casing.

## Known limitations
- Continent label only appears with the zone-map experience enabled (the catalog is only read then).
- `images.unoptimized` is site-wide, so responsive sizes are pre-generated files, not on-the-fly.
- The artwork is served from the app (`/zones/hero`), not the atlas CDN: the CDN publishes the immutable atlas export, which hero art must not mix into.
