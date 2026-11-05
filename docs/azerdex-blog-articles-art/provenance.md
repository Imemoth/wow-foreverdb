# WoW: Forever launch posts: cover artwork provenance

Status: **owner-approved, AI-assisted illustrations, supplied to this repository by the owner.** Not owner photography, not
traced or copied from any named third-party image, and not an official game image. Distinct in kind from
`docs/azerdex-library-art/`, `docs/azerdex-hero-art/` and `docs/azerdex-card-art/` (owner-supplied raster art) and from
`docs/azerdex-news-blog-art/` (hub banners).

## What this covers

Cover art for the two launch posts in `web/content/blog/`:

| Article | Subject |
| --- | --- |
| `wow-forever-beginners-guide-2026` | A hooded adventurer seen from behind on a stone overlook at sunrise, looking over a river valley, forests, bridges and towered towns toward distant snow-capped mountains; a round shield, a bow and quiver and a softly glowing spellbook rest against the ruined arch beside them. |
| `wow-forever-new-race-class-combinations` | An undead holy knight in battered gilded plate with a glowing warhammer (main subject), a braided-beard dwarven mystic channelling lightning and floating stones behind them, ruined arches, a hilltop castle and armed silhouettes in a rainstorm. |

## Origin and approval

- The two masters (1672x941 PNG) were supplied by the owner in the PR #166 follow-up request on 2026-11-05 and approved there
  ("approved the two new premium fantasy illustrations"). They were created with an AI image generator.
- **Not recorded:** which generator and model, the prompts or seeds used, and any licence terms of that service. The editorial
  brief (`VISUAL-BRIEFS.md`, Illustrations A and B) described the intended scenes. If the owner has the generator's terms or
  prompts on file, add them here; this record deliberately does not guess.
- The masters are kept, re-encoded as WebP (quality 96, visually lossless), in
  `docs/azerdex-blog-articles-art/masters/` so that variants can be re-cut without going back to the original files.
  This directory is documentation only: it is not under `web/public` and is never served.
- They replace the temporary code-authored (procedural SVG) illustrations first committed in PR #166; that generator and its
  output no longer exist in the repository.

## Shipped files

Each article has four files in `web/public/content-images/blog/`, all cut from its master by
`web/scripts/content-art/export-covers.mjs` (run from `web/`; `sharp` comes with Next.js, as for `scripts/build-race-art.mjs`):

| File | Size | Used for |
| --- | --- | --- |
| `<slug>.webp` | 1920x1080 | Hero (desktop/tablet), `cover.src` in the frontmatter, JSON-LD `image` |
| `<slug>-mobile.webp` | 810x1080 | Hero below 640px (3:4 crop around the subject) |
| `<slug>-card.webp` | 800x600 | `/blog` card thumbnail |
| `<slug>-social.webp` | 1200x630 | `og:image` and `twitter:image` |

Processing: crop to the exact aspect of the output (within 0.05%), then a single Lanczos resize, WebP quality 88. **Nothing is
stretched or repainted.** The masters are 1672x941, so the 1920x1080 hero and the 810x1080 mobile crop are upscaled by about
1.15x (the card and social variants are downscaled). Crop windows were checked by eye: the knight's face and hammer and the
traveller, sun and props are intact in every variant. The slug-to-variant mapping is `SLUG_COVER_ART` in
`web/src/lib/content/article-media.ts`; `web/tests/unit/launch-articles.test.ts` asserts that every file exists with exactly
these dimensions and a sane weight. A sharper 1920x1080 source would be a drop-in improvement (same file names).

No text, logo, UI or watermark is part of either image; all typography is HTML.

## Blizzard-specific element review

Reviewed against the same criteria as the other provenance records, by eye on the shipped images (not a legal clearance):

- No Blizzard/World of Warcraft logo or wordmark, no named character likeness and no reproduction of an identifiable in-game
  location or Blizzard key art was found. Both scenes use generic high-fantasy staging.
- The combinations image shows a **sunburst/cross motif** on the knight's armour, shield and warhammer. It is a generic holy
  symbol, not a faction crest, but it is the element most likely to draw a comparison with in-game Paladin imagery; the owner
  should keep it in mind when judging the IP risk accepted for this artwork.
- The undead knight, dwarf and the other figures are archetypes of the article's subject (race/class combinations), not copies of
  existing characters.

The frontmatter attribution remains `Original AzerDex editorial illustration`; the art is not presented as an official game image.
Under the "owner-approved, subject to normal IP review" standing used by the other records, this is **not** a claim of independent
legal clearance.
