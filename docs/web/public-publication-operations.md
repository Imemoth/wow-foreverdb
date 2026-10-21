# Public publication — Supabase-native operations runbook

```
private Supabase (wow-forever)                     public Supabase (azerdex-public-read, chcoypkjzxfznsqmmbrq)
  publication_export.* (migration 0010)              pg_cron  */15 * * * *  ──▶ pub_ops.invoke_publisher()
        ▲  foreverdb_projection_reader                                              │ pg_net POST (gateway JWT + x-publish-token, both from Vault)
        │  (read-only, RR snapshot)                                                 ▼
        └────────────────────────────── Edge Function publish-observations ─── SET LOCAL ROLE foreverdb_publisher
                                          projection → staging inserts → finalize_publication → atomic activation
                                                                                    │
                                                         web_api.* (foreverdb_web_reader) ◀── Next.js on Vercel (GET only)
```

All business logic is the shared core in `publisher/src/core`, copied byte-for-byte into
`supabase/functions/publish-observations/core` by `node scripts/sync-edge-core.mjs` (`--check` runs in CI).
The Node CLI (`publisher/src/cli.ts`) and the Edge Function run the same `runPublication`.

## Secrets and where they live

| Secret | Location | Never in |
| --- | --- | --- |
| `publish_invoke_token` | public Vault (generated inside the DB, never displayed) | Git, logs, browser |
| `publish_gateway_jwt` | public Vault (the project's public anon JWT) | — |
| `private_export_database_url` (login `foreverdb_projection_reader`) | public Vault, read only by `foreverdb_publisher` via `pub_ops.private_export_url()` | Git, logs |
| `SUPABASE_DB_URL` | injected by Supabase into the Edge runtime | — |
| `PUBLIC_READ_DATABASE_URL` (web reader) | Vercel Preview/Production env (sensitive) | Git, browser bundle |

Setting/rotating the export credential: `select pub_ops.set_private_export_url('<url>');` — it accepts only a URL for the
`foreverdb_projection_reader` user. Rotating the invoke token: `select pub_ops.configure(...)` (see 0004) and re-run `set_schedule`.

## Status (one call)

```sql
select pub_admin.ops_status();           -- as foreverdb_publisher or the project owner
select * from pub_ops.cron_status(5);    -- cron job + last pg_cron runs + last publisher runs
```

`ops_status` returns: `activePublicationId`, `activatedAt`, `sourceDataUpdatedAt`, `counts`, `lastRun`, `lastSuccessfulRun`,
`lastActivation`, `lastPublishDurationMs`, `lastError`, `lastSuccessAgeSeconds`, `stale` (no confirmed run in 45 min),
`previousAvailableForRollback`, `retainedPublicationIds`, `lease` (`heldNow`, `abandoned`) and `runsLast24h`.

## Pause Cron

```sql
select pub_ops.set_schedule(false);      -- unschedules; the site keeps serving the active publication
```

## Resume safely

1. `select pub_admin.ops_status();` — confirm no `lease.heldNow` (or wait ≤ 300 s for an abandoned lease to expire).
2. Prove the path without writing: invoke the function with `{"mode":"dry_run"}`, then `{"mode":"rehearse"}` (full write path, then ROLLBACK):
   `select pub_ops.invoke_publisher('manual', 'rehearse');` and read the result in `net._http_response` / Edge logs.
3. `select pub_ops.set_schedule(true);` — default `*/15 * * * *`.
4. Watch `pub_ops.cron_status()` for the next tick.

## Roll back a bad publication

The previous three publications are retained. As the database owner (role `foreverdb_pub_owner`; **not** granted to the publisher or the web):

```sql
select pub_ops.set_schedule(false);                 -- stop new publications first
select pub_admin.status();                          -- find the id to restore
set role foreverdb_pub_owner;
select pub_admin.activate_publication(<id>);        -- atomic pointer swap, instant
reset role;
```
Fix the cause, then resume as above. A republished unchanged export is recognised as a duplicate of the *active* one only, so after a rollback the next run will publish the current export again — pause Cron until the cause is fixed.

## Failure behaviour (verified)

| Situation | Behaviour |
| --- | --- |
| Export contract violation, shrink/empty guard, rejection ratio, FK/denominator check | Whole publication rolls back; previous publication stays active; run logged `failed` with an error class (no row values) |
| Unchanged content | Detected **before any row is written** (`duplicate`, 0 rows) |
| Overlapping runs (Cron + manual) | Lease + `pg_try_advisory_xact_lock`: the second run answers `skipped_busy` and writes nothing |
| Platform kills the Edge worker (CPU limit) | Nothing activates (single transaction); our run log is skipped; lease stays held ≤ 300 s; `ops_status.lease.abandoned = true` |
| Private export unreachable / unconfigured | `failed` (`private_export_not_configured` or DB error class); previous publication stays active |
| Synthetic source | Refused for `publish`; allowed only for `dry_run`/`rehearse` benchmarks, which never persist |

## Platform CPU telemetry

`process.cpuUsage()` is not implemented in the Supabase Edge runtime, so the function reports `cpuMs: null` and **does not estimate**.
Real CPU per execution is in the platform's `Shutdown` log record (`cpu_time_used`, `memory_used`, `reason`; `EarlyDrop` = normal, `CPUTime` = killed):

```sql
-- Supabase logs explorer / MCP query_logs, source function_logs
select timestamp, event_message, metadata from function_logs where event_message like 'Shutdown%' order by timestamp desc limit 20
```
Wall times in run metrics (`totalMs`, `projectBuildMs`, `publicWriteMs`, `activationMs`) are wall-clock, never CPU.

## Private side: migration 0010 and kill switch

`0010_public_projection_export` adds `publication_export.*` (SECURITY DEFINER aggregate functions) and the read-only login
`foreverdb_projection_reader` (6 EXECUTEs, 0 table SELECT; `anon`/`authenticated` have none).
Emergency stop, restore and full rollback: `database/rollback/0010_public_projection_export_{kill_switch,kill_switch_restore,rollback}.sql`
(rehearsed non-superuser by `scripts/private-export-hosted-compat.sh`). Companion ingestion tables are not touched.

## Owner-only actions (not possible through tooling)

- Disable the Data API (PostgREST) for the public project in the Supabase dashboard (Settings → Data API); the site uses direct SQL only.
- Delete the retired `diag-db-host` Edge function in the dashboard (it is already inert: HTTP 410).
- Give `foreverdb_web_reader` a login password and set Vercel Preview `PUBLIC_READ_DATABASE_URL` (see `docs/web/vercel-environments.md`;
  use the Supavisor pooler host shown in the Supabase "Connect" dialog, user `foreverdb_web_reader.chcoypkjzxfznsqmmbrq`; Vercel is IPv4-only).
- `supabase_read_only_user` has SELECT through Supabase's own default; it is not used by AzerDex.
