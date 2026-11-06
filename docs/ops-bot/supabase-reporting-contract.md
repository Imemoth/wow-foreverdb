# Supabase reporting contract (DESIGN ONLY: not implemented, not deployed)

Status: **draft for separate owner review.** Nothing in this document has been run against any database. No production SQL, grant, role, Edge Function or secret is created by this workstream. Production database migration and Edge Function deployment require explicit owner approval later.

## Goal

Give the bot **one read-only, narrow, authenticated report** about News ingestion health and the G6 job, without giving it a database password, a service-role key, access to the `private` or `cron` schemas, or any write capability.

## Existing production facts this builds on (unchanged)

- `private.azerdex_news_health()`: `SECURITY DEFINER`, owner `postgres`, executable only by `postgres`; returns per source `sourceKey, state, severity, causes[], lastAttemptAt, lastFetchOkAt, minutesSinceAttempt, consecutiveFailures, overdueTopics` (plus fields the bot does not need).
- `private.azerdex_news_assert_healthy()`; cron job 7 `azerdex-news-health` (`*/15 * * * *`, user `postgres`). `cron.job` and `cron.job_run_details` have row-level security keyed on `username = CURRENT_USER`.
- Four other cron jobs (ids 3 to 6) must stay byte-identical.

## Proposed shape (needs approval before any step)

```text
Ops bot (Cloudflare)  --HMAC-signed GET-->  Supabase Edge Function "ops-health-report"  --narrow DB role-->  one SECURITY DEFINER projection function
```

1. **Projection function** (new, `private`-schema, owner `postgres`, `search_path = pg_catalog`): calls `private.azerdex_news_health()` and reads job 7 from `cron.job` / `cron.job_run_details`, and returns exactly the contract below. `EXECUTE` is granted to **one dedicated login role** (for example `azerdex_ops_reporter`) and revoked from everyone else. That role has no table privileges, no schema `USAGE` beyond what the call requires, and cannot write.
2. **Edge Function** (new): verifies the HMAC signature and a ±120 s timestamp window, in constant time, using a function secret; binds the signature to method and path; connects as the dedicated role (credential held only as an Edge Function secret); returns only the projection; sets `cache-control: no-store`; logs no values. `verify_jwt` is false because authentication is the HMAC (same pattern as the collector function).
3. **Request** (what `HttpHealthProvider` already sends): `GET <url>` with `x-azerdex-ops-timestamp` (epoch seconds) and `x-azerdex-ops-signature = hex(HMAC-SHA256(secret, "<ts>\nGET\n<path>"))`. The secret is never transmitted.
4. **Why not simpler options:** granting the bot `postgres` or service-role credentials breaks least privilege; exposing `private.azerdex_news_health()` through PostgREST would widen the Data API surface; reading `cron.job_run_details` directly needs the same unrelated privileges.

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

## Required non-production validation before any approval request

1. A review of the projection function's SQL and grants by the owner (including `has_function_privilege` checks for every application role and the pre/post function fingerprint method used for G2).
2. Execution against an isolated database that has `pg_cron` and a copy of the G2 functions (a local Supabase stack or a throw-away project; the free plan has no branches, so this is an owner decision).
3. HMAC verification tests including replay, wrong path, clock skew and constant-time comparison.
4. Proof that jobs 3 to 7 and all existing functions are unchanged afterwards (md5 of command and of function bodies).
5. A rollback script (drop the projection function, drop the role, delete the Edge Function) rehearsed on the isolated database.

Until then the bot runs against the mock provider (staging) and **cannot** run in production (`HEALTH_PROVIDER=mock` is refused there).
