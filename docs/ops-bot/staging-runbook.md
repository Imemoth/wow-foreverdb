# Staging runbook: AzerDex Operations Bot

Status: **instructions only. Nothing here has been executed.** Creating staging resources, registering a Discord application, posting real Discord messages and deploying a Worker each need the owner's confirmation first. Staging must use its own Discord server and channel, its own Cloudflare resources and its own heartbeat check; never reuse production ones.

## 0. What the owner supplies

| Item | Notes |
| --- | --- |
| Staging Discord server + private channel `#azerdex-ops-staging` | Not the production server. |
| Discord application (staging) | Bot user, public key, application id. Bot permissions: View Channel, Send Messages, Embed Links. **No** Administrator, no Manage Messages, no Mention Everyone. |
| Operator user id(s) or role id | Who may use `/azerdex`. |
| Cloudflare account + `wrangler` login | Plan limits for Workers, Cron Triggers and D1 to be confirmed. Install `wrangler` per Cloudflare's documentation; it is deliberately not a repository dependency. |
| Healthchecks.io-compatible check (staging) | Period 5 minutes, grace 10 minutes. Its alert integrations (for example email or SMS) must be **independent of Discord**. |
| Fallback route (optional in staging) | An https endpoint accepting JSON `{ "text": "..." }`. |

## 1. Create resources (staging only)

```bash
cd ops-bot && npm ci
npx wrangler d1 create azerdex-ops-bot-staging            # copy the database_id into wrangler.toml [env.staging] locally; do not commit a real id without owner review
npx wrangler d1 migrations apply azerdex-ops-bot-staging --env staging
```

Verify the schema: `npx wrangler d1 execute azerdex-ops-bot-staging --env staging --command "select name from sqlite_master where type='table' order by name"` must list exactly: `audit_log, component_state, incident_events, incidents, locks, maintenance, monitor_state, outbox, rate_limits, seen_interactions` (plus Cloudflare's internal tables).

## 2. Secrets (never in files, chat or logs)

Enter each at the prompt:

```bash
for s in DISCORD_BOT_TOKEN DISCORD_PUBLIC_KEY DISCORD_APPLICATION_ID DISCORD_ALERT_CHANNEL_ID DISCORD_GUILD_IDS OPERATOR_USER_IDS HEARTBEAT_PING_URL FALLBACK_WEBHOOK_URL; do
  npx wrangler secret put "$s" --env staging
done
```

(`OPERATOR_ROLE_IDS` optionally.) Staging uses `HEALTH_PROVIDER=mock` from `wrangler.toml`; no Supabase credential exists in staging.

## 3. Register commands (guild-scoped, staging)

```bash
DISCORD_BOT_TOKEN=... DISCORD_APPLICATION_ID=... DISCORD_GUILD_ID=... npx tsx scripts/register-commands.ts --apply --staging
```

(set the three values from your protected shell, never on a shared command line). In the staging server: Server Settings > Integrations > the bot > `/azerdex`: allow it **only** for the operator role. The Worker enforces authorization independently.

## 4. Deploy and connect

```bash
npx wrangler deploy --env staging
```

Set the application's **Interactions Endpoint URL** to `https://<staging-worker-host>/interactions`; Discord sends a signed PING and only accepts the URL if the Worker answers correctly. `GET /healthz` must return `{"ok":true}`.

## 5. Staging acceptance (each item is TO BE PERFORMED and recorded; none is done yet)

Select a simulated scenario at runtime (no redeploy):

```bash
npx wrangler d1 execute azerdex-ops-bot-staging --env staging --command "insert into monitor_state (key, value, updated_at) values ('mock_scenario','source_critical', strftime('%s','now')*1000) on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at"
```

Scenarios: `healthy`, `source_critical`, `g6_stalled`, `g6_missing`, `g6_inactive`, `reporting_down`, `stale_snapshot`. These are **simulated**; they prove the bot, not Supabase.

| # | Check | Expected |
| --- | --- | --- |
| 1 | `healthy` for 30 minutes | No Discord message; heartbeat pings arrive every 5 min; `/azerdex status` = HEALTHY |
| 2 | Set `source_critical` | Within one cycle: exactly one alert with the Acknowledge button |
| 3 | Leave it for 3 hours | At most one reminder; no storm |
| 4 | Press Acknowledge as an operator; again as another operator | Message edits in place; second press is a no-op; the audit shows the first actor |
| 5 | Press Acknowledge / run `/azerdex ack` as a non-operator | Refused, ephemeral, no state change |
| 6 | Set `healthy` | After two cycles: one RECOVERED message referencing the incident |
| 7 | `g6_stalled`, `g6_missing`, `g6_inactive` | One incident each; recovery on `healthy` |
| 8 | `reporting_down` for 20 minutes | After 3 polls: a `supabase:reporting` incident delivered; heartbeat shows a `log` entry, not a `/fail` |
| 9 | Revoke the bot's Send Messages permission for one cycle, then restore it | Outbox retries; a permanent 403 becomes DEAD, the fallback route announces it once, the heartbeat shows `/fail` |
| 10 | Remove the cron trigger for 15 minutes (or `wrangler deployments`-pause equivalent) and restore | The heartbeat service alerts on missed pings; after restore the bot opens and later resolves `bot:schedule` |
| 11 | `/azerdex maintenance start` on the component, trigger `source_critical` | No alert while muted; alert after `end` while still critical |
| 12 | Real-runtime checks | Ed25519 verification on the Workers runtime, D1 `changes()` and `RETURNING` behaviour, nonce de-duplication, 429 handling, Discord's 3-second deadline, command permission UI |
| 13 | Log review | `wrangler tail` output contains no token, URL or clear operator id |

Record the evidence (timestamps, screenshots without secrets) in `docs/ops-bot/test-evidence.md` under "Staging validation".

## 6. Tear down staging

See [rollback-plan.md](rollback-plan.md). Pause the heartbeat check **before** removing the cron trigger so no false alarm is raised.
