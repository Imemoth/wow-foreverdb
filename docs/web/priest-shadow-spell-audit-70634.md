# Priest Shadow cross-spell audit — 1.60.1.70634

Scope: Blackout, Spirit Tap, Dark Inspiration, Shadow Weaving, Silence. This is data/import logic only; no UI, deployment, or production changes.

## Evidence reviewed (2026-10-28)

- Current AzerDex V1 data: `text.json` and `coverage.json` under `web/src/data/talents/forever/1.60.1.70634/`.
- Same-build Everloot spell rows: `Everloot/everloot@d4a225e44d4e798b814d1fe8acd5b37e6e2f49d1:web/src/data/game-data/spell-values.json`. It contains 466 talent spell rows, **none** of the five referenced spell rows listed below.
- The client-extraction package mentioned in `docs/web/class-guides-talents.md` contains some partial supporting-spell fields, but not authenticated duration/dice/stack facts for these dependencies. Older build descriptions or third-party tooltip values are not accepted as a substitute.

| Talent (node / own spell) | Ranks | Required referenced tokens | Missing evidence |
| --- | ---: | --- | --- |
| Blackout (105832 / 15326) | 1–5 | `$15269d` | duration of spell 15269 |
| Spirit Tap (105833 / 15270) | 1–5 | `$15271s1`, `$15271d`, `$15271S2` | spell 15271 effect 1 and 2, duration |
| Dark Inspiration (105823 / 1326159) | 1–5 | `$1326168d` | spell 1326168 duration |
| Shadow Weaving (105821 / 15257) | 1–3 | `$15258s1`, `$15258d`, `$15258u` | effect 1, duration, and **maximum stacks** of spell 15258 |
| Silence (105824 / 15487) | 1 | `$1241057d` | duration of spell 1241057 |

**Result:** 0/19 rank descriptions can currently be marked complete on the available verified sources. Their existing explicit `spell` gaps must remain. No game numbers are filled in this PR.

## Importer support

The importer now accepts *optional* `--referenced-spells <file> --referenced-spells-ref <immutable source reference>`. Input must have `schema: "azerdex.referenced-spells/1"`, `build: "1.60.1.70634"`, and a `spells` object keyed by spell IDs. Each record requires `durationMs`, a list of complete `effects` (`index`, `basePoints`, `dieSides`, `periodMs`, `chainTargets`, `radiusYards`), and `source: { build, description, tableDigests }`. Missing fields abort the import; any individual missing/zero/ambiguous field at rendering remains a gap. Use immutable full-build references, extraction SHA-256, and table digests in each record's provenance. The output records the reference and SHA-256 of the input source. The importer must only be given independently verified, exact-build rows. Provenance metadata alone is **not** a substitute for auditing the source.

The renderer only resolves cross-spell `$<id>d` and effect `$<id>sN`/`$<id>SN` when explicit facts are supplied. It conservatively leaves `$<id>u` (maximum stacks), missing effects, zero, and dice-dependent values as gaps; it does not infer them. The default import path is unchanged until the missing records are verified.

## Acceptance / next extraction

1. Acquire full same-build `SpellEffect`, `SpellDuration` and relevant stack-cap data for 15258, 15269, 15271, 1241057, 1326168. Cross-check build config and the spell-row table digests against pinned 70634 client data.
2. Independently verify each effect, duration and max-stack semantic, including `$S2` and `$u` grammar, before enabling an actual value. Run the optional import into a scratch copy; only commit regenerated `text.json`, `coverage.json`, `COVERAGE.md` after the evidence is complete.
3. Run `vitest` tests (`talents-priest-shadow-references.test.ts` and existing talent suites), TypeScript, ESLint and release CI; compare rank 1 through max for all five nodes. If any token cannot be proven, it stays a `spell` gap.
4. Keep PR #126 and Production untouched. Owner approval required before merge.

**Caveat:** this is a source-gated resolver and regression safeguard, **not** a claim that any of the missing spell values has been recovered.
