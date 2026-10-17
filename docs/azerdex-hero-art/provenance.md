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

## Source records — private, not in the publicly served tree (Phase 1 Task C)

**Status as of Phase 1 Task C: removed from the public tree.** The as-received,
unwatermarked files were originally kept byte-for-byte unmodified under
`web/public/hero/source/<theme>.source.webp` as an audit copy. That path is wrong for
that purpose: anything under `web/public/` is served as a static file by Next.js, so
those unwatermarked originals were (unintentionally) publicly downloadable — directly
contradicting the requirement that unwatermarked master artwork stay private. They have
been deleted from this tree in a follow-up commit (see "Residual git-history exposure"
below — deleting them here does **not** erase them from git history).

**Before deletion, the owner confirmed holding an independent copy of the original
artwork outside this repository** — this was a direct precondition checked before
removing these files, since they were the only copies of the unwatermarked originals
tracked anywhere in this repo.

SHA-256 of each (computed when they were added; this is now the only record of their
content kept in this repository's public tree — the audit trail, not a way to
reconstruct the files):

| File | SHA-256 |
| --- | --- |
| `source/floating-city.source.webp` | `7f7f359b7f5475ebe9de27590177598683f0664bf4933c2a6224fab5f17c23be` |
| `source/violet-moon.source.webp` | `85c7f81ed8f1bc93746fc8800e2be28acf93b8bb2fcc1abd16e9d45a69ef59c3` |
| `source/arcane-ruins.source.webp` | `001a1b4efcd2bbcee245e5773fefe418e7c19b1031c35631376722273f64f7a9` |

Original (as-received) dimensions: 1672×941 for all three.

## Published derivatives (public, watermarked)

The only files this repository serves publicly are the optimized, watermarked
derivatives at `web/public/hero/<theme>.webp` — re-encoded WebP, quality 80, same
1672×941 (no upscaling or downscaling applied, no demonstrated benefit to either), now
also carrying the embedded AzerDex watermark (see "Embedded AzerDex watermark" below).
Size history:

| Theme | As-received (private, not served) | Optimized, pre-watermark | Optimized + watermark (currently served) |
| --- | --- | --- | --- |
| `floating-city` | 438,514 B | 250,002 B | 241,542 B |
| `violet-moon` | 414,136 B | 239,310 B | 229,926 B |
| `arcane-ruins` | 438,264 B | 258,382 B | 248,804 B |

Metadata was minimized in the served derivatives (re-encoded through Pillow, which does
not copy EXIF/XMP by default) per the owner's instruction.

## Residual git-history exposure (Phase 1 Task C — read before assuming these are gone)

**Deleting `web/public/hero/source/*.webp` from the working tree does not remove them
from this repository's git history, and this record does not claim otherwise.** Precise
facts, not a general disclaimer:

- The three files were added in a single commit
  (`feat(web): integrate owner-approved Phase 1 hero artwork`, 2026-10-17). That commit
  was already pushed to `origin/web/azerdex-brand-v1` — the branch backing Draft PR #61
  — before this cleanup, and Vercel built and deployed it successfully (deployment
  `dpl_BEPeKo79MSCi8Noxc6ZS93QdNW4h`, state `READY`). That means the unwatermarked
  originals were live and publicly fetchable at `/hero/source/<theme>.source.webp` on
  that Preview deployment for the period between that deploy and the deploy that
  removed them.
- This GitHub repository is **public** (confirmed via the repository API:
  `"private": false`), with at least one existing fork. Anyone — not just people with
  write access — can browse, clone, or fork the full commit history, including the
  commit above, indefinitely. `git show <that commit>:web/public/hero/source/<file>`,
  GitHub's commit/blob view, and `raw.githubusercontent.com` all remain valid ways to
  retrieve these exact bytes from that commit for as long as it stays reachable from
  any ref (and, separately, from anything already cloned/forked, regardless of what
  happens to this repository's refs afterward).
- Checked whether any other branch forks from at or after that commit (would matter if
  a history rewrite were ever considered): none of this repository's other branches
  share that commit as an ancestor point reached after it — but **no history rewrite
  was performed or is proposed here**, so this is informational only, not something
  acted on.
- Vercel does not delete a prior Preview deployment just because a newer one supersedes
  it on the branch alias; the deployment-specific URL for the build above may remain
  independently reachable after this cleanup's new deployment goes live.
- Any crawler, cache, or person who already fetched the live URL during the window
  above may hold an independent copy that no action inside this repository can reach or
  revoke.

**What this cleanup does accomplish:** stops the unwatermarked originals from being
served by the current and future deployments, and from appearing in a normal browse of
the repository's current `HEAD`. **What it does not accomplish:** erase them from this
repository's history, from the public GitHub view of the commit that added them, or
from anyone who already has a copy. Actually removing them from history would require a
rewrite (e.g. `git filter-repo`) and a force-push, coordinated with the known fork and
anyone else who has cloned this repository — that is a separate, more disruptive
action, explicitly **not performed or authorized by this round of work**, and would
need its own explicit owner sign-off given the public-repo, already-forked, already-
deployed state documented above.

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

## Embedded AzerDex watermark (Phase 1 Task B)

Per owner instruction, the three served derivatives
(`web/public/hero/<theme>.webp`) now carry a discreet AzerDex watermark
embedded directly into the raster pixels (not a CSS/HTML overlay) — a visitor
who downloads the image file gets a watermarked copy, not a clean one.

**Mark:** the existing AzerDex compass/rune emblem from `web/public/icon.svg`
(the one used as the site favicon and in `Logo`), recolored to a single flat
tint (no change to the approved scene artwork itself beyond this addition).

**Tint and opacity:** each theme's placement area was sampled for local
brightness; all three landed on the warmer, gold tint (`#e8cf8f`) against
their dark night-sky placement areas, at 17% opacity — within the requested
12–18% range, biased toward the top of it because the mark is small (see
below).

**Placement:** a single universal position per theme, chosen empirically
against both the desktop crop (full width, cropped top/bottom per
`HERO_IMAGE_FOCAL`) and the mobile crop (full height, cropped left/right).
The two crops impose independent, theme-specific constraints — the mark must
clear each theme's own desktop top-crop line *and* sit above the headline's
eyebrow text on mobile — which left very little shared margin for
`arcane-ruins` and `floating-city` in particular, so the mark was kept small
(~3.2% of image width, 53px at the served 1672px width) specifically to fit
both:

| Theme | Anchor (% of image) | Tint | Verified against |
| --- | --- | --- | --- |
| `arcane-ruins` | 30%, 10.5% | gold | desktop (no header clip) + mobile (clears headline) |
| `violet-moon` | 55%, 7% | gold | desktop (no header clip) + mobile (clears headline) |
| `floating-city` | 35%, 8.5% | gold | desktop (no header clip) + mobile (clears headline) |

All three were moved off their first-attempt positions after screenshot
review: the original anchors either clipped under the sticky header on
desktop, sat on top of visually busy detail (violet-moon's own moon surface,
which swallowed the mark), or touched the headline text on mobile. Final
placement was verified with Playwright screenshots at both breakpoints for
all three themes (no clipping, no text overlap, mark visible but subtle).

**File size impact** (re-encoded WebP, quality 80, method 6, same 1672×941 —
compositing requires a re-encode, so these numbers supersede the "Optimized
(served)" column above as the current on-disk state):

| Theme | Pre-watermark (served) | Post-watermark (served) | Change |
| --- | --- | --- | --- |
| `floating-city` | 250,002 B | 241,542 B | −3.4% |
| `violet-moon` | 239,310 B | 229,926 B | −3.9% |
| `arcane-ruins` | 258,382 B | 248,804 B | −3.7% |

(The re-encode happens to shrink the files slightly; the watermark itself is
a sparse, low-opacity addition and doesn't meaningfully add entropy.)

**Framing, per the owner's own instruction:** this watermark is brand
identification and a deterrent, not a technical copy-protection measure and
not a copyright claim — copyright in the underlying images (to the extent it
exists; see "What this record does and doesn't establish" above) isn't
created or strengthened by adding a mark.

No ® or © symbol is used anywhere (no trademark/copyright registration has
been asserted).

## Related

- `web/src/components/hero/README.md` — the asset drop-in procedure these files follow.
- `web/src/components/hero/themes.ts` — `HERO_ASSET_SRC`, `HERO_IMAGE_FOCAL`.
- Repository policy this review was weighed against: `docs/ROADMAP.md` engineering rule
  2 and `web/src/components/SiteFooter.tsx` ("No Blizzard artwork is redistributed by
  this site") — both concern actual Blizzard-sourced assets (e.g. CASC-extracted map
  textures); they are unaffected by this review's conclusion that these three images
  are not Blizzard-sourced.
