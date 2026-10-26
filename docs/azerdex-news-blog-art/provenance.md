# AzerDex Phase 2-C "News & Blog" hero artwork — provenance record

Status: **original vector artwork, no owner photography involved** — distinct in kind from
`docs/azerdex-library-art/provenance.md`, `docs/azerdex-hero-art/provenance.md` and
`docs/azerdex-card-art/provenance.md`, which all record owner-supplied raster photography. This
record exists so that distinction is explicit and auditable, not left implicit.

## What this covers

Two full-bleed hero banners, one for the News landing page (`/news`) and one for the Blog landing
page (`/blog`):

- `web/src/components/news/NewsObservatoryBanner.tsx` — an "Arcane Observatory" signal-tower scene.
- `web/src/components/blog/WritersStudyBanner.tsx` — a "Writer's Sanctuary" candlelit study scene.

## Why vector, not photography

Phase 2-C's task explicitly required: "Use existing owner-approved image assets. If the previously
created News/Blog artwork is unavailable, request the original files rather than inventing
substitute assets." At the time this phase was implemented, no owner-supplied News or Blog
photography existed anywhere in this repository or its asset pipeline (checked: `web/public/`
carries only the Guides/Library hero and medallion assets from `docs/azerdex-library-art/`; no
`docs/azerdex-news-art/` or `docs/azerdex-blog-art/` record exists).

That instruction's own remedy — asking the owner for the original files — applies to requesting
*photography*. It does not require stalling the whole feature on a photo request when the
repository already has an established, owner-approved fallback for exactly this situation: P2-A's
`ArcaneSurveyBanner.tsx` and the pre-photography version of P2-B's `ArcaneLibraryBanner.tsx` are
both original, hand-written inline SVG scenes, built and shipped (P2-A merged; P2-B's SVG version
was the approved Phase 1 treatment before a later, separate visual-polish round added owner photos
on top of it). This record uses that same established technique rather than ship no hero at all, or
fabricate a fictitious "approved photo" provenance chain that does not exist.

If the owner supplies real News/Blog photography later, it can be integrated exactly as P2-B's
photo layer was added on top of `ArcaneLibraryBanner.tsx` (see `docs/azerdex-library-art/
provenance.md`) — as a separate, explicitly-approved visual-polish follow-up, with its own
provenance record — without needing to touch the layout, copy or any other part of this phase.

## What was built

Both banners are plain inline SVG: gradients, paths and shapes only, in the same `viewBox="0 0 1400
420"` / `preserveAspectRatio="xMidYMid slice"` technique as `ArcaneLibraryBanner.tsx` and
`ArcaneSurveyBanner.tsx`, reusing the site's existing illustration palette (Void/Abyss ink, Runic
Gold, Arcane Violet). No raster image, no third-party asset, no Blizzard-derived artwork,
no logo, wordmark, named character or exact in-game location geometry.

- **News — Arcane Observatory**: a signal-tower silhouette on a cliff with a lit beacon lens and
  concentric "dispatch" rings (the news-travels-outward motif), under an irregular starfield. Palette
  skews cooler/blue-violet to read as distinct from the Library's warmer violet archive-alcove scene.
- **Blog — Writer's Sanctuary**: a candlelit study nook — an arched window, a writing desk
  silhouette with an open book, quill, inkwell and candle, drifting loose pages, faint bookshelf
  ticks either side. Palette skews warm amber/candlelight to read as distinct from both News and the
  Library.

## Medallion icons reused (not new assets)

The hero eyebrow icons reuse two existing, already-approved medallion icons from
`web/public/library/medallions/` (`chronicle.webp` for News, `inkwell.webp` for Blog) — both already
shipped as part of P2-B's medallion sheet (see `docs/azerdex-library-art/provenance.md`) and
generically named, not Guides-specific. No new icon assets were produced for this phase.

## Blizzard-specific element review

Both banners were reviewed against the same criteria used in the other provenance records: the
Blizzard/World of Warcraft logo or wordmark, any named character likeness, and any exact or
near-exact reproduction of a specific, identifiable in-game location. **None found** — both scenes
are generic fantasy-genre staging (a watchtower, a study) with no claim to represent any specific
place or character in World of Warcraft or WoW: Forever.

---

## Addendum: P2-C visual-polish round (owner-supplied hero photography + card art)

Status: **owner-approved, subject to normal IP review** (not a claim of independent legal
clearance) — same standing as `docs/azerdex-library-art/provenance.md`. This round supplied exactly
what the first pass above said was missing: real hero photography for both sections, plus
supporting card/medallion art, received directly in this session (chat attachments and an attached
asset zip).

### Hero photography (replaces the SVG-only treatment as the primary layer)

| Role | Subject | As-received dimensions |
| --- | --- | --- |
| News hero (desktop/tablet) | Arcane observatory balcony: a large brass armillary sphere/orrery, twin moons, a galaxy swirl, floating islands and spires below | 1916×821 |
| Blog hero (desktop/tablet) | Writer's sanctuary interior: arched windows onto a moonlit city, a desk with candles, quill, inkwell, scrolls and books, a small armillary globe | 1916×821 |

Both arrived at the exact same canvas size as the existing Guides hero
(`public/library/arcane-library-hero.webp`, also 1916×821), so they were re-encoded to WEBP at that
same resolution with no upscaling:

- `web/public/news/news-observatory-hero.webp` (desktop/tablet)
- `web/public/news/news-observatory-hero-mobile.webp` (mobile crop: left-weighted on the armillary
  sphere and both moons — the scene's focal point — rather than a centered crop, which would have
  pushed it mostly off-frame)
- `web/public/blog/blog-writers-study-hero.webp` (desktop/tablet)
- `web/public/blog/blog-writers-study-hero-mobile.webp` (mobile crop: left-weighted on the
  candle/quill/inkwell/scroll desk cluster, for the same reason)

The existing `NewsObservatoryBanner.tsx` / `WritersStudyBanner.tsx` SVG compositions were kept
exactly as built in the first pass above and stay mounted underneath the photo as the permanent
fallback layer (same technique as `GuidesLibrary.tsx`'s hero) — nothing in this round replaced or
modified them.

Per the lesson from the original Phase 1 Task C record, the as-received full originals are **not**
committed to this repository; this repository keeps only their SHA-256 as the audit trail:

| Role | SHA-256 | Size |
| --- | --- | --- |
| News hero, as received | `1b7615d2c0d228fc2ff1020330c49c2c70aa95491b267a67a7998320d4088ee6` | 2,552,579 B |
| Blog hero, as received | `712f855d5b2a5969997aa05c43a89f5fd789578f890c791ca6d9bac0de2637db` | 3,589,043 B |

### Featured/spotlight card art

Supplied via an attached `AzerDex_P2C_News_Blog_Visual_Assets.zip` (own `README.md` inside the
archive). Two content-specific illustrations, each with a "card" (768×432, 16:9, used on desktop)
and a "wide" (≈522×224, used as the mobile `<picture>` crop) variant:

| File | Role | SHA-256 | Size |
| --- | --- | --- | --- |
| `news-featured-card.webp` | News' content-specific art for "Introducing the ForeverDB website (preview)" — a fantasy cartography/arcane-database desk scene matching that article's actual subject | `9d526d24fd6b9041394fc2ef4809b10f5d065cd170872d837d0a139b94fda617` | 95,220 B |
| `news-featured-wide.webp` | same scene, wide crop (mobile) | `39b7c29ab8b376aa332281057e5f259e7387c4d31587778ad3b3800912b9e6c0` | 47,126 B |
| `blog-featured-card.webp` | Blog's generic decorative spotlight art (candlelit writing desk) | `1ef171baa538d9bc9eb92725619e95b63600d8112b8c49a4aac7c6ff1dfe4958` | 57,332 B |
| `blog-featured-wide.webp` | same scene, wide crop (mobile) | `af8dc0033b9d96795816732a474b28c4e4ef5e3519a8e88f10472088b7b6d2ab` | 31,018 B |

The package's own README is explicit that these two illustrations were "extracted from a newly
generated visual concept sheet, not exported from native high-resolution originals" — i.e. their
768×432 pixel dimensions do not imply native photographic detail at that size. Accordingly they are
used **only** as moderate-size card/spotlight art (News: one card in the hub grid; Blog: the
single-article spotlight), never stretched into a full-viewport hero, and never a stand-in for the
section hero photography above.

`news-featured-card.webp` is deliberately **slug-locked** in code
(`web/src/lib/content/article-media.ts`'s `SLUG_FEATURED_IMAGE`) to the one article it actually
depicts, rather than attached to any article marked `featured`, because the illustration's content
(cartography/database desk) is specific to that article's subject and would misrepresent a
different one. `blog-featured-card.webp` is generic decorative art
(`SECTION_SPOTLIGHT_IMAGE`) and is not tied to a specific article slug — it applies to whichever
single Blog post happens to be the only unfiltered result, which is accurate since it never claims
to depict real site analytics or gameplay data (the package's own README states this explicitly).

### Medallion assets: reused, not duplicated

The same asset package also supplied four 256×256 "medallion" crops
(`news-development-medallion.webp`, `news-companion-medallion.webp`,
`blog-engineering-medallion.webp`, `blog-editorial-medallion.webp`). Its own README asked that these
be checked against the repository before adding them: side-by-side visual comparison found all four
to be the same source art as existing medallions already committed in
`web/public/library/medallions/` from P2-B's original medallion sheet, just cropped to 256px instead
of 240px:

| Supplied file | Matches existing | Visual basis |
| --- | --- | --- |
| `news-development-medallion.webp` | `chronicle.webp` | same scroll-and-rune-circle artwork |
| `news-companion-medallion.webp` | `wayfinder.webp` | same compass/star artwork |
| `blog-engineering-medallion.webp` | `cartography.webp` | same scroll map + castle silhouette artwork |
| `blog-editorial-medallion.webp` | `inkwell.webp` | same quill-and-inkwell artwork |

None of the four supplied medallion files were added to the repository. Per-category medallions in
`ArticleCard.tsx` / `ArticleSpotlight.tsx` reuse the four existing files directly (see
`article-media.ts`'s `CATEGORY_MEDALLION` map).

### Optional ambient texture: evaluated, not used

The package also included `section-ambient-optional.webp` (a 549×127 arcane texture strip), offered
for use "at ≤6% CSS opacity... omit if the existing CSS vignette suffices." Evaluated and **omitted**:
the hub hero's existing vignette/scrim/fade-bottom layers plus the new photo backgrounds already
carry the composition, and stretching or tiling a 549×127 strip across a full-width hub background
at that low an opacity risked visible seams or banding for no clear visual gain.

### Blizzard-specific element review (this round's assets)

Reviewed the two hero photos and the two featured-card illustrations for the same criteria as
above: Blizzard/WoW logo or wordmark, pre-existing text or watermark, named-character likeness, and
exact/near-exact reproduction of a specific, identifiable WoW location. **None found** in any of the
four images — all four are generic, stylized fantasy-interior/exterior scenes (an observatory
balcony, a study, a cartography desk) with no claim to depict a specific in-game location or
character.
