# Class art (Guides navigation and class cards)

Two sets of same-origin static assets under `web/public/`, both served by Next.js/Vercel (no CDN, no Cloudflare deployment, nothing to configure; the page CSP needs no change).

## `class-icons/<class>.webp` - Guides landing page navigation

Nine original AzerDex-themed class emblems, 128x128 WebP, used by `ClassGuidesEntry` (the compact row under the search panel on `/guides`) at 36-40 CSS px inside >=44px links. They are generated artwork, not Blizzard class icons or client textures. SHA-256 values come from the icon package's `manifest.json` and are pinned in `tests/unit/class-art.test.ts`.

## `class-cards/<class>.webp` and `<class>-640.webp` - Choose your class

The owner-supplied, owner-approved character illustrations (not regenerated or altered apart from resizing/encoding). Each source was identified by its content (Druid: antlered night-elf-style druid with a bear; Hunter: bow and wolf; Mage: arcane robes and spell rings; Paladin: hammer, shield and lion tabard; Priest: golden staff and radiant light; Rogue: hooded dual-wielder; Shaman: horned tauren with lightning; Warlock: fel flames and demons; Warrior: spiked orc with an axe) and matched to the file name given by the owner; none was ambiguous.

Each is encoded twice at the original aspect ratio (WebP, quality 80): 1024 px wide for the `srcset`'s large entry and 640 px wide for small screens. The card shows a 4:3 window (`object-fit: cover`) steered per class by `CARD_ART_POSITION` in `src/lib/classes/art.ts`, so faces, weapons and signature armour stay in frame. The original PNGs (about 2.5-3.1 MB each) are not in the repository.

| file | size |
|---|---|
| `druid-640.webp` | 67 KB |
| `druid.webp` | 140 KB |
| `hunter-640.webp` | 77 KB |
| `hunter.webp` | 168 KB |
| `mage-640.webp` | 75 KB |
| `mage.webp` | 153 KB |
| `paladin-640.webp` | 79 KB |
| `paladin.webp` | 166 KB |
| `priest-640.webp` | 60 KB |
| `priest.webp` | 123 KB |
| `rogue-640.webp` | 43 KB |
| `rogue.webp` | 93 KB |
| `shaman-640.webp` | 62 KB |
| `shaman.webp` | 133 KB |
| `warlock-640.webp` | 56 KB |
| `warlock.webp` | 115 KB |
| `warrior-640.webp` | 69 KB |
| `warrior.webp` | 143 KB |

Cards are `<li>` blocks: the class name is a link whose `::after` covers the card (so the whole card opens the class page) and "Talent calculator" is a separate link above it; no link is nested in another. A dark gradient covers only the lower 60% where the text sits. Hover zooms the art by 3% (not with reduced motion); keyboard focus draws a violet ring around the whole card.

Caching: same behavior as the other `public/` images (Next.js default revalidation with ETags); file names are not versioned, so no `immutable` header is set.

Copyright: the Blizzard-related notices in the site footer are unchanged.
