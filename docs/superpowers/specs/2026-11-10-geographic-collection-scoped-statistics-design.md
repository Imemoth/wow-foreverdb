# Geographic Collection and Scoped Statistics Design

Status: **proposed for owner review; implementation has not started**.

## Intent

Collect statistically valid source observations and item drops by continent,
zone, and city while preserving existing global statistics and historic data.
The public Companion API must return aggregate results only. Guildbook data
remains local-only.

The selected storage direction is additive: new per-installation geographic
aggregate tables and a validated map registry are introduced alongside the
current global tables. The owner selected this approach on 2026-11-10. Existing
global table keys, RPC signatures, and public global statistics keep their
current meaning during migration and client rollout.

## Current contract and data loss point

`addon/ForeverDB/Database.lua:RecordObservation` increments one global
source/loot-kind observation counter and increments global item drop, quantity,
and quest-drop counters for the same loot event. If the event has a location,
it separately increments a location record keyed by `mapId`, subzone label, and
coordinates. Location records do not identify which item was observed. The
global counters therefore cannot be split by zone after collection.

The addon currently records `mapId`, parent map ID, map-art ID and map-layer
metadata. It does not persist a canonical continent/zone/city identity. A
subzone label is display text and is not a reliable geographic key.

The Companion parser reconstructs the SavedVariables export into
`ForeverDbSnapshot`; `PublicObservationSnapshot` projects only sources and maps
into the network payload. `SyncService` serializes this allowlisted DTO, and the
transport guard rechecks it. SQL migration 0018 strips Guildbook fields before
the observation writer. The geography contract must pass through these same
allowlists without adding Guildbook fields or raw installation data to public
read paths.

The ingest writer replaces one installation's aggregate rows in a transaction
under the installation advisory lock. Older `updatedAt` snapshots are ignored.
Replaying an equal/current snapshot is safe because the replacement is atomic.
New geographic rows will use that same lock, stale check, and transaction.

The Addon timestamp has only second resolution, so timestamp alone cannot order
successive snapshots produced within one second. The geography contract adds a
persistent `snapshotRevision`, monotonically increasing for the stable
installation ID whenever exported state changes. The server stores the last
accepted revision. A higher revision is newer even if `updatedAt` is equal; a
lower revision is stale and a no-op. Replaying the same revision with the same
canonical payload is idempotent; reusing a revision for different content is a
conflict. Revision comparison and global/scoped replacement occur atomically
under the existing installation lock.

Older Addons send no revision and retain the existing timestamp-only global
ordering, including equal-timestamp replacement behavior, only until that
installation accepts its first geography-aware snapshot. After activation,
timestamp-only uploads are rejected and do not change either global or scoped
data. The revision high-water mark is retained. Revision state is scoped to
installation identity; a reset/new identity starts a new sequence and cannot
reuse another installation's revision.

The first geography-aware snapshot for an installation with accepted legacy
state bootstraps at revision 1 only after a server-side comparison with that
installation's existing state. A lower `updatedAt` than
`public.installations.snapshot_updated_at` is rejected before any writes. An
equal timestamp is accepted only if a versioned semantic digest of the
incoming global projection matches the currently persisted global aggregate
state; a mismatch is ambiguous and fails closed. The digest uses canonical
field ordering and the legacy writer's global semantics, not raw JSON byte
ordering. If the current rows cannot be compared unambiguously, bootstrap is
rejected for explicit recovery. Revision 1 never overrides the legacy
timestamp or global-state comparison.

Historical installation observations and item drops have no trustworthy shared
geographic key. The location observations cannot repair the missing item link;
they must not be used to manufacture historical zone drop counts.

## Geography model

The selectable taxonomy is:

```text
Continent
├── Zone
└── City
```

Each collection event belongs to exactly one terminal collection scope: one
zone, one city, or the explicit `Unknown` scope. It does not also increment the
continent scope. Continent totals are computed from their terminal zone and
city children, exactly once. Cities are direct children of their continent in
this collection taxonomy, so their data is not also counted in an enclosing
zone. Subzone names remain descriptive location metadata and are not independent
filter or statistics keys.

The coordinate `mapId` remains a separate identity from `scopeId`: several
coordinate maps may resolve to one collection scope, and a city map may have an
independent coordinate system. Marker rendering continues to use the original
observation `mapId`, `x`, and `y` unchanged.

Each scoped contribution also retains its attribution evidence class. A
`verified_source_map` contribution may support source-position map display;
`verified_interaction_zone` supports zone-level totals only and must never be
rendered as a source point. The public response preserves these classes in
aggregate coverage metadata. A scope receiving both classes reports them
separately so interaction evidence is not presented as source-map coverage.

Canonical mappings come from a versioned, CI-validated WoW Forever map manifest.
The manifest records map IDs, parent IDs, map type, continent ancestry, and the
evidence/build used to classify each map as continent, zone, or city. The
registry is product-scoped and includes the actual Forever `wowf` product; it
does not use an exact client-build allowlist. A verified mapping can be reused
by later Forever builds when map identity, hierarchy, map type, coordinate
space, and geometry remain compatible. Content hashes and metadata
fingerprints provide evidence: matching fingerprints support reuse, while
changed content triggers validation of the affected map and regeneration only
when necessary. A build-number change alone is not incompatibility, and an
unverified build is never labelled verified. Runtime display names and
`subZoneName` are never sole mapping keys. The server owns the accepted
registry. Unknown, invalid, or ambiguous map identities resolve to `Unknown`
and are reported as coverage gaps until reviewed evidence is added.

## Collection and snapshot contract

At `RecordObservation`, use an event-type-specific attribution resolver; do
not treat player coordinates as source coordinates. The contract distinguishes
four evidence states:

1. `verified_source_map`: an API or validated source record explicitly ties
   the observed source identity to a verified coordinate map. Only this state
   can support source-position markers.
2. `verified_interaction_zone`: a concrete source identity is tied to a loot
   interaction event, and a valid, unambiguous player zone/map identity is
   sampled synchronously with that event. This proves the zone where the loot
   interaction was recorded, not the creature/node's exact coordinates or
   necessarily its spawn point. It may contribute to zone-level counts only;
   its player coordinates are never reused as source coordinates.
3. `unverified_player_position`: a player map/position exists without an
   event-to-source interaction link. It remains provenance/context only and
   contributes to no named geographic scope.
4. `unknown`: source, map, timing, or zone identity is absent, contradictory,
   or ambiguous. This is the safe result for all other event types.

For a loot interaction, the resolver requires one recognized, unambiguous
source GUID from the loot API; an event-time player map ID that resolves to
matching valid map metadata; a non-empty zone identity consistent with that
map; no map/zone transition during capture; and, for a pending gathering or
fishing action, a matching source and still-valid interaction window. Missing
map metadata, multiple candidate sources, a mismatched pending source, a
stale interaction, or inconsistent map/zone readings fail closed to `Unknown`.
An ID such as 1420 is not sufficient by itself: map IDs can have distinct
zone labels/aliases, so the map ID and validated zone identity are considered
together. The registry must preserve the evidence class and must not promote
interaction-zone counts to source-map counts. Creature loot can therefore be
zone-attributed without claiming exact creature coordinates only when those
checks pass. Quest rewards, crafted items, mail, and events without a linked
source interaction remain `Unknown` unless a separate event-specific resolver
is proven.

Player position outside the linked interaction callback remains
`unverified_player_position` context only. The resolver and evidence type are
part of the geography contract and are tested per event type.

Increment exactly one scoped source observation bucket, including events with
no items or zero drops. For each item observed in that event, increment the
matching scoped item drop count, quantity, quest-drop count, and quest ID set.
Preserve the existing global counters unchanged. Unknown-attributed events
remain in Unknown contribution and coverage counters, but are excluded from
named zone/city and continent totals; they are never discarded or redistributed.
Coverage reports known versus Unknown observations so the UI can explain the
gap without presenting Unknown as a geographic area.

The addon SavedVariables schema advances and exports a versioned geography
contract alongside the existing global source data. The scoped aggregate grain
is:

- source: `(canonical scope ID, source type, source ID, source level, loot kind)`
- item: the source grain plus `item ID`

Where separate coordinate maps feed the same canonical scope, retain their
map identities in the bounded location aggregate/provenance grain so map
rendering does not collapse different coordinate spaces.

The export preserves the existing location records unchanged. It does not
derive scoped item counts by joining those records later.

The Companion parser adds typed scoped source and item models. The
`PublicObservationSnapshot` allowlist explicitly includes these models and the
geography contract version, but continues to exclude Guildbook capture, roster,
member, and profession data. Payload size and collection row limits must be
measured against the 0019 8 MiB/2,500-source bounds; new scoped rows receive
their own preflight limits and clear PT413 errors rather than partial upload.

## Database schema proposal

Add a forward-only migration (next free migration number after reviewing the
branch's migration ledger) with:

1. `geographic_scopes`: server-owned stable IDs, `scope_kind` (`continent`,
   `zone`, `city`, `unknown`), canonical label, parent scope, evidence version,
   and active/verified state. Zone and city scopes point directly to one
   continent. Unknown has no continent parent.
2. `geographic_map_registry`: product/map identity to canonical terminal scope,
   including verified parent map ID, map type, build/manifest evidence, and
   mapping status. A map identity can resolve to no more than one active
   terminal scope.
3. `installation_geographic_source_stats`: installation + canonical scope +
   attribution evidence class + source identity + loot kind, with observations.
4. `installation_geographic_item_stats`: the same key plus item ID, with drop,
   quantity, quest-drop counts and quest IDs.
5. Installation geography/revision metadata: geography contract activation
   state, contract version, first complete scoped snapshot/update time,
   monotonic revision high-water, and versioned canonical global-projection
   digest for safe legacy bootstrap comparison. This distinguishes a true
   scoped collection interval from an installation's earlier Global/Legacy
   history and allows bootstrap/replay checks before destructive writes.

All installation tables remain private aggregate inputs: enable RLS, revoke
direct `anon` and `authenticated` table access, and grant no raw-table access to
public roles. Existing global tables and views are not rewritten. Guildbook
tables, grants, cleanup paths, and local-only semantics are not touched.

Ingest behavior is version-gated by an explicit geography contract field, not
the general addon schema version alone. This matters because an older Companion
may parse a newer addon export but omit unknown fields when building its public
DTO.

- A current geography contract is validated against the server registry and
  monotonic revision ordering, then replaces that installation's scoped rows
  atomically with the global rows.
- A legacy payload with no geography contract retains existing timestamp-only
  global behavior only until that installation has accepted its first
  geography-aware snapshot. After activation, timestamp-only payloads are
  rejected with a version-conflict response at lower, equal, or higher
  timestamps; neither global nor scoped rows, coverage state, nor revision
  high-water are changed. This prevents old clients from silently replacing
  newer global state or deleting scoped contributions.
- A new Companion with an old Addon, or a new Addon with an old Companion,
  keeps global-only behavior before geography activation. Once activated, the
  old side must be upgraded before that installation can sync again; the
  Companion reports the required update.
- A new Addon against a backend without the geography migration keeps legacy
  global behavior only if the installation has not already activated the
  geography contract. The Companion reports scoped statistics unavailable.
- Fork recovery is an explicit fresh-collector operation. It preserves the
  prior installation and server aggregates, creates a new authorized
  installation identity, and starts with zero historical observations,
  item/quest counts, scoped counts, and locations. Only post-fork events are
  uploaded under the new identity. Historical counters are never copied to a
  second installation, preventing global double counting.
- A newer map identity absent from the validated registry is stored in
  Unknown, not rejected as an invalid global observation.

The stale/bootstrap/revision checks remain before any deletes. Equal-revision
replay replaces the same per-installation sets and produces identical
aggregates. No Guildbook field is copied into the scoped ingest projection.

## Scoped query API

Add bounded, budgeted SECURITY DEFINER RPCs with empty `search_path`, following
the existing authenticated Companion API gate and explicit grants. RPCs return
aggregate data only; installation IDs and installation-level rows never leave
the database.

Required inputs are a scope ID (or All zones), bounded query/page parameters,
and existing entity keys for detail. The database validates scope IDs against
the registry. Continent RPCs aggregate verified terminal zone/city descendants;
zone and city RPCs aggregate one terminal scope. The query surface returns:

- distinct item/source search entities and exact total counts;
- scoped source observations including installations with zero item drops;
- scoped item drops, quantity, quest semantics and observed drop rate;
- safely aggregated location cells for matching source/map identities,
  preserving coordinate map identity and returning deterministic coarse-cell
  coordinates instead of individual observation points;
- aggregate coverage metadata distinguishing scoped collection from Global /
  Legacy history.

No RPC returns per-installation records or installation identifiers. Location
counts and rates are grouped server-side by source/map and coarse spatial cell,
subject to a minimum independent-installation cohort threshold. Cells below
the threshold are suppressed or rolled into a coarser cell. Each RPC has
bounded page size, result count, execution budget, and payload size. Responses
contain only aggregate counts/rates and safe cell coordinates; they never
expose raw coordinates, per-installation locations, or a way to infer one
installation's contribution. These controls apply to detail and map endpoints
as well as search.

The denominator is computed from geographic source rows independently of item
rows, matching the zero-drop correctness fixed for global statistics in
migration 0011. Continent aggregates sum terminal scopes once. Search and
catalog remain server-side and bounded; the Companion does not fan out to every
zone.

All zones continues using the existing global stats contract, including
historical records. Scope-specific RPCs never silently mix Global / Legacy
rows into zone numerators or denominators. They expose scoped coverage start and
whether legacy coverage is excluded so the UI can label incomplete coverage.

The public website read database is physically separate and currently consumes
global projection contract v1. This feature does not alter v1. If zone/city
statistics are later published to website clients, add an aggregate-only v2
projection and its separate threshold/privacy review; do not expose raw
installation rows or reuse Companion RPC access for the website.

## Migration dependencies and rollout

1. Migration 0019 is a required backend prerequisite: it establishes the
   guarded public observation ingestion wrapper and the payload limits on which
   the geography-aware writer builds. Verify 0019 is present before applying
   the future additive geography migration. That migration must preserve the
   0019 auth, payload, size, source-count, and Guildbook-stripping protections.
   Environments without 0019 retain their existing global contract only;
   scoped ingestion is unavailable. An installation already marked as
   geography-active cannot fall back to timestamp-only ingestion if the
   geography migration is absent; fail closed and require the supported
   backend/client pair.
2. Generate and review the canonical map registry from WoW Forever metadata
   and client assets. Discover supported `wowf` builds automatically; do not
   maintain an exact-build allowlist. Validate map identity, hierarchy, map
   type, coordinate space, geometry, and content/metadata fingerprints. Reuse
   mappings when checks pass; flag affected maps for regeneration only when
   evidence shows asset or geometry changes. Check duplicate aliases, parent
   cycles, invalid map types, missing continent ancestry, and city/zone
   classification. Unverified maps remain Unknown and unverified builds are
   never labelled verified.
3. Add the geography-aware Addon event aggregation/export and parser DTO behind
   the explicit geography contract version. Keep global counters byte-for-byte
   equivalent, preserve schema-9 exports, and add monotonic snapshot revisions.
4. Add the additive SQL migration, transactional ingest and aggregate-only
   scoped RPCs. Run migration preflight, rollback-shape checks and security
   assertions only in local/CI PostgreSQL + GoTrue environments.
5. Update the Companion Search UI to Continent → Zone / City, remove subzones as
   selectable/statistics scopes, call server-side scoped RPCs, display
   coverage, and switch maps only within one coordinate identity.
6. Add a supported-client rollout note. New Addon/Companion pair requires both
   migration 0019 and the follow-on geography migration for scoped APIs; old
   clients and backends without these migrations keep global collection only.
   No production migration, environment creation, deployment or PR merge is
   included in this design or its first implementation PR.
7. After owner approval, execute a separate deployment plan with production
   preflight, backup/rollback, migration ordering, client compatibility window,
   and post-deploy validation. No production change occurs by merging code
   alone.

No historical backfill is planned. Existing location metadata remains
available for maps, but historical item drops and rates remain Global / Legacy
because their numerator cannot be connected reliably to a location.
Unknown coverage is reported separately and is never imputed to a named zone
or city.

## Verification plan

All database tests run against disposable local PostgreSQL and real local
GoTrue test stacks already used by `database/tests/enrollment`; CI must never
connect to a paid staging or production Supabase project for these tests.

Fixtures and integration cases cover:

- one source observed in two zones, with separate observation denominators;
- one item with different drops/rates in two zones;
- an observation bucket with zero item drops, included in the denominator;
- city totals included once at continent scope and absent from surrounding zone;
- continent rollup equals its zone + city leaves with no double counting;
- Global / Legacy rows remain in All zones but never enter scoped rates;
- unknown, invalid, ambiguous, and newly added map IDs; compatible `wowf`
  builds reusing validated map mappings, content/metadata changes triggering
  targeted validation, and build-number-only changes not producing false
  incompatibility;
- current contract, old Addon payload/old Companion projection before and after
  geography activation, and explicit fork recovery;
- concurrent snapshots, same-second revisions, exact replay, conflicting
  duplicate revision, stale snapshot no-op, and downgrade/return to a legacy
  client where post-activation legacy requests are rejected without changing
  global/scoped state or the revision high-water mark;
- atomic rollback on invalid scope/oversized payload;
- event-specific attribution for verified source maps, verified loot
  interaction zones without source coordinates, player-position-only events
  resolving to Unknown, and ambiguous source/map relationships (including
  duplicate map IDs with different zone labels, map transitions, invalid map
  metadata, multiple source GUIDs, and stale/mismatched pending interactions);
- exact quest-drop/quantity semantics and preservation of original coordinates;
- unauthenticated and anonymous-key-only RPC denial; authenticated gate,
  execution/payload budgets, row caps, aggregate-only output, independent
  installation cohort thresholding, coarse location cells, and absence of
  per-installation output;
- negative assertions that no Guildbook key/table is accepted into or returned
  from the public observation API.

Addon Lua smoke tests verify each event increments exactly one leaf/Unknown
scope and preserves the existing global counters. Companion integration tests
assert the selected scope is sent to the correct RPC and every displayed
result/count/rate/location reflects only that scope. Windows CI builds the
current x64 Companion and runs full map-mode/coordinate regressions.

## Non-goals

- Reconstructing geographic statistics for historical drops.
- Independent subzone statistics or filtering.
- Rewriting global table primary keys or changing existing global RPC meaning.
- Changing map coordinate transforms, atlas assets, or Full Reveal behavior.
- Publishing installation-level data or Guildbook data.
- Applying any production migration, deploying, creating staging, or merging.

## Owner review decisions already made

- Additive scoped tables plus a validated server map registry.
- Cities are selectable leaf scopes under their continent; no zone-level
  double-counting of city observations.
- Historical data remains Global / Legacy without geographic backfill.
- Implementation is phased and the PR remains Draft until all verification and
  owner acceptance gates pass.
