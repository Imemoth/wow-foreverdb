# Reporting endpoint, Option G: the HMAC-gated Data API RPC (IMPLEMENTED, NOT DEPLOYED)

Status: **implemented and validated on a throwaway PostgreSQL with a real, version-pinned PostgREST; applied nowhere.** Decision 1 (build it) was taken by the owner;
**Decision 2 (apply it to production) is pending** and each production step below needs the owner's explicit GO. Until then production keeps running the Gate C design
(`azerdex-ops-health` connecting as the `azerdex_ops_reporter` login role, see [supabase-reporting-contract.md](supabase-reporting-contract.md)). The custom-JWT
approach is withdrawn (section 2).

## 1. Why

GO-1 found that the login role `azerdex_ops_reporter` inherits platform `PUBLIC` privileges: schema `net` (pg_net 0.20.4 grants it to `PUBLIC` by design) with
`net.http_get/post/delete` and full access to `net.http_request_queue` and `net._http_response`. A leaked reporter password would therefore allow outbound requests
from the database and interference with pg_net, and `PUBLIC` grants cannot be removed per role. Option G removes the direct SQL login from the health endpoint altogether.

## 2. Decision record

| Mechanism | Verdict |
| --- | --- |
| Custom-role JWT with an imported signing key | **Withdrawn.** Supabase's key-state table: a newly created key's "Accepted JWT signatures" are "Current key only"; it must be **rotated** into use, which changes production Auth signing and can break `verify_jwt` Edge Functions. |
| Edge Function mints its own tokens | Needs a private signing key in the runtime: a broad credential. Rejected. |
| Legacy JWT secret, secret API keys, `service_role` | Broad credentials. Excluded by the owner's requirement. |
| Auth service user with short-lived tokens | Adds user lifecycle management, grants the broader `authenticated` role, and each Edge request cold-starts (a sign-in per request). Rejected. |
| Third-party auth (custom OIDC) | Needs an external identity provider. Rejected. |
| Keep the reporter login with documented risk acceptance | The fallback if Decision 2 is NO-GO. |
| **Option G: gated RPC called as plain `anon`** | **Chosen.** No new role, no JWT, no signing key, no login credential, no platform setting change. |

## 3. Architecture

```text
Ops bot (Cloudflare) --HMAC GET (unchanged contract)--> Edge Function azerdex-ops-health (handler.ts UNCHANGED)
  --GET /rest/v1/rpc/ops_health_report, apikey = publishable key (public), x-azerdex-gate-ts + x-azerdex-gate-sig (60 s HMAC)-->
  Supabase Data API (PostgREST) as role anon --> public.ops_health_report() [SECURITY INVOKER]
     --> ops_report.gated_health() [SECURITY DEFINER, unexposed schema] verifies the HMAC against ops_report.gate_keys
     --> ops_report.health() (the existing contract v1 projection) --> private.azerdex_news_health() + cron.*
```

- `handler.ts` (sha256 `6a169e5b0fe526dab99752a7869079b42f1990a6746e7d94a5260b7f90d97088`) is byte-identical; a test pins the hash. `index.ts` now wires `report-source.ts`
  instead of a PostgreSQL client. The function reads `SUPABASE_URL` (platform), `OPS_HEALTH_APIKEY` (the **publishable** key, public by design) and `OPS_HEALTH_GATE_KEY`.
- **The gate key** is 32 random bytes generated **inside the database** by `ops_report.rotate_gate_key()`, returned once to the operator, stored as the Edge secret
  `OPS_HEALTH_GATE_KEY` (64 hex). It never appears in a statement, migration, log or chat, and never travels: each request carries `HMAC-SHA256(key, "<unix s>\nGET\nops_health_report")`,
  accepted within 60 s of the database clock, for the `current` key or a `previous` key whose **bounded overlap (default 15 minutes, at most 1 hour)** has not ended.
- Every refusal is the same error (SQLSTATE `PT401`, HTTP 401, `{"code":"PT401","details":null,"hint":null,"message":"unauthorized"}`). There is deliberately **no failure counter or lock-out**: it would let an
  anonymous caller lock the bot out.
- Only `GET` is accepted (`request.method`), so a `POST` with a valid signature is refused too.

## 4. Effective privileges (exact, proved)

0020 adds exactly three privileges, all to `anon` (the test snapshots every privilege of `anon`, `authenticated`, `service_role`, `authenticator` and the reporter across the
whole database before and after, and fails on any other difference):

| Grantee | Privilege |
| --- | --- |
| anon | `USAGE` on schema `ops_report` |
| anon | `EXECUTE` on `ops_report.gated_health()` |
| anon | `EXECUTE` on `public.ops_health_report()` |

| Function | Owner / kind | EXECUTE held by |
| --- | --- | --- |
| `public.ops_health_report()` | postgres, SECURITY **INVOKER**, STABLE, `search_path = pg_catalog` | postgres, anon |
| `ops_report.gated_health()` | postgres, SECURITY DEFINER, STABLE, `search_path = pg_catalog`, `statement_timeout 5s` | postgres, anon |
| `ops_report.health()` | postgres, SECURITY DEFINER (0019) | postgres, `azerdex_ops_reporter` (until 0021) |
| `ops_report.rotate_gate_key(interval)`, `revoke_gate()`, `gate_status()` | postgres, SECURITY DEFINER | postgres only |
| table `ops_report.gate_keys` | postgres, RLS on, no policy | nobody else (no table, column or default grant) |

The chain `anon -> USAGE ops_report, EXECUTE wrapper -> EXECUTE gated_health -> (definer) health()` is proved by removing each link in a rolled-back transaction: each removal gives
`permission denied`. `authenticated` and `service_role` cannot call the wrapper or the gate (HTTP 403, 42501, through real JWTs). A JWT for `postgres`, `supabase_admin`,
the reporter or any role `authenticator` is not a member of is never accepted. `ops_report`, `net`, `private`, `cron` and `pub` are not exposed schemas (HTTP 406 `PGRST106`), and with
`openapi-mode = follow-privileges` anon sees exactly one callable object in the default schema. The DEFINER functions live in the unexposed schema, pin `search_path = pg_catalog`,
qualify every reference, and use no dynamic SQL (a test with a hostile caller `search_path` proves it cannot change the outcome).

`database/ops/verify_ops_health_gated_rpc.sql` is a **read-only** verifier of all of the above (exact ACLs, flags, owners, search paths, key slots) plus the five fingerprints; it is safe to run on production
as `postgres` and prints `PASS|FAIL|INFO` lines.

## 5. Abuse, rate limiting, connections, workload (measured over real HTTP)

The gate is callable by anyone with the (public) publishable key, so a flood is possible. Measured through the pinned PostgREST (pool of 10) on a developer machine
(`ops-bot/test/gate-g-load.test.ts`, 12 s phases; absolute numbers are machine-dependent, the shape is the evidence):

| Phase | Result |
| --- | --- |
| Baseline, 30 sequential valid requests | 399 req/s, p50 2.1 ms, p95 2.8 ms, all 200 |
| Flood of refused requests (no headers / wrong signature / stale / malformed), 128 concurrent | **38,621 requests, 3,172 req/s, all 401**; database connections never above the pool (10); database CPU 0.24 s and PostgREST CPU 0.54 s per 1,000 refusals |
| Legitimate signed request every 200 ms during that flood | **50 of 50 returned 200**, p95 66 ms |
| Worst case if the key leaked: valid signed requests at saturation, 64 concurrent | 11,016 requests, 1,374 req/s, all 200, p95 82 ms, database CPU 1.39 s per 1,000 requests, connections never above 10 |
| Kill switch (`revoke_gate()`) while 32 clients are in flight | **all 6,385 requests that started after the revoke returned 401**, none returned anything else |

Findings and mitigations:

- A refusal is answered in about a millisecond of database time (the header check precedes any HMAC or report work), so refused floods do not load the database meaningfully, and a valid-key
  flood is a read-only report at about 1 ms of CPU each. Neither can write, and the report cache in `handler.ts` (10 s) only protects the *external* endpoint, not this RPC.
- A flood **can** occupy PostgREST's connection pool; the legitimate caller kept succeeding in the measurement because refusals are fast, but a hosted project has other API traffic sharing the pool.
  Hosted protections (edge/CDN request filtering and the per-project pool and compute limits, see Supabase "Connection management") sit in front of this and were **not** measurable here.
  Role timeouts apply as documented (anon 3 s, authenticated 8 s, authenticator 8 s); a PostgREST pool-acquisition timeout shows as HTTP 504 `PGRST003`.
- Recommended, owner-chosen and **not** part of this change: watch the `edge_logs` for `/rest/v1/rpc/ops_health_report` status 401 spikes (a flood) and 503/504 (pool pressure); an optional rate-limiting rule at the edge for that path; the
  kill switch below. The legitimate poller is one request per 5 minutes.

## 6. Secrets, logs and error text

- The key, the signature and the publishable key are never in a thrown message, log line, CI output or artifact: `report-source.ts` throws only a fixed code (`source_*`), logs nothing (tests spy on every console method), and the
  function folder is statically checked (no `console`, no database client, no connection string, only the five expected environment variables).
- Under a **verbose worst-case** PostgreSQL profile (`log_statement=all`) the 60-second request signatures appear in the server log (statement text/parameters); the **key never does**. Under the **hosted documented profile**
  (`log_statement=ddl`, `log_min_error_statement=error`, `log_duration` off, `log_min_duration_statement=-1`) the same HTTP suite produced 28 ERROR entries (refusals and permission errors) and **no key, signature or header value** reached the log.
  The harness fails the build on either.
- A captured signature can only replay a read-only report for at most 60 seconds, and only while its key is valid.

## 7. Migration (owner Decision 2; each numbered step needs an explicit GO)

0. **Prerequisites:** the off-machine backup copy is confirmed (the project is on the Free plan: no automatic backups, no PITR); this PR is merged by the owner; the PostgREST pin was cross-checked (section 11).
1. **Baseline (read-only):** run `database/ops/verify_ops_health_gated_rpc.sql`'s fingerprint expressions, or record the five values; they must equal the 2026-11-10 baseline in the contract document.
2. **Apply `0020_ops_health_gated_rpc.sql`** as the platform `postgres` admin. It aborts untouched unless 0019 and pgcrypto (in `extensions`) are present. Run the verifier: no `FAIL`, `gate state CLOSED`, fingerprints unchanged.
3. **Create the key and the Edge secrets** (PowerShell; nothing is printed; the admin URL is typed at a hidden prompt):

   ```powershell
   function Read-Plain([string]$Prompt) { $s = Read-Host $Prompt -AsSecureString; $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) } }
   $ref     = 'chcoypkjzxfznsqmmbrq'
   $admin   = Read-Plain 'Admin DB URL (hidden)'
   $gateKey = (psql $admin -tA -c "select ops_report.rotate_gate_key(interval '1 hour')").Trim()   # generated in the database, held in memory only
   $apikey  = Read-Plain 'Publishable API key (sb_publishable_..., Settings > API Keys)'
   $envFile = Join-Path $env:TEMP ("ops-gate-" + [guid]::NewGuid().ToString('N') + ".env")
   [IO.File]::WriteAllText($envFile, "OPS_HEALTH_GATE_KEY=$gateKey`nOPS_HEALTH_APIKEY=$apikey`n", (New-Object Text.UTF8Encoding $false))
   icacls $envFile /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
   try { supabase secrets set --env-file $envFile --project-ref $ref } finally { Remove-Item $envFile -Force }
   $gateKey = $null; $admin = $null
   ```
4. **Deploy** the new function version (the previous version keeps working until this moment and still has `OPS_HEALTH_DATABASE_URL`): `supabase functions deploy azerdex-ops-health --no-verify-jwt --project-ref $ref`.
5. **Verify:** run the owner check `ops-bot/scripts/check-health-endpoint.ts` unchanged (9 checks) and the verifier again; confirm in the edge logs 3x 401, 1x 405, 1x 200 for the run and in `gate_status()` one current key.
6. **Observe 48 hours** with the bot (or the check script on a schedule) showing the reporting source healthy.
7. **Remove the direct login:** unset the Edge secret `OPS_HEALTH_DATABASE_URL` (`supabase secrets unset OPS_HEALTH_DATABASE_URL --project-ref $ref`), then apply `0021_drop_ops_reporter_login.sql`. Re-run the verifier.

## 8. Credential rotation and revocation

- **Routine (every 90 days, or after anyone with access leaves):** `select ops_report.rotate_gate_key(interval '1 hour')`, set the new `OPS_HEALTH_GATE_KEY` exactly as in step 3 (and re-deploy is not needed: the secret update re-versions the function), then confirm one successful poll. The old key dies by itself when its overlap ends; if the new secret is not in place before then, the endpoint answers 503 and the bot shows UNKNOWN (never healthy).
- **Suspected exposure:** `select ops_report.revoke_gate()` (instant: every request is refused), then `select ops_report.rotate_gate_key(interval '0')`, set the secret, verify. Check `select * from ops_report.gate_status()` (slots, ages, validity; never the key).
- **The publishable key** is public by design; a leaked one gives nothing without the gate key. If the legacy `anon` key is later disabled, nothing changes because the function uses the publishable key.
- **The bot's external HMAC secret** (`AZERDEX_OPS_HEALTH_SECRET`) is independent and unchanged by Option G.

## 9. Rollback

1. Redeploy the previous function version: `git show ba378a7:supabase/functions/azerdex-ops-health/index.ts` (it needs the secret `OPS_HEALTH_DATABASE_URL` and the 0019 reporter, which stay until step 7 of the migration). If 0021 was already applied, re-apply `0019_ops_health_report.sql` (it re-creates the login role without a password), set a password out of band and re-create the secret, as in the Gate C procedure.
2. `0020_ops_health_gated_rpc_rollback.sql` removes the wrapper, the gate functions, `gate_keys` and anon's schema `USAGE` and nothing else. **Run it before** `0019_ops_health_report_rollback.sql`: running them in the other order is refused by PostgreSQL and changes nothing (tested).
3. Re-run the verifier / fingerprints: identical to the pre-0020 baseline. Tested: after the rollback the whole-database effective-privilege snapshot equals the original.

## 10. Regression tests (what proves what)

| Where | Proves |
| --- | --- |
| `ops-bot/test/gate-g-source.test.ts` (19) | signature vectors and format; request shape; fixed error vocabulary; no secret in any error or log; config validation before any request; handler.ts hash; function folder is database-client-free and logs nothing; 0020's static properties |
| `scripts/ops-health-gated-rpc-tests.sh` stage 4 | 0020 applies and is idempotent; fingerprints unchanged; verifier; exact three-grant privilege diff; privilege chain; refusal matrix; bounded 15-minute overlap; rotation bounds; kill switch; role isolation; `search_path` hijack; hygiene of SQL messages |
| `ops-bot/test/gate-g-e2e.test.ts` (7) | the bot's real provider -> the unchanged handler -> the gated source -> the real SQL gate -> the real projection; the owner's 9-check script passes unchanged |
| `ops-bot/test/gate-g-http.test.ts` (35), real PostgREST | exact HTTP status and body of every outcome; custom headers reach the function; role isolation by real JWTs; schema isolation; negative shapes; key lifecycle over HTTP; clean failure when the projection fails |
| `ops-bot/test/gate-g-load.test.ts` (3), real PostgREST | abuse and load (section 5) |
| harness stages 6b, 7 | no key, signature or header value in any log under the hosted logging profile; no key anywhere under the verbose profile |
| harness stage 8 | rollback restores the original effective privileges and fingerprints; ordering with the 0019 rollback; full unwind and re-apply; 0021 |

CI runs all of it in `.github/workflows/ops-bot-ci.yml` on its own throwaway PostgreSQL (no service container, nothing touches Supabase).

## 11. Known limits and owner actions

- **Not verifiable outside production:** that the hosted API gateway forwards the two custom headers, that `PT401` maps to HTTP 401 on the hosted PostgREST version (the pinned 12.2.12 is tested; the hosted version is not known), and that the security advisor stays quiet about the wrapper (it is `INVOKER` and the definer function is in an unexposed schema). Step 5 of the migration verifies all three; a failure is a **NO-GO and rollback** (step 9.1).
- **PostgREST pin:** `scripts/postgrest-pin.env` pins version and sha256 of the test binary, computed from the downloaded asset. GitHub's API was not reachable from the authoring environment: **owner action:** cross-check the sha256 against the digest shown beside the asset on the PostgREST release page before merging.
- **Backup:** the off-machine copy of the 2026-11-05 dump remains a prerequisite for step 2.
- **Not changed:** the 0019 migration, the existing reporter until 0021, the News jobs 3 to 7, any existing function, Auth keys, or any production configuration.
