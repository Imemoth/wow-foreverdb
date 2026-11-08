# "World First: Level 60" editorial: cover artwork provenance

Status: **original, code-authored vector artwork.** No photograph, no AI-generated raster, no game screenshot or asset, and no
third-party/competitor image is used or hotlinked, so there is nothing to license. Distinct in kind from
`docs/azerdex-blog-articles-art/` (owner-approved AI-assisted illustrations).

## What it covers

Cover art for `web/content/news/jokerd-team-world-first-level-60-wow-forever.md`: a silhouetted party (three Mages, a Paladin with
a raised warhammer, a Shaman) on a ridge under a runic moon, with an Arcane Explosion shockwave rippling from their feet. The
left half is deliberately quiet for the headline. The image contains no text; all typography is HTML.

## Rebuild

```
cd web && node scripts/content-art/build-world-first-60-art.mjs
```

The script draws one 1920x1080 SVG scene (seeded PRNG, so output is reproducible) and exports, to `web/public/content-images/news/`:

| File | Size | Used for |
| --- | --- | --- |
| `<slug>.webp` | 1920x1080 | Hero, `cover.src`, JSON-LD image, /news lead |
| `<slug>-mobile.webp` | 810x1080 | Hero below 640px / lead below 768px |
| `<slug>-card.webp` | 800x600 | Card thumbnail |
| `<slug>-social.webp` | 1200x630 | `og:image` / `twitter:image` |

`web/tests/unit/world-first-article.test.ts` asserts every file exists with exactly these dimensions.

## Sources for the article's facts

Wowhead, Icy Veins and Warcraft Tavern coverage (linked in the article), cross-checked against Endgame Tools and Forever Guides
trackers for races and the roster. The three primary pages could not all be read in full from the authoring environment
(Icy Veins returned HTTP 403; Wowhead returned only its headline), so the final-4%-of-level-59 and Arcane Explosion details
rest on the brief and tracker summaries. Sources disagree by minutes on whose level-up landed first, so the piece presents a
joint world first and gives no exact timestamps or quotations.
