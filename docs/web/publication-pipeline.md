# Publication pipeline — operations runbook

```
production (0010 publication_export.*) ──[projection_reader, RR read-only snapshot]──▶ publisher
publisher: strict contract parse → sanitize → thresholds → Wilson/confidence → zones/search index → SHA-256
publisher ──[publisher role, ONE transaction]──▶ begin_publication → INSERT staging rows (RLS) → finalize_publication
finalize: counts · FK integrity · denominator invariant · empty/shrink guard · duplicate hash → atomic pointer swap
```

## Commands (`publisher/`)

| Command | Needs | Effect |
| --- | --- | --- |
| `npx tsx src/cli.ts export --out f.json` | `PRIVATE_EXPORT_DATABASE_URL` | Writes the aggregate export (for dry runs/debugging; treat the file as internal) |
| `npx tsx src/cli.ts build --from-export f.json --out p.json` | — | Offline projection and report |
| `npx tsx src/cli.ts publish --dry-run` | export URL | Builds and validates, writes nothing |
| `npx tsx src/cli.ts publish [--from-export f.json]` | both URLs | Publishes. Exit ≠ 0 on any failure |
| `--allow-shrink` | — | Operator override when the item count legitimately drops > 50 % |

Logs are one JSON line per event (`projection_built`, `publication_finished`, `publication_failed_closed`, `publication_error`). They contain counts, rejection reasons and the hash, **never row values or connection strings**.

## Scheduling (production design)
Publication is Supabase-native: `pg_cron` (`*/15 * * * *`) → `pub_ops.invoke_publisher()` → `pg_net` → Edge Function `publish-observations`, secured with Vault.
The website runtime holds none of the worker secrets. Concurrency is serialized by a lease table plus a transaction-scoped advisory lock (overlapping runs answer `skipped_busy`).
Operations (status, pause/resume, rollback, telemetry): [public-publication-operations.md](public-publication-operations.md). Measured limits and verdict: [public-publication-benchmarks.md](public-publication-benchmarks.md).
The GitHub Actions workflow `publish-public-db.yml` remains manual-only (break-glass); it is not the default publisher.

## Failure handling
- `publication_failed_closed: export_contract_violation`: the export shape changed. Do not widen `contract.ts` without an allowlist review.
- `publication_failed_closed: export_too_large`: the private export holds more rows than the safety threshold (sum of `sources`, `items`, `buckets`, `drops`, `locations`; default **120,000**, optional `limits.maxExportRows` in `publication-config.json`). The detail carries counts only (`limit`, `section`, `rowsReadBeforeStop`, rows per collection read so far). The limit is enforced **in the database read** (`readPrivateExport` reads each collection with `limit <remaining budget> + 1` inside the one repeatable-read snapshot), so an oversized export is never loaded into the worker, validated or written, and the previous active publication is untouched. It is a memory safety threshold, **not** a promise that an export of that size finishes inside the Edge CPU budget (measured ceiling: about 36-43k input rows, see `public-publication-benchmarks.md`). Investigate why the export grew. `limits.maxExportRows` can only **lower** the threshold: **120,000 is a hard ceiling** (the config schema, `maxExportRows()` and `readPrivateExport` all enforce it), because the measured memory of the whole pipeline is already close to the 256 MB Edge limit at that size. Going above it is a code change that needs a fresh memory benchmark on the hosted runtime, not a config edit. The metadata query `export_meta_v1()` is bounded as well (`limit 2`; exactly one row is its contract, more fails closed as `export_meta_invalid`).
- **Memory protection is not CPU capacity.** The 120,000-row threshold protects memory. The Edge **CPU** ceiling is much lower: about 36,000-39,000 input rows (25-27x synthetic scale, 2 s CPU limit; 30x, 43,470 input rows, was killed by the platform), so an export that passes the guard can still end as a platform CPU kill, which fails closed with the previous publication active but without an `export_too_large` diagnostic. An operational limit below 120,000 must come from hosted-runtime benchmarks and observed production runs, not from a guess (60,000, for example, is above the measured CPU ceiling and therefore not a guaranteed safe value).
- `export_contract_violation` now stops validating at **20** issues (`detail.issues`, `detail.truncated`): memory and work for a failing export are bounded, the report is still `{path, code}` only.
- `rejection_ratio_exceeded` / `anomaly_ratio_exceeded`: possible poisoning or a collector bug. Investigate in production with read-only aggregate queries. The site keeps serving the previous publication.
- `Projection shrank …`: confirm intent, then rerun with `--allow-shrink`.
- Rollback: as the public DB owner, `select pub_admin.activate_publication(<id>);` (ids from `select pub_admin.status();`). Retained: the last 3.

## Freshness monitoring (to configure)
Alert when `now() - (web_api.meta()->>'publishedAt')::timestamptz > 3 hours` while the export's `data_updated_at` keeps advancing, and when any run exits non-zero twice in a row. `/api/v1/meta` exposes `publishedAt` for an external uptime/freshness probe.

## Fixture regeneration
`cd web && npm run fixture:refresh` rebuilds the committed **synthetic** projection from `database/tests/fixtures/synthetic_private_export.json`. That export comes from the synthetic seed (`generate_synthetic_private_seed.py`) applied to an ephemeral replica. Never run it on real data.
