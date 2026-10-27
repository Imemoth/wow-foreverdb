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

Does **not** contain, and the UI says so instead of inventing it: **rank descriptions** (the optional `descriptions` field exists but is empty), **icons** (talents are shown as name plates; no Blizzard artwork is bundled), gameplay advice.

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

To add rank descriptions later: add `descriptions: string[]` (one entry per rank) to a talent once you have a source whose text is verified for the same build and may be redistributed. `TalentCard` then shows the current and next rank; no UI change is needed.

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

## Interaction

Click/tap/Enter/Space adds a point; right-click, Shift+click, Backspace/Delete or the **Remove** button in the detail panel removes one; arrow keys move between talents (one tab stop per tree); status changes are announced through a polite live region. No inline styles are used (page CSP), grid placement uses literal Tailwind classes.

## Tests

- `tests/unit/talents-engine.test.ts`, `talents-build-code.test.ts` - rules and codec on a small synthetic fixture (never shipped).
- `tests/unit/talents-data.test.ts` - schema, structure, tier rule, reachability of every talent, point budget, manifest hashes for all nine classes.
- `tests/unit/classes.test.ts` - registry, copy and the rendered Shadow guide.
- `tests/e2e/talents.spec.ts` - navigation, allocation/removal, max rank, tiers, prerequisites, shared budget, reset, share/restore, invalid links, keyboard, tooltips, axe, mobile/touch. Also covered by the shared a11y/responsive specs.
