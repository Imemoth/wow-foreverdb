# WoW: Forever launch posts: cover artwork provenance

Status: **original, code-authored illustrations. No third-party imagery, no owner photography, no AI image model.**
Distinct in kind from `docs/azerdex-library-art/`, `docs/azerdex-hero-art/` and `docs/azerdex-card-art/` (owner-supplied
raster art) and from `docs/azerdex-news-blog-art/` (hub banners).

## What this covers

Cover art for the two launch posts in `web/content/blog/`:

| Article | Master | Subject |
| --- | --- | --- |
| `wow-forever-beginners-guide-2026` | `/content-images/blog/wow-forever-beginners-guide-2026.webp` | A hooded traveller seen from behind on a stone overlook at sunrise, with a weathered shield, a bow and quiver and a softly glowing spellbook at their feet (brief: Illustration A). |
| `wow-forever-new-race-class-combinations` | `/content-images/blog/wow-forever-new-race-class-combinations.webp` | An undead holy knight (main subject) in storm-lit ruins, a dwarven elemental mystic channelling stone and lightning mid-ground, orc-caster and gnome-priest silhouettes in the distance (brief: Illustration B). |

Each article has four files, all in `web/public/content-images/blog/`:

| File | Size | Used for |
| --- | --- | --- |
| `<slug>.webp` | 1920x1080 | Hero (desktop/tablet) and `cover.src` in the frontmatter, JSON-LD `image` |
| `<slug>-mobile.webp` | 810x1080 | Hero below 640px (portrait crop around the focal subject) |
| `<slug>-card.webp` | 800x600 | `/blog` card thumbnail |
| `<slug>-social.webp` | 1200x630 | `og:image` and `twitter:image` |

The mapping from slug to variants lives in `web/src/lib/content/article-media.ts` (`SLUG_COVER_ART`);
`web/tests/unit/launch-articles.test.ts` asserts that every file exists with exactly these dimensions.

## How the images were made

The images were **authored as procedural SVG and rendered with headless Chromium**, then exported to WebP with `sharp`.
No image-generation model was available when they were produced, so the "suggested generator prompts" in the editorial
brief were used as a *composition brief* (subject, palette, focal placement, quiet title area), not as model input.

- Source: `web/scripts/content-art/` (`lib.mjs` toolkit, `scene-beginners-guide.mjs`, `scene-race-class.mjs`, `render.mjs`, `build.mjs`).
- Everything is deterministic (seeded RNG): `cd web && node scripts/content-art/build.mjs` reproduces the files.
- `sharp` is not a declared dependency; like `scripts/build-race-art.mjs` it comes with Next.js. Run from `web/`.
- No text, logo, UI, watermark or faction emblem is drawn into any image; all typography is HTML.
- Characters are generic fantasy archetypes (a cloaked traveller; an armoured, bone-faced knight with a warhammer; a
  braided-beard mystic; two small silhouettes). No named character, no Blizzard key art, no ability or class icon and no
  existing AzerDex race/class illustration was used or traced.

## Honest limitation

The result is a clean, stylised, flat-shaded illustration. It is **not** painterly photoreal art like the owner-supplied hub
hero photography, and a hand-painted or model-generated replacement would be a visual upgrade. Replacing it needs no code
change beyond overwriting the four files per article (same names and dimensions) and, if the focal point moves, updating
`heroPosition` in `SLUG_COVER_ART`.

## Blizzard-specific element review

Reviewed against the same criteria as the other provenance records: no Blizzard/World of Warcraft logo or wordmark, no named
character likeness, no exact reproduction of an identifiable in-game location or key art. **None found.** The scenes are
generic fantasy staging (a mountain overlook; ruined arches in a storm). Attribution in frontmatter is
`Original AzerDex editorial illustration`. The art does not claim to be an official game image.
