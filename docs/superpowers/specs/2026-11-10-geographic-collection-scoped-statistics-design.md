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

Canonical mappings come from a versioned, CI-validated WoW Forever map manifest.
The manifest records map IDs, parent IDs, map type, continent ancestry, and the
evidence/build used to classify each map as continent, zone, or city. Runtime
display names and `subZoneName` are never used as the sole mapping key. The
server owns the accepted registry. The ingestion payload identifies the
observed map identity, and the server resolves it to one canonical leaf scope;
unknown, invalid, or ambiguous map identities resolve to `Unknown` and are
reported as coverage gaps. New map IDs stay unknown until registry evidence is
reviewed and added.

## Collection and snapshot contract

At `RecordObservation`, resolve the event's observed WoW map ID to a candidate
collection map key. Increment exactly one scoped source observation bucket,
including events with no items or zero drops. For each item observed in that
event, increment the matching scoped item drop count, quantity, quest-drop
count, and quest ID set. Preserve the existing global counters unchanged. If
there is no trustworthy map identity, increment the explicit Unknown bucket.

The addon SavedVariables schema advances and exports a versioned geography
contract alongside the existing global source data. The scoped aggregate grain
is:

- source: `(scope map identity, source type, source ID, source level, loot kind)`
- item: the source grain plus `item ID`

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
   source identity + loot kind, with observations.
4. `installation_geographic_item_stats`: the same key plus item ID, with drop,
   quantity, quest-drop counts and quest IDs.
5. Installation geography coverage metadata: geography contract version and
   the first complete scoped snapshot/update time. This distinguishes a true
   scoped collection interval from an installation's earlier Global/Legacy
   history.

All installation tables remain private aggregate inputs: enable RLS, revoke
direct `anon` and `authenticated` table access, and grant no raw-table access to
public roles. Existing global tables and views are not rewritten. Guildbook
tables, grants, cleanup paths, and local-only semantics are not touched.

Ingest behavior is version-gated by an explicit geography contract field, not
the general addon schema version alone. This matters because an older Companion
may parse a newer addon export but omit unknown fields when building its public
DTO.

- A current geography contract is validated against the server registry, then
  replaces that installation's scoped rows atomically with the global rows.
- A legacy payload with no geography contract still updates global tables. Its
  geography coverage becomes `legacy` and its prior scoped contribution is
  removed in the same transaction, so a downgrade cannot leave stale scoped
  data visible.
- A new Companion with an old Addon keeps global behavior; no scope-specific
  counts are invented.
- A new Addon against a backend without the migration keeps global collection
  working; the Companion reports scoped statistics unavailable until the
  server capability is present.
- A newer map identity absent from the validated registry is stored in
  Unknown, not rejected as an invalid global observation.

The stale snapshot check remains before any deletes. Equal-timestamp replay
replaces the same per-installation sets and produces identical aggregates.
No Guildbook field is copied into the scoped ingest projection.

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
- raw location rows only for matching source/map identities, preserving the
  coordinate map identity;
- aggregate coverage metadata distinguishing scoped collection from Global /
  Legacy history.

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

1. Generate and review the canonical map registry from the exact WoW Forever
   map metadata used by the addon/runtime. Add data-quality checks for duplicate
   aliases, parent cycles, invalid map types, missing continent ancestry, and
   city/zone classification. Unverified maps remain Unknown.
2. Add the geography-aware Addon event aggregation/export and parser DTO behind
   the explicit geography contract version. Keep global counters byte-for-byte
   equivalent and preserve schema-9 exports.
3. Add the additive SQL migration, transactional ingest and aggregate-only
   scoped RPCs. Run migration preflight, rollback-shape checks and security
   assertions only in local/CI PostgreSQL + GoTrue environments.
4. Update the Companion Search UI to Continent → Zone / City, remove subzones as
   selectable/statistics scopes, call server-side scoped RPCs, display
   coverage, and switch maps only within one coordinate identity.
5. Add a supported-client rollout note. New Addon/Companion pair requires the
   server migration for scoped APIs; old clients keep global collection. No
   production migration, environment creation, deployment or PR merge is
   included in this design or its first implementation PR.
6. After owner approval, execute a separate deployment plan with production
   preflight, backup/rollback, migration ordering, client compatibility window,
   and post-deploy validation. No production change occurs by merging code
   alone.

No historical backfill is planned. Existing location metadata remains
available for maps, but historical item drops and rates remain Global / Legacy
because their numerator cannot be connected reliably to a location.

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
- unknown, invalid, ambiguous, and newly added map IDs;
- current contract, old Addon payload, old Companion projection, replayed and
  concurrent snapshots, and downgrade to a legacy client;
- stale snapshot no-op and atomic rollback on invalid scope/oversized payload;
- exact quest-drop/quantity semantics and preservation of original coordinates;
- unauthenticated and anonymous-key-only RPC denial; authenticated gate, budget,
  row caps and aggregate-only output;
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
