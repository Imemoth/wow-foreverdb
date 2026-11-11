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
| Migration history | Row `20261111092220` / `ops_0020_gated_rpc` recorded in `supabase_migrations.schema_migrations` after the fact (SQL not re-run). `statements[1]` is the exact released file: 8132 bytes, sha256 `80cdc31624020ff1521f67c6405c9b94efde2a5569586940593309d49d4b8ab5`, verified equal to the release (the insert was guarded on that hash). Same convention as the 0019 row (one element holding the whole file). The CRLF cosmetic difference of three function bodies in the live catalog is unchanged. |
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

## Verification procedure for the 24 h and 48 h checkpoints

Checkpoints: **T+24 h = 2026-11-12 10:17 UTC** and **T+48 h = 2026-11-13 10:17 UTC**. All steps are read-only except the owner's external check, which only makes five requests. Nothing here needs a secret in the transcript.

**A. Owner (own shell, hidden secret):** `cd ops-bot && HEALTH_API_URL=https://chcoypkjzxfznsqmmbrq.supabase.co/functions/v1/azerdex-ops-health HEALTH_API_SECRET=... npx tsx scripts/check-health-endpoint.ts`. Expect 9 PASS and `READY`; the clock must be synchronised (a skew over 120 s gives a 401).

**B. Assistant, database (run as `postgres` through the SQL tool; no key material is read):**

1. The release verifier `database/ops/verify_ops_health_gated_rpc.sql` (comment lines and the trailing `;` removed for the SQL tool): zero `FAIL`, gate state `open`, the five `INFO fingerprint` lines equal to the baseline above, the reporter login `present` until 0021.
2. `select slot, valid from ops_report.gate_status()` returns one valid `current` and no valid `previous`.
3. Jobs and G2/G6 since the start:

```sql
select
  (select md5(string_agg(jobid||'|'||jobname||'|'||schedule||'|'||command||'|'||active, '~' order by jobid)) from cron.job where jobid between 3 and 7) as jobs3_7_md5,          -- unchanged, equals the cron fingerprint input for jobs 3-7
  (select count(*) from cron.job_run_details where jobid between 3 and 7 and start_time >= timestamptz '2026-11-11 10:17:00+00') as runs_since_start,
  (select count(*) from cron.job_run_details where jobid between 3 and 7 and start_time >= timestamptz '2026-11-11 10:17:00+00' and status <> 'succeeded') as failed_runs,
  (select ops_report.health()->>'overall') as g2_overall,                                   -- ok
  (select jsonb_array_length(ops_report.health()->'sources')) as sources,                   -- 3
  (select ops_report.health()->'g6'->>'lastRunStatus') as g6_last,                          -- succeeded
  (select count(*) from supabase_migrations.schema_migrations where name = 'ops_0020_gated_rpc') as history_row;  -- 1
```

**C. Assistant, platform:** `list_edge_functions` (collector v12 `9193cdfa…` unchanged, `azerdex-ops-health` bundle `d6495cb5…`, no new version unless approved); logs since the start with the log tool:

- `function_edge_logs` of function `8069892a-b46e-41da-a2f8-2283c3d35379`: only 200, plus 401/405 from deliberate probes; no 5xx.
- `function_logs`: no `error` rows other than `"errorClass":null`; collector runs continue.
- Secret scan over all sources: no match for `x-azerdex-gate`, `OPS_HEALTH_GATE_KEY`, `OPS_HEALTH_APIKEY`, `rotate_gate_key` outside the 0020 DDL statement and deliberate probes, and no 64-hex string other than the collector's `projection_built` `sha256` field.
- `postgres_logs`: no `PT401`/`FATAL`/`panic`.

**GO/NO-GO for 0021 (decided at T+48 h):** GO only if both checkpoints pass every item above, the owner confirms, and `OPS_HEALTH_DATABASE_URL` is then unset and the external check is re-run to `READY` before 0021 is applied. Any failure, unexpected change or unexplained 5xx is NO-GO: the observation restarts after the cause is fixed, or the rollback in `reporting-gated-rpc.md` section 9 runs if the gate is at fault.
