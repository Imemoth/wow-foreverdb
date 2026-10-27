# Class Guides & Talent Calculator (V1)

Public, login-free pages under the Guides section:

| Route | What |
| --- | --- |
| `/guides/classes` | All nine classes |
| `/guides/classes/[class]` | Class page: intro, specializations (talent trees), the talent calculator |
| `/guides/classes/[class]/[spec]` | A specialization guide (only where one exists; today `priest/shadow`) |

Everything is stateless and client-side: a build lives in the page URL (`?b=<code>`), there is no backend, table or account.

## Data: what it is and where it comes from

- **Dataset:** `web/src/data/talents/forever/<build>/<class>.json` (+ `manifest.json`), schema `azerdex.talent-class/1` (`src/lib/talents/types.ts`, validated by `schema.ts`).
- **Current build:** WoW: Forever **1.60.1.70630** (beta client). All nine classes, 27 trees, 466 talents.
- **Source:** the [Everloot](https://github.com/Everloot/everloot) talent catalog (`web/src/data/game-data/talents/<class>.json`, pinned commit in the manifest), read by that project from the client's trait tables. Converted mechanically by `web/scripts/import-talent-catalog.mjs`; the manifest holds the sha256 of every source and output file.
- **Cross-check (2026-10-27):** compared with an independent extraction of the previous build (1.60.1.70532, from wago.tools DB2 exports): 465 of 466 talents match on id, name and maximum rank; the differences are the 70532→70630 changes recorded in Everloot's change log (nodes added/removed, one rank change).
- **Rights:** the data is Blizzard's game data (names, ranks, grid positions, prerequisites). It is not covered by this repository's licence and carries a source note wherever it is shown. Everloot's catalog says the same about its copy. Review this before publishing outside the beta.

### What the data does and does not contain

Contains: talent name, spell id, tier/column, maximum rank, prerequisites, tier requirement, the point budget (51 points: one per level, levels 10-60).

Does **not** contain, and the UI says so instead of inventing it: **rank descriptions** and **icons** (both need the Forever client data, which was not reachable when this was built; see "Descriptions", "Icons" and "Verified vs unverified" below), and gameplay advice.

### Rules the calculator applies (and how sure we are)

| Rule | Status |
| --- | --- |
| 51 talent points shared by all three trees | From the client's point-level table |
| A tier needs `5 x row` points spent in the same tree on the rows above | Amount from the client data (every gated talent); "counted per tree" confirmed for most tiers |
| 35 talents carry an `assumed-tree` gate | The client gives the amount, not where points are counted (the extractor labels it "unconfirmed"). Applied per tree and flagged with a dagger in the UI. If a later build confirms or changes it, only the importer output changes |
| Prerequisite = the required talent at **full rank** | Conventional reading, **not confirmed** for Forever (also noted in the UI/guide) |
| "any" prerequisites = at least one of the listed talents | From the client's edge types ("sufficient" vs "required") |
| A point can be removed only if the remaining build is still reachable by legal single-point additions | Our rule; also handles edges that point both ways in the data (e.g. Hunter Intimidation / Bestial Wrath) |

## Updating the talent data

```bash
git clone --depth 1 https://github.com/Everloot/everloot /tmp/everloot-src      # or any checkout of the catalog
git -C /tmp/everloot-src rev-parse HEAD                                         # pin this sha
cd web
node scripts/import-talent-catalog.mjs /tmp/everloot-src/web/src/data/game-data/talents --commit <sha>
# writes src/data/talents/forever/<build>/ ; then point src/lib/talents/registry.ts at the new folder
npm test                      # tests/unit/talents-data.test.ts re-checks every invariant
```

Then update the E2E canaries in `tests/e2e/talents.spec.ts` (they name real Priest talents) and, if talent names changed, `PriestShadowGuide`. Old build codes stop working on purpose: the code embeds a hash of the layout and is refused on mismatch.

Descriptions, icons and art have their own refresh flow, below. A new build means: regenerate the structure, then regenerate (or empty) `text.json` and `icons.json` for **that** build. Overlays stamped with another build are ignored on purpose.

To add another game version, add a new folder and a second registry (the class pages are written against `TalentClassData`, not against a build).

## Adding a class or talent tree

All nine classes ship. A class missing from `registry.ts` renders "Talent data not available yet" (no tree) and is `noindex`; nothing else needs changing. Class identity (name, colour) lives in `src/lib/classes/classes.ts`; spec URL segments default to the tree's slug, with explicit aliases in `SPEC_ALIAS` (e.g. `priest/shadow-magic` → `shadow`).

## Adding a specialization guide

1. Write a body component next to `src/components/classes/guides/PriestShadowGuide.tsx` taking `GuideBodyProps` (`data`, `tree`, `calculator`).
2. Register it in `src/components/classes/spec-guides.tsx` under `"<class>/<specSlug>"`.
3. That is all: the route, class-page link, sitemap entry and metadata come from the registry.

**Content rule:** state only what the data (or another verified Forever source) supports. Compute facts from `data`/`tree` instead of typing numbers, and mark what cannot be verified as such (see the Shadow guide). Do not copy Classic-era behaviour or other sites' text.

## Build codes

`?b=<layoutHash>.<tree1>-<tree2>-<tree3>`: one digit per talent in data order (row, column), trailing zeros trimmed. Decoding validates format, layout hash, ranks and legality (tiers, prerequisites, budget) and either restores the whole build or refuses it with a message. The address bar always equals the current share link.

## Interaction and the tooltip model

Two **independent** states:

| State | Set by | Shown as | Cleared by |
| --- | --- | --- | --- |
| **Hover** (`hoverId`) | Mouse/pen pointer over a talent. Touch never sets it (no hover; an emulated enter would stick) | Floating tooltip (md and up), the full talent card | Pointer leaving the talent (immediately), `Escape`, Reset |
| **Selected** (`selectedId`) | Click/tap, a refused click on a locked talent, keyboard focus, the Add/Remove buttons | The bottom detail panel only: the full card plus **Remove / Add** buttons. Sticky while something is selected | `Escape`, Reset |

- The tooltip never depends on selection or focus, and selecting never opens or keeps a tooltip. Hovering talent B while A is selected shows B's tooltip and leaves A in the panel.
- `Escape` is handled by a document-level listener that exists only while a tooltip or selection exists, so a hover-only tooltip closes even when keyboard focus is elsewhere.
- Click/tap/Enter/Space adds a point; right-click, Shift+click, Backspace/Delete or the panel's **Remove** removes one. Arrow keys move between talents (one tab stop per tree). Keyboard focus selects (inspects) without spending points.
- A mouse press does not focus the talent on mousedown (that would swap the panel to its sticky overlay mid-click and could swallow the click); the click handler selects and then focuses the talent so Backspace/arrows keep working.
- Status changes go to a polite live region. No inline styles are used (page CSP); grid placement uses literal Tailwind classes. The tooltip is hidden below `md`; touch uses the panel.

## Descriptions (rank text)

- **Format:** `src/data/talents/forever/<build>/text.json`, schema `azerdex.talent-text/1`: `{ build, source: { name, reference, extractedAt }, talents: { "<talentId>": { descriptions: [rank 1.. rank N] } | { description } } }`. Text must be **resolved** (no `$s1`-style tokens): token resolution is the extractor's job.
- **Merge rules** (`src/lib/talents/text.ts`, tested): the overlay is used only if `build` equals the dataset build; otherwise it is ignored as a whole (reported as "mismatch" in the source note), never mixed in. Per talent, `descriptions` must have exactly `maxRank` non-empty entries, else a single non-empty `description` is used, else the talent keeps the honest "not yet verified" message. Text is rendered as plain text.
- **Display:** per-rank text shows the current rank and "Next rank:" (or "Rank 1:" at rank 0); a single description is shown as is; the source note reports source, build, extraction date and coverage.
- **Source policy:** the same Forever client build as the tree (`Spell.Description_lang` with rank-specific spell effects resolved), or official Blizzard publications that explicitly match that build. Third-party tooltips for other builds (e.g. 1.60.1.70532) may help cross-checking but are never presented as verified for the current build. Never import scraped guide prose. Record source, build, extraction date and the redistribution review.
- **Status today:** `text.json` is an empty placeholder (`build: null`). No build-matched, redistributable description text was obtainable: the Blizzard CDN and the data sites were unreachable from the build environment, and Everloot's published catalog deliberately omits text.

## Icons

- **Policy:** `docs/web/maps-and-assets.md` lists Blizzard spell icons as not licensed for AzerDex, and Blizzard-owned assets stay **out of git**. So icons can only come from the allow-listed asset host and are **off by default**.
- **Switch:** `AZERDEX_TALENT_ICONS=cdn` **and** `NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL=https://<allow-listed host>` (`src/lib/maps/asset-url.ts`). Anything else (unset, other value, non-allow-listed or same-origin base) means no icons. The CSP gains that origin in `img-src` **only** when the switch is on (`talentIconImgOrigin`, `buildPageCsp`).
- **Manifest:** `icons.json`, schema `azerdex.talent-icons/1`: `{ build, icons: { "<spellId>": <iconFileDataId> } }`. URLs are `<base>/talent-icons/<build>/<fileDataId>.webp`. The manifest is used only if `build` equals the dataset build.
- **Rendering:** `NodeFace` shows the icon with the name on a strip; a missing URL, a failed request or a broken image falls back to the plain name plate (also pre-hydration errors are caught). The tooltip and the panel header show a small icon with the same fallback. Icons are decorative (`alt=""`); the name is always real text.
- **Status today:** `icons.json` is an empty placeholder. No icon files or ids were obtainable here, and nothing is uploaded to a host.

## Background art

- **Original vector art, project-owned** (`src/components/classes/backdrops.tsx`): a class-coloured glow plus one line-art motif per class (hero, cards) and per talent tree (a themed motif chosen from the tree's name, e.g. vortex for Shadow Magic, rays for Holy; the table is `TREE_MOTIF`, tested to cover all 27 trees). Plain inline SVG like the Arcane Library banner: no raster file, no Blizzard artwork, no new dependency.
- **Where:** class page hero, each talent tree panel, and the class cards on `/guides/classes`.
- **Safety:** `aria-hidden`, `pointer-events: none`, clipped by its own container (so tree panels do not clip tooltips and no stacking context is created), low strength plus a dark scrim so text and nodes keep their contrast. Content sits above it (`relative`).
- **Raster art later:** AzerDex's own precedent is owner-approved raster art with a provenance record (`docs/azerdex-library-art/provenance.md`, files under `web/public`). If the owner supplies themed art, replace `ClassBackdrop`'s internals (keep the props and `data-testid`s) and add a provenance record. Blizzard art would additionally need the asset-host route above and an owner decision (see maps-and-assets.md).

## What is build-specific, and what is verified

| Item | Build-specific? | Status |
| --- | --- | --- |
| Talent structure, ranks, positions, prerequisites, gates | Yes (1.60.1.70630) | Client-extracted by Everloot, cross-checked against an independent extraction of the previous build |
| Point budget, tier rule amounts | Yes | From the client data |
| Gate scope for 35 talents; full-rank prerequisites | Yes | **Inferred, not confirmed in game**; flagged in the UI |
| Rank descriptions | Yes (`text.json.build` must match) | **Unverified / absent** |
| Icons | Yes (`icons.json.build` must match; URL contains the build) | **Absent** |
| Background art | No (original, build-independent) | n/a (decorative) |
| Class colours, names, motifs, copy | No | Fixed facts / decorative |

## Verified vs unverified

Verified (data-backed): everything in the first two rows above; the Shadow guide's numbers (computed from the data). **Unverified or absent:** descriptions, icons, the two inferred rules, and all gameplay claims (playstyle, strengths, weaknesses), which the guide states as "not verified yet".

## Refreshing for a new build

1. Regenerate the structure (see "Updating the talent data"); point the registry at the new folder.
2. Extract resolved description text and icon file ids **from the same client build** (the Everloot-style extractor `client-extract` / `client-assets` flow is the model; it needs the client CDN). Write `text.json` and `icons.json` stamped with that build.
3. Upload the icon files (never to git) to the allow-listed asset host under `talent-icons/<build>/<fileDataId>.webp`, and set `AZERDEX_TALENT_ICONS=cdn` for the deployment (owner decision; see Icons).
4. `npm test`: the overlay tests assert that shipped overlays are empty or match the dataset build; diff the per-rank text against the previous build before publishing.
5. Update the E2E canaries and the Shadow guide if names changed.

## Tests

- `tests/unit/talents-engine.test.ts`, `talents-build-code.test.ts` - rules and codec on a small synthetic fixture (never shipped).
- `tests/unit/talents-data.test.ts` - schema, structure, tier rule, reachability of every talent, point budget, manifest hashes for all nine classes.
- `tests/unit/classes.test.ts` - registry, copy and the rendered Shadow guide.
- `tests/unit/talents-overlays.test.ts` - build-guarded text merge, icon resolution and CSP origin, card rendering of descriptions/icons, backdrop theme coverage.
- `tests/e2e/talents.spec.ts` - navigation, allocation/removal, max rank, tiers, prerequisites, shared budget, reset, share/restore, invalid links, keyboard, the hover-vs-selected model, descriptions and icons (via the E2E-only `/test-fixtures/talents` page, which overlays *synthetic* text and icons on the real Priest tree), backgrounds, axe, mobile/touch. Also covered by the shared a11y/responsive specs.
