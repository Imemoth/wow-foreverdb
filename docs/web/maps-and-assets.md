# Maps and visual assets — licensing audit

| Asset | Source | Licence / basis | Website use |
| --- | --- | --- | --- |
| Zone map artwork (BLP tiles, MapArtID textures) | Blizzard client (CASC) / Blizzard CDN, exported from the owner's installed client to AzerDex's asset CDN | Blizzard property; no independently verified broad redistribution licence; owner-authorised non-commercial fan-site reference, subject to withdrawal/removal | **Published in production** as an optional CDN-backed layer (`AZERDEX_ZONE_MAPS=1`, verified in Vercel Production configuration on 2026-11-03). This is a factual deployment statement, not a legal clearance |
| Full-reveal overlay *numeric* atlas (`FullRevealOverlays-70009.json`) | jonlipin/map-tab, MIT | MIT (attribution in `docs/third-party-map-atlas-notice.md`) | Not needed. It only describes Blizzard textures, so it gives no rights to the imagery |
| cjber/tweaks-forever overlay data | Comparison evidence only | Not imported | Not used |
| Fonts: Cinzel, Inter, JetBrains Mono | Fontsource npm packages | SIL OFL 1.1 | Self-hosted |
| ForeverDB logo, category glyphs, location plots | Original SVG in `web/src/components` | Project-owned | Used |
| Item/spell icons | Blizzard | Not licensed | **Not used.** The Class Guides talent calculator has an optional, **off-by-default** path for talent icons from the allow-listed asset host only (never git). 358 icons (build 1.60.1.70634) are uploaded and verified (358/358, 2026-11-02); the owner authorised publication on 2026-10-28 (beta) and approved production publication on 2026-11-02 (`AZERDEX_TALENT_ICONS=cdn`, enforced by the release parity gate); see [`class-guides-talents.md`](class-guides-talents.md#icons), [Publication and rights](class-guides-talents.md#publication-and-rights) and [`third-party-blizzard-content-notice.md`](../third-party-blizzard-content-notice.md) |
| Talent names, ranks, positions and description text (Class Guides) | Blizzard game data read from the Forever client (Everloot catalog; owner's local export) | Not licensed; attribution shown | Shown on beta/preview/local; on production shown with `AZERDEX_TALENT_TEXT=1` (**owner approved 2026-11-02**; enforced by the release parity gate) |
| Everloot / TalentForge / extraction tooling | Third-party code and data | Everloot AGPL-3.0 code (its data is Blizzard's); TalentForge has no licence | References and cross-checks only; no code redistributed |
| Class/tree backdrops (Class Guides) | Original inline SVG in `web/src/components/classes/backdrops.tsx` | Project-owned | Used |

## V1 decision
Location data is shown as **coordinate plots on a neutral 0–100 % grid**, aggregated to 1 % cells with cells below 2 observations hidden. A text table of the densest cells goes with each plot for accessibility. This delivers useful "where" information without proprietary imagery.

## Extensible path (Phase D)
`LocationPlot` takes points in map-percent coordinates, so a future map layer can sit underneath it unchanged. Acceptable future backgrounds: (a) original, self-drawn zone outlines; (b) community maps under a compatible licence with recorded attribution; (c) explicit written permission. Clustering and heatmaps can be computed server-side from `pub.locations` without new data.

## P2-D proof of concept
The isolated `/poc/maps/tirisfal` proof of concept remains a test-only, non-indexable experience with synthetic observations; see [`maps-poc.md`](maps-poc.md). **Separately**, the later unified zone atlas from PR #78's history was incorporated into `release` and its map artwork was activated for production on the AzerDex asset CDN. This is owner-approved use for the fan site, but ownership remains with Blizzard; no independent licence verification is implied. See [`zone-atlas.md`](zone-atlas.md) and [`third-party-map-atlas-notice.md`](../third-party-map-atlas-notice.md). Real-coordinate calibration remains **provisional**, and the live state of the `web_api.zone_map_points` public-read RPC is **unverified** until read-only DB inspection.
