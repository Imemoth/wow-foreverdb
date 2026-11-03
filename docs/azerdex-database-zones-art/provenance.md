# AzerDex "P2-A Visual Polish: Database & Zones" artwork — provenance record

Status: **owner-approved, subject to normal IP review** (not a claim of independent legal
clearance) — same standing as `docs/azerdex-library-art/provenance.md` and the hero-photography
addendum in `docs/azerdex-news-blog-art/provenance.md`. This round supplied exactly two hero
photographs, received directly in this session as chat attachments, plus reuse of existing
icon/medallion assets already shipped from earlier rounds. No new icon or medallion art was
produced.

## Hero photography

| Role | Subject | As-received dimensions |
| --- | --- | --- |
| Database hero (desktop/tablet) | "Arcane Archive": a mystical data-repository interior — glass display cases, glowing armillary spheres/orreries, tall shelving of scrolls and tomes | 1916×821 |
| Zones hero (desktop/tablet) | "Arcane Cartography": a fantasy geographic-exploration vista — floating islands, a waterfall cluster, twin moons over a cartography-themed skyline | 1916×821 |

Both arrived at the exact same canvas size as every other hero asset already in the site
(`public/library/arcane-library-hero.webp`, `public/news/news-observatory-hero.webp`,
`public/blog/blog-writers-study-hero.webp`, all 1916×821), so they were re-encoded to WEBP at that
same resolution with no upscaling:

- `web/public/database/database-arcane-archive-hero.webp` (desktop/tablet, quality 70 — the
  archive scene's density of fine detail compressed less efficiently than the Zones vista at the
  same quality, so it was tuned down a step after a visual A/B at 84/78/74/70/65 found no
  perceptible difference from 78 down to 70)
- `web/public/database/database-arcane-archive-hero-mobile.webp` (mobile crop: left-weighted on
  the glass archive cases and glowing armillary spheres — the scene's focal point — rather than a
  centered crop, which would have pushed it mostly off-frame; quality 72)
- `web/public/zones/zones-arcane-cartography-hero.webp` (desktop/tablet, quality 84)
- `web/public/zones/zones-arcane-cartography-hero-mobile.webp` (mobile crop: left-of-center on the
  floating-island/waterfall cluster and both moons; quality 84)

Per the established pattern from earlier rounds, the as-received full originals are **not**
committed to this repository; this repository keeps only their SHA-256 as the audit trail:

| Role | SHA-256 | Size |
| --- | --- | --- |
| Database hero, as received | `5893a0cb733242bde2ee49550453fa4721d5716d76710d67d2b4723fa0df0df2` | 382,122 B |
| Zones hero, as received | `f4a7dd3c1bcc43b5fa22d8ba0b0b118c4b140e1cc23cf1c2b861cddbaa7758b8` | 348,652 B |

### Resulting file sizes vs. target

The task set a target of "~300KB or less per desktop hero and 100KB or less per mobile hero,
unless visual quality justifies a documented exception." Both pairs landed comfortably under
target with no exception needed:

| File | Size | Target |
| --- | --- | --- |
| `database-arcane-archive-hero.webp` | ~290 KB | ≤300 KB |
| `database-arcane-archive-hero-mobile.webp` | ~79 KB | ≤100 KB |
| `zones-arcane-cartography-hero.webp` | ~233 KB | ≤300 KB |
| `zones-arcane-cartography-hero-mobile.webp` | ~61 KB | ≤100 KB |

## How the two heroes were integrated

Both photographs are mounted by a new shared component, `components/cartography/CartographyHero.tsx`,
built on the exact same full-bleed cinematic technique already established for the Guides/News/Blog
hub heroes (`components/content/ArticleHub.tsx`, `components/library/GuidesLibrary.tsx`): a
breakout wrapper (`relative left-1/2 w-screen -ml-[50vw]`), the existing
`ArcaneSurveyBanner.tsx` SVG composition mounted underneath as a permanent fallback layer (SVG is
always rendered — the photo sits on top via `<picture>`), a separately art-directed mobile crop via
a `(max-width: 639px)` `<source>`, the shared `.hero-vignette`/`.hero-fade-bottom` CSS plus an
extra darkening scrim for title legibility, and left-aligned title/eyebrow typography.

- `/database` uses it in `compact` mode (shallower: ~260–340px min-height across breakpoints) since
  Database is a functional search interface, not a landing page — the search form must stay close
  to the fold. Eyebrow: "Arcane Archive" with the `items.webp` icon.
- `/zones` uses the default (taller: ~360–480px min-height) mode, since it is primarily an
  exploration directory and can afford more scale. Eyebrow: "Arcane Cartography" with the
  `cartography.webp` medallion.
- `/zone/[id]` intentionally does **not** use `CartographyHero` — per the task's explicit
  "restrained, not another tall hero on every data-heavy page" requirement, it keeps the original
  contained `CartographyBanner.tsx` at its existing height, with only a small decorative medallion
  added beside the title (see below).

## Reused icons and medallions (no new assets)

Every decorative icon in this round reuses an existing file already committed from earlier phases;
nothing new was generated.

| Asset | Reused from | New placement this round |
| --- | --- | --- |
| `public/icons/items.webp` | P2-A icon set | Database hero eyebrow icon |
| `public/icons/creatures.webp` | P2-A icon set | Database "Start browsing" `mob` tile; zone-detail "Creatures" quick filter |
| `public/icons/mining.webp` | P2-A icon set | Database "Start browsing" `mining` tile; zone-detail "Mining" quick filter |
| `public/icons/herbalism.webp` | P2-A icon set | Database "Start browsing" `herbalism` tile; zone-detail "Herbalism" quick filter |
| `public/icons/fishing.webp` | P2-A icon set | Database "Start browsing" `fishing`/`fishing_pool` tiles (reused for both — there is no separate pool icon and the two are visually the same activity); zone-detail "Fishing pools" quick filter |
| `public/icons/zones.webp` | P2-A icon set | Database "Browse by zone" sub-heading icon |
| `public/library/medallions/cartography.webp` | P2-B medallion sheet | Zones hero eyebrow icon; one of 3 rotating zone-card/zone-detail medallions |
| `public/library/medallions/wayfinder.webp` | P2-B medallion sheet | One of 3 rotating zone-card/zone-detail medallions |
| `public/library/medallions/discovery.webp` | P2-B medallion sheet | One of 3 rotating zone-card/zone-detail medallions |

The `quests.webp` and `professions.webp` icons were deliberately **not** wired up — no route or
filter exists for either in the current application (no quest browsing, no profession-specific
landing page), so wiring them would point at a nonexistent destination. Four `LOOT_KINDS` values
(`skinning`, `chest`, `gameobject`, `disenchant`) have no matching decorative icon and render as a
plain rune-glyph placeholder tile (Database) or a plain text chip (zone detail "Chests" filter)
instead — every acquisition method stays reachable, per the task's explicit "retain existing
acquisition methods, including categories without dedicated decorative icons" requirement.

### Zone medallion rotation

The Zones directory cards and the zone-detail identity banner share one deterministic
hash-then-pick helper (`components/cartography/zoneMedallion.ts`, same technique as
`components/library/CategoryBadge.tsx`'s `accentFor()`): a zone's name is hashed to pick one of the
three medallions above, so the same zone always gets the same medallion but neighbouring zones
don't repeat one icon. Every medallion image is `aria-hidden="true"` with empty `alt`, and is purely
decorative — it never claims to depict that specific zone's real in-game geography, and the task's
"a generic atlas-style decorative background is acceptable, but must not be presented as
geographical evidence" requirement is met by not pairing any medallion with location-specific
claims anywhere in copy.

## Blizzard-specific element review

Both new hero photographs were reviewed against the same criteria used in every prior provenance
record: the Blizzard/World of Warcraft logo or wordmark, any named-character likeness, and any
exact or near-exact reproduction of a specific, identifiable in-game location. **None found** —
both are generic, stylized fantasy-genre scenes (an arcane archive interior, a floating-island
cartography vista) with no claim to represent a specific place or character in World of Warcraft or
WoW: Forever.
