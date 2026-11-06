# Companion — Quest data pipeline, fresh staging baseline (C0)

Status: **planning and acceptance only**. No Companion code, remote schema, production database, Vercel deployment, or addon export change is authorized by this document.

## Starting point

- Repository: `Imemoth/wow-foreverdb`. Production integration branch: `release`, **not** `main`.
- Fresh branch: `feat/companion-quest-staging-v1`, forked from the release merge of the consolidated accepted Quest Tracker #173, commit `26a7820be6851805c7445359583a236c5a5ba389`.
- The accepted WoW: Forever addon is **0.7.1-alpha**, interface 16001, **Schema 9**. Companion remains **0.9.0-alpha**.
- Quest Tracker private journal is `ForeverDB_Saved.questJournal[characterGUID]`; it is local-only and never part of the current `ForeverDB_Export` string.
- Existing exporter record types: `H|9`, `M`, `A`, `S`, `B`, `L`, `I`. The current item observation includes `questDrops` and a possibly blank quest-ID CSV. **A quest flag with no explicit quest ID is NOT a canonical quest–item link.** There are no `Q`/`R` quest rows in Schema 9.
- The current Companion parser extracts the `ForeverDB_Export` Lua string, and public transport uses its explicit projection plus `PublicSnapshotGuard`. Guildbook is an independently parsed and local-only concern.
- Legacy Companion PRs #81 (AutoSync), #82 (WoW installation picker) and #83 (account switching) are closed, unmerged and out of date. Do not cherry-pick them into this scope without a fresh review.

## Phase C0 — staging-only acceptance of EXISTING Schema 9 sync

**Goal:** Prove a real, non-empty `0.7.1-alpha` addon export can traverse **manual Sync Now** -> Companion parser -> privacy allowlist -> ownership-checked transport -> **isolated staging/test** ingest -> read-back without duplication.

1. **Preflight, no writes:** confirm installed Companion version and selected WoW: Forever installation and SavedVariables filename; compare current `H|9` header to saved fixture. Identify the actual destination by project ID/host and credential scope, and confirm it is **not production**. Inspect existing ingest functions, ownership checks, counters and idempotency contract before testing. Disable AutoSync; make no unsolicited upload.
2. **Fixture hygiene:** use an actual non-empty export as a parser *input* in a restricted environment, with the raw local `.lua` remaining private; test fixtures committed to GitHub must be scrubbed and use synthetic installation IDs, dates and locations where necessary. Never commit/upload real GUIDs, character/account/realm details, session history, guild rosters, secrets or the raw quest journal.
3. **Parser acceptance:** verify all Schema 9 source and map records can be parsed, including creature loot, skinning and GameObject quest-item observations (e.g. Equipment Boxes source 164662; `Scavenged Goods` item 11127); IDs, counts, level, location granularity and map-art metadata must not be fabricated or silently dropped. Reject unsupported schema or malformed/incomplete input with clear errors.
4. **Privacy gate:** serialize exactly the outbound `p_snapshot` request and run `PublicSnapshotGuard.CheckBody` (or equivalent existing guard). Assert **no `questJournal`, private quest progress or completion history, character GUID/name/realm, sessions, Guildbook member/roster/profession data or extra object keys** reach network transport. The existing pseudonymous installation identity remains governed by the current ownership contract; do not replace it in this phase.
5. **Manual Sync Now:** perform a single owner-authorized upload to isolated staging only after preflight. Read back destination records and reconcile installation scope, counts, item drops/questDrops and locations against the parsed payload. Record sanitized before/after data and whether a write was accepted.
6. **Replay and idempotence:** repeat the *identical* snapshot and an interrupted/retried submission. Assert no unintended duplicate sources, extra sample counts or repeated aggregate increments; inspect actual server semantics and fix a broken dedupe mechanism rather than interpreting every HTTP 200 as idempotent.
7. **Negative cases:** wrong installation owner/account, revoked credential, unavailable staging, partial-write file, malformed/unsupported export, path targeting beta, unexpected fields, legacy Guildbook entries, stale snapshot and nonempty payload with blank `questIds`. Fail closed without production fallback. Errors must not leak sensitive content.
8. **Test and gate:** .NET 8 Windows WPF build, parser/public snapshot guard tests, account/ownership integration (GoTrue/PostgREST where applicable), Guildbook local-only tests, CI, and a documented isolated staging read-back. Do not claim a public AzerDex Quest Database exists merely because source-item rows ingest.

### Acceptance matrix

| Area | Expected |
| --- | --- |
| Input | Real nonempty `H|9` export accepted on staging with no raw-file network transfer |
| Scope | Exactly the configured Forever installation, known owner, explicit staging host |
| Privacy | Public allowlist PASS; forbidden private keys absent from actual request |
| Mapping | Sources/items/maps/quantized positions reconcile with the original export |
| Replay | Identical snapshot sync + retry do not duplicate counts |
| Failure | Wrong owner, malformed file, network/credential failure safely rejected |
| Guildbook | Local-only; no cloud migration or payload |
| Production | Zero schema, RPC, deployment, or data writes from this acceptance |
| Evidence | Sanitized fixture/test results and read-after-write record reconciliation |

## Phase C1 — future anonymous Quest Database transport (separate PR and approval)

The current Schema 9 transport does **not** publish the quest journal. Do **not** upload the raw journal, insert `Q`/`R` rows unilaterally, change the Companion protocol by assumption, or infer quest-item relationships from item names or proximity.

Design an independently **versioned**, privacy-reviewed addon export and Companion model for evidence-backed, non-character-identifying candidate data:
- Quest ID, locale, client build, title, level, descriptions and objectives, with evidence/provenance.
- Offered fixed/choice rewards and observed XP/money; selected or granted item marked **unknown** unless independently observed.
- Giver and turn-in source IDs, source type and **quantized player interaction position** (not authoritative NPC spawn).
- Quest target NPC tooltip matches, observed deaths and progress deltas **as distinct evidence types**, without inferring kill credit.
- Item/source/quest links **only with explicit positive quest ID evidence**; allow unknown and disagreement.
- Allowlisted payload, per-build aggregation, confidence, retention, replay keys and publication thresholds.

Future sequence: contract and fixtures -> addon versioned exporter -> Companion parser/transport -> staging validator/ingest -> publisher/read model -> AzerDex Quest Database UI. No production migration or release without a separate owner gate.

## Closure and references

- Consolidated, actual-client-accepted Quest Tracker [PR #173](https://github.com/Imemoth/wow-foreverdb/pull/173); former stacked PRs #168/#170 are superseded.
- [Issue #169](https://github.com/Imemoth/wow-foreverdb/issues/169) captures the quest evidence and limitations.
- [Issue #175](https://github.com/Imemoth/wow-foreverdb/issues/175) is this new Companion scope and acceptance tracker.
- Complete **C0** before C1 implementation; keep this PR Draft until the user approves the next build stage.
