# Blizzard game content on AzerDex - notice, provenance and licence separation

AzerDex is an independent, free-to-access, non-commercial fan website for World of Warcraft: Forever. It is **not** an official
Blizzard product and is not affiliated with or endorsed by Blizzard Entertainment, Inc.

## What is Blizzard's

World of Warcraft and related names are trademarks or registered trademarks of Blizzard Entertainment, Inc.
(c) Blizzard Entertainment, Inc. All rights reserved. The following shown by AzerDex are Blizzard's property and AzerDex claims no
rights to them:

| Content | Where | How AzerDex got it |
| --- | --- | --- |
| Talent names, ranks, positions, prerequisites, tier gates (game data) | `web/src/data/talents/forever/<build>/<class>.json` | Read from the Forever client's tables by the Everloot project (pinned commit in `manifest.json`) |
| Talent description text and numbers | `.../text.json` | Description templates and per-rank values read from the owner's installed Forever client (read-only; no encrypted block decrypted), proven against Everloot's text hashes |
| 358 talent spell icons | **not in this repository**; served from the asset host under `talent-icons/<build>/<FileDataID>.webp` | Extracted from the owner's installed Forever client (CASC) as BLP files and **technically converted** to lossless 64x64 WebP for browser compatibility; each WebP is pixel-identical to its BLP source. `icons-inventory.json` records sha256 hashes only |
| Zone map images | asset host | Game client, see `third-party-map-atlas-notice.md` |

No Blizzard artwork is sold, and AzerDex does not claim ownership of any of it. The images identify talents inside a game reference tool.

## Licence separation

The repository's own software licence covers AzerDex's code and its original content only. It does **not** cover Blizzard's game
content listed above, which stays Blizzard's. Third-party tools (Everloot, AGPL-3.0 code with Blizzard data; TalentForge, no licence,
used only for cross-checking; the WDC5 reader and CASC export used for the owner's package, not in this repository) are credited in
the manifests and are not redistributed here.

## Attribution shown on the site

- Site footer (every page): independent, free, non-commercial fan project; not affiliated with or endorsed by Blizzard; trademark and
  (c) notice; Blizzard's ownership of map images, talent names, descriptions and icons.
- Class Guides calculator source note: build, extraction source and the same ownership/non-affiliation statement.

## Blizzard's published terms (what could be verified)

Primary references named by the owner (2026-10-28):

- Blizzard Legal FAQ, entry "What is Blizzard Entertainment's copyright/trademark policy for the Internet, specifically for fansites?"
  (<https://www.blizzard.com/en-sg/legal/c1ae32ac-7ff9-4ac3-a03b-fc04b8697010/blizzard-legal-faq>)
- Blizzard Entertainment Trademark Usage Guidelines
  (<https://www.blizzard.com/en-us/legal/38fd0408-8431-469a-99bc-2cd9eb9462c8/blizzard-entertainment-trademark-usage-guidelines>)

**Verification limit.** `www.blizzard.com` did not resolve from the build environment, so the pages were not read directly. What was
confirmed is from search-engine excerpts of those pages and of the same FAQ in other regional versions, and is recorded here as
excerpts, not as the authoritative text:

- The FAQ describes a **personal, non-exclusive, non-transferable and non-assignable licence** to use and display Blizzard material
  "for home, noncommercial and personal use only", on condition that copyright and other notices stay intact, and Blizzard may revoke
  it at any time.
- The Trademark Usage Guidelines allow use of Blizzard marks for non-commercial purposes in the activities they list (fan sites are
  one), require notices/credit lines (for example the (R)/TM mark on first use), forbid implying affiliation or endorsement, and
  discourage product names in domain names.

**What this means for the proposed use, stated precisely.** The conditions AzerDex can and does meet are: non-commercial, free access,
notices and credit retained, a visible unofficial/non-affiliation statement, no claim of ownership, no sale of Blizzard art. The one
point the excerpts do not settle is whether the FAQ's licence wording ("home ... personal use") extends to **public hosting of assets
extracted from an installed client and converted from BLP to WebP**; the excerpts neither grant nor prohibit that specifically, and no
clause prohibiting format conversion was seen. The project owner has authorised the publication on this basis (2026-10-28) and
accepts that Blizzard may revoke the permission. If Blizzard objects, remove `talent-icons/*` from the asset host (the calculator then
falls back to name plates by itself) and set `AZERDEX_TALENT_ICONS` to anything but `cdn`.

**To close the verification gap:** allow `www.blizzard.com` in the environment's network settings so the two pages can be read in full,
or paste the FAQ entry; then replace the excerpts above with the verbatim conditions and the date read.
