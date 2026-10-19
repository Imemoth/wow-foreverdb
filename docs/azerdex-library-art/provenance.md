# AzerDex Phase 2-B "Arcane Library" visual-polish artwork — provenance record

Status: **owner-approved, subject to normal IP review** (not a claim of independent
legal clearance) — same standing as `docs/azerdex-hero-art/provenance.md` and
`docs/azerdex-card-art/provenance.md`, which this record follows in structure and
intent.

## What this covers

Four raster images (one ultra-wide hero scene, two square variants of the same desk
scene, one 2×3 medallion icon sheet) supplied directly to this session as pasted chat
attachments, approved by the repository owner for integration into the Guides "Arcane
Library" experience (`web/src/components/library/`). Distinct from the Phase 1 hero
backgrounds and the Phase 2 homepage card art (separate provenance records).

## Source and approval

Per the repository owner (stated directly to this session, as part of the "P2-B Visual
Polish & Approved Artwork Integration" task), these four files are supplied,
owner-approved artwork for this feature, subject to normal IP review. Received as
`.webp` via the chat attachment pipeline (same conversion-on-paste behavior documented
in the other two provenance records).

| Role | Subject | As-received dimensions |
| --- | --- | --- |
| Hero (desktop/tablet, integrated) | Ultra-wide library/cartography desk scene: arched window onto a floating-island skyline, compass/astrolabe, candles, maps, a griffin statue | 1916×821 |
| Hero (mobile crop, integrated) | Square variant of the same room, centred on an open book with an astrological diagram and a quill/inkwell | 1254×1254 |
| Square variant (reviewed, not integrated) | Square variant centred on the astrolabe/compass and crystal ball, same room | 1254×1254 |
| Medallion sheet (integrated, cropped into 6 icons) | 2×3 grid of gold/violet circular medallions: open book, scroll, compass/star, map, magnifying glass over a castle vista, quill and inkwell | 1536×1024, genuine alpha transparency |

## Private source records (not in the publicly served tree)

Per the lesson from Phase 1 Task C (`docs/azerdex-hero-art/provenance.md`), the
as-received originals are **not** committed to this repository — not even under a
`source/` path, since anything under `web/public/` is served as a static file. The
owner holds the originals (this session's own copies live only in this session's
scratch workspace, outside the repository); this repository keeps only their SHA-256 as
the audit trail, computed on receipt:

| Role | SHA-256 | Size |
| --- | --- | --- |
| Hero, desktop/tablet (ultra-wide) | `90b3f622f3ac8da9a922a87e7cdf62d3f472a15e3f91411d8761b359b14aceae` | 416,374 B |
| Hero, mobile crop (open-book square) | `a46f31df4f0dea3dead8d7fa2ff838f3c7e26260a827eb4ce96e36ecc423a868` | 488,122 B |
| Square variant, reviewed/not integrated (astrolabe square) | `25556e61a8d7fb71ae830cb42982f20b878def0409c6d146bdff5ebc0626f079` | 357,026 B |
| Medallion sheet (2×3 grid) | `a20fb2cf7674662c8597b48148308f494ad90a52c0637b24d7a0e7cc3cfbb32d` | 494,074 B |

## Focused visual review for Blizzard-specific protected elements

Same criteria as the hero and card art reviews: distinguish genre convention (not a
concern) from logo/trademark/named-character/exact-location reproduction (a concern),
and name any concrete element found rather than a blanket rejection.

**Reviewed all four images (plus the two hero crops as rendered) for:** the Blizzard or
World of Warcraft logo/wordmark, any text or watermark pre-existing in the source, any
recognizable named WoW character likeness, and any exact or near-exact reproduction of a
specific, identifiable WoW location's actual geometry.

**Found, named explicitly:**

- The wide hero scene includes a bronze **griffin/gryphon statue** on the right edge.
  Assessed and **not treated as a blocking concern**: it carries no Stormwind-style
  blue/gold heraldry, saddle, or rigging that would identify it as a specific WoW mount
  design — griffins/gryphons are a mythological creature used across countless fantasy
  properties (Harry Potter, Final Fantasy, D&D, heraldry generally), not a distinctive,
  protectable WoW-specific expression in this generic statuary form.
- Hanging banners in the wide hero carry a diamond/rune insignia. This reads as closer
  to AzerDex's **own** existing compass/diamond emblem (`web/public/icon.svg`) than to
  any WoW faction crest — it is not the Alliance lion or the Horde emblem found in the
  Phase 2 card-art review, and no concrete match to a specific Blizzard mark was
  identified.
- No logos, wordmarks, pre-existing watermarks, or named/recognizable character figures
  appear in any of the four images (all four are pure environment/still-life
  compositions - desk, books, instruments, a window view - with no figures at all).
- No 1:1 reproduction of a specific, identifiable WoW zone's actual geometry; the
  floating-island skyline and gothic spires are the same broad dark-fantasy genre
  convention already assessed as unprotectable scènes à faire in the Phase 1 hero
  review (gold Gothic architecture, floating islands, large moons, a violet magical
  palette - used across many properties, not exclusive to Warcraft).
- The medallion sheet's six icons (book, scroll, compass, map, magnifying glass, quill)
  are generic knowledge/cartography iconography with no logos, trademarks, or
  identifiable characters.

**Overall conclusion:** consistent with the Phase 1 and Phase 2 reviews, no concrete,
nameable instance of logo, trademark, character, or exact-location reproduction was
identified in this set. This review found no blocking concern under the criteria the
owner specified.

## Published derivatives (public)

### Hero images (watermarked)

Both integrated hero images are full illustrated scenes (the same category as the
Phase 1 hero backgrounds and Phase 2 card backgrounds), so both carry the embedded
AzerDex watermark — see below. The desktop/tablet hero is served at its native
1916×821 (no upscaling or downscaling - already comfortably under a 2× pixel-density
budget for its `max-w-7xl` = 1280px CSS container). The mobile hero crop was downscaled
from its 1254×1254 original to a 960×960 square and watermarked, then - after the
Lighthouse pass below found it carrying both unused vertical pixels and more resolution
than a phone-width banner needs - re-cropped to the exact band `object-cover`/
`object-[75%_45%]` renders and resized down to 768×452. See "Mobile Lighthouse/
performance review" below for the two-round derivation.

| File | Pre-watermark (as-received) | Published (served) | Change |
| --- | --- | --- | --- |
| `library/arcane-library-hero.webp` (1916×821, no resize) | 416,374 B | 237,652 B | −42.9% |
| `library/arcane-library-hero-mobile.webp` (1254→960 square → cropped to 960×564 → resized to 768×452) | 488,122 B | 79,184 B | −83.8% |

Published SHA-256 (the files actually served from `web/public/library/`):

| File | SHA-256 |
| --- | --- |
| `library/arcane-library-hero.webp` | `843e783f4fe218c65b4f09a7f7936451735c17dcb7f77dad89682a3961297f3c` |
| `library/arcane-library-hero-mobile.webp` | `b7488199cd511ca0a9c96310a77d8d73219ff0da54b1c4a98efae8fc5c157c61` |

### Medallion icons (not watermarked)

The six medallions are cropped individually from the 2×3 sheet, downscaled to 240×240
(comfortable 2×-retina headroom over their rendered size, matching the established
`cards/medallions/*.webp` convention), and re-encoded as WebP with alpha preserved. The
two that are actually wired into a component (`wayfinder`, `compendium`) were then
downscaled further to 128×128 as part of the Lighthouse pass below - still several times
their largest rendered size (24px) - since Lighthouse's `image-delivery-insight` audit
flagged 240×240 as oversized for icons never rendered above `h-6 w-6`. The four unused
medallions were left at 240×240: they are not referenced by any component, so they cost
nothing at runtime, and re-touching already-correct, already-documented dormant assets
for a page that never loads them isn't worth the churn.

**Extraction method** (same alpha-bbox approach as the 8-icon category sheet in
`docs/azerdex-card-art/provenance.md`): per-column and per-row alpha sums located the
grid gutters at x-ranges `[24–503, 530–1006, 1031–1513]` and y-ranges `[16–493,
513–988]`; each cell's own content bounding box was then measured and found to already
fill nearly the entire cell (content width/height within 2–6px of the cell size),
consistent with the source art being evenly centred and scaled per icon. Each icon was
cropped to a square centred on its own content midpoint with a uniform ~10px margin,
then downscaled to 240×240. Verified: all six corners are fully transparent on every
exported icon, no clipped ornament, consistent apparent scale.

| Grid position | Slug | Subject | Published path |
| --- | --- | --- | --- |
| row 1, col 1 | `compendium` | Open grimoire | `library/medallions/compendium.webp` |
| row 1, col 2 | `chronicle` | Bound/sealed scroll | `library/medallions/chronicle.webp` |
| row 1, col 3 | `wayfinder` | Compass/star astrolabe | `library/medallions/wayfinder.webp` |
| row 2, col 1 | `cartography` | Unrolled map | `library/medallions/cartography.webp` |
| row 2, col 2 | `discovery` | Magnifying glass over a castle vista | `library/medallions/discovery.webp` |
| row 2, col 3 | `inkwell` | Quill and inkwell | `library/medallions/inkwell.webp` |

Published sizes and SHA-256:

| File | Size | SHA-256 |
| --- | --- | --- |
| `library/medallions/compendium.webp` (128×128, downscaled - wired in) | 10,114 B | `be5341fecaac0a3e7229cf650b3ba8236a0c5cbd830938b35ecc51cd6c129442` |
| `library/medallions/chronicle.webp` (240×240, unused) | 28,006 B | `6dda693d19c83553b113690dd1f60f82ac07717a2e0b21c27eee80142b4a3169` |
| `library/medallions/wayfinder.webp` (128×128, downscaled - wired in) | 10,398 B | `b7fd08cbc8e3fd97d24a507ecf91b09019417e5aa659c6573e708db48d32935c` |
| `library/medallions/cartography.webp` (240×240, unused) | 30,028 B | `1ede45580236e26e5283dcf1c4d2834ee36b6632d07400937aa08ae461055bd9` |
| `library/medallions/discovery.webp` (240×240, unused) | 30,208 B | `233add563ff47c646fc75f327691d6949b9429ab3e1f2dc2a6638c1768635f9c` |
| `library/medallions/inkwell.webp` (240×240, unused) | 30,254 B | `cf597ebf5e77a56919b6502086bfcc7ca3297d5638dfc778bb88fd91e4a065a0` |

**Used in the UI:** `wayfinder` (hero eyebrow accent) and `compendium` (table-of-contents
summary accent) — see "Icon integration" below. `chronicle`, `cartography`,
`discovery` and `inkwell` are extracted, optimized, committed and documented here but
**not referenced by any component yet**, per the brief's own instruction to "keep icon
usage restrained" - the same stance `docs/azerdex-card-art/provenance.md` took for the
unused `quests`/`professions` category icons.

**Why not watermarked:** same reasoning as the homepage card medallions - these are
small (rendered well under 100px), closer to UI iconography than illustrated scenes, and
a watermark visible at that scale would either be invisible or dominate the icon's own
illustration.

## Embedded AzerDex watermark (hero images only)

Same mark, method and framing as the Phase 1 hero art and Phase 2 card backgrounds: the
AzerDex compass/rune emblem from `web/public/icon.svg`, recoloured to a single flat gold
tint (`#e8cf8f`), composited directly into the raster pixels (not a CSS/HTML overlay) at
15% opacity - within the previously-used 12–18% range.

**Reconstruction note:** no SVG rasterizer (e.g. `cairosvg`, `rsvg-convert`) was
available in this session's environment, so the mark was reconstructed from
`icon.svg`'s own geometry (a 40×40 viewBox: an outer ring, eight cardinal/diagonal
ticks, an outer diamond outline, and a filled inner diamond) using Pillow drawing
primitives rather than rasterizing the file directly. Visually equivalent to the
source mark at the small sizes used here; not a pixel-identical rasterization.

**Placement**, sized ~3.2% of each image's own width (consistent with the Phase 1
hero's "kept small" rationale):

| Image | Anchor (% of published image) | Mark size | Verified against |
| --- | --- | --- | --- |
| `arcane-library-hero.webp` (1916×821) | 90%, 10% | 61px | Desktop/tablet hero: top-right sky/architecture area, clear of the bottom-anchored "Arcane Library" headline and the eyebrow text (`CartographyBanner`-style `justify-end` text block) |
| `arcane-library-hero-mobile.webp` (composited at 960×960, before the two-round performance pass below) | 88%, 24% of the original square → 88%, 9% of the published 768×452 file | 31px at 960w → ~25px at the published 768w | Falls inside the horizontal band `object-cover` actually displays in the mobile banner (verified with a rendered screenshot at 390px width and a pixel zoom of the mark's corner - see Phase 2-B visual-polish screenshots) |

**Framing, per the established policy:** this watermark is brand identification and a
deterrent, not a technical copy-protection measure and not a copyright claim. No ® or
© symbol is used.

## Mobile Lighthouse/performance review

A Lighthouse run against the built `/guides` page (`npx lighthouse http://localhost:3100/guides
--only-categories=performance`) was used to check the new hero asset's effect on mobile
performance. This took two rounds to converge.

**Desktop preset:** performance score 100/100 (FCP 0.4s, LCP 0.8s, TBT 0ms, CLS 0.012) -
no issue; the desktop hero is served at its native 1916×821 with no resize needed.

**Mobile preset (default throttling), round 1 - the square 960×960 mobile crop:**
performance score 89/100 (FCP 1.4s, LCP 3.6s, TBT 140ms, CLS 0.028). Lighthouse's
`image-delivery-insight` audit flagged the mobile hero: at the emulated device's
rendered box, `object-cover` only ever displays a 960×564-equivalent band of the
960×960 square - the extra ~41% of stored vertical pixels is downloaded by every mobile
visitor and then clipped away by CSS, never seen. Estimated savings: 118 KiB, ~500ms of
LCP. **Fix:** pre-cropped the mobile hero to the exact 960×564 band `object-cover`/
`object-[75%_45%]` renders (computed directly from the CSS object-fit math for the
`h-56` banner), then re-encoded at the same quality. Pure re-crop of the
already-published, already-watermarked file - no new source access needed, and the
watermark still lands well inside the new crop. 191,232 B → 138,328 B (−27.7%), no
visible change (the removed pixels were already being clipped, never rendered).

**Mobile preset, round 2:** score improved to 92/100 (LCP 3.2s), but
`image-delivery-insight` still flagged the same file - its *correct* aspect ratio was
now still carrying more raw resolution and a higher WebP quality factor than the
emulated device's box (reported as 662×389) needs, and separately flagged
`wayfinder.webp` (240×240, rendered at 35×35 in this emulation). **Fix:** resized the
mobile hero from 960×564 to 768×452 (≈1.3× the flagged target, kept as headroom for
higher-density/wider phones a single fixed asset also has to serve) at WebP quality 75
(down from the initial encode's higher quality, checked visually for banding/blocking at
full size - none visible under the permanent gradient overlay); downscaled the two
*wired-in* medallions (`wayfinder`, `compendium`) from 240×240 to 128×128, still 3-5×
their largest rendered size. Result: hero 138,328 B → 79,184 B (a further −42.8%, 191,232
B → 79,184 B overall, −58.6%); `wayfinder.webp` 29,546 B → 10,398 B (−64.8%);
`compendium.webp` 28,596 B → 10,114 B (−64.6%).

**Mobile preset, after round 2 (final):** performance score 94/100 - FCP 1.4s, **LCP
3.0s** (down from 3.6s, −17%), TBT 50ms (down from 140ms), CLS 0.028 (unchanged, as
expected - this is a non-interactive background image that was never render-blocking).

**Why this is the stopping point, not a third round:** `image-delivery-insight` still
reports a theoretical ~45 KiB on this page, because Lighthouse evaluates a single fixed
image against one specific emulated device (Moto G Power, DPR 1.75) - a device-matched
asset for that profile is undersized for a higher-DPR/wider phone and oversized for a
smaller one. Closing that residual gap for every device properly needs a `srcset` with
multiple pre-rendered widths, which is a reasonable *future* enhancement but materially
larger in scope than this round's brief (a single, correctly-cropped, well-compressed
asset per breakpoint); it was not built here. The 768×452 asset chosen is sized against
Lighthouse's own reported target with margin for common iPhone widths/DPRs, not just the
one profile Lighthouse tested.

## Icon integration

`web/src/components/library/ArcaneLibraryBanner.tsx`'s SVG remains the permanent,
always-rendered fallback (no raster image, works with JavaScript off or if the raster
fails to load) - the hero photo is layered on top of it via a `<picture>` element with
an art-directed mobile `<source>`, exactly mirroring the homepage hero's
"SVG-is-the-permanent-fallback" principle from `docs/azerdex-hero-art/provenance.md`,
adapted to a server-rendered (no client JS, no inline styles, no CSP risk) `<picture>`
instead of the homepage's session-themed `next/image` layer, since the Guides hero has
one fixed image rather than three session-rotating themes.

The two wired medallions are purely decorative, `aria-hidden="true"` with empty `alt=""`
so they never produce a redundant screen-reader announcement alongside the adjacent
visible text they sit next to (the hero eyebrow label and the "In this guide" summary
text already carry the accessible name on their own).

## Related

- `docs/azerdex-hero-art/provenance.md` - the hero artwork record this one mirrors,
  including the git-history-exposure write-up (the same caveats about a public,
  already-forked repository apply to anything committed here).
- `docs/azerdex-card-art/provenance.md` - the card/medallion record this one mirrors for
  the icon-extraction method and the "small icons aren't watermarked" rationale.
- `web/src/components/library/ArcaneLibraryBanner.tsx`, `GuidesLibrary.tsx`,
  `GuideArticle.tsx` - where these assets are wired in.
