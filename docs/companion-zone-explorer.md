# Companion hierarchical zone explorer

Status: **implementation in progress; not acceptance-ready**.

The Companion now builds the zone navigation tree from observed search scopes
and the addon's exported `UiMapID` / `parentMapID` records. A missing or cyclic
parent chain is shown under **Unknown mapping**. Multiple database zone labels
that share one `UiMapID` are shown under **Observed labels on this map**; the
client does not treat those labels as verified geographic descendants.
Searching the tree retains matching parent nodes and expands the path. Selecting
a verified parent scope composes its observed `map_id + zone_name` children via
the existing bounded search/catalog RPCs, and duplicate entities are removed.

## Existing API boundary

The current backend exposes zone search and zone catalog by one exact
`map_id + zone_name` pair. The Companion can therefore compose those existing
queries for a continent or parent map without a schema change. The result is
still the backend's existing *observed source in zone* association; it does not
prove where an individual item drop occurred.

The current stats RPCs return item/source aggregates without geographic scope.
Location RPCs return points but do not expose item identity for source locations
or scope-specific drop counts. Consequently, the current API cannot correctly
recompute every detail row's observations, drops, rate, or source-type counters
for a selected subzone. This Companion-only change must not claim that those
detail aggregates are scope-specific until the API supplies the required
geographic grouping. The current implementation clears old detail/map state on
scope change to prevent stale overlays, but it does not yet satisfy the complete
per-detail filtering contract.

Subzone/city discovery also depends on exported map metadata. `parentMapID`
establishes only map hierarchy; it cannot turn a free-text `subzone_name` into a
verified UiMapID. Such values must remain explicitly ambiguous until a stable
map or area identifier is available.

## Verification required

- Windows WPF build and UI keyboard/focus acceptance.
- Integration tests for aggregate scope requests and paging/unique counts.
- A backend contract decision for correctly scoped detail aggregates before
  claiming the full acceptance criteria.
- Regression checks for map markers, clusters, heatmap and full reveal after
  scope changes.
