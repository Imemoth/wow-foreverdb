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
- **Current build:** WoW: Forever **1.60.1.70634** (beta client). All nine classes, 27 trees, 466 talents. The previous dataset was 1.60.1.70630; see "Build 70630 to 70634" below for why the move is justified and how old share links keep working.
- **Source:** the [Everloot](https://github.com/Everloot/everloot) talent catalog (`web/src/data/game-data/talents/<class>.json`, pinned commit in the manifest), read by that project from the client's trait tables. Converted mechanically by `web/scripts/import-talent-catalog.mjs`; the manifest holds the sha256 of every source and output file.
- **Cross-check (2026-10-27, for the previous build):** compared with an independent extraction of the previous build (1.60.1.70532, from wago.tools DB2 exports): 465 of 466 talents match on id, name and maximum rank; the differences are the 70532→70630 changes recorded in Everloot's change log (nodes added/removed, one rank change).
- **Rights:** the data is Blizzard's game data (names, ranks, grid positions, prerequisites). It is not covered by this repository's licence. The Blizzard copyright, trademark and non-affiliation notice is in the site footer on every page, and the provenance (build, extraction sources) is on `/about/data#class-guides`; the calculator pages no longer carry a technical source panel. Everloot's catalog says the same about its copy. Review this before publishing outside the beta.

### What the data does and does not contain

Contains: talent name, spell id, tier/column, maximum rank, prerequisites, tier requirement, the point budget (51 points: one per level, levels 10-60).

Descriptions (`text.json`) and icon ids (`icons.json`) are optional, build-stamped overlays; see "Descriptions", "Icons" and "Coverage". For build 70634: **466 of 466 talents** have a verified description, **363** with every number resolved (1052 of 1313 ranks); the remaining numbers are marked "?" with a reason. **466 of 466 talents** have a validated icon id (358 distinct images); the images themselves are not in this repository and are shown only when the asset host serves them and the switch is on. Gameplay advice is not included.

### Build 70630 to 70634

The calculator moved from 1.60.1.70630 to **1.60.1.70634** because both the owner's local client export and Everloot's own CDN-based extraction are 70634, and the evidence below shows nothing the calculator uses differs. Nothing was relabelled: every dataset carries the build it was read from.

- Everloot's 70634 catalog and `spell-values.json` (commit `d4a225e4`, generated from Blizzard's public CDN) differ from its 70630 files **only in the build stamp**; its change record for 70634 lists no talent, rank, gate, prerequisite or spell-value change.
- Everloot's per-table client digests (330 tables) are identical for 70630 and 70634 except three `UiTextureAtlas*` tables. That includes `Spell`, `SpellEffect`, `SpellDuration`, `SpellAuraOptions`, `SpellName`, **`SpellMisc`** (where the icon ids live), `TraitDefinition`, **`TraitDefinitionEffectPoints`**, `TraitNode`, `TraitNodeEntry`, `TraitEdge` and `TraitTree`. `Curve` and `CurvePoint` are not digested by Everloot, so the rank curves of 70630 specifically cannot be proven from digests; they are used here only as the same-build values of 70634.
- `import-talent-catalog.mjs --previous <70630 output> --layout-compatible 1.60.1.70630` compared every class, tree and talent (ids, names, spell ids, positions, ranks, gates, prerequisites) and found **no difference**; only then did it add `build.layoutCompatibleWith: ["1.60.1.70630"]` to the data. The importer refuses the flag on any difference.
- **Share links:** the layout hash includes the build string, so 70634 links carry a new hash. `decodeBuild` also accepts the hash of any build listed in `layoutCompatibleWith`, so links shared for 70630 still decode (tested with the 70630 hashes pinned as literals). A link from any other build is still refused.

## Updating the talent data

```bash
git clone --depth 1 https://github.com/Everloot/everloot /tmp/everloot-src      # or any checkout of the catalog
git -C /tmp/everloot-src rev-parse HEAD                                         # pin this sha
cd web
node scripts/import-talent-catalog.mjs /tmp/everloot-src/web/src/data/game-data/talents --commit <sha>
# add  --previous src/data/talents/forever/<old build> --layout-compatible <old build>  when the layout is unchanged (the importer proves it)
# writes src/data/talents/forever/<build>/ ; then point src/lib/talents/registry.ts at the new folder
npm test                      # tests/unit/talents-data.test.ts re-checks every invariant
```

Then update the E2E canaries in `tests/e2e/talents.spec.ts` (they name real Priest talents) and, if talent names changed, `PriestShadowGuide`. Old build codes stop working on purpose when the layout changed: the code embeds a hash of the layout and is refused on mismatch. When it did not change, declare it with `--layout-compatible` (see above).

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
- **Node states and geometry (UI V2.1):** each talent is one square frame (46px on desktop, 42px on phones, thin 1px border, quiet glow) centred in a `--cell` grid cell (68px on desktop / 60px on phones, i.e. 11-9px of air around each frame). The talent button is the **whole cell**, so the hit area is at least 44x44px by construction; the frame is drawn inside it and connectors are drawn in cell units, so they always end on the frame centres at any size. Trees are fixed-size and centred in their panel, so the three trees of a class line up. The state is carried by more than colour: *available* (gold frame, bright icon), *in progress* (violet frame, small violet glow and badge), *maxed* (brighter gold frame, solid gold badge), *locked* (dark frame, desaturated icon, a small lock glyph, a low-contrast badge) and *waiting* (no points left: muted). The rank badge (`0/5`, 10px tabular figures) is a small corner mark attached to the bottom-right of the frame and always stays inside its cell, so badges and frames of neighbours can never overlap. Selection is a separate parchment ring on the frame, independent of the state. With an icon the artwork fills the frame (no text strip over it; the name is the button's accessible name, the tooltip and the panel); without an icon the name plate fills it. A light legend lists the states; the full keyboard/mouse instructions are in a **How to use** disclosure next to it, with one concise hint always visible. Prerequisite lines are thin (a met requirement is a solid gold line, an unmet one a faint dotted line) and the lines touching the selected or hovered talent turn violet and heavier. The class chooser, the guides entry and the sitemap list classes alphabetically.
- **Tooltip and panel (UI V2.1):** one card, two variants. The **panel** (`TalentCard variant="panel"`) is compact and dismissible: on desktop one header row (icon, name, tree and tier, a `Rank r/max` summary with pips, **- Remove / + Add**, a close button) over a two-column body (description with current and next rank on the left, requirements, status and spell id on the right). It sticks to the bottom of the screen while a talent is selected, never takes pointer events outside its own card, closes with its x button (focus goes back to the talent without re-selecting it) or `Escape`, and scrolls inside only when needed. On phones it is a **bottom sheet**: collapsed it shows name, rank and the Add/Remove buttons (all controls at least 44px; the trees stay usable), the chevron expands it to the full details (`aria-expanded`), and it sits above the safe area. The **tooltip** is hover-only, a fixed 288px wide, nudged back into the viewport at any edge, shows the current rank, the next rank as secondary text, requirements, status, and a quiet spell id. Unresolved values are quiet dotted-underline "?" marks (the reason is their accessible name); the panel adds one line and a collapsed "Why?", the tooltip a one-line note.
- Status changes go to a polite live region. No inline styles are used (page CSP); grid placement uses literal Tailwind classes. The tooltip is shown only in the wide panel mode (below); touch uses the panel.
- **Responsive layout (phones, tablets, desktop):** tree columns follow the width at which complete trees fit, not device names. A tree card needs 298px (four 68px cells + padding + border; `warlock/destruction` has three columns, the other 26 trees four, all seven rows), the main column is the viewport minus 2rem (max 80rem), so: **one centred card per row below 644px** (at most 22rem, 60px cells / 42px frames below 640px), **two from 644px** (iPad mini portrait 768, iPad Air 834, phone landscape 956; the third tree is centred under them) and **three from 960px** (iPad mini landscape 1024, desktop). Positions, prerequisites and the artwork are unchanged (`sizes` of the tree picture now describes the narrower cards). On phones (< 640px) a plain in-flow `spec-nav` row of anchor links jumps to each tree (native scrolling, focus moves to the tree heading, no `#hash` is written into the shareable URL, nothing fixed, all trees stay mounted).
- **Panel modes:** two complementary custom variants in `globals.css` choose how the detail panel behaves, by input and room instead of `md`: **`wide`** = fine pointer (mouse/trackpad) and at least 48rem x 35rem: always the full details, no expand button, hover tooltips, 40vh cap; **`sheet`** = everything else (phones, tablets and other coarse-pointer devices, narrow or short windows): a compact bottom sheet that starts collapsed (icon, name, rank, Remove/Add, expand, close; one row from 640px, so also on a landscape phone), expands to at most **44dvh** with the card scrolling inside, with every control at least 44x44px, `aria-expanded`/`aria-controls` on the toggle, and bottom safe-area spacing. After a talent is selected or the sheet grows, the page scrolls only as far as needed so the selected talent is not under the panel. Disabled Add/Remove differ by a dashed border and muted fill, not only opacity. Tooltips never open for touch.
- Verified in `tests/e2e/responsive-calculator.spec.ts`: 320x700, 390x844, 440x956, 956x440, 768x1024, 1024x768, 834x1194 and 1440x900 across all nine classes / 27 trees (columns, centring, no overflow, nothing clipped, artwork fills the card un-stretched and loaded), plus touch, keyboard, shared-link, axe and quick-navigation tests.

## Descriptions (rank text)

### What is shown

`src/data/talents/forever/<build>/text.json` (schema `azerdex.talent-text/2`) holds, per talent, the **client's own description template rendered with the numbers the data proves**. A value that cannot be filled in is kept as an explicit gap `{ g: "$m1", c: "spell" }` with a stable reason code and shown as a labelled **?** (never a guess). Text that differs per rank is stored per rank; the tooltip and the panel show the current rank and the next one ("Rank 1:" before the first point), like the game.

| Code | Meaning (shown to the user via `GAP_TEXT`) |
| --- | --- |
| `curve` | The talent's per-rank value (`TraitDefinitionEffectPoints` -> `Curve`/`CurvePoint`) is missing for that rank. |
| `spell` | The number belongs to another spell (`$12345s1`, `$12345d`, `$@spelltooltip...`) whose rows are not in the available data. |
| `proc`, `named`, `conditional`, `plural`, `effect`, `dice`, `zero`, `expr` | Proc data (`$h`, `$n`), named variable (`$rap`, `$<minDam>`), player-state conditional, plural of a missing number, missing effect/period/radius/duration, die range with an unverified display rule, a 0 in the spell table whose number lives elsewhere, expression over unavailable values. |

### How a description is accepted (`scripts/import-talent-text.mjs`)

1. **Template proof.** The raw client text must reproduce the target build's own text hash `sha256(description + "\0" + aura description)[0:12]` (Everloot records it per spell in `spell-values.json`). The earlier importer hashed the description alone, so the 60 talents that have aura text failed; it now hashes both, strictly. A template that does not reproduce the hash is **not shown**.
2. **Definition link.** A talent's per-rank values come from its trait definition. The talent -> definition link is taken from the **target build's catalog** (`definitionId`), never from the extraction's own best-effort choice (that choice differed from the catalog for 4 talents; 68 were only heuristic). The catalog's definition must be present in the extraction.
3. **Values.** Spell-row numbers come from the target build's `spell-values.json`. Per-rank (curve) values come from the extraction's `TraitDefinitionEffectPoints` -> `Curve`/`CurvePoint` for that definition, and are used **only when the extraction is of the dataset's own build** (`--templates-build` equals the dataset build); a template source of another build keeps curve effects as gaps and additionally needs `--spell-values-prev` proving the spell rows unchanged. A rank missing from a curve stays a gap (Rogue "Cutthroat" lacks ranks 4 and 5 of its second curve: not inferred).
4. **Own resolver.** `src/lib/talents/tooltip.ts`, shared by the importer and the site; no code from other projects.
5. **Whole-result validation, atomic write.** Ids, spell ids, hashes, segment shapes, gap codes, no leaked `$` syntax, 466 talents. On any failure nothing is written. Output is deterministic.

### Independent checks of the shipped text (reproduced 2026-10-28)

- **466/466** raw description+aura hashes equal Everloot's `textHash` for **both** 70630 and 70634 (the two files differ only in the build stamp). 406 match on the description alone; the 60 with aura text need both.
- **466/466** talents match the AzerDex dataset and Everloot's 70634 catalog on node id, spell id, max rank and name.
- Basic effect fields (base points, period, die sides, effect index set) of the extraction equal Everloot's spell values for **466/466**. Duration, chain targets and radius are not in the export, so they are covered only by the identical `Spell`/`SpellEffect`/`SpellDuration` digests above.
- **Rank-by-rank comparison with an independent renderer** (TalentForge's resolved 70532 tooltips, a different parser on a different build): 1005 comparable ranks of 454 talents, **999 identical**. The 6 differences are two talents whose per-rank values differ between the builds and nothing else: Mage "Elemental Precision" (5 to 3 ranks, listed in Everloot's 70630 change record) and Priest "Champion of the Light" (curve 10/20/30 to 20/40/60, consistent with the `TraitDefinitionEffectPoints` digest differing between 70532 and 70630). Curve series compared with TalentForge's 70532 per-definition values: 515 identical, the same 2 different.
- The extraction's `candidateDefinitionId` and 2 of its `candidateCurves` were not used where they disagreed with the catalog's definition.

### Merge and display

- `src/lib/talents/text.ts` merges the overlay only if its `build` equals the dataset build (else "mismatch", ignored as a whole); each entry must belong to the talent (same spell id, valid hash, 1 or `maxRank` texts, known gap codes) or it is skipped. The merge never changes `id` or `maxRank`, so **build codes stay valid** (tested).
- **Tooltip and panel** (`TalentCard`): the hover tooltip (hover only, no sticky state) and the selected-talent panel show the same text; a legend explains each "?".
- **Publication gate:** the text is Blizzard game text. It is merged everywhere **except a production deployment**, where it is withheld unless `AZERDEX_TALENT_TEXT=1` (`talentTextPublished`). See "Publication and rights".

### Provenance of the shipped overlay

Per-rank values and raw templates: the owner's local export of the installed WoW: Forever client (`DBFilesClient.zip`, sha256 `b51d718c9584ef97e3b96ef40b5dd6330277aff858529fd2049857a04bce3cd8`; ten WDC5 tables decoded read-only, no encrypted section decrypted; the build **1.60.1.70634 is the one the installed client reported** - DB2 headers do not state it - and is corroborated by the text/effect agreement with Everloot's CDN-derived 70634 data above). Spell values, text hashes and trait definition ids: Everloot @ `d4a225e44d4e798b814d1fe8acd5b37e6e2f49d1` (build 70634, extracted 2026-10-27T18:15:44Z from Blizzard's public CDN; encrypted blocks skipped). `text.json.source` records the sha256 of every input and DB2 table. The DB2 reader (`parse_wdc5.py`) and the extraction package are the owner's; they are not part of this repository.

### Coverage

`src/data/talents/forever/1.60.1.70634/COVERAGE.md` (and `coverage.json`) list **every one of the 466 talents** with node id, name, class/tree, spell id, ranks resolved and the exact reason, plus every other spell the unresolved numbers still reference. `tests/unit/talents-overlays.test.ts` asserts the report matches what is shipped. Summary for 1.60.1.70634:

| Metric | Count |
| --- | ---: |
| Classes / trees / talent nodes | 9 / 27 / 466 |
| Nodes with a verified description | 466 (100%) |
| Nodes where every rank is fully resolved | 363 (77.9%) |
| Ranks fully resolved | 1052 of 1313 (80.1%) |
| Ranks with an unresolved number | 261 (in 103 nodes) |
| Unresolved nodes by reason (a node can have several) | `spell` 91, `expr` 12, `proc` 7, `named` 6, `effect` 2, `zero` 1 |
| Curve (per-rank) gaps | 0 |

### What is still unresolved, and why

- **Other spells' values (`spell`, 91 nodes; 111 distinct referenced spells):** durations (`$12345d`), values (`$12345s1`) and descriptions of spells that talents trigger. The package's `supporting-spells.json` has rows for 53 of them, but only `basePoints`, `period` and `triggerSpell`: **no duration, die sides, radius or chain targets**, and no hash to verify it against. Because `$12345d` is the most common reference (68 tokens) and a die range would change how a value is printed, these are **not** resolved from it. To resolve them, extend the export to the full `SpellEffect`/`SpellDuration`/`SpellMisc` rows of the ids listed in `COVERAGE.md` (and ideally their text hashes) and add them as a spell-facts source to the resolver.
- **Expressions over those or over game variables (`expr`, 12):** e.g. `${$s1+($rap*($s4/100))}`, `${$proccooldown}`, `${$d-1}`.
- **Proc data (`$h`, `$n`, 7), named variables (`$<minDam>`, `$proccooldown`, 6), a missing effect (2: Shifting Power `$s2`, Piercing Howl `$a2`), and Improved Seal of Fury `$m1` (the spell row holds 0 and the talent has no curve).**

Nothing in this list is guessed; each shows as a labelled "?" in the tooltip and panel.

## Icons

- **Policy:** `docs/web/maps-and-assets.md` lists Blizzard spell icons as not licensed for AzerDex, and Blizzard-owned assets stay **out of git**. Icons come only from the allow-listed asset host and are **off by default**.
- **Switch:** `AZERDEX_TALENT_ICONS=cdn` **and** `NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL=https://<allow-listed host>` (`src/lib/maps/asset-url.ts`). Anything else means no icons. The CSP gains that origin in `img-src` **only** when the switch is on.
- **Manifest:** `icons.json` (`azerdex.talent-icons/1`: `{ build, icons: { "<spellId>": <FileDataID> } }`) and `icons-inventory.json` (sha256, size and dimensions of each image, and of its BLP source; **hashes only**). URLs are `<base>/talent-icons/<build>/<FileDataID>.webp`. A manifest is used only if its `build` equals the dataset build.
- **Status (1.60.1.70634):** **466 of 466 talents mapped, 358 distinct images.** Validated by `scripts/import-talent-icons.mjs` and reproduced independently on 2026-10-28:
  - mapping build equals the dataset build (the importer refuses to relabel); every talent's spell is mapped, to the **same** `SpellMisc.SpellIconFileDataID` the client export reports for that talent (0 disagreements; no spell has two icons);
  - the 358 distinct ids equal the 358 BLP exports, the 358 WebP files and the owner's inventory one-to-one; every WebP is 64x64, decodes, and its sha256 and size equal the inventory; every WebP is **pixel-identical** to its decoded BLP source (274 of the images use real alpha). The BLP sources were checked for the BLP2 signature and by decoding; the owner's package reports their CRC check.
  - `SpellMisc` is digest-identical in Everloot's 70630 and 70634 data, so the ids are the same for both builds.
- **What is NOT done:** no image is in git (a test fails if a `.blp` or `talent-icons/*.webp` is tracked), and nothing has been uploaded. Display needs the asset host to serve them; see "Publishing the icons".
- **Rendering:** `NodeFace` fills the square node frame with the icon; a missing URL, a failed request or a broken image falls back to the plain name plate. The tooltip and the panel header show a small icon with the same fallback. Icons are decorative (`alt=""`); the name is always real text.
- **Local rendering check (2026-10-28):** with `AZERDEX_TALENT_ICONS=cdn` and the asset host stood in by request interception serving the 358 files (the CSP stays on), all nine class pages rendered **466 of 466** talent icons at 64x64, requested 358 distinct URLs, raised no CSP violation, and an aborted icon fell back to its name plate. This proves the code path; it is not the CDN verification.

### Publishing the icons

The asset host is the existing Cloudflare Pages project `azerdex-assets` (allow-listed `azerdex-assets.pages.dev` / `assets.azerdex.com`). **The project owner authorised publication on 2026-10-28** (beta first; production variables stay unchanged). What is done and what is not:

- **Done (in this repository):** the packaging pipeline accepts `talent-icons/<build>/<FileDataID>.webp` (path convention, `_headers` block, exact file-set and per-icon hash/dimension checks, verify-remote contract, 17 new tests); the 358 supplied icons load and verify through it; the staging directory verifies offline (`verify-talent-icons-cdn.mjs --dir`, 358 of 358).
- **Not done: the upload.** It needs three things this build environment does not have: network access to `azerdex-assets.pages.dev` (the egress proxy refuses it), a Cloudflare credential able to deploy to the `azerdex-assets` Pages project (the connected Cloudflare tool exposes Workers/KV/R2/D1 only, not Pages deployments), and the owner's baseline zip `atlas-dist-1.60.1.70450.zip`, from which the complete snapshot is built (a Pages deployment replaces the whole file set, so an icons-only deployment would delete the maps and heroes). The exact commands are in [`map-atlas-cdn-deploy.md`](map-atlas-cdn-deploy.md#unified-snapshot--talent-icons-class-guides---build-and-upload).
- **Verify the live host:** `node web/scripts/verify-talent-icons-cdn.mjs --dataset web/src/data/talents/forever/<build> --base <origin>` (or Actions -> "Talent icons CDN read-only verification"): HTTP 200, `image/webp`, exact byte length and sha256 for every icon, a 404 control, cache headers. The `--base` must be an https allow-listed asset origin (no other host, port, credentials or path) and redirects are never followed; it never runs on pull requests.
- **Then, beta only:** set `AZERDEX_TALENT_ICONS=cdn` (the beta already has `NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL=https://azerdex-assets.pages.dev`), redeploy so the value is read, check the nine class pages (466 icons, hover tooltip, panel). **Production variables stay unset** until the owner decides.

## Publication and rights

Distinguish four things; none of them is licensed by this repository:

| Item | What it is | Status here |
| --- | --- | --- |
| Factual game data | Talent ids, ranks, grid positions, prerequisites, tier gates, spell ids, numeric values | Facts read from the client; still Blizzard's data. Shown with attribution. |
| Client-extracted description text | Blizzard-authored sentences (Forever's own wording, rendered with its numbers) | Blizzard copyright. **Gated**: shown on beta/preview/local, withheld on production unless `AZERDEX_TALENT_TEXT=1`. |
| Blizzard-owned artwork | The 358 spell icons (BLP converted to WebP) | Blizzard copyright. **Never in git; off by default; not uploaded.** Needs the owner's explicit publication approval. |
| Third-party extraction tools and data | Everloot (AGPL-3.0 code; its data is Blizzard's and says so), TalentForge (no licence; used only for cross-checking), the WDC5 reader and CASC export used for the owner's package (not in this repo), WoWDBDefs layouts | Used as references or tools; their code is not redistributed here. Credit them where they were used (see the source note and the manifests). |

- **Attribution shown on every page:** the site footer states that AzerDex is an independent, free, non-commercial fan project (owner-approved designation) not affiliated with or endorsed by Blizzard, carries the trademark and (c) Blizzard Entertainment, Inc. notice, and says that zone map images, talent and ability names, descriptions and icons remain Blizzard's property and that the class and race illustrations, emblems, tree backgrounds and homepage artwork are not game assets. The provenance (build, Everloot extraction, local client export, BLP to WebP conversion) is on `/about/data#class-guides`. The calculator no longer shows a technical source panel (UI V2).
- **Owner decision:** on 2026-10-28 the owner explicitly authorised publishing the 358 icons (and the description text) on AzerDex as a free, independent, non-commercial fan site, beta first. That is an implementation authorisation, not a licence from Blizzard.
- **Blizzard's terms:** the Legal FAQ entry on fan sites and the Trademark Usage Guidelines (links and the conditions that could be confirmed are in [`docs/third-party-blizzard-content-notice.md`](../third-party-blizzard-content-notice.md)). `www.blizzard.com` was not readable from the build environment, so only search-engine excerpts were confirmed: a personal, non-exclusive, non-transferable licence for "home, noncommercial and personal use", notices kept intact, revocable at any time; marks for non-commercial purposes with notices/credit lines and no implied affiliation. AzerDex meets the stated conditions (non-commercial, free, notices kept, visible non-affiliation statement, no ownership claim, no sale of Blizzard art). No clause against format conversion was seen. Whether the "home ... personal use" wording extends to public hosting of client-extracted images is **not settled by the excerpts**; the owner accepts that, and the fallback is to remove `talent-icons/*` from the host. To close the gap, allow `www.blizzard.com` in the environment's network settings and replace the excerpts with the verbatim text.
- **Provenance recorded:** the icons were extracted from the owner's installed Forever client and technically converted from BLP to lossless 64x64 WebP for browser compatibility (pixel-identical to the BLP); AzerDex does not claim ownership; the game assets are separate from the repository's own licence.
- **Rule of thumb enforced by the code:** nothing Blizzard-owned is enabled on production by default: text needs `AZERDEX_TALENT_TEXT=1`, icons need `AZERDEX_TALENT_ICONS=cdn` plus the asset base.

## Background art

- **Original vector art, project-owned** (`src/components/classes/backdrops.tsx`): a class-coloured glow plus one line-art motif per class (hero, cards) and per talent tree (a themed motif chosen from the tree's name, e.g. vortex for Shadow Magic, rays for Holy; the table is `TREE_MOTIF`, tested to cover all 27 trees). Plain inline SVG like the Arcane Library banner: no raster file, no Blizzard artwork, no new dependency.
- **Where:** class page hero, each talent tree panel, and the class cards on `/guides/classes`.
- **Safety:** `aria-hidden`, `pointer-events: none`, clipped by its own container (so tree panels do not clip tooltips and no stacking context is created), low strength plus a dark scrim so text and nodes keep their contrast. Content sits above it (`relative`).
- **Raster art later:** AzerDex's own precedent is owner-approved raster art with a provenance record (`docs/azerdex-library-art/provenance.md`, files under `web/public`). If the owner supplies themed art, replace `ClassBackdrop`'s internals (keep the props and `data-testid`s) and add a provenance record. Blizzard art would additionally need the asset-host route above and an owner decision (see maps-and-assets.md).
- **Tree illustrations (27 of 27 trees):** owner-approved 3:4 illustrations (not Blizzard artwork, no regeneration) are laid over each tree's vector backdrop by `TreeBackdrop`, mapped by **tree slug** in `TREE_BACKGROUNDS` (`src/lib/classes/art.ts`; the file stem is the artwork's own name, so e.g. `druid-feral` is `druid/feral-combat`, `shaman-elemental` is `shaman/elemental-combat`, `priest-shadow` is `priest/shadow-magic`). Priest (Discipline = violet and gold, Holy = cream and gold, Shadow Magic = dark violet) was the reference implementation; the other 24 followed the same way. Each tree has two WebP encodes under `web/public/tree-backgrounds/`: `<stem>.webp` (900x1200) and `<stem>-600.webp` (600x800), served through a plain `srcset` (no inline styles, no CSP change). The delivered 1536x2048 exports of 13 images had a thin bright export-edge band (3-6 px on one or both side edges, found by an edge-profile check on all 27); those edges were cropped by the band plus 2 px and the 3:4 shape kept (at most about 8 px trimmed top and bottom), with no other change to the artwork. Quality is 80 (76 for the three heaviest so each 900w file stays under 200 KB). The image fills the panel (`object-cover`) behind two dark layers (a flat 55% scrim plus a top/bottom gradient): white text on the brightest 5% of every picture after the scrim stays above 6.8:1 (asserted at >= 4.5:1 in `tests/e2e/tree-backgrounds.spec.ts`). It is `aria-hidden`, `pointer-events: none`, lazy-loaded, and the vector backdrop stays rendered underneath, so a failed image falls back to it. Hashes are pinned in `tests/unit/tree-backgrounds.test.ts`.

## What is build-specific, and what is verified

| Item | Build-specific? | Status |
| --- | --- | --- |
| Talent structure, ranks, positions, prerequisites, gates | Yes (1.60.1.70634; layout identical to 70630) | Client-extracted by Everloot (CDN); identical to its 70630 catalog |
| Point budget, tier rule amounts | Yes | From the client data |
| Gate scope for 35 talents; full-rank prerequisites | Yes | **Inferred, not confirmed in game**; flagged in the UI |
| Rank descriptions | Yes (`text.json.build` must match; templates must reproduce the build's description+aura text hash) | **Verified for 466/466**; 363 fully resolved, 103 with numbers marked "?" |
| Icons | Yes (`icons.json.build` must match; URL contains the build) | **466/466 ids validated, 358 images; not published, off by default** |
| Background art | No (original, build-independent) | n/a (decorative) |
| Class colours, names, motifs, copy | No | Fixed facts / decorative |

## Verified vs unverified

Verified (data-backed): the structure (identical across 70630 and 70634 by Everloot's change record and table digests), the description templates (hash-proven for 466/466 talents) and, with the caveat in "Provenance", the per-rank values; the icon ids (validated against the client's own `SpellMisc` rows). **Unverified or absent:** the 261 ranks with a "?", the two inferred rules, publication rights, and all gameplay claims (playstyle, strengths, weaknesses), which the guide states as "not verified yet".

## Refreshing for a new build

1. Regenerate the structure (see "Updating the talent data"); declare `--layout-compatible` only if the importer proves the layout unchanged; point the registry at the new folder.
2. Regenerate the description overlay for **that** build (all inputs of the dataset's own build; never mix builds):
   ```bash
   cd web
   node scripts/import-talent-text.mjs --dataset src/data/talents/forever/<build> \
     --client-snapshot <client-talents.json> --catalog <Everloot talents dir at <build>> \
     --templates-build <build> --templates-ref "<where the export comes from>" \
     --spell-values <Everloot spell-values.json at <build>> --spell-values-ref <repo@commit:path> [--check]
   ```
   (`--templates <normalized dir> --spell-values-prev <older spell-values.json>` is the alternative for a template source of another build; then per-rank values stay gaps.) It prints the added/removed/changed talents against the previous overlay, refuses (exit 1, nothing written) if validation fails, and rewrites `text.json`, `coverage.json`, `COVERAGE.md`.
3. Icons: `node scripts/import-talent-icons.mjs --dataset ... --mapping <icons-<build>.json> --snapshot <client-talents.json> --images <dir with talent-icons/<build>/*.webp> --inventory <asset-inventory.csv>` validates and writes `icons.json` and `icons-inventory.json` (ids and hashes only). Then follow "Publishing the icons".
4. `npm test`: the overlay tests assert that the shipped overlays match the dataset build, that the coverage report accounts for all talents and equals what is shipped, that the icon manifest and inventory agree one-to-one, that no Blizzard image is tracked, and that the layout hash is unchanged by text.
5. Update the E2E canaries and the Shadow guide if names changed.

## Tests

- `tests/unit/talents-engine.test.ts`, `talents-build-code.test.ts` - rules and codec on a small synthetic fixture (never shipped).
- `tests/unit/talents-data.test.ts` - schema, structure, tier rule, reachability of every talent, point budget, manifest hashes for all nine classes.
- `tests/unit/classes.test.ts` - registry, copy and the rendered Shadow guide.
- `tests/unit/talents-import-icons.test.ts` (icon importer and `--layout-compatible`), `tests/unit/talents-cdn-verify.test.ts` (the read-only CDN verifier against a local stand-in host), `tests/unit/talents-data.test.ts` (also: 70630 share links still decode, other builds refused).
- `tests/unit/talents-tooltip.test.ts` - the template resolver: values, formats, curve handling, coded gaps, no leaked `$` tokens, escapes. `tests/unit/talents-import-text.test.ts` - the real importer on a synthetic dataset (acceptance rules, per-rank values only from the target build, determinism, `--check`, atomic failure).
- `tests/unit/talents-overlays.test.ts` - shipped overlay provenance and coverage report consistency, production gate, layout-hash invariance, build-guarded text merge (v1 and v2), icon resolution and CSP origin, card rendering of descriptions/icons, backdrop theme coverage.
- `tests/e2e/talents.spec.ts` - navigation, allocation/removal, max rank, tiers, prerequisites, shared budget, reset, share/restore, invalid links, keyboard, the hover-vs-selected model, real build-verified descriptions (complete text, labelled gaps, unverified fallback; also on touch), and icon rendering (via the E2E-only `/test-fixtures/talents` page, which overlays *synthetic* text and icons on the structural Priest data), backgrounds, axe, mobile/touch. Also covered by the shared a11y/responsive specs.
