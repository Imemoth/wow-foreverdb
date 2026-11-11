# AZR-004 Option G: production acceptance evidence and 48-hour observation

Project `azerdex-public-read` (`chcoypkjzxfznsqmmbrq`). Released source: `release` at `4a1c910c9dd757ab0699cd3e4279d865b53a8736` (PR #190).
No secret, key, signature or database URL appears in this document or was shown to the assistant. Times are UTC.

## What was applied (2026-11-11)

| Item | Result |
| --- | --- |
| Migration `0020_ops_health_gated_rpc.sql` (sha256 `80cdc316…8b5`) | Applied by the owner in the SQL editor at about 09:22. Three function bodies carry CRLF line endings from the paste (cosmetic, proven by md5). No migration-history row exists (SQL editor). |
| Gate key | Generated inside the database by `ops_report.rotate_gate_key()`; owner entered it as `OPS_HEALTH_GATE_KEY`. One `current` key valid; `previous` slot expired (valid=false). |
| Edge secrets | `OPS_HEALTH_GATE_KEY`, `OPS_HEALTH_APIKEY` set by the owner. `OPS_HEALTH_DATABASE_URL` still set (rollback). |
| Edge Function `azerdex-ops-health` | v10, bundle sha256 `d6495cb58a527fa68ea8f10630f014f9a9c65129e87e76c479f4f0defc8d1b1d`, `verify_jwt=false`, byte-identical to `release`. |
| Not touched | `0021`, the `azerdex_ops_reporter` login, `azerdex-news-collector`, jobs 3-7, G6, GO-2, GO-3. |

## Owner acceptance (external script, 9 checks)

9/9 PASS, signed GET HTTP 200, contract v1 valid, report generated 0 minutes ago, 3 of 3 sources OK, G6 present, active, last run succeeded. Result READY (200 at 10:06:20).

## Post-acceptance verification (2026-11-11, 10:08-10:17)

1. Fingerprints (all equal to the pre-change baseline):
   - cron.job `3ef09676aadde9c471a052fbe6693694`
   - functions `e08db34ef2c49dcca7605916d3ad0291`
   - schemas+ACL `f0bd058c07dcc2eb119efa726f577b2e`
   - relations+ACL `2c0916b5195eba5d1f428bd119d98472`
   - roles `82206b00df8e274655bdb0fd1e34d7e8`
2. 0020 permissions: read-only verifier, 18 PASS / 0 FAIL. Effective additions are exactly three, all to `anon`: USAGE on schema `ops_report`, EXECUTE on `ops_report.gated_health()`, EXECUTE on `public.ops_health_report()`. rotate/revoke/status are postgres-only. `gate_keys`: RLS on, owner-only ACL, no column grants. No new function is executable by PUBLIC, `authenticated` or `service_role`.
3. Gate state: open, one `current` key valid, `previous` expired.
4. `azerdex-ops-health` requests since 09:00: 09:56 probe set 3x 401, 1x 405 (negative tests); 10:06 acceptance set 3x 401, 1x 405, 1x 200. No 5xx. No boot error.
5. Log scan (all sources, since 08:30): no 64-hex gate key or signature in any source except the collector's own `projection_built` `sha256` fields (8 rows, not gate material); the only gate-related strings are the 0020 DDL statement log (no key), my own negative probes (404 on `rotate_gate_key` and `gate_keys` through the Data API) and Supabase's dashboard helper. No `error` rows other than `"errorClass":null`; the single `postgres_logs` match is the 0020 DDL statement itself.
6. Regression: jobs 3-7 unchanged (command md5 equal to baseline), active, latest run `succeeded` for all five, 39 runs since 08:00 and none failed. `azerdex-news-collector` v12 unchanged (`9193cdfa…`). G2/projection `overall = ok`, 3 sources, G6 `succeeded`.

## Observation period

- Start: **2026-11-11 10:17 UTC** (completion of the verification above; database clock 10:16:49).
- Earliest safe `0021`: **2026-11-13 10:17 UTC** (start + 48 h), and only if every condition below holds.

Conditions to close the period (all required, evidence recorded here):

1. No failed job 3-7 run, G6 last run succeeded, G2 `ok`, collector unchanged, for the whole window.
2. No `azerdex-ops-health` 5xx or boot error; only expected 401/405 from deliberate probes.
3. No gate key, signature or header value in any log; verifier still 18 PASS / 0 FAIL; five fingerprints unchanged; exactly three `anon` grants.
4. A fresh external 9-check run just before cleanup (and ideally one at about 24 h) returns READY.
5. Owner confirms. Then, in order: unset `OPS_HEALTH_DATABASE_URL` and re-run acceptance, then apply `0021` (docs/ops-bot/reporting-gated-rpc.md section 7). Rollback until then: section 9.

Note: until the Ops bot's production polling is enabled, the only production traffic through the gate is the owner's acceptance run and manual checks, so the 24 h and 48 h acceptance re-runs are what give evidence of the gate itself.
