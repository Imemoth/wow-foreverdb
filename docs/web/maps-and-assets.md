# Maps and visual assets — licensing audit

| Asset | Source | Licence / basis | Website use |
| --- | --- | --- | --- |
| Zone map artwork (BLP tiles, MapArtID textures) | Blizzard client (CASC) / Blizzard CDN, resolved per user by the Companion | Blizzard property. No redistribution licence | **Not used.** Do not host, proxy or hotlink |
| Full-reveal overlay *numeric* atlas (`FullRevealOverlays-70009.json`) | jonlipin/map-tab, MIT | MIT (attribution in `docs/third-party-map-atlas-notice.md`) | Not needed. It only describes Blizzard textures, so it gives no rights to the imagery |
| cjber/tweaks-forever overlay data | Comparison evidence only | Not imported | Not used |
| Fonts: Cinzel, Inter, JetBrains Mono | Fontsource npm packages | SIL OFL 1.1 | Self-hosted |
| ForeverDB logo, category glyphs, location plots | Original SVG in `web/src/components` | Project-owned | Used |
| Item/spell icons | Blizzard | Not licensed | **Not used** |

## V1 decision
Location data is shown as **coordinate plots on a neutral 0–100 % grid**, aggregated to 1 % cells with cells below 2 observations hidden. A text table of the densest cells goes with each plot for accessibility. This delivers useful "where" information without proprietary imagery.

## Extensible path (Phase D)
`LocationPlot` takes points in map-percent coordinates, so a future map layer can sit underneath it unchanged. Acceptable future backgrounds: (a) original, self-drawn zone outlines; (b) community maps under a compatible licence with recorded attribution; (c) explicit written permission. Clustering and heatmaps can be computed server-side from `pub.locations` without new data.
