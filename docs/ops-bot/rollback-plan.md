# Rollback plan: AzerDex Operations Bot

The bot is additive and self-contained: it creates nothing in Supabase, never changes job 7 or any other cron job, and keeps its state in its own D1 database. Rollback therefore never touches News data, the website or the G2/G6 objects. Order is the reverse of activation.

## Per component

| Order | Component | Action | Effect | Verify |
| --- | --- | --- | --- | --- |
| 1 | External heartbeat | **Pause** the check in the heartbeat service first | Prevents a false "missed ping" alarm during teardown | Check shows paused |
| 2 | Cron Trigger | Remove the `crons` entry (or `wrangler deploy` a config without it) | Monitoring cycles stop | No new rows in `monitor_state.last_cycle_at` |
| 3 | Discord interactions | Clear the application's **Interactions Endpoint URL**; delete the guild commands (`PUT` an empty list) | `/azerdex` stops working | Commands no longer listed |
| 4 | Worker | `npx wrangler delete --env <env>` | No code runs; `/healthz` fails | HTTP error |
| 5 | Discord application | Remove the bot from the server or delete the application; revoke the token | Bot can no longer post | Bot offline, token invalid |
| 6 | D1 | Export for the record (`wrangler d1 export`), then run `rollback/0001_ops_bot_init.down.sql` or delete the database | All bot state removed (incident history is lost; keep the export if needed) | `select name from sqlite_master` shows no bot tables |
| 7 | Secrets | `wrangler secret delete <NAME> --env <env>` for each | No credential remains | `wrangler secret list` empty |
| 8 | Supabase reporting endpoint (only if Gate C was completed) | Rehearsed script: delete the Edge Function, drop the projection function, drop the dedicated role, delete its secrets | Reporting path removed | Function and role absent; jobs 3 to 7 and G2 functions fingerprint-identical |
| 9 | Repository | `git revert` the merge commit of the bot PR | Removes `ops-bot/`, `docs/ops-bot/`, the workflow | `release` builds as before |

## Notes

- Step 8 now exists: the reporting endpoint was deployed to production on 2026-11-10 (GO-1). Supabase therefore needs this rollback if the bot is withdrawn: delete the Edge Function `azerdex-ops-health` (or its secrets), then run `database/ops/0019_ops_health_report_rollback.sql`. Rolling back the bot alone (steps 1 to 7) does not require it; the endpoint is read-only and unused until GO-3.
- Rolling back the bot does not roll back G6: job 7 keeps running and still shows failures in `cron.job_run_details` (the operational signal that existed before the bot).
- Partial rollback is safe at any point: disabling the Cron Trigger alone leaves the bot idle and silent, and the heartbeat service (if not paused) then reports the missed pings, which is the intended signal.
- The down migration is tested: it removes exactly the tables the up migration created, leaves unrelated tables untouched, is idempotent, and the schema can be re-applied (`ops-bot/test/security.test.ts`).
- If Option G is applied ([reporting-gated-rpc.md](reporting-gated-rpc.md)), step 8 also covers it: redeploy the previous function version, run `0020_ops_health_gated_rpc_rollback.sql` **before** `0019_ops_health_report_rollback.sql` (the other order is refused and changes nothing), and re-run the read-only verifier.
