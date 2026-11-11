# Supabase reporting contract and endpoint (DEPLOYED AND ACCEPTED IN PRODUCTION, GO-1)

Status: **applied to production project `chcoypkjzxfznsqmmbrq` on 2026-11-10 and accepted (GO-1); one least-privilege finding is open** (see "Production activation record (GO-1)" at the end: the reporter role inherits pre-existing `PUBLIC` grants on the `pg_net` schema). The bot is **not** connected yet: the production Worker secrets, the Discord resources and the activation are GO-2 and GO-3. Until then the bot runs against the mock provider (staging) and **cannot** run in production (`HEALTH_PROVIDER=mock` is refused there).

Artifacts: `database/ops/0019_ops_health_report.sql` (+ `0019_ops_health_report_rollback.sql`), `supabase/functions/azerdex-ops-health/` (`handler.ts`, `index.ts`), `supabase/config.toml` (`verify_jwt = false`, authentication is the HMAC), tests `database/public-read/tests/ops_health_report.sql` and `scripts/ops-health-sql-tests.sh`, `ops-bot/test/gate-c-handler.test.ts` and `gate-c-e2e.test.ts`, and the owner's post-deployment check `ops-bot/scripts/check-health-endpoint.ts`.

## Goal

Give the bot **one read-only, narrow, authenticated report** about News ingestion health and the G6 job, without giving it a database password, a service-role key, access to the `private` or `cron` schemas, or any write capability.

## Existing production facts this builds on (unchanged)

- `private.azerdex_news_health()`: `SECURITY DEFINER`, owner `postgres`, executable only by `postgres`; returns per source `sourceKey, state, severity, causes[], lastAttemptAt, lastFetchOkAt, minutesSinceAttempt, consecutiveFailures, overdueTopics` (plus fields the bot does not need).
- `private.azerdex_news_assert_healthy()`; cron job 7 `azerdex-news-health` (`*/15 * * * *`, user `postgres`). `cron.job` and `cron.job_run_details` have row-level security keyed on `username = CURRENT_USER`.
- Four other cron jobs (ids 3 to 6) must stay byte-identical.

## Implemented shape

```text
Ops bot (Cloudflare)  --HMAC-signed GET-->  Supabase Edge Function "azerdex-ops-health"  --role azerdex_ops_reporter-->  ops_report.health()  -->  private.azerdex_news_health() + cron.job / cron.job_run_details
```

1. **Projection function** `ops_report.health()` (new schema `ops_report`, `SECURITY DEFINER`, owner `postgres`, `STABLE` so it cannot write, `search_path = pg_catalog`, `statement_timeout = 5s`). It calls the existing G2 function and reads job `azerdex-news-health` from `cron.job` / `cron.job_run_details`, and returns exactly contract v1: fields are copied from the G2 report by name (an allow-list), codes are lower-cased and anything outside the contract's code alphabet becomes `unclassified`, numbers are clamped into the contract's range, `overall` is recomputed from the sources, G6 history is bounded to seven days, at most 16 sources. It **raises** (the endpoint answers 503) if G2 raises, reports no source, or reports an unknown severity: it never invents a healthy answer. A missing G6 job is valid data (`present: false`), which the bot raises as its own critical state.
2. **Dedicated role** `azerdex_ops_reporter` (login, no password in the repository, not superuser / createdb / createrole / bypassrls / replication, no membership, `NOINHERIT`, connection limit 3, read-only and timeout defaults). The migration grants it exactly one function privilege (`EXECUTE` on `ops_report.health()`) and `USAGE` on one schema, and no table or sequence privilege; it cannot call the G2 functions, read `pub`, `private` or `cron`, or create objects. `PUBLIC`, `anon`, `authenticated` and `service_role` have no access to the schema or the function. **Correction found in production (GO-1):** these are the privileges *0019 adds*. The role's *effective* privileges also include whatever the platform grants to `PUBLIC`; on this project that is the `pg_net` schema (details and decision at the end). The disposable local PostgreSQL has no `pg_net`, so the local suite could not show it.
3. **Edge Function** `azerdex-ops-health`: `GET` only (405 otherwise). Authentication is one uniform 401 for a missing or malformed header, a clock skew over 120 s, a wrong signature and an unset secret (fail closed); the signature is `hex(HMAC-SHA256(secret, "<ts>\nGET\n<path>"))`, compared in constant time, and `<path>` is the **configured** signed path (default `/functions/v1/azerdex-ops-health`, overridable with `AZERDEX_OPS_HEALTH_SIGNED_PATH`), not the path the platform shows the function, so the check does not depend on how the host rewrites paths. After authentication it reads the report through the dedicated role (8 s bound; 503 `unavailable` on any database failure), rebuilds it from the contract allow-list (502 `invalid_report` if anything is malformed), and answers with `cache-control: no-store`. The last good report is reused for 10 s, so even an authenticated burst loads the database only a few times a minute. Nothing is logged: no value, header or error text. Replay inside the 120 s window can only repeat a read-only report, which is accepted.
4. **Bot side:** no change to `HttpHealthProvider` or its interface: it already signs `GET url.pathname` and classifies 401/403 as `auth`, 429 as `rate_limited`, 5xx as `server` (503 and 502 included), anything else as `bad_response`. The Worker secrets are `HEALTH_API_URL` (the function URL) and `HEALTH_API_SECRET` (at least 32 random characters, identical to the function's `AZERDEX_OPS_HEALTH_SECRET`).
5. **Why not simpler options:** the bot gets no `postgres` or service-role credential (least privilege); the G2 function is not exposed through PostgREST (no wider Data API surface); a dedicated schema keeps the grant off `private`.

Deviation from the original design: the projection lives in its own schema `ops_report` instead of `private`, so the role needs no privilege on `private`. No cron job is added and no existing object is touched (proved by fingerprints in `scripts/ops-health-sql-tests.sh`).

## Response contract v1 (`ops-bot/src/health/contract.ts`)

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-11-06T12:00:00Z",
  "overall": "ok",
  "sources": [
    { "sourceKey": "blizzard-bluepost-us", "state": "healthy_no_new_content", "severity": "ok", "causes": [],
      "lastAttemptAt": "2026-11-06T11:56:00Z", "lastFetchOkAt": "2026-11-06T11:56:00Z",
      "minutesSinceAttempt": 4, "consecutiveFailures": 0, "overdueTopics": 0 }
  ],
  "g6": { "jobName": "azerdex-news-health", "present": true, "active": true, "schedule": "*/15 * * * *",
          "lastRunAt": "2026-11-06T11:45:00Z", "lastRunStatus": "succeeded", "lastSucceededAt": "2026-11-06T11:45:00Z" }
}
```

Rules: `.strict()` (unknown fields are rejected), `sources` 1 to 16 entries, codes match `^[a-z0-9][a-z0-9_:.-]{0,79}$`, no free text, no ids of players, characters, guilds, accounts or posts. `generatedAt` must be less than 10 minutes old. The server must compute the report itself and must never echo caller input.

## Failure behaviour the bot expects

| Endpoint behaviour | Bot interpretation |
| --- | --- |
| 200 + valid + fresh | Used |
| 401 / 403 | `auth`: UNKNOWN, escalates after 2 polls (configuration or secret problem) |
| 429 (with `Retry-After`) | `rate_limited`: bounded retry, UNKNOWN, escalates after 3 polls |
| 5xx, timeout, network | `server`/`timeout`/`network`: bounded retry, UNKNOWN, escalates after 3 polls |
| 200 but invalid or extra fields | `contract`: UNKNOWN (fail closed) |
| 200 but `generatedAt` stale | `stale`: UNKNOWN (never reported healthy) |

## Validation performed (disposable local PostgreSQL 16 with Supabase stand-ins, synthetic data)

`scripts/ops-health-sql-tests.sh` builds the same hosted-like database as the News SQL tests (non-superuser admin, `cron`/`net`/`vault` stand-ins, the News migrations and the G2 functions), seeds look-alikes of cron jobs 3 to 7, applies 0019 and proves:

- **Nothing that existed changed:** fingerprints of every cron job, every function (body, owner, ACL, config) outside `ops_report`, every schema and relation ACL and every other role are identical before and after applying 0019, after re-applying it, after the tests, and after rolling back and re-applying (jobs 3 to 7 and the G2 functions are byte-identical).
- **Healthy, info, warning, critical, stale and unavailable data** produce the exact contract shape, with the sanitising, clamping and fail-closed behaviour above (12 assertion groups), including every G6 state (present, inactive, missing, never ran, failed, running, unknown, older than seven days).
- **Read-only and least privilege:** privilege and ACL assertions, plus behaviour **as** the role (it runs the report; cannot read `pub`, `cron` or call G2; cannot write or create).
- **Rollback:** removes only the function, the schema and the role; idempotent; 0019 applies again afterwards.

`ops-bot/test/gate-c-handler.test.ts` (authentication matrix, allow-list, failure mapping, caching, bounded execution, compatibility with the bot's real signing function, provider and zod contract) and `gate-c-e2e.test.ts` (bot provider -> endpoint core -> the real SQL function as the restricted role -> the bot's evaluation and incident engine) cover the HTTP and bot side. Mutation checks (removing the `PUBLIC` revoke, the allow-list, adding a table grant, making the function volatile, touching an existing object, leaving the role behind after the rollback, granting the role `pub` access) each fail the suite. **Not validated here:** real `pg_cron` / `pg_net` behaviour, the Supabase pooler, and the deployed Edge runtime; the post-deployment check below covers the last two, and the first is covered by the G2 functions already running in production.

## Option G: the HMAC-gated Data API RPC (implemented in a separate PR, NOT applied)

Option G replaces the direct database login in the Edge Function by a gated call to `public.ops_health_report()` through the Data API as plain `anon`
(migrations `0020_ops_health_gated_rpc.sql`, its rollback and `0021_drop_ops_reporter_login.sql`, `report-source.ts`, a read-only verifier and a PostgREST HTTP test suite). It keeps this
document's response contract and the external HMAC contract (`handler.ts` is unchanged) and removes the reporter's inherited `PUBLIC` privileges (pg_net) from the picture.
Everything about it (decision record, exact privileges, abuse measurements, migration, rotation, rollback) is in [reporting-gated-rpc.md](reporting-gated-rpc.md). Until the owner
takes its production decision, the procedure below remains the one in force.

## Operator procedure (NOT executed by this repository; each step needs the owner's GO)

1. **Record the baseline** (read-only): the md5 of `cron.job` rows 3 to 7 and of the G2 function bodies, using the fingerprint queries in `scripts/ops-health-sql-tests.sh` (`fp()`), and keep them with the owner's evidence.
2. **Apply** `database/ops/0019_ops_health_report.sql` as the platform `postgres` admin on `azerdex-public-read`. Re-run the baseline: identical.
3. **Set the role password** out of band (a generated secret, never in a file, chat or shell history): `\password azerdex_ops_reporter` in `psql`. The migration deliberately sets none, so the role cannot log in until you do.
4. **Create the Edge Function secrets:** `AZERDEX_OPS_HEALTH_SECRET` (at least 32 random characters), `OPS_HEALTH_DATABASE_URL` (the role's connection string: with Supabase's pooler the user is `azerdex_ops_reporter.<project-ref>`, with TLS required). Optional: `AZERDEX_OPS_HEALTH_SIGNED_PATH` only if the bot's URL path differs from the default.
5. **Deploy** `supabase functions deploy azerdex-ops-health --no-verify-jwt` (the authentication is the HMAC; `supabase/config.toml` records the same setting).
6. **Verify before the bot sees it:** `HEALTH_API_URL=... HEALTH_API_SECRET=... npx tsx scripts/check-health-endpoint.ts` from `ops-bot/` (four refusals, then one signed read; neither value is printed). It must print `READY`.
7. **Then** the production bot's own gate: set `HEALTH_API_URL` and `HEALTH_API_SECRET` as production Worker secrets (`wrangler secret put ... --env production`) per `production-release-checklist.md`.

**Rollback:** delete the Edge Function (or remove its secrets), then run `database/ops/0019_ops_health_report_rollback.sql`, then remove the Worker's `HEALTH_API_*` secrets. The rollback changes nothing but the function, its schema and the role.

## Production activation record (GO-1, 2026-11-10, all times UTC)

Evidence only; no secret, credential, signature or connection string is recorded here.

| Step | Result |
| --- | --- |
| Identity | Project `azerdex-public-read`, ref `chcoypkjzxfznsqmmbrq`, eu-west-1, Postgres 17.11, `ACTIVE_HEALTHY`. Before: no `ops_report` schema, no reporter role; G2 functions present; jobs 3 to 7 active (`azerdex-news-blueposts` 3 `*/10`, `azerdex-news-official` 4 `*/30`, `azerdex-news-revisions` 5 `0 */6`, `azerdex-publish-observations` 6 `*/15`, `azerdex-news-health` 7 `*/15`). |
| Baseline fingerprints (two identical passes, md5) | cron.job `3ef09676aadde9c471a052fbe6693694`; functions (body, owner, ACL, config) `e08db34ef2c49dcca7605916d3ad0291`; schemas+ACL `f0bd058c07dcc2eb119efa726f577b2e`; relations+ACL `2c0916b5195eba5d1f428bd119d98472`; roles `82206b00df8e274655bdb0fd1e34d7e8`. Same expressions as `fp()` in `scripts/ops-health-sql-tests.sh`, with `~` as separator (the SQL tool rejected `;` inside the literals). |
| Migration | `database/ops/0019_ops_health_report.sql` (sha256 `81def3a8a4e008190510c63cbbaf464fb64725d2a46b1cb2efa2df1373269156`, 7778 bytes, identical on `release` `ba378a7`) applied at 13:00:29 as migration `ops_0019_health_report`. All five fingerprints identical afterwards and again at final verification; jobs 3 to 7 unchanged. |
| Role password and secrets | Set by the owner out of band (`\password`, `supabase secrets set --env-file`), not through the assistant. The HMAC secret was exposed once in a shared terminal output and **rotated** before acceptance. |
| Edge Function | `azerdex-ops-health`, `verify_jwt=false`. First deployed 13:01 (v1); redeployed 14:07 as v4 with the identical source (`index.ts` sha256 `4de588a46f9e5e545145a6d0df936ad6101aa9afcde802807d2f3bf66456f469`, `handler.ts` sha256 `6a169e5b0fe526dab99752a7869079b42f1990a6746e7d94a5260b7f90d97088`, both verified byte-for-byte against `release` `ba378a7`). Versions 5 to 7 are platform re-versions caused by the owner's secret updates: bundle hash unchanged (`9e7a4d03f25a3f6f0d8ea60414a9980aab06dba599a07a4993ee3ca262bbcf7c`). The three pre-existing functions (`publish-observations`, `diag-db-host`, `azerdex-news-collector`) kept their bundle hashes. |
| Acceptance | Owner-run `ops-bot/scripts/check-health-endpoint.ts` at 14:48: **all 9 checks PASS**, signed GET HTTP 200, contract v1 valid, report fresh, 3 sources `ok`, G6 present, active, last run succeeded. Edge logs show 3x 401, 1x 405 and 1x 200 for that run; the pooler shows `azerdex_ops_reporter` authenticated in `transaction` mode. A read-only call of `ops_report.health()` returns `schemaVersion` 1, `overall` ok, exactly the allow-listed keys. |
| Backup (prerequisite) | **Not fully satisfied, accepted by the owner's scope.** The project is on the Supabase Free plan (no automatic backups, no PITR). The only backup is the owner's four-schema dump of 2026-11-05; its off-machine copy is **not confirmed** (see `docs/web/g4-g5-g6-execution-log-2026-11-05.md`). 0019 is additive (one schema, one function, one role) and its rollback was rehearsed. |

**Defects found and fixed during activation** (all on the operator side; the approved code was not changed):

1. First signed GET returned 401: the owner's Windows clock was more than 120 s off (the handler allows +/-120 s). Fixed by resynchronising the clock. The server clock was verified correct.
2. Signed GET then returned 503: the pooler log showed `password authentication failed for user "postgres"` and metadata `user=postgres`, i.e. the stored `OPS_HEALTH_DATABASE_URL` named the wrong user. Fixed by re-creating it with `azerdex_ops_reporter.<project-ref>` (pooler, port 6543, `sslmode=require`). Nothing in the role, the function or the Deno client was at fault: the client uses the simple query protocol for a query without arguments (`deno-postgres` v0.19.3, `connection.ts`), which is compatible with the transaction-mode pooler.

**Open finding: inherited `PUBLIC` privileges (least privilege is only partly achieved).** The privileges 0019 adds are minimal (verified: one `EXECUTE`, one schema `USAGE`, no membership, no `CREATE` anywhere, not superuser / createdb / createrole / bypassrls / replication, connection limit 3, role defaults statement/lock/idle timeouts and read-only). But a catalog check of the role's effective rights (`has_*_privilege`) shows rights that come from platform `PUBLIC` grants and exist for every login role on this project; they are not caused by 0019 and no fingerprint changed:

- `USAGE` on schema `net` (and on `public`, where nothing usable is granted), and `EXECUTE` on `net.http_get`, `net.http_post`, `net.http_delete`, `net.http_collect_response`;
- all table privileges on `net.http_request_queue` and `net._http_response`, and `USAGE` on `net.http_request_queue_id_seq`.

Consequence if the reporter password leaked: an attacker could ask the database to make outbound HTTP requests through `pg_net` (server-side request origin), and could read or delete queued requests and stored responses. The role's `default_transaction_read_only` is a default, not a barrier: a session can change it. It cannot reach `cron`, `private`, `pub`, `pub_admin` or `extensions` (no schema `USAGE`), so it cannot read or alter the cron jobs, the G2 functions or the publication data. Not tested by exercising the privileges (that would write to production).

The remedy is a change to platform-managed `pg_net` grants and needs its own owner GO after a rehearsal on a disposable database that has `pg_net`: jobs 3 to 7 run as `postgres`, which today holds `EXECUTE` on `net.http_*` only through `PUBLIC`, so a naive `REVOKE ... FROM PUBLIC` would break the News jobs unless `postgres` and the platform roles are granted explicitly first. Until the owner decides (fix, or accept with the compensating controls: secret stored only as a Supabase Edge Function secret, connection limit 3, 5 s timeouts, rotation on any suspicion), this item is open in [production-release-checklist.md](production-release-checklist.md) and in the [threat model](threat-model.md). The local suite should also gain a `pg_net`-like `PUBLIC` fixture so the claim "no table/sequence privilege" is tested against effective privileges, not only against grants.
