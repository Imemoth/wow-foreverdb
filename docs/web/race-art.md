# Race art (race cards, race page hero, Guides thumbnails)

Same-origin static assets under `web/public/race-cards/`, served by Next.js/Vercel like the class art (no CDN, nothing to configure; the
page CSP needs no change: images are `<img>` elements with `srcset`, positioned with static Tailwind classes, no inline styles).

## Source

Ten owner-provided illustrations (`races.zip`, delivered 2026-10-29), PNG, **1086 x 1448 px (3:4 portrait)**, 2.7-3.1 MB each (28.8 MB in total). They are
the owner's artwork for AzerDex; nothing was generated or altered apart from resizing and encoding. Each file was identified by its
content and matched to its race slug by name (none was ambiguous): Dwarf with hammer and braided beard; Gnome with pink hair, goggles and a
wrench; High Order Skyborne in blue-and-white robes with a crystal staff before floating spires; Human in a lion-tabard plate with a
sword; Night Elf with feathered pauldrons under a moon; Orc with a horde banner and axe; Tauren with horns and a totem staff; Troll with a
red crest and a spear; Undead with skull armour under green flames; Windshaper Skyborne with teal scarf and feathers and a wind staff. The
two Skyborne pictures are different images. The original PNGs are **not** in the repository.

The Blizzard-related notices in the site footer and `docs/third-party-blizzard-content-notice.md` are unchanged; this art is not Blizzard
client art.

## Processing (reproducible)

```bash
cd web
node scripts/build-race-art.mjs <directory with the ten source PNGs>
```

`scripts/build-race-art.mjs` (uses `sharp`, which ships with Next.js; it is not a dependency of this project) writes four WebP files per
race (quality 80, effort 6, Lanczos3 resize, aspect ratio unchanged, **never upscaled**; the 1086 px file is the native size encoded
without resizing). It prints the size and SHA-256 of every source and output. Re-running it produces byte-identical files.
`tests/unit/race-art.test.ts` pins the SHA-256, size and dimensions of all 40 outputs and the SHA-256 of the ten sources, checks the 3:4
ratio, the asset budget and that no PNG is committed.

| file | use |
|---|---|
| `<slug>-240.webp` | thumbnails on `/guides` (about 40 px wide) |
| `<slug>-540.webp` | race cards, phone hero |
| `<slug>-800.webp` | high-density cards, desktop hero |
| `<slug>.webp` | native 1086 px: high-density desktop hero |

| race | source file | source SHA-256 (first 16) | 240 px | 540 px | 800 px | 1086 px (native) |
|---|---|---|---|---|---|---|
| `human` | `Human.png` | `b8ee90006acafc42` | 21 KB | 84 KB | 156 KB | 232 KB |
| `dwarf` | `dwarf.png` | `a3ea35ea1c71f422` | 22 KB | 94 KB | 176 KB | 272 KB |
| `night-elf` | `night-elf.png` | `0c55d7d4d5b70b09` | 23 KB | 101 KB | 190 KB | 290 KB |
| `gnome` | `gnome.png` | `9abab9f61331cafb` | 24 KB | 101 KB | 184 KB | 272 KB |
| `high-order-skyborne` | `High-Order-Skyborne.png` | `0e304a4ae08053f4` | 27 KB | 113 KB | 211 KB | 326 KB |
| `orc` | `orc.png` | `40fc3e9fdb328b44` | 23 KB | 94 KB | 173 KB | 256 KB |
| `tauren` | `tauren.png` | `66f22141cecfe66a` | 24 KB | 108 KB | 201 KB | 305 KB |
| `troll` | `troll.png` | `c730bc02c91f50f4` | 27 KB | 122 KB | 229 KB | 343 KB |
| `undead` | `undead.png` | `a4a945a5b8ab2935` | 23 KB | 101 KB | 188 KB | 283 KB |
| `windshaper-skyborne` | `Windshaper-Skyborne.png` | `6f5d729cd6a6cefe` | 27 KB | 111 KB | 205 KB | 304 KB |
| **total** | | | 240 KB | 1031 KB | 1914 KB | 2884 KB |

All 40 files: **5.9 MiB** (the ten source PNGs were 28.8 MB; the nine class cards are 1.9 MiB for comparison).
The largest single file is 343 KB.

## Where it is used

- `RaceCard` (`/guides/races`): the picture at its own 3:4 with a dark information footer, `sizes="(min-width: 1280px) 236px, (min-width: 1024px) 380px, (min-width: 640px) 46vw, 92vw"`, lazy.
- `RaceHero` (`/guides/races/[race]`): a clipped banner like `ClassHero`. Desktop: picture on the right half, fading into the dark, text on the left. Phones: the picture is a 5:6 block above the text so no text lies on the artwork. Eager, `fetchpriority="high"`. Per-race `object-position` in `RACE_HERO_POSITION` (`src/lib/races/art.ts`).
- `RaceGuidesEntry` (`/guides`): 40 px thumbnails from the 240 px files (same artwork, no separate collection).
- `ClassTile` (race pages, "Available classes"): reuses `classCardArt()` / `classIconPath()` / `HERO_ART_POSITION` from `src/lib/classes/art.ts` and the class colours; no class image was added or copied.

All pictures are decorative (`alt=""`, `aria-hidden`): the adjacent text names the destination. The page behind each image is dark (`bg-ink-950`)
so a slow or failed load still reads correctly.

Caching: same as the other `public/` images (default Next.js revalidation with ETags; file names are not versioned, so no `immutable` header).

Screenshots (before and after, desktop and phone) are in `docs/screenshots/race-art/`.
