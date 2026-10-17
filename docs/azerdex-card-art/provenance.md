# AzerDex Phase 2 "Explore AzerDex" card artwork — provenance record

Status: **owner-approved, subject to normal IP review** (not a claim of independent
legal clearance) — same standing as `docs/azerdex-hero-art/provenance.md`, which this
record follows in structure and intent.

## What this covers

Four illustrated background images and four matching circular medallions, used by the
homepage's "Explore AzerDex" section (`FEATURE_CARDS` in `web/src/app/page.tsx`,
rendered by `web/src/components/FeatureCard.tsx`). Distinct from the hero backgrounds
(separate provenance record) and from the homepage's six `ENTRY_POINTS` category cards
(still using the original line-icon glyphs — see "Deferred assets" below).

## Source and approval

Per the repository owner, all eight files are ChatGPT-generated images supplied
directly for this feature, approved subject to normal IP review. Received as `.webp`
(the chat attachment path converts pasted images to WebP, same as the hero art).

| Slug | Background subject | Medallion subject |
| --- | --- | --- |
| `community-data` | Robed figure at an archway overlooking a lit valley | Five silhouetted figures in a star-ringed violet emblem |
| `interactive-maps` | Compass/star table with floating islands on a charted path | World-map compass rose with constellation lines |
| `tools-guides` | Open spellbook and writing desk overlooking the valley | Open grimoire with a quill and sketched map pages |
| `exploration-discovery` | Robed figures at a glowing ritual circle, valley beyond | Mountain peak and ruined archway in a starburst frame |

## Focused visual review for Blizzard-specific protected elements

Same criteria as the hero art review: distinguish genre convention (not a concern) from
logo/trademark/named-character/exact-location reproduction (a concern), and name any
concrete element found rather than a blanket rejection.

**Found, and named explicitly:** three of the four backgrounds (`community-data`,
`tools-guides`, `exploration-discovery`) show a blue banner with gold trim bearing a
golden rampant-lion medallion at an archway. This reads as a concrete, specific match to
World of Warcraft's **Alliance faction crest** — not a generic dark-fantasy element like
the moons, floating islands or violet palette already assessed as unprotectable
scènes à faire in the hero art review. `exploration-discovery` additionally shows
figures in plate armor consistent with Alliance-style character art. This is a stronger,
more concrete match than anything found in the hero art set (which had no logos,
text, or character figures at all).

**Owner decision, recorded explicitly (owner-accepted risk):** informed of this finding
before any implementation, the owner chose to proceed with these three backgrounds
as-is rather than requesting regenerated versions without the crest. This project's
standing policy ("No Blizzard artwork is redistributed by this site",
`web/src/components/SiteFooter.tsx`) is written with actual Blizzard-sourced assets
(e.g. CASC-extracted textures) in mind; this is a different situation — a
ChatGPT-generated image that happens to echo a specific piece of Blizzard iconography,
accepted into this fan project with the owner's explicit, informed sign-off rather than
silently shipped or silently rejected. If this is ever challenged, this record and the
retained private originals (see below) are the audit trail of what was known and
decided, and when. `interactive-maps` and all four medallions showed no logos,
trademarks, character likenesses, or exact-location reproductions.

## Private source records (not in the publicly served tree)

Per the lesson from Phase 1 Task C, the as-received originals are **not** committed to
this repository at all — not even under a `source/` path — since anything under
`web/public/` is served as a static file. The owner holds the originals independently;
this repository keeps only their SHA-256 as the audit trail, computed when received:

| File | Role | SHA-256 | Size |
| --- | --- | --- | --- |
| (community-data bg) | background | `c8fc059c12dfb8c7e939437f5029b5ebc7f424b918fd97b6a925496ac74b8cc9` | 322,482 B |
| (tools-guides bg) | background | `ab7041f8b229704eb3753812d2f57fe098ca76cbe7e24732be1032a046289293` | 292,208 B |
| (interactive-maps bg) | background | `0f0938b23e2af4fe0a21c40106d5b84b33d38b35d1b687f036712bde18bbe590` | 331,154 B |
| (exploration-discovery bg) | background | `e019de70fb73e0058c7c38672deabf33cd14fa143ca3cdd1e983af0708599c0f` | 261,628 B |
| (community-data medallion) | medallion | `ce31b6b3f50c7b2fe090be54ac63142f11e4bd3843ec26329a46cec5bd805870` | 362,914 B |
| (interactive-maps medallion) | medallion | `b47b599279cd05e85561429e464d22c4befa016d801817a73a3ae3a03b69eaa5` | 393,394 B |
| (exploration-discovery medallion) | medallion | `00f9afbd0ab856d79fa7983609fd9659773d57469f5eb5f7c16ba17a4ad07706` | 486,634 B |
| (tools-guides medallion) | medallion | `cc2550f3164ec51acdc442ec6686f2b66a8bc91258e04f3fbde9271838671dfa` | 491,324 B |

All backgrounds received at 2000×667; all medallions received at 1254×1254 with genuine
alpha transparency (verified: each medallion's corners are fully transparent, ~30–43%
of pixels fully transparent, no accidental opaque black/white fill, no clipped
ornament — the medallions' own decorative points touching the canvas edge is the
source art's intentional framing, confirmed by inspection, not a cropping defect).

## Published derivatives (public, watermarked where applicable)

Backgrounds are re-encoded WebP (quality 82, same 2000×667, no up/downscaling) and
carry the embedded AzerDex watermark (below). Medallions are downscaled to 360×360 —
comfortable 2×-retina headroom over their ~140px rendered size — re-encoded as WebP
with alpha preserved, and are **not** watermarked (see rationale below).

| Slug | Kind | Pre-watermark | Published (served) | Change |
| --- | --- | --- | --- | --- |
| `community-data` | background | 197,116 B | 192,886 B | −2.1% |
| `tools-guides` | background | 173,500 B | 169,342 B | −2.4% |
| `interactive-maps` | background | 216,422 B | 206,488 B | −4.6% |
| `exploration-discovery` | background | 146,394 B | 137,358 B | −6.2% |
| `community-data` | medallion | n/a (not watermarked) | 47,242 B | — |
| `interactive-maps` | medallion | n/a (not watermarked) | 66,706 B | — |
| `exploration-discovery` | medallion | n/a (not watermarked) | 58,948 B | — |
| `tools-guides` | medallion | n/a (not watermarked) | 55,748 B | — |

Published SHA-256 (the files actually served from `web/public/cards/`):

| File | SHA-256 |
| --- | --- |
| `cards/community-data.webp` | `e00c44a498131166d72e056c09bd864483a13a4f2efe85d3eb2577af63e68806` |
| `cards/tools-guides.webp` | `8a32ae93bc393871295249341ef01f85bc543fa8ab73a8d06b893d9f4d17cbcc` |
| `cards/interactive-maps.webp` | `68dfc749ad223b18b7d119aa4a8ba90e88e14e8134ada10b4feda8b7daa7cc9b` |
| `cards/exploration-discovery.webp` | `79b96724e71ad4bac4f0f983f530e889d03e880fde2df095b2ffb2c2ecce2080` |
| `cards/medallions/community-data.webp` | `e66ee2d91cc5f35ced0ec8492c20704f672e49b58f9836c3200c6b9ad52aacfc` |
| `cards/medallions/interactive-maps.webp` | `f11e56fb6ec5a16b349f3f0a041e54158ccf18a27cb82e1c89a0bec707c1ed9a` |
| `cards/medallions/exploration-discovery.webp` | `1353d993b9840ac6e14e1d6588a66340366e7dbbc4874eda30a54504fd7fb247` |
| `cards/medallions/tools-guides.webp` | `94adb3543099ee90aaff95c24b53349a85120b9e6a0729931ea966d0d8b81922` |

## Embedded AzerDex watermark (backgrounds only)

Same mark, method and framing as the hero art (`docs/azerdex-hero-art/provenance.md`):
the AzerDex compass emblem from `web/public/icon.svg`, single flat gold tint
(`#e8cf8f`), composited directly into the raster pixels (not a CSS/HTML overlay),
16% opacity.

**Placement:** a single anchor at (48%, 12%) of each background's 2000×667 canvas,
used uniformly across all four. Unlike the hero, these cards crop only
*horizontally* — every card container (2-column desktop down to 1-column mobile) is
narrower in aspect than the 3:1 source, so `object-fit: cover` always shows the full
image height and crops width only. The tightest case (mobile, ~342px card width)
leaves roughly the horizontal band 10–63% of source width visible, depending on each
card's own `focal` x-position (`FEATURE_CARDS` in `page.tsx`); 48% falls inside that
band for all four themes with margin, and at y=12% sits near the top, clear of the
top-left medallion overlay and the bottom title/description text in every layout.
Verified with Playwright screenshots at 1440px and 390px widths; confirmed directly
against the published raster files, not just the rendered page.

**Why medallions aren't watermarked:** they're small (rendered ~64–72px on the card,
exported at 360px), and a 16%-opacity mark at that scale would either be invisible or,
if sized up enough to read, dominate the medallion's own illustration — inconsistent
with "clean icon boundaries" and the "small, elegant, discreet" brief for watermarking
set in Phase 1. The medallions aren't full illustrated scenes the way the hero
backgrounds and these card backgrounds are; they're closer to UI iconography. Framing
in Phase 1 still applies: this is brand identification and a deterrent on the published
artwork, not a copyright claim or a technical copy-protection guarantee.

## Deferred assets

Not yet integrated — no files received yet (or not receivable as processable files
this round):

- **Full AzerDex wordmark logo** (for homepage hero/brand-signature integration,
  brief section 3). The image was shown in conversation but never landed as a file
  this session's tools could open; needs to be re-sent as a proper file attachment
  rather than inline/pasted.
- **8-icon category sheet** (Items/Creatures/Quests/Zones/Mining/Herbalism/Fishing/
  Professions, brief section 4). Same blocker as the logo.

Until these arrive, the homepage's six `ENTRY_POINTS` category cards keep their
existing line-icon glyphs unchanged, and no hero/navbar logo change has been made —
per the owner's own instruction not to fabricate or substitute placeholder art for a
missing approved asset.

## Related

- `docs/azerdex-hero-art/provenance.md` — the hero artwork record this one mirrors,
  including the git-history-exposure write-up (the same caveats about a public,
  already-forked repository apply to anything committed here).
- `web/src/components/FeatureCard.tsx`, `web/src/app/page.tsx` (`FEATURE_CARDS`) —
  where these assets are wired in.
