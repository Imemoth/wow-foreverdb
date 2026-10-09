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

## Scheduling (proposed)
Run hourly from a scheduled job that holds the two worker secrets, e.g. a GitHub Actions `schedule` workflow in a protected environment with required reviewers for secret changes, or a small scheduled container. The website runtime must **not** hold these secrets. Concurrency is serialized with a transaction-scoped advisory lock.

## Failure handling
- `publication_failed_closed: export_contract_violation`: the export shape changed. Do not widen `contract.ts` without an allowlist review.
- `rejection_ratio_exceeded` / `anomaly_ratio_exceeded`: possible poisoning or a collector bug. Investigate in production with read-only aggregate queries. The site keeps serving the previous publication.
- `Projection shrank …`: confirm intent, then rerun with `--allow-shrink`.
- Rollback: as the public DB owner, `select pub_admin.activate_publication(<id>);` (ids from `select pub_admin.status();`). Retained: the last 3.

## Freshness monitoring (to configure)
Alert when `now() - (web_api.meta()->>'publishedAt')::timestamptz > 3 hours` while the export's `data_updated_at` keeps advancing, and when any run exits non-zero twice in a row. `/api/v1/meta` exposes `publishedAt` for an external uptime/freshness probe.

## Fixture regeneration
`cd web && npm run fixture:refresh` rebuilds the committed **synthetic** projection from `database/tests/fixtures/synthetic_private_export.json`. That export comes from the synthetic seed (`generate_synthetic_private_seed.py`) applied to an ephemeral replica. Never run it on real data.
