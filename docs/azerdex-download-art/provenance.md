# AzerDex "P2-E Addon & Companion" Download hero artwork — provenance record

Status: **owner-approved, subject to normal IP review** (not a claim of independent
legal clearance) — same standing as the other `docs/azerdex-*-art/provenance.md`
records.

## What this covers

One hero photograph for the `/download` ("Addon & Companion") page, supplied directly
to this session as a chat attachment and explicitly approved for this page ("The image
was already designed and approved for this page").

| Role | Subject | As-received dimensions |
| --- | --- | --- |
| Download hero (desktop/tablet + mobile crop) | A monumental, symmetrical arcane installation chamber: a central descending column of violet light under a crystalline chandelier, paired violet energy-conduit pillars along both walls, runic/gothic architecture, reflective floor | 1916×821 |

Arrived at the same canvas size as every other hero asset already in the site
(`public/library/arcane-library-hero.webp`, `public/news/news-observatory-hero.webp`,
`public/database/database-arcane-archive-hero.webp`, etc., all 1916×821).

## Private source record (not in the publicly served tree)

Per the established pattern (`docs/azerdex-hero-art/provenance.md` and every subsequent
round), the as-received original is **not** committed to this repository; this
repository keeps only its SHA-256 as the audit trail, computed on receipt:

| Role | SHA-256 | Size |
| --- | --- | --- |
| Download hero, as received | `ee18aeaef01e72f0005d3b7ffd5980a81e1c466f537b35cbb8c289fbb3308d36` | 335,130 B |

## How it was processed

- **Desktop/tablet**: served at the native 1916×821 (no upscaling or downscaling),
  watermarked (see below), re-encoded to WebP at quality 76 to land under the ~300KB
  target: `web/public/download/download-arcane-chamber-hero.webp`, 286,382 B.
- **Mobile**: unlike Database/Zones/News/Blog's off-center focal points, this
  composition is deliberately **symmetrical** (the light column and chandelier sit on
  the vertical center line), so a **center crop** was used instead of a left-weighted
  one — a left crop would have cut the column in half. Cropped to the same
  768×493 (~1.558:1) aspect already used for the Database/Zones mobile heroes, centered
  horizontally (crop box x=318..1597 of the 1916px-wide source, full height), then
  resized to 768×493, watermarked, and re-encoded at quality 78:
  `web/public/download/download-arcane-chamber-hero-mobile.webp`, 82,406 B.

Both comfortably meet the task's ~300KB desktop / ~100KB mobile targets with no
exception needed.

## Embedded AzerDex watermark

This round follows the **Library (Guides) hero precedent**
(`docs/azerdex-library-art/provenance.md`): the AzerDex compass/rune emblem from
`web/public/icon.svg`, redrawn as a single flat gold tint (`#d9b978`, the same gold as
the icon's own stroke color) at 15% opacity (18–22% for the inner diamond), composited
directly into the raster pixels (not a CSS/HTML overlay), placed in the bottom-right
corner away from the title-safe zone the hero's left-aligned text occupies.

**Note on consistency across rounds**: the Database/Zones (P2-A) and News/Blog (P2-C)
hero photographs integrated in earlier rounds were *not* embedded with this watermark —
only their SHA-256 was recorded. That is an inconsistency in this project's own prior
work, not a deliberate policy difference; it is flagged here rather than silently
repeated or silently "fixed" by retroactively editing already-shipped files outside
this task's scope. This round (and any future hero photograph round) should follow the
Library/Download precedent — embed the watermark — unless the owner decides otherwise.

**Framing, per the established policy:** this watermark is brand identification and a
deterrent, not a technical copy-protection measure and not a copyright claim. No ® or
© symbol is used.

## Permanent decorative fallback

`DownloadHero.tsx` mounts an original inline-SVG scene (`ArcaneInstallationFallback`)
underneath the photo at all times — a symmetrical arcane-chamber silhouette (central
light column, paired conduit pillars, arch silhouettes, floor rings) that echoes the
photo's composition without reproducing it, so the hero never shows a broken image if
the photo fails to load. Same layering technique as `ArcaneSurveyBanner.tsx` /
`ArcaneLibraryBanner.tsx`.

## Blizzard-specific element review

Reviewed for the same criteria as every prior round: Blizzard/World of Warcraft logo or
wordmark, pre-existing text or watermark in the source, named-character likeness, and
exact/near-exact reproduction of a specific, identifiable WoW location. **None found** —
this is a generic, stylized fantasy-architecture scene (an arcane installation chamber)
with no claim to depict a specific in-game location or character.

## Screenshot slot conventions (P2-E Phase 3)

The `/download` page's Addon and Companion screenshot galleries use a centralized, typed
media-slot registry (`web/src/lib/download/media-slots.ts`) rather than hard-coded
`<img>` tags. Each slot has a stable `id`, a `group` (`addon` | `companion`), a `title`,
a `description`, and an `intendedFilename` — the exact file name the slot expects once a
real screenshot exists, under `web/public/download/screenshots/`.

**To add a real screenshot once one is available:**

1. Have the screenshot reviewed for private IDs/tokens/account details and third-party
   artwork (per this task's own instruction) before it goes anywhere near the
   repository.
2. Save it as `web/public/download/screenshots/<intendedFilename>` (the exact name
   already declared in `media-slots.ts` for that slot — do not invent a new name).
3. Set that slot's `asset` field in `media-slots.ts` to
   `"/download/screenshots/<intendedFilename>"`.
4. Nothing else changes: `MediaSlotGallery.tsx` automatically renders the real image
   instead of the placeholder, and the existing lightbox/keyboard/focus behavior applies
   to it unchanged.

No screenshot has been supplied for this round; all eight slots (four addon, four
companion) currently render the intentional placeholder (a gradient panel with the
AzerDex compass glyph, never a mock UI image presented as a real screenshot, never a
broken-image request).
