# Staging runbook: AzerDex Operations Bot

Status: **instructions only. Nothing here has been executed.** Creating channels, registering a Discord application, changing Discord permissions, creating Cloudflare resources, deploying a Worker and posting real Discord messages each need the owner's separate authorization first. Staging and production use **separate Discord applications, bot tokens, permissions, Cloudflare Workers, D1 databases and heartbeat checks**; never reuse one across environments.

## 0. Discord topology and owner-side setup

### 0.1 The existing AzerDex Discord server is used (owner-confirmed)

The official AzerDex Discord server already exists: **Guild ID `1561649407584370809`**. It has an established community structure, including a private STAFF ONLY category, and has not yet been opened to the public. Do **not** create or require a new Discord server. Staging and production both use this guild, strictly separated by application, token, channel, operators, Worker, D1 and heartbeat:

| | Staging | Production |
| --- | --- | --- |
| Discord guild | `1561649407584370809` | `1561649407584370809` (same server) |
| Alert and command channel | `#ops-testing` | `#ops-alerts` |
| Discord application | a separate Discord application, for example "AzerDex Ops (staging)" | a separate Discord application, for example "AzerDex Ops" |
| Bot token, public key, application id | staging application only | production application only |
| Cloudflare Worker | `azerdex-ops-bot-staging` | `azerdex-ops-bot` |
| D1 database | `azerdex-ops-bot-staging` | `azerdex-ops-bot` |
| Heartbeat check and fallback route | staging check | production check |
| Operator ids (`OPERATOR_USER_IDS` / `OPERATOR_ROLE_IDS`) | set per environment | set per environment |
| Commands usable in | `#ops-testing` only | `#ops-alerts` only |

Optional `#ops-logs`: V1 posts **nothing** to a logs channel (there is no such feature), so it needs no bot permission and can stay uncreated until a future, separately approved change uses it.

The guild id is a public identifier, so it is a plain var in `wrangler.toml` for both environments (`DISCORD_GUILD_IDS`); it is not entered as a secret.

### 0.2 Proposed channel layout (proposed and not yet confirmed as created)

The channels are proposed and not yet confirmed as created; update this runbook with the real ids once they exist.

```text
OPERATIONS  (private category; visible only to explicitly authorized staff/operators)
  #ops-testing   staging bot only
  #ops-alerts    production bot only
  #ops-logs      optional, unused by V1
```

Rules that keep the environments apart even though they share one server:

- `OPERATIONS` is private: `@everyone` is denied **View Channel**; only the authorized operators (a dedicated `ops-operators` role, or named users) are allowed. It is a **new** category: nothing is moved into or out of STAFF ONLY.
- Each bot is allowed **View Channel, Send Messages and Embed Links** in **its own channel only**, through a channel-level permission overwrite for the bot. The staging bot is allowed in `#ops-testing` only: it cannot see or post in `#ops-alerts`, and the production bot has no access to `#ops-testing`. A mistyped channel id in staging therefore fails safe (Discord answers 403, the outbox row goes DEAD and the fallback route reports it) instead of posting into the production channel.
- Neither bot gets Administrator, Manage Messages, Manage Channels, Mention Everyone, or any permission at the server level.
- Each application's `/azerdex` command is allowed only for the operators and only in its own channel (Server Settings > Integrations > the application > `/azerdex`).
- The Worker independently enforces: the Ed25519 public key of **its own** application, the application id, the guild allowlist and the operator allowlist. A signature from the other environment's application is rejected.

### 0.3 What stays untouched

Do **not** modify existing channels, roles, onboarding configuration, rules screening, Community settings or community permissions. The only additions are (1) the new private `OPERATIONS` category with its channels, and (2) the bots themselves (Discord may add one managed role per bot; it must carry no permissions and sit below every staff role). Because the server is not yet public, nothing here is visible to the community; **when the server opens**, re-check with "View Server As Role" that `@everyone` and every onboarding/member role cannot see `OPERATIONS`, and that no `OPERATIONS` channel was added to Onboarding's default channels.

### 0.4 What the owner supplies

| Item | Notes |
| --- | --- |
| Authorization to create the `OPERATIONS` category and `#ops-testing` in guild `1561649407584370809` | Production's `#ops-alerts` can wait until production activation. |
| Staging Discord application | Bot user, public key, application id. Not public, no privileged intents, no Gateway use. |
| Operator user id(s) or role id | Who may use `/azerdex` in staging. |
| Cloudflare account + `wrangler` login | Plan limits for Workers, Cron Triggers and D1 to be confirmed. Install `wrangler` per Cloudflare's documentation; it is deliberately not a repository dependency. |
| Cloudflare `workers.dev` account subdomain | Registered under Workers & Pages (shown as "Your subdomain"; Wrangler offers to register it on the first deploy). **Staging uses `workers.dev` and needs no custom domain or DNS change.** |
| Healthchecks.io-compatible check (staging) | Period 5 minutes, grace 10 minutes. Its alert integrations (for example email or SMS) must be **independent of Discord**. |
| Fallback route (optional in staging) | An https endpoint accepting JSON `{ "text": "..." }`. |

### 0.5 Owner-side setup for the first staging test

Everything below is performed by the owner (or by an agent only after the owner separately authorizes that exact step). None of it has been done.

**A. Discord, in guild `1561649407584370809` (enable Developer Mode to copy ids)**

1. Decide the operators: a dedicated `ops-operators` role (a new role is an addition) or named user ids. Copy the operator user ids (and the role id if used).
2. Create the private `OPERATIONS` category: deny `@everyone` View Channel; allow the operators. Create `#ops-testing` inside it (leave `#ops-alerts` and `#ops-logs` for later). Copy the `#ops-testing` channel id.
3. In the Discord **Developer Portal** create a new application for staging (not the production one). Under **Bot**: create the bot, turn **Public Bot** off, leave all privileged intents off, copy the token (never paste it into chat, files or GitHub). Under **General Information** copy the **Application ID** and **Public Key**.
4. Invite the staging bot to the guild only, with **no** permissions: `https://discord.com/oauth2/authorize?client_id=<STAGING_APPLICATION_ID>&scope=bot%20applications.commands&permissions=0&guild_id=1561649407584370809&disable_guild_select=true`.
5. In `#ops-testing` add a permission overwrite for the staging bot: **View Channel, Send Messages, Embed Links** (nothing else). Confirm the staging bot has no access to any other channel. Make sure its managed role (if one appeared) has no permissions and sits below the staff roles.

**B. Cloudflare and heartbeat**

6. Log in with `wrangler`; make sure the account has a `workers.dev` subdomain.
7. Create the staging D1 database, put its `database_id` into `[[env.staging.d1_databases]]` via a reviewed change (do not commit anything else from your account), and apply the migration (section 1).
8. Create the staging heartbeat check (period 5 min, grace 10 min) with alert routes that do not use Discord; optionally a fallback route.
9. Set the staging secrets with `wrangler secret put ... --env staging` (section 2): `DISCORD_BOT_TOKEN`, `DISCORD_PUBLIC_KEY`, `DISCORD_APPLICATION_ID`, `DISCORD_ALERT_CHANNEL_ID` (= the `#ops-testing` id), `OPERATOR_USER_IDS` (and/or `OPERATOR_ROLE_IDS`), `HEARTBEAT_PING_URL`, optionally `FALLBACK_WEBHOOK_URL`. `DISCORD_GUILD_IDS` is already in `wrangler.toml`.

**C. Connect and test**

10. Register the staging commands for the guild (section 3), then in Server Settings > Integrations > the staging application > `/azerdex`: allow only the operators and only `#ops-testing`.
11. Deploy `wrangler deploy --env staging`, run the four `curl` checks, and set the **Interactions Endpoint URL** (section 4). Discord's signed PING must validate it.
12. Run the scenarios in section 5, in `#ops-testing` only.

Each of steps 2 to 5, 7 to 9, 10, 11 and 12 requires the owner's separate authorization before it is carried out.

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
for s in DISCORD_BOT_TOKEN DISCORD_PUBLIC_KEY DISCORD_APPLICATION_ID DISCORD_ALERT_CHANNEL_ID OPERATOR_USER_IDS HEARTBEAT_PING_URL FALLBACK_WEBHOOK_URL; do
  npx wrangler secret put "$s" --env staging
done
```

(`OPERATOR_ROLE_IDS` optionally.) All of these come from the **staging** Discord application and `#ops-testing`; none may be a production value. `DISCORD_GUILD_IDS` is a plain var in `wrangler.toml` (the existing guild `1561649407584370809`); do not also set it as a secret. Staging uses `HEALTH_PROVIDER=mock` from `wrangler.toml`; no Supabase credential exists in staging.

## 3. Register commands (guild-scoped, staging)

```bash
DISCORD_BOT_TOKEN=... DISCORD_APPLICATION_ID=<staging application id> DISCORD_GUILD_ID=1561649407584370809 npx tsx scripts/register-commands.ts --apply --staging
```

(set the token from your protected shell, never on a shared command line; the guild id is public). In the server: Server Settings > Integrations > the **staging** application > `/azerdex`: allow it **only** for the operators and only in `#ops-testing`. The Worker enforces authorization independently.

## 4. Deploy, expose and connect

### Routing decision (verified against Cloudflare's Workers documentation on 2026-11-06)

Discord can only deliver interactions to a **public HTTPS URL**, so the staging Worker needs a public hostname. `wrangler.toml` therefore sets, for `[env.staging]` only:

- `workers_dev = true`, giving `https://azerdex-ops-bot-staging.<account-subdomain>.workers.dev` (the Worker `name` is the first label; Cloudflare limits it to 63 characters of letters, digits and dashes). Cloudflare infers `workers_dev = false` whenever a `route` is configured and defaults it to true only when none is, so the file states it explicitly and defines no `route`.
- `preview_urls = false`: from Wrangler 4.44 the preview-URL default follows `workers_dev`, which would otherwise publish a second hostname for every version. Not needed, so off.
- The top level of the file has `workers_dev = false` and `preview_urls = false`, so a bare `wrangler deploy` (without `--env`) publishes nothing.

Why `workers.dev` and not a dedicated hostname: staging is disposable and needs no DNS change, certificate management or zone. Cloudflare describes `workers.dev` as intended for personal and hobby projects and recommends routes or custom domains for production; production therefore uses a Custom Domain (see [production-release-checklist.md](production-release-checklist.md) Gate D). A dedicated staging hostname is only worth it if the owner wants a stable, branded URL. In that case replace `workers_dev = true` with a `[[env.staging.routes]]` Custom Domain entry in a reviewed PR.

**Being public grants nothing.** The endpoint accepts a request only if it carries a valid Discord Ed25519 signature over the original body (otherwise 401), is within the 5-minute timestamp window, has not been seen before, comes from the configured application, and the user is a configured operator in a configured guild. `GET /healthz` returns only `{"ok":true}`. This is covered by `ops-bot/test/worker-endpoint.test.ts`.

**Do not enable Cloudflare Access on this hostname** (including the one-click option in the Worker's settings): Discord cannot authenticate to Access, so the endpoint would stop validating. Signature verification is the access control. The `workers.dev` hostname is a public certificate record; keep names free of sensitive information (the Worker name is deliberately neutral).

### Deploy

```bash
npx wrangler deploy --env staging
```

The output prints the URL. On the first deploy of a new `workers.dev` hostname, `523` errors for about a minute are normal while DNS propagates.

### Verify the hostname before connecting Discord (no secrets needed)

```bash
H=https://azerdex-ops-bot-staging.<account-subdomain>.workers.dev
curl -s  "$H/healthz"                                        # expect {"ok":true}
curl -si -X POST "$H/interactions" -d '{}' | head -1         # expect HTTP/2 401 (no signature)
curl -si "$H/interactions" | head -1                         # expect HTTP/2 405
curl -si "$H/" | head -1                                     # expect HTTP/2 404
```

If `/interactions` answers `503 {"error":"service_unavailable"}`, a required secret or setting is missing or invalid: the Worker fails closed (`wrangler tail` shows only issue codes, never values).

### Connect Discord

Set the application's **Interactions Endpoint URL** to `https://azerdex-ops-bot-staging.<account-subdomain>.workers.dev/interactions` (that is, `$H/interactions`). Discord sends a signed PING and only saves the URL if the Worker answers correctly, which also proves the public key and signature verification work end to end.

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
| 9 | In `#ops-testing` only, revoke the staging bot's Send Messages permission for one cycle, then restore it | Outbox retries; a permanent 403 becomes DEAD, the fallback route announces it once, the heartbeat shows `/fail` |
| 10 | Remove the cron trigger for 15 minutes (or `wrangler deployments`-pause equivalent) and restore | The heartbeat service alerts on missed pings; after restore the bot opens and later resolves `bot:schedule` |
| 11 | `/azerdex maintenance start` on the component, trigger `source_critical` | No alert while muted; alert after `end` while still critical |
| 11b | Environment separation | The staging bot can neither see nor post in `#ops-alerts` or `#ops-logs` (check once `#ops-alerts` exists; a post attempt returns 403 and ends DEAD); the staging application's `/azerdex` is not offered in any other channel; the staging Worker rejects an interaction signed by another application |
| 11a | Routing and exposure | The four `curl` checks in section 4 return 200 / 401 / 405 / 404; `wrangler deployments list --env staging` shows no preview or version URL in use; no Cloudflare Access application protects the hostname |
| 12 | Real-runtime checks | Ed25519 verification on the Workers runtime, D1 `changes()` and `RETURNING` behaviour, nonce de-duplication, 429 handling, Discord's 3-second deadline, command permission UI |
| 13 | Log review | `wrangler tail` output contains no token, URL or clear operator id |

Record the evidence (timestamps, screenshots without secrets) in `docs/ops-bot/test-evidence.md` under "Staging validation".

## 6. Tear down staging

See [rollback-plan.md](rollback-plan.md). Pause the heartbeat check **before** removing the cron trigger so no false alarm is raised.
