# AzerDex Phase 1 hero artwork — provenance record

Status: **owner-approved, subject to normal IP review** (not a claim of independent legal clearance).

## What this covers

The three raster background images integrated into the homepage hero system
(`web/public/hero/*.webp`), wired through `HERO_ASSET_SRC` in
`web/src/components/hero/themes.ts`.

## Source and approval

| Theme ID | Original filename (as supplied) | Generation tool | Generation date |
| --- | --- | --- | --- |
| `floating-city` | `égi_városok_a_lila_holdfényben.png` | ChatGPT image generation | 2026-10-17 |
| `violet-moon` | `lila_holdfény_birodalma.png` | ChatGPT image generation | 2026-10-17 |
| `arcane-ruins` | `égi_romok_és_lila_örvény.png` | ChatGPT image generation | 2026-10-17 |

Per the repository owner (stated directly to this session, 2026-10-17): these three
files are newly generated image outputs from ChatGPT's image-generation capability,
not downloaded Blizzard promotional art, game screenshots, or assets extracted from
World of Warcraft. The owner explicitly approved these three files for the AzerDex
project, subject to normal IP review, and asked that this provenance be documented
rather than relying on an unrecorded claim.

**What this record does and doesn't establish:** this documents what was represented
and by whom, and the independent visual review that followed (below). It is not an
independent technical verification that the images were in fact produced by the named
tool on the stated date — that rests on the owner's attestation. If that attestation is
ever challenged, this file, the retained source copies, and the git history are the
audit trail.

## Format note

The files as received by this session were already WebP (`.webp`), not the `.png`
extension named in the owner's mapping — the chat interface that delivered them
converts pasted images to WebP on attachment. The retained source files below are
exactly what this session received, unmodified; if the owner holds the original PNG
output directly from ChatGPT, that is a more faithful record and can replace these if
wanted.

## Retained source records

The as-received files are kept, byte-for-byte unmodified, under
`web/public/hero/source/<theme>.source.webp` (not referenced by any application code —
audit copies only). SHA-256 of each, computed at the time they were added:

| File | SHA-256 |
| --- | --- |
| `source/floating-city.source.webp` | `7f7f359b7f5475ebe9de27590177598683f0664bf4933c2a6224fab5f17c23be` |
| `source/violet-moon.source.webp` | `85c7f81ed8f1bc93746fc8800e2be28acf93b8bb2fcc1abd16e9d45a69ef59c3` |
| `source/arcane-ruins.source.webp` | `001a1b4efcd2bbcee245e5773fefe418e7c19b1031c35631376722273f64f7a9` |

Original (as-received) dimensions: 1672×941 for all three. The optimized derivatives
actually served (`web/public/hero/<theme>.webp`, re-encoded WebP, quality 80, same
1672×941 — no upscaling or downscaling applied, no demonstrated benefit to either):

| Theme | As-received | Optimized (served) | Reduction |
| --- | --- | --- | --- |
| `floating-city` | 438,514 B | 250,002 B | 43.0% |
| `violet-moon` | 414,136 B | 239,310 B | 42.2% |
| `arcane-ruins` | 438,264 B | 258,382 B | 41.0% |

Metadata was minimized in the optimized derivatives (re-encoded through Pillow, which
does not copy EXIF/XMP by default) per the owner's instruction; the unmodified source
copies above are the provenance record and were not altered.

## Focused visual review for Blizzard-specific protected elements

Requested explicitly by the owner: distinguish "fantasy art style inspired by the
genre" (not a concern) from "redistribution or substantial copying of copyrighted
Blizzard artwork" (a concern), and name any concrete element found rather than
rejecting the set solely for resembling the high-fantasy genre.

Reviewed all three images directly for: the Blizzard or World of Warcraft logo/wordmark,
any text or watermark, any recognizable named WoW character likeness, and any exact or
near-exact reproduction of a specific, identifiable WoW location's actual geometry.

**Found:** none of the above in any of the three images. No logos, no text, no
watermarks, no character figures at all (all three are pure environment/architecture
compositions) — and no 1:1 recreation of a specific real zone's layout.

**One element named explicitly, as requested, rather than omitted:** the
`floating-city` image has a ring/halo structure encircling a moon in the upper-right
sky. This is the closest visual echo to Oribos (Shadowlands' ring-shaped afterlife hub
city) identifiable in the set. Assessed and **not treated as a blocking concern**: it
lacks Oribos's actually distinctive design elements — no bone/Maw aesthetic, no
Arbiter statue or iconography, no death-cosmology motifs. A ring-shaped structure in a
sky vista is a generic compositional device (also common in non-Blizzard fantasy art:
portal rings, orreries, Dyson-ring imagery) — genre convention, not Blizzard's specific
protected expression.

**Overall conclusion:** gold Gothic architecture, floating islands, large moons, and a
violet/purple magical palette are broad dark-fantasy genre conventions used across many
properties (not exclusive to Warcraft), and are unprotectable scènes à faire in
isolation. No concrete, nameable instance of logo, trademark, character, or
exact-location reproduction was identified. This review found no blocking concern under
the criteria the owner specified.

## Related

- `web/src/components/hero/README.md` — the asset drop-in procedure these files follow.
- `web/src/components/hero/themes.ts` — `HERO_ASSET_SRC`, `HERO_IMAGE_FOCAL`.
- Repository policy this review was weighed against: `docs/ROADMAP.md` engineering rule
  2 and `web/src/components/SiteFooter.tsx` ("No Blizzard artwork is redistributed by
  this site") — both concern actual Blizzard-sourced assets (e.g. CASC-extracted map
  textures); they are unaffected by this review's conclusion that these three images
  are not Blizzard-sourced.
