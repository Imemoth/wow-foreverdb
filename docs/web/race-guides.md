# Race Guides (V1) and the versioned racial-ability data

Public, login-free pages under the Guides section:

| Route | What |
| --- | --- |
| `/guides/races` | All ten race-faction entries, Alliance and Horde (five each) |
| `/guides/races/[race]` | Race page: overview, available classes (linked to the Class Guides), two active and two passive abilities, collapsed Version History, data provenance |

Race slugs: `human`, `dwarf`, `night-elf`, `gnome`, `high-order-skyborne`, `orc`, `tauren`, `troll`, `undead`, `windshaper-skyborne`.
The two Skyborne factions are separate entries because their classes and two abilities differ; their three shared abilities
(Walk on Air, Wind Blessed, Elemental Insight) are stored once and referenced by both. Everything is read-only and needs no
database, backend, account or API: the data is bundled JSON, resolved when the server starts.

## How the data is organised

```
web/src/data/races/forever/
  sources.json                    every source, once (url, title, publisher, kind, publication date, retrieval date)
  baseline/2026-09-22.json        earliest documented definitions
  changes/2026-09-24.json ...     append-only change records, one file per publication date
web/src/lib/versioned/            generic engine (types, zod schemas, resolver) - reusable for a later Class Abilities history
web/src/lib/races/                race layer: identities, registry (the only place that imports the JSON), view-model builder, validator
```

**Current state is derived, never stored:** `baseline + change records = current definitions`, computed by `resolveVersioned()`
at load (`src/lib/races/registry.ts`). There is no second editable copy. Every file is schema-validated at load, so malformed data
fails the build rather than reaching a page.

### Entities and properties

- `race.<slug>`: `classes`, `newClasses` (class ids = the existing Class Guide ids).
- `<race-or-group>.<ability>` (kind `ability`): `name`, `type` (`active`/`passive`), `races` (a list, which is how Skyborne abilities are shared),
  `description`, `cooldown`, `duration`, `details[]` (conditions and limits), `communityNotes[]` (community-only details).
  `null` always means "not documented", never zero.
- Ability ids are stable: renaming or tuning an ability never changes its id. A replacement is a `removed` + `added` pair
  (Blizzard says "replaced with"), so the old definition stays in history and leaves the current set.

### Change records

Each record states: `announcedOn` (publication date of the evidence, **not** the in-game date), `effectiveOn` (`null` unless established),
`build` (`null` unless the record is `client-verified`; the talent build 1.60.1.70634 is deliberately not reused), `evidence`,
`sources` (ids), `verifiedOn` (when AzerDex checked it), `notes`, and `ops`. An op has an `entity`, a `type`
(`added`, `modified`, `renamed`, `removed`, `restored`, `documented`), the new values in `set`, the expected old values in `previous`
(a mismatch with the resolved state is a conflict error, never silently resolved) and a one-sentence player-readable `summary`.
`documented` means a detail became known without claiming the game changed (used only for community-reported details).

### Evidence rules (decided per property)

Priority: `client-verified` > `official` (Blizzard articles and development notes) > `corroborated` (independent community sources) > `unverified`.

- Official evidence may change any property, and add/remove/restore abilities.
- Community evidence may fill an unknown property or refine a community-backed one. It **never overwrites a property that Blizzard
  stated**, and cannot add, remove or restore abilities.
- `unverified` evidence never changes anything.
- Anything that cannot be applied stays on the entity as `pending`; it is never merged and never dropped.
- Each displayed field carries its own label on the page (Blizzard-documented / Community-reported / Verified in the game client).

## Updating after a new patch or announcement

1. **Identify** the new official source (patch notes, development notes, article). Add it to `sources.json` (publication date from the page, today's date as `retrievedOn`).
2. **Compare** it with what the site shows now (`/guides/races/<race>` or `RACE_GUIDES` in a test).
3. **Add** the verified differences as a *new* dated file `changes/YYYY-MM-DD.json` (one record per source publication). Use `previous` for the values you saw before, so a wrong assumption fails loudly. Leave `effectiveOn` and `build` as `null` unless the source itself establishes them.
4. **Preserve** history: never edit an existing record or the baseline. A correction is a new record. `tests/unit/races-data.test.ts` pins a fingerprint of every published record and fails if one is edited.
5. **Resolve**: import the new file in `src/lib/races/registry.ts` (chronological order). Nothing else changes: pages, cards and the history UI read the resolved data.
6. **Validate**: `npm test` (resolver, dataset, UI), `npx tsc --noEmit`, `npm run lint`, `npm run build`, and `npx playwright test --project=desktop --project=mobile tests/e2e/races.spec.ts tests/e2e/a11y-seo.spec.ts`. Add the new record's fingerprint to `FROZEN_FINGERPRINTS` and a regression test for the new values.
7. **Publish** through a reviewed pull request into `web/azerdex-beta`; the owner approves any merge or production promotion.

If a new source contradicts an older one, record it as a new change; do not edit the old record. If a value is not published, leave it
`null` ("Not documented").

## Source coverage and what is confirmed

Read on 2026-10-29. Blizzard pages: the 22 September race/class overview (class tables, new combinations, lore) and "Meet the New
Skyborne" (22 September; full Skyborne ability lists and classes); the Deep Dive recap (13 September; Dwarf and Undead statements, "two
active and two passive abilities", the six new combinations); the Beta Development Notes forum thread, posts of 24 Sep, 1 Oct, 15/16 Oct,
26 Oct and 27 Oct (the Oct 27 post adds Blood Fury, Berserking, Touch of the Grave and the Skyborne clarifications to the Oct 26 list).
Community cross-checks: Warcraft Tavern's BlizzCon-demo catalogue (12 Sep), SKTools and WoW Forever Tier List.
Mobalytics could not be read (HTTP 403 for automated requests) and was not used.

**Confirmed (official):** race/faction identity, all ten class lists and the six new combinations; the Skyborne abilities as of 22 Sep; the
Oct 15, Oct 26 and Oct 27 changes and the "was" values they state (which also fix several earlier values: Blood Fury 2 min, War Stomp 2 min,
Cultivation 60 min, Walk on Air 2 min, Berserking 10 sec, Shatter Curse 15 %, Troll Regeneration 10 %, Tauren Endurance hit chance, Wind Blessed 1 %).

**Community-reported only:** the pre-October ability lists of the eight Classic races (Warcraft Tavern, a demo catalogue; Blizzard's "was"
values corroborate it where they overlap), Stoneform's 8 sec / 10 % / 3 min, Elune's Light's 3 min, the Read Leyline and Skysight 2 min
cooldowns, War Stomp's area and Cultivation's once-per-herb limit. Each is labelled on the page.

**Unresolved (shown as "Not documented"):** cooldowns of Will to Survive, Perception, Shatter Curse, Berserking, Eureka!, Cannibalize,
Rapid Regeneration, Shadowmeld, Escape Artist, Will of the Forsaken (one community site says 2 min, another 45 sec; no agreement); the
Touch of the Grave base chance before 15 Oct; Plainsrunning's exact pre-26-Oct per-stack numbers as of 22 Sep. A single community
site listed Troll Rapid Regeneration as 20 %; three sources say 50 % (used, community-reported).

**Not verified against the release client.** No racial value is tied to a client build; the development notes describe the beta. Do
not read a Blizzard development note as proof of release-client behaviour.

### Things to know

- The brief's example shows Ruthless with a "22 September" earlier definition. Blizzard's 22 September material does not document
  Ruthless: it replaced Sword Specialization on 15 Oct. Ruthless therefore has history `15 Oct (added, 2 %)` then `26 Oct (1 %)`, and Sword
  Specialization appears under "Earlier abilities no longer available".
- The 22 September articles document the Skyborne abilities, class tables and lore but not the other races' abilities. The baseline for
  those therefore comes from the community BlizzCon catalogue (12 Sep) with official statements overlaid where they exist.
- Orc "Command restored": Command is absent from the earliest Forever lists, so it is recorded as `added` (Blizzard says "re-added").
- Blizzard's 15 Oct post calls the Undead racial "Touch of the Dead" in places; it is recorded as Touch of the Grave (the 26 Oct post).
- Forum post 1 (24 Sep) was edited later (last 26 Oct); its entries are dated by the post's creation.
- Priest racial *spells* (Fear Ward, Divine Grace, ...) are class spells and out of scope for V1.
- Race artwork: the ten owner-provided illustrations on the cards, hero and `/guides` thumbnails; see [race-art.md](race-art.md). Ability icons: none. AzerDex has no licensed ability artwork (see `docs/third-party-blizzard-content-notice.md`), so ability cards use a neutral lettered tile.
- Pages are server-rendered per request (dynamic), like the Class Guides: the site's nonce-based CSP requires a per-request nonce.

## Tests

`tests/unit/versioned-resolve.test.ts` (engine, evidence precedence, explicit failures), `races-data.test.ts` (structure, Blizzard class
tables, 40 slots, sources, ordering, frozen records, Oct 26/27 regressions, state as of each date), `races-ui.test.ts` (components),
`races-seo.test.ts` (sitemap in production, empty in preview/local), `tests/e2e/races.spec.ts` (desktop and mobile: pages, history
disclosure and keyboard use, class links, overflow, touch targets, SEO policy, axe) and the race routes added to `a11y-seo.spec.ts` and `responsive.spec.ts`.
