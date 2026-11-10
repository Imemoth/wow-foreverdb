# Geographic Collection and Scoped Statistics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Each phase is a separately reviewable Draft PR; do not merge, deploy, or change live data.

**Goal:** Add event-time geographic source/item statistics by Continent → Zone / City while preserving global results and local-only Guildbook data.

**Architecture:** The Addon records scoped counters and a monotonic revision; the Companion parses and serializes only the public observation allowlist. Additive private DB tables validate map identity against a server-owned `wowf` registry, ingestion is transactional, and bounded aggregate-only RPCs serve the Search UI.

**Tech Stack:** WoW Forever Addon Lua 5.1, .NET 8 WPF Companion, PostgreSQL/Supabase SQL, local GoTrue integration tests, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-11-10-geographic-collection-scoped-statistics-design.md`

## Global Constraints

- Preserve existing global table keys, RPC signatures, global counters, and All zones behavior.
- Geographic scope is collected at event time; never backfill historical item drops from player locations.
- An event maps to one terminal Zone, City, or Unknown contribution; Unknown is excluded from named/continent totals and reported in coverage.
- Player position alone is never source attribution; event/source/map ambiguity resolves to Unknown.
- No exact-build allowlist; validate `wowf` map identity, hierarchy, coordinate metadata, geometry, and content evidence.
- No public RPC returns installation IDs, per-installation records, or raw individual locations; locations are coarse aggregate cells with a minimum independent-installation cohort threshold.
- Guildbook, roster, member, profession, and private character data remain local-only and absent from public payloads and responses.
- Apply migrations and run PostgreSQL + GoTrue tests only in disposable local/CI stacks. Never use paid staging or production.
- Keep implementation PRs Draft until the phase gates and upstream dependencies pass. No production migration, deployment, merge, or live data edit is authorized by this plan.

## Review Focus

- Same-second snapshots, equal-revision payload conflicts, and concurrent writers must not reorder or partially replace data.
- SavedVariables restore, older-client downgrade, client reinstall, and installation-ID rotation must fail closed rather than overwrite newer server state.
- Map identities can be coordinate maps, parent maps, or new-build maps; names alone cannot create attribution or compatibility.
- Different collector types have different source evidence; player position must not be mistaken for the source location.
- Small geographic cohorts and fine location cells must not expose one installation's contribution through Search or map detail.

---

## PR dependency strategy

Current upstreams, all still Draft:

| PR | Current role | Dependency / gate for this work |
|---|---|---|
| #179 | Ownerless Companion ingestion; targets `release` | Migration 0019 and its ingest contract must be present in the local/CI migration chain before the geographic ingest phase is accepted. Keep its server-side ingestion verification gate visible. |
| #180 | `wowf` atlas compatibility; targets `release` | Consume its verified map/build metadata interfaces and test fixtures where applicable. Do not duplicate exact-build compatibility rules. If its interface changes, adapt the registry adapter before phase 3. |
| #181 | Integrated ownerless + atlas branch; targets `release` | Existing integration parent for #183; leave unchanged and Draft. |
| #183 | Hierarchical Search zone explorer; based on #181 | Search integration starts from this UI and branch. Preserve #183 changes and its dependency on #181. |
| #186 | Approved geography design; based on #183 | This plan is added here. Geography implementation stacks on its approved HEAD and remains Draft. |

Proposed implementation stack:

1. **Geo A — Addon collection contract**: based on #186. Includes source attribution, Unknown accounting, scoped aggregates, and revision persistence.
2. **Geo B — Companion contract**: based on Geo A. Includes parser models, serialization allowlist, local revision watermark/recovery UX, and payload preflight.
3. **Geo C — DB schema and ingest**: based on Geo B; migration 0019 is a hard predecessor in the migration ledger. Adds private scope/registry/stats tables and transactional revision-aware replacement.
4. **Geo D — Scoped RPCs**: based on Geo C. Adds aggregate-only bounded Search/detail/location RPCs and privacy thresholding.
5. **Geo E — Search UI**: based on Geo D and #183. Replaces subzone scope selection with Continent → Zone / City and renders coverage/Unknown status.

Do not retarget or merge #179/#180/#181/#183 as part of these PRs. When upstreams land, rebase the stack in order onto `release`, retain one phase per PR, and rerun that phase's gates. If #179 or #180 is still Draft, downstream code can be reviewed against its branch contract, but the dependent phase cannot be marked acceptance-ready.

## Unknown attribution forecast and measurement

No collector-specific attribution telemetry exists yet, so the values below are planning estimates from current code paths, not observed rates. Phase 1 must record only aggregate diagnostic counts by collector type in local smoke fixtures; it must not upload collector diagnostics or coordinates. The pilot report must include numerator, denominator, measured Unknown percentage, evidence class, and build.

| Collector | Current source evidence | Initial expected Unknown share | Assignment rule |
|---|---|---:|---|
| Creature loot / quest loot / mail / generic loot | `LootTracker.lua` receives source GUIDs but `GetCurrentLocation()` is player position; no verified source-map link exists | **~100%** until a source-specific map is available | Unknown unless source GUID is tied to an authoritative map/instance identity by an explicit supported API. Never promote corpse-loot player position. |
| Herbalism / mining | `GatheringTracker.lua` observes the gathering cast and may retain a gameobject GUID plus a 12-second pending window; current saved position is the player's interaction context | **0–20%** for GUID-correlated, valid-map interactions; **100%** for unmatched/expired/missing-map events | Attribute the zone only when the interaction event and source GUID correlate and the map identity is valid. Store player coordinates as interaction provenance, not node coordinates. |
| Skinning | Pending gathering flow can identify a creature source, but its exact source map is not separately exposed | **~100%** until the source map can be proven; a GUID match alone is insufficient | Unknown unless a source-specific map is provided; no use of player coordinates as the creature's location. |
| Fishing | `FishingPoolTracker.lua` records cast/hover context and may correlate a pool object; regular water casts can lack a readable pool GUID | **5–25%** when cast-to-catch correlation and a valid map are present; **100%** without valid cast context | Use the map captured at the cast event only when the catch is correlated to that cast. Pool hover/map context may improve identity; projected/player coordinates are not pool coordinates. |
| Any other event without source evidence | No authoritative source map | **100%** | Unknown. |

These ranges are not pass/fail coverage goals. Correct Unknown classification outranks a lower Unknown percentage. A phase gate fails if any player-position-only fixture lands in a named Zone/City. If a short owner-approved acceptance sample is later desired, it must use aggregate counts only and must not upload the observations; no live collection is required for implementation acceptance.

## Revision ordering and recovery contract

- The Addon persists `snapshotRevision` under its existing installation ID and increments it for each changed exported snapshot. The first geography-aware snapshot for an existing installation may start at revision 1; the DB high-water mark is initialized to 0 for legacy installations.
- Revision 1 is a bootstrap case, not permission to overwrite the existing installation. Under the installation lock, compare its `updatedAt` with `public.installations.snapshot_updated_at` before any writes. A lower timestamp is stale and rejected. An equal timestamp is accepted only when a versioned canonical digest of the incoming global projection equals the already persisted global aggregate state; equal-time mismatch is an ambiguous conflict and is rejected. A greater timestamp may proceed under the existing legacy ordering, but only after confirming the current server installation and the complete source/item/location replacement is atomic. Revision and payload acceptance are committed together.
- The server computes bootstrap equality using a versioned semantic digest over the same global observation fields and canonical ordering used by the legacy writer; do not compare raw JSON byte order. If the persisted rows cannot be represented unambiguously by that digest, fail closed and require a separately reviewed recovery procedure. Never fall back to “revision 1 wins.”
- The server accepts a greater revision even when second-resolution `updatedAt` is equal, atomically replacing global and scoped snapshots. Same revision + same canonical payload is idempotent; same revision + different canonical payload is a conflict; lower revision is a no-op with a recovery result.
- The Companion stores an encrypted local high-water mirror keyed by installation ID as a recovery signal. It never silently raises an older SavedVariables revision and resubmits stale contents.
- On restore/concurrency conflict, the client pauses ingestion and compares the local revision and timestamp with the server high-water/timestamp. If the local snapshot is lower or equal-but-conflicting, the owner must restore the newest SavedVariables copy. Never raise the revision and resend without proving the base is current.
- A fork is an explicit “start a new collector” action, not an installation-ID-only edit. It preserves the old server installation/global aggregates; archives the prior local snapshot locally; generates a fresh authorized installation identity; and starts the new upload database with zero source observations, item drops, quest counts, scoped counts, and locations. Only events recorded after the fork are uploaded under the new identity. Do not copy old aggregate counters to the new ID: that would double-count them in global statistics. Do not delete, merge, or rewrite the old server installation.
- Once an installation has accepted a geography-aware snapshot, reject every timestamp-only payload from an older Addon/Companion with a version-conflict response, regardless of whether its timestamp is lower, equal, or greater. Leave both global and scoped rows and the revision high-water mark unchanged. This prevents stale global replacement and accidental deletion of scoped contributions. Older clients retain legacy timestamp behavior only for installations that have never accepted the geography contract. No silent downgrade path is provided.
- On upgrade after a blocked downgrade, resume only with a geography-aware snapshot whose revision is above the server high-water and whose ordering is accepted. Otherwise require SavedVariables restore or the explicit empty-counter fork above. No automatic rebase of unknown old-client contents.
- Installation identity rotation creates a new independent installation record and revision sequence. It must use the existing authorized enrollment/identity workflow; client-supplied ID changes cannot claim or rewrite an existing identity. Existing server records are retained.

## Phase 0: Attribution feasibility investigation (before Geo A)

This is a read-only/static and local WoW diagnostic gate; it does not write to a server, upload diagnostics, or collect private character data. Inspect the `wowf` build's available APIs and existing Addon event paths, then exercise the source events on a local test character. Record only counts and evidence classes, not names, coordinates, GUIDs, or account data.

| Event type | Evidence in current code | Initial feasibility finding | Geo A default until verified |
|---|---|---|---|
| Creature loot | `LootTracker.lua` uses `GetLootSourceInfo`/source GUIDs; `GetCurrentLocation()` is the player's map/position. Current path has no source map field. | No source-specific map evidence is established. Verify whether `wowf` exposes a GUID-to-map/source API for the corpse actually looted. | Unknown for all creature loot unless that API is verified. |
| Skinning | `GatheringTracker.lua` can retain a creature GUID in the pending flow; saved location is captured from the player. A GUID alone has no map. | No source-specific creature map evidence is established. Verify whether the skinning event exposes an authoritative source map or only the player interaction context. | Unknown unless source map is explicitly proven. |
| Herbalism/mining | Spell success can identify an interaction; `UnitGUID("npc")` may identify a gameobject and the current code captures player map during the pending window. | A matching interaction and map may prove the same map instance, but exact node map/coordinates are not currently read from the object. Verify same-map guarantees in this client build. | Unknown unless interaction-to-source GUID and valid map are both proven; player coordinates remain interaction provenance only. |
| Fishing | `FishingPoolTracker.lua` may see a pool object via world cursor/tooltip and correlates cast/hover context; current projected location derives from the player. | Verify which `wowf` builds expose a readable pool GUID/map and whether catch-to-cast correlation is reliable. Cast map can support zone scope only if client semantics prove the cast's water is in that map; it never proves pool coordinates. | Unknown without verified cast context and valid map identity. |

**Feasibility task steps:**

- [ ] Build an API/evidence matrix for `wowf` build `1.60.1.70862`: record API name, event timing, returned source identity, map identity availability, and whether evidence is source map, interaction map, player position, or absent.
- [ ] Add local Lua fixtures that model each observed evidence shape, including secret/unavailable tooltip values, expired pending interactions, map transitions, and mismatched source GUIDs.
- [ ] On a local test character, verify at least 20 controlled events per available collector type (creature loot, skinning, herb/mining, fishing); record only evidence-class counts in the test report. Do not synchronize these snapshots.
- [ ] Compare actual evidence counts with the provisional planning ranges below. If sample/API evidence is unavailable, mark that collector “unverified” and retain 100% Unknown as the safe planning assumption.
- [ ] Publish the evidence matrix and revise the estimates before opening Geo A. Any event without source-map proof remains Unknown even if this reduces coverage.

The current estimates below are hypotheses only, not feasibility results, telemetry, or acceptance targets. Geo A must use the findings above; passing this gate does not authorize weakening attribution rules.

## Phase 1: Addon collection and revision persistence

**Files:**

- Modify: `addon/ForeverDB/Core.lua` — advance SavedVariables schema and initialize revision/contract without changing the stable installation ID.
- Modify: `addon/ForeverDB/Database.lua` — keep global counters unchanged; add leaf/Unknown scoped source and item counters; attach revision to export state.
- Modify: `addon/ForeverDB/GatheringTracker.lua`, `LootTracker.lua`, `FishingPoolTracker.lua`, `LocationTracker.lua` — pass typed event/source/map evidence, preserving interaction/player position as provenance only.
- Modify: `addon/ForeverDB/Exporter.lua` — encode geography contract, per-event-type attribution evidence, scoped counts, and revision in a backwards-readable format.
- Modify: `tests/collector_smoke.lua` and add focused `tests/geographic_collection_smoke.lua` — test current collector fixtures under Lua 5.1/5.4.

**Produces:** Addon export contract `geographyContractVersion` and `snapshotRevision`; each source/item aggregate carries observed map identity, event type, and attribution evidence class. The server registry resolves identity to the canonical leaf scope.

**Task steps:**

- [ ] Add failing Lua fixtures for zero-drop buckets, herb/mining GUID correlation, fishing cast correlation, creature loot, skinning, and map-less events.
- [ ] Run `lua5.1 tests/geographic_collection_smoke.lua`; confirm the new attribution assertions fail before implementation.
- [ ] Implement the event-specific scope resolver and scoped counters while preserving existing global values.
- [ ] Add failing restore/revision fixtures, then persist and advance `snapshotRevision` only when exported state changes.
- [ ] Run the Lua 5.1/5.4 collector suites and compile checks; commit the Addon phase.

**Acceptance tests:**

- Assert global observations/drops/quantity/quest counts remain identical for existing fixtures.
- Assert herb/mining map attribution only with a correlated interaction and valid map; missing GUID, expiry, or map gives Unknown.
- Assert fishing requires a correlated cast context; pool/player coordinates never become exact source coordinates.
- Assert creature loot, skinning, quest rewards, and player-position-only fixtures become Unknown.
- Assert each event increments exactly one leaf or Unknown bucket, including zero-drop observations.
- Assert restore preserves installation ID/revision, revisions increase for changed export state, and legacy schema exports remain parseable.
- Assert each source attribution fixture agrees with Phase 0 evidence; any event without verified source-map evidence remains Unknown.

**Gate:** `lua5.1` and `lua5.4` collector smoke suites plus `luac5.1 -p` / `luac5.4 -p` on addon and new test files pass in CI. Report forecast vs fixture-observed Unknown ratios by collector; do not change safe Unknown behavior to meet a percentage target.

## Phase 2: Companion parsing, serialization, and recovery

**Files:**

- Modify: `companion/ForeverDB.Companion/Models/ForeverDbSnapshot.cs` and add typed geography models under `Models/`.
- Modify: `companion/ForeverDB.Companion/Models/PublicObservationSnapshot.cs` — explicit allowlist for scoped aggregate + contract/revision only.
- Modify: `companion/ForeverDB.Companion/Services/ForeverDbExportParser.cs` — parse new export records and validate bounds/contract.
- Modify: `companion/ForeverDB.Companion/Services/SyncService.cs` — serialize revision, preserve current auth/transport path, and handle revision recovery response.
- Modify: `companion/ForeverDB.Companion/Services/SyncHealthState.cs` or a focused new revision-recovery service — DPAPI-protected local watermark and user-visible restore/fork action.
- Test: `tests/companion-account/PublicPayloadBoundaryTests.cs`, new geography parser/payload/recovery tests in `tests/companion-account/`.

**Produces:** Typed `GeographyContractVersion`, `SnapshotRevision`, scoped source/item aggregates, and an allowlisted request; revision conflicts stop automatic replacement/retry until explicit recovery.

**Task steps:**

- [ ] Add parser tests for current geography exports and schema-9 legacy exports; confirm the new-record assertions fail before implementation.
- [ ] Add payload tests for forbidden Guildbook fields, malformed geography, row/byte limits, same-second revisions, and revision conflicts.
- [ ] Implement parser models and the explicit `PublicObservationSnapshot` allowlist.
- [ ] Add DPAPI-watermark recovery tests; ensure stale local state is blocked and fork flow uses a new installation identity.
- [ ] Run the Companion account test suite and Windows x64 build; commit the Companion phase.

**Acceptance tests:**

- New records parse; schema-9/no-geography input still parses and serializes the existing global payload.
- Payload guards reject malformed identity, negative/overflowing counters, duplicate or ambiguous scope candidates, excessive rows, and oversize bytes before network transport.
- Serialized JSON includes revision and permitted observation fields only; Guildbook names, members, professions, roster fields, and private character values are absent.
- Test same-second higher revision, exact replay, lower revision, duplicate revision with different content, server/local watermark mismatch, SavedVariables restore, older-client response, and installation-ID fork behavior.
- Assert a lower restored snapshot is not automatically assigned a higher revision and sent.
- Assert fork output has a fresh authorized installation ID and zero historical counters/locations; old SavedVariables stay local-only and old server global totals remain unchanged.
- Assert first geography revision 1 is stale when `updatedAt` is lower than the accepted legacy snapshot; equal-time bootstrap succeeds only on an exact semantic global-state digest match and otherwise conflicts without writes.
- Assert timestamp-only clients are blocked after geography activation for lower, equal, and higher timestamps, while legacy timestamp behavior remains before activation.

**Gate:** `dotnet test tests/companion-account/Companion.Account.Tests.csproj` and the Windows x64 Companion build pass. This PR does not require a database or remote environment.

## Phase 3: Additive DB schema and revision-aware ingestion

**Files:**

- Create: `database/migrations/0020_geographic_scoped_stats.sql` — verify this is the next unused migration number before implementation; create `geographic_scopes`, `geographic_map_registry`, private installation source/item scope aggregates, coverage state, and revision high-water storage.
- Create: `database/migrations/0021_geographic_snapshot_ingest.sql` — extend the 0019 public ingestion path without changing its auth, size/source limits, Guildbook stripping, or legacy global semantics.
- Create: `database/tests/geographic/stack.sh`, fixtures/harness, and revision/ingest SQL tests modeled on `database/tests/enrollment/`.
- Create: `.github/workflows/geographic-stats.yml` to run the disposable local PostgreSQL + local GoTrue geographic suite without paid environment secrets.

**Produces:** Registry-validated map-to-scope resolution; transactional replacement under the existing installation lock; global and scoped replacement share stale/revision decisions. Tables have RLS and no direct API-role access.

**Task steps:**

- [ ] Add disposable PostgreSQL + GoTrue tests for the 0019 prerequisite, registry constraints, and private table grants; confirm they fail before 0020/0021.
- [ ] Create additive scope, map registry, aggregate, coverage, and revision state tables in 0020.
- [ ] Add transactional ingest in 0021 and tests for current, legacy, downgrade, replay, conflict, concurrency, and rollback paths.
- [ ] Run the geographic DB stack and existing enrollment regressions; commit the ingest phase.

**Acceptance tests (apply migrations in order, including 0018 then 0019):**

- Preflight fails when required prior functions/policies are missing; verify 0019 auth/payload checks still wrap geography ingestion.
- Legacy payloads retain timestamp-only global behavior before geography activation; once activated, lower/equal/higher timestamp-only payloads are rejected without changing global rows, scoped rows, coverage, or revision high-water.
- Current payload with higher revision replaces both datasets atomically; same timestamp/higher revision succeeds; exact replay does not double counts; stale revision is a no-op; conflicting equal revision fails without partial writes.
- Concurrent revisions serialize; loser becomes stale/conflict; invalid registry identity and malformed counters roll back all writes.
- Bootstrap regression: revision 1 from restored state older than accepted legacy data is a no-op; equal-time identical digest may attach scoped state; equal-time mismatch fails closed; a greater timestamp follows the legacy recency rule within the same atomic transaction. Compare global aggregates, scoped rows, accepted timestamp, and revision high-water before/after every rejection.
- Fork regression: the old installation aggregates remain unchanged; a new authorized ID starts with zero historic global/scoped/location counts; one post-fork event contributes once.
- Downgrade regression: timestamp-only clients are rejected after geography activation at lower/equal/higher timestamps; global rows, scoped rows, coverage status, and revision high-water remain unchanged. Confirm old-client timestamp behavior before activation.
- New/ambiguous/unregistered maps resolve to Unknown while global ingestion succeeds.
- Historical records stay Global/Legacy; no location-based backfill occurs.
- Migration rollback/preflight fixtures and Guildbook retention/local-only tests from enrollment still pass.

**Gate:** Run only disposable PostgreSQL + local GoTrue: `bash database/tests/geographic/stack.sh` (to be added) and relevant existing migration suites such as `bash database/tests/enrollment/stack.sh`. CI secrets must not contain or use a paid staging/production Supabase URL. Migration 0019 presence in the tested chain is a hard dependency gate.

## Phase 4: Scoped aggregate RPCs and location privacy

**Files:**

- Create: `database/migrations/0022_geographic_scoped_rpcs.sql` — separately review RPCs after schema/ingest.
- Create/modify: `database/tests/geographic/rpc_security.test.mjs`, `scope_aggregates.test.mjs`, and privacy fixtures.

**Produces:** Bounded search/catalog/detail/source-rate/coverage/location RPCs for All, Continent, Zone, and City scopes. Unknown is surfaced only as coverage metadata/aggregate, not treated as a named geography.

**Task steps:**

- [ ] Add failing role and aggregate fixtures for zero-drop denominators, city/continent rollup, legacy exclusion, and Unknown coverage.
- [ ] Implement 0022 RPCs with empty `search_path`, explicit grants, pagination, statement/payload budgets, cohort threshold, and coarse location cells.
- [ ] Assert responses contain no installation IDs, raw coordinates, event timestamps, Guildbook values, or per-installation rows.
- [ ] Run local PostgreSQL + GoTrue geographic and existing API-security regressions; commit the RPC phase.

**Acceptance tests:**

- Denominator includes zero-drop source observations; numerator/denominator only use the selected scope and accepted scoped collection interval.
- Continent aggregation sums terminal Zone + City leaves exactly once; city observations never appear in surrounding zone totals.
- All zones preserves global history; geographic RPCs exclude Global/Legacy rows and report coverage start/Unknown counts.
- Every RPC validates scope and page bounds, applies execution and payload budgets, and returns aggregate-only output.
- Assert no response includes installation IDs, per-installation rows, raw coordinates, individual event times, or Guildbook/private data.
- Location aggregates use deterministic coarse cells, a minimum independent-installation cohort threshold, suppression/coarsening below threshold, and safe pagination; adversarial slicing cannot isolate a single installation.
- Authenticated Companion gate succeeds; anon/key-only, unauthorized, and direct raw-table reads fail.

**Gate:** Same disposable PostgreSQL + local GoTrue suite as Phase 3; no live RPC/database changes. Run existing `database/tests/api_security_roles_and_quotas.sql` and `database/tests/zone_catalog_browse_smoke.sql` regressions alongside the geographic suite.

## Phase 5: Search UI integration

**Files:**

- Modify: `companion/ForeverDB.Companion/Models/SearchModels.cs` — Continent → Zone / City scope, coverage state, Unknown metadata.
- Modify: `companion/ForeverDB.Companion/Services/SearchService.cs` — call new scoped RPCs without per-zone fanout; preserve All zones legacy path.
- Modify: `companion/ForeverDB.Companion/Services/ZoneExplorerBuilder.cs` and `MainWindow.xaml` / `MainWindow.xaml.cs` — show continent, zone, city options, scoped results, coverage, and Unknown explanation.
- Modify: `tests/companion-search-zone/Program.cs` and test project references for new models/services.
- Modify: `.github/workflows/companion-health.yml` path filters and existing Search-zone test step to include the new scope/RPC contract.

**Produces:** Search and details are scoped through bounded server RPCs; UI does not infer scopes from display strings and does not expose per-installation data.

**Task steps:**

- [ ] Add failing Search service/UI contract tests for Continent → Zone / City, Unknown coverage, All zones legacy mode, and server-only scoped results.
- [ ] Implement scope models and RPC routing without per-zone fanout; preserve existing request cancellation/epoch behavior.
- [ ] Update the Search selector and result/detail/coverage displays.
- [ ] Run Search-zone tests, map regressions, account payload tests, and Windows x64 build; commit the UI phase.

**Acceptance tests:**

- Continent, zone, and city selection routes to the correct RPC and scope ID; city results contribute to continent totals but not zone results.
- All zones displays existing global behavior and history.
- Unknown/incomplete coverage is visible without fabricating a zone or item location.
- Search, catalog pagination, detail, rates, and map cells update from server aggregates only; stale in-flight requests cannot overwrite the selected scope.
- Existing Search navigation, cancellation, map identity, and detail regression tests pass.
- Windows x64 Companion build plus full `tests/companion-search-zone` and map regression projects pass.

**Gate:** CI green for the x64 Windows build, `dotnet run --project tests/companion-search-zone/Companion.SearchZone.Tests.csproj`, account/public payload boundaries, map regression suite, and geographic local-DB integration. PR remains Draft until all gates across the stack pass.

## Final integration gates

- Confirm upstream status and reviewed contracts for #179, #180, #181, and #183; verify #186 remains the design/plan parent.
- Apply migrations on a clean disposable DB and on a clone of the repository's test baseline, in order through 0019 and the new migrations; run rollback-shape and retention tests.
- Confirm old Addon + old Companion, new Addon + old Companion, new Companion + old Addon, new pair + missing geography migration, and supported current pair behaviors.
- Run Lua 5.1/5.4, .NET unit/integration, PostgreSQL + GoTrue security, and Windows x64 package workflows on exact phase HEADs.
- Review payload diffs and SQL RPC outputs for Guildbook exclusion and aggregate-only privacy; verify `git diff` contains no production configuration/secrets.
- Keep every implementation PR Draft until upstream merge/dependency and all phase acceptance gates pass. Request owner approval before any merge or production migration/deployment.
