# AzerDex: WoW Forever cross-spell evidence and extraction plan — 2026-10-29

**Status: research / staging only.** No actual talent text values have been changed. Applies to the 1.60.1.70634 talent dataset and all nine classes; does not change PR #126, Production, or the calculator UI.

## Inventory

Canonical live input: `web/src/data/talents/forever/1.60.1.70634/coverage.json`.

- 466 talents / 1,313 ranks; 103 partial talents / 261 ranks have at least one unresolved number.
- 91 talent nodes have a `spell` gap. Some additionally have a `proc`, `expr` or `named` gap; the categories overlap.
- 111 distinct referenced spell IDs are in `coverage.spellReferences`, across the nine classes.
- See **[the complete 111-ID worklist](talent-reference-wowhead-research-70634.json)**: each ID, its required tokens, consumers, class, ranks and research status.
- Initial indexed Wowhead Forever survey: **14 IDs investigated**, **11 with directly observed candidate spell values**, 3 needing special review/indirect evidence, **97 not yet surveyed**. This is NOT 12 verified 70634 records.

### Sample values observed on Wowhead Forever

| Referenced spell | Consumer | Candidate display value(s) | Caution |
| ---: | --- | --- | --- |
| 15269 | Priest Blackout | duration 3 sec | [Forever spell](https://www.wowhead.com/forever/spell=15269) |
| 15271 | Priest Spirit Tap | Spirit +100%; duration 15 sec; mana regen while casting 50% | [Forever spell](https://www.wowhead.com/forever/spell=15271); page shows raw Effect Value 101/51 vs buff 100/50 |
| 1326168 | Priest Dark Inspiration | duration 10 sec | [Forever spell](https://www.wowhead.com/forever/spell=1326168) |
| 15258 | Priest Shadow Weaving | 2% in buff text, duration 15 sec; 5 max stacks in talent text | **Conflict / incomplete stack proof:** buff's raw Effect Value is 3%; exact 70634 semantics require validation |
| 1241057 | Priest Silence | 3 sec in parent talent description | **Indirect only:** no corresponding direct Forever spell page yet; DO NOT use as verified 1241057 duration |
| 12355 | Mage Impact | duration 2 sec | [Forever spell](https://www.wowhead.com/forever/spell=12355) |
| 12484 | Mage Improved Blizzard | duration 1.5 sec | [Forever spell](https://www.wowhead.com/forever/spell=12484); buff's remaining time is displayed rounded |
| 12494 | Mage Frostbite | duration 5 sec | [Forever spell](https://www.wowhead.com/forever/spell=12494) |
| 12579 | Mage Winter's Chill | Wowhead says 2% bonus crit (raw effect 3%) | **Conflicts** with AzerDex's hash-verified 70634 talent text about Cone of Cold damage. DO NOT import |
| 12880 | Warrior Enrage | duration 12 sec | [Forever spell](https://www.wowhead.com/forever/spell=12880); separate `$h` proc gap remains |
| 14143 | Rogue Remorseless Attacks | duration 20 sec | [Forever spell](https://www.wowhead.com/forever/spell=14143); raw effect 41 vs displayed 40 |
| 27813 | Priest Blessed Recovery | duration 6 sec | [Forever spell](https://www.wowhead.com/forever/spell=27813) |
| 27827 | Priest Spirit of Redemption | duration 15 sec | [Forever spell](https://www.wowhead.com/forever/spell=27827) |
| 14181 | Rogue Relentless Strikes | 25 Energy | [Forever spell](https://www.wowhead.com/forever/spell=14181); raw effect 26 vs rendered 25 |

**Wowhead version caveat:** a `/forever/spell=` page is not pinned to the precise 70634 build. The [Wowhead talent calculator announcement](https://www.wowhead.com/news/wow-forever-talent-calculator-now-live-382870) expressly warned that rank scaling and some preliminary tooltip values might be inaccurate. Treat these as review candidates only, never a source of automatic `verified` claims. Review the linked spell's own page, not only the talent name or the classic/retail pages. The indexed tooltip, the page's raw Effect Value, and the 70634 client template may differ.

## Reproducible OWN client extraction: two stages

### A. Obtain a pinned client-row snapshot

The open [Everloot `client-extract` implementation](https://github.com/Everloot/everloot/blob/d4a225e44d4e798b814d1fe8acd5b37e6e2f49d1/kb/src/client-extract.ts) can read Blizzard's **unencrypted** CDN DB2/WDC tables into SQLite using `@rhyster/wow-casc-dbc@2.16.17`, with WoWDBDefs pinned to a commit. No credentials or keys are used. Use its CLI on a connected machine (from the `kb/` directory of a reviewed checkout):

```powershell
git clone https://github.com/Everloot/everloot.git
cd everloot/kb
npm ci
npm run kb -- client-extract --product wowf --out data/client
```

The snapshot is named like `wowf-70634-7d8ae4cd.sqlite` plus a manifest (the exact actual filename comes from the tool). **This command reads the CURRENT CDN build**: if the CDN has moved beyond 70634, it will NOT retrieve 70634. In that case use a previously pinned 70634 SQLite snapshot or the owner's installed 70634 `DBFilesClient.zip` + WDC5 reader. Do not relabel another build's output. Likewise, a 70630 extraction is an explicitly different source, not an automatic substitution.

Inspect the manifest: `product=wowf`, `buildId=70634`, `buildConfig=7d8ae4cd9c1f639a3ea04fd47e21c746`; check the WoWDBDefs revision, missing tables and encrypted block counts. For 70630 fallback use `buildConfig=644ffedb0d59bb0da2af9011b36f44db` and verify the exact relevant table digests against the 70634 baseline. Original game data stays local.

### B. Export only the 111 linked IDs as RAW evidence (our script)

`web/scripts/export-referenced-spell-evidence.py` is a read-only standard-library Python 3 utility. From a local AzerDex checkout:

```powershell
python web/scripts/export-referenced-spell-evidence.py `
  --snapshot "C:\path\to\everloot\kb\data\client\wowf-70634-7d8ae4cd.sqlite" `
  --coverage "web/src/data/talents/forever/1.60.1.70634/coverage.json" `
  --expected-build 1.60.1.70634 `
  --output "$env:TEMP\azerdex-70634-linked-raw.json"
```

The exporter checks the snapshot/coverage build, opens SQLite `mode=ro`, extracts only required IDs from `Spell`, `SpellName`, `SpellEffect`, `SpellMisc`, `SpellAuraOptions`, related `SpellDuration` via `SpellMisc.DurationIndex`, and related `SpellRadius` via `SpellEffect.EffectRadiusIndex`. Each output carries source build config, snapshot SHA-256, needed tokens and affected talent IDs. It was smoke-tested on a synthetic SQLite fixture, including rejection of a wrong build. **It produces evidence, not text.json and not verified spell-facts input.**

This utility does not implement the WDC5 decoder; it deliberately consumes the existing independently extracted SQLite. The data may include incomplete decrypted coverage or undecoded relationships: inspect `missing` and the snapshot manifest. Unresolved spells remain unresolved.

## C. Convert audited raw spell rows into correct displayed values

1. Join the spell relationships using **SpellID**, `SpellEffect.EffectIndex`, `SpellMisc.DurationIndex`, `SpellDuration.Duration`, `SpellAuraOptions.CumulativeAura` (max stacks only after separately confirming the semantic for the exact build), `SpellEffect.EffectRadiusIndex` and `SpellRadius`. Follow any `EffectTriggerSpell` links; stop on missing/encrypted rows.
2. Validate the data's actual tooltip rendering semantics. **Do not blindly print `EffectBasePoints` or apply `+1`/-1 globally**: Wowhead sometimes displays raw 101 vs rendered 100, raw 26 vs rendered 25; effects may be dummy/scripted, curve-derived, dice-driven, or altered by server hotfixes.
3. For every referenced token such as `$15271S2`, `$15258u`, `$12355d`, map to the exact same-build field and grammar; record whether the field is verified, unknown, conflicting or dynamic. Expand expressions and proc variables only if their actual data and context are proven. Never turn dynamic character stats into fixed guesses.
4. Match the talent's unchanged source template hash and rank identity, render **all ranks** with the existing importer, run unit/CI, and compare with the original Wowhead number as a *secondary* check.
5. Preserve token-level provenance: `targetBuild`, `sourceBuild`, build config, table name/row id/field, DB2 content key or source snapshot hash, applicable render rule, Wowhead URL/date and review status. Explicitly mark any 70630 fallback and only allow it for fields whose corresponding 70630/70634 table rows are demonstrably identical.
6. Only after manual validation produce the `azerdex.referenced-spells/1` input accepted by `import-talent-text.mjs --referenced-spells ... --referenced-spells-ref ...`. The current optional importer checks schema/build and *presence of provenance fields*, not cryptographically that each individual value matches the real client. **Do not treat that input gate alone as proof.** Add a cross-source attestation test before shipping numeric values.
7. Recompute coverage from the canonical importer; no manual edits of `text.json`, `coverage.json`, `COVERAGE.md`. An unverified field remains the original labelled `?`. Keep the entire change in a beta-targeted Draft PR and obtain owner approval before merge.

## Priority and scope

First verify the 111 linked spells; that addresses the **spell** category affecting 91 talents. Then treat the other categories independently: `proc` (7 talents), `expr` (12), `named` (6), `effect` (2), `zero` (1). These counts **overlap**. Full 103/103 resolution is not guaranteed by cross-spell work alone.

No Wowhead content or raw Blizzard game assets are copied wholesale into the repository; this is a numerical fact/provenance worklist. No CDN, Vercel, UI or Production changes.
