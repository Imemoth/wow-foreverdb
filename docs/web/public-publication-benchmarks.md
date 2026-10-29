# Public publication — measured results, scalability and verdict

All numbers were measured on the hosted public project (`chcoypkjzxfznsqmmbrq`, eu-west-1) unless marked "local".
CPU figures are the platform's own `cpu_time_used` from the Edge `Shutdown` log record; wall time is the function's own
`totalMs`/phase timers. Neither is derived from the other.
Synthetic data (`source: "synthetic"`) is refused for `publish` and was only ever run as `dry_run`/`rehearse`
(full write path, then ROLLBACK): nothing synthetic exists in the public database.

## Verdict

**`SUPABASE_NATIVE_PUBLISHER_PASS_WITH_LIMITS`**

- The Edge Function runs the genuine transformation and publication; Cron → pg_net → Edge → public Postgres is authenticated end to end.
- **Limiting factor (measured): the Edge Function CPU limit of 2 s per request**, reached at roughly **25–27× the current volume**
  (30× is killed by the platform: `reason: CPUTime`, HTTP 546). Memory (~110 MB heap at 30× of a 256 MB limit) and wall time (28 s of 150 s) are not limiting.
  At today's real volume the run uses a small fraction of the budget (see Benchmark A).
- **Smallest viable adjustment beyond ~20×**: keep the Edge Function but split the run into several invocations that stage
  chunks into one *staging* publication and activate atomically at the last invocation (the schema already stages before
  `finalize_publication`); or push the aggregation into Postgres. Not implemented: not needed at current volume.

## Benchmark results

| | Workload | Result |
| --- | --- | --- |
| A | Real data, first publish | 133 sources / 138 items / 152 buckets / 375 drops / 552 location rows in → 132 / 138 / 151 / 373 / 5 zones / 283 zone entities / 157 published location cells / 270 search entries out (4 of ~798 records rejected = 0.5 %, limit 5 %). Publication **10 ACTIVE**, 1,509 rows, 663.7 ms total (public write 174.9 ms, activation 12.2 ms, 24 DB ops). Private export read: connect ~240 ms, export query ~46–128 ms, 8 ops |
| B | Same content again | `duplicate`, recognised **before** any write: 0 rows, 462 ms, 14 ops; the active publication stays 10 |
| C | Controlled failure | Local (`scripts/public-failure-recovery-tests.sh`): shrink guard failure keeps the previous publication with no leftovers; contract violation persists/echoes no canary; SIGKILL mid-write then lease recovery. Hosted: failed runs are logged with error class only |
| D | Concurrency | Hosted: 3 simultaneous invocations → 1 `rehearsal_ok` (4.46 s), 2 `skipped_busy` (~170–250 ms; ~60–77 ms CPU each). Local: two overlapping runs → exactly one proceeds |
| E | Growth (synthetic, rehearse) | see table below |
| F | Scheduled execution | see "Scheduled runs" below |

### E — growth (synthetic, `rehearse`, hosted)

**Unit of "Rows" below: rows WRITTEN (the projection's output rows), not input rows.** Input rows (the five export collections) are far fewer: synthetic scale 10 = 14,490 input rows -> 35,294 output rows; scale 25 = 36,225 -> 87,849; scale 30 = 43,470 -> 105,722; scale 83 = 120,267 -> 292,040. The real export today is 1,350 input rows. So the Edge CPU ceiling (25-27x) corresponds to roughly **36-39k input rows**.

| Scale | Rows | CPU (platform) | Wall | Notes |
| --- | --- | --- | --- | --- |
| 1× | ~3.5k | 147 ms (dry run), 165 ms (rehearse) | 209 / 493 ms | |
| 10× | 35,294 | ~790–817 ms | 2.9 s | |
| 20× | 70,585 | 1,485 ms | 5.9 s | heap 53 MB |
| 25× | 87,849 | 1,896 ms (95 % of limit) | 28.2 s | activation/validate 19.6 s, write 6.6 s, heap 67 MB |
| 30× | — | killed at 2,006 ms | — | `reason: CPUTime`, HTTP 546, heap ~110 MB |

The dominant CPU consumer is `projectBuild` (zod parse + build + hash). Before the optimisation commit the projection was O(n²)
(10× cost ~1.5 s CPU); single-pass indexes brought it to ~0.8 s with byte-identical hashes (golden tests in `publisher/test/golden-hash.test.ts`).
Node-side CPU for the same projection is in `publisher/scripts/bench-projection.ts`.

### Cron mechanics (rehearsal-only job, since removed)
Two ticks at :00: pg_cron reported "succeeded" in 32 ms and 4 ms (it only enqueues the HTTP call), Edge `rehearsal_ok` in 972 ms and 1,036 ms,
~195 ms CPU, ~1 s wall each.

## Scheduled runs (production schedule `*/15 * * * *`, enabled 2026-10-21 09:50 UTC)

| Tick (UTC) | Trigger | Outcome | Platform CPU | Wall (`totalMs`) | Rows written |
| --- | --- | --- | --- | --- | --- |
| 2026-10-21 10:00:00 | pg_cron (job 2) | `duplicate` (no-change, pre-write detection), publication 10 stays active, run id 21 | 183 ms (`reason: EarlyDrop`, heap 9.8 MB) | 873.5 ms (connect 134 + 307 ms, export query 90 ms, projection 247 ms, precheck 50 ms) | 0 |

pg_cron reported `succeeded` after 17 ms (it only enqueues the pg_net call); the HTTP response was 200.

**Scheduled activations of new real content (observed 2026-10-21):** after genuine Companion uploads changed the aggregate export, Cron produced
real publications on its own: run 24 (10:45 UTC) activated **publication 11** (source data freshness 2026-10-21 10:42, 1,397 ms wall) and run 25
(11:00 UTC) activated **publication 12** (freshness 10:50, 1,115 ms); run 26 (11:15 UTC) was a `duplicate` no-change run (1,218 ms) leaving 12 active.
Six consecutive Cron ticks (10:00–11:15) all `succeeded` with no `failed` run; publications 10 and 11 are retained for rollback. Counts were unchanged
(132 sources / 138 items / 157 cells) because the new observations did not cross the publication thresholds yet. No data was inserted to force any of this.
The full write path was additionally exercised by the rehearsal-only Cron job above.

## What is not proven

- Behaviour above 25× real volume was measured with synthetic data only (by design); real volume is ~1×.
- Platform CPU for real-data runs is available in Edge logs only for runs still inside the log retention window.
- The website's read path against the published data was verified through the `web_api` functions as `foreverdb_web_reader`
  (zones 1420/1412/1421 and Copper Vein 1731 returned real cells); the Vercel Preview itself is blocked on an owner action (see operations doc).

## Export size guard (#137): measured on the shared core, Node 24, local PostgreSQL 16

Safety threshold: 120,000 total input rows (sum of the five collections), enforced in the database read (see `publication-pipeline.md`) and again before validation.
It bounds memory; it does **not** mean such an export completes: synthetic scale 83 (120,267 input rows) needs 3.3 s of `buildProjection` in Node against the 2 s Edge CPU limit.

**Valid exports, old vs new code (validation + projection, medians; run-to-run spread about +/-8 %):**

| Export | Validation old / new | `buildProjection` old / new |
| --- | --- | --- |
| production-sized, 1,350 rows | 3.21 / 3.18 ms (validation only) | n/a |
| scale 1 (1,449 rows) | 3.1-3.3 / 3.2-3.4 ms | 25.4-25.9 / 24.3-27.0 ms |
| scale 10 (14,490 rows) | 33.5-35.9 / 37.6-38.3 ms | 298.7-312.8 / 301.0-305.7 ms |
| scale 25 (36,225 rows) | 87.4-90.5 / 94.8-98.2 ms | 815.8-836.8 / 770.1-895.0 ms |

Published content is byte-identical (golden hashes unchanged; the same content hash through the database read path).

**Database read, real PostgreSQL with synthetic export functions (old = unbounded, new = limit 120,000):**

| Rows in the database | Old | New |
| --- | --- | --- |
| 1,350 | loaded, 16 ms, heap +4 MB | identical |
| 88,000 | loaded, 341 ms, heap +33 MB, RSS +59 MB | identical cost |
| 120,000 | loaded, 460 ms, heap +40 MB, RSS +92 MB | loaded, 450 ms |
| 150,000 | loaded, 572 ms, RSS +100 MB | **refused** (`export_too_large`) |
| 1,000,000 | loaded, 3.9 s, heap +343 MB, RSS +448 MB (above the 256 MB Edge limit) | **refused**, 0.6 s, heap +59 MB, RSS +99 MB |

**Many invalid rows (every row fails, 4 issues per row):**

| Rows | Old (`PrivateExport.safeParse`) | New (bounded) |
| --- | --- | --- |
| 1,000 | 4,000 issues, 30 ms, +4 MB | 20 issues, 6 ms, +0 MB |
| 100,000 | 400,000 issues, 1.2 s, **+376 MB** | 20 issues, 5 ms, +1 MB |
| 1,000,000 | **out of memory at 2 GB** | 20 issues, 5 ms, +0 MB |

