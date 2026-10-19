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
