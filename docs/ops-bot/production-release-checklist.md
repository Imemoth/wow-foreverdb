# Production release checklist: AzerDex Operations Bot

**Nothing in this checklist is authorized by the Draft PR.** Production activation is a separate owner decision, taken only after every gate below is complete. Production deployment of this bot is also independent of, and must not displace, the Quest Tracker delivery lane.

## Gate A: code and review

- [ ] Draft PR reviewed by the owner; CI green (`AzerDex Ops Bot` workflow and all required checks); merged to `release` by the owner.
- [ ] Merging does not deploy anything: the website build is unaffected (`ops-bot/` is outside `web/`), and no Cloudflare or Supabase action is triggered by the merge.

## Gate B: staging evidence (all of [staging-runbook.md](staging-runbook.md) §5 completed and recorded)

- [ ] Items 1 to 13 passed with real Discord and Cloudflare runtime evidence.
- [ ] No secret, URL or clear operator id found in `wrangler tail` output.
- [ ] Cost and limits confirmed (Workers requests, Cron Triggers, D1 reads/writes, heartbeat provider plan).

## Gate C: Supabase reporting endpoint (separate approval and separate PR)

- [ ] [supabase-reporting-contract.md](supabase-reporting-contract.md) reviewed; projection function, dedicated role and Edge Function reviewed by the owner.
- [ ] Validated on an isolated non-production database; jobs 3 to 7 and all existing functions proven unchanged (md5 of commands and of function bodies); rollback rehearsed.
- [ ] Owner explicit GO to apply it to project `chcoypkjzxfznsqmmbrq` and to create its secrets.

## Gate D: production resources (owner-created)

- [ ] Production Discord application, bot and private channel; commands visible only to the operator role.
- [ ] Production Cloudflare Worker `azerdex-ops-bot`, D1 database `azerdex-ops-bot`, real `database_id` reviewed in `wrangler.toml`.
- [ ] **Production routing (documented, not activated by the Draft PR).** Production must be served from a **Custom Domain** (`custom_domain = true`) on an **active Cloudflare zone the owner controls**, not from `workers.dev` (Cloudflare recommends routes or custom domains for production; `workers.dev` is intended for personal and hobby use). The owner chooses the hostname, for example `ops.<owner-domain>`. `wrangler.toml` currently holds the placeholder `REPLACE-WITH-PRODUCTION-OPS-HOSTNAME.invalid`, so `wrangler deploy --env production` cannot succeed until a **reviewed PR** replaces it. Preconditions: the hostname has no existing CNAME record (Cloudflare refuses to create a Custom Domain over one); `workers_dev = false` and `preview_urls = false` stay as they are; Cloudflare creates the DNS record and certificate when the domain is attached.
- [ ] **No Cloudflare Access on the interactions hostname** (Discord cannot authenticate to it). The access control is the Ed25519 signature check plus server-side authorization. Optional extra: a Cloudflare WAF or rate-limiting rule on the hostname, decided by the owner and tested in staging first.
- [ ] Hostname verified before connecting Discord: `GET /healthz` returns `{"ok":true}`, an unsigned `POST /interactions` returns 401, and `GET /interactions` returns 405.
- [ ] Production heartbeat check (period 5 min, grace 10 min) with alert integrations independent of Discord; separate fallback route.
- [ ] Secrets set with `wrangler secret put --env production`: bot token, public key, application id, channel id, guild ids, operator ids, heartbeat URL, fallback URL, reporting URL and secret. `BOT_ENV=production`, `HEALTH_PROVIDER=http` (production refuses `mock`).
- [ ] D1 backup/export taken before first use of production data (the database starts empty; record that).

## Gate E: activation (owner present)

1. `wrangler d1 migrations apply azerdex-ops-bot --env production`; verify the ten tables.
2. Register commands for the production guild (guild-scoped only).
3. `wrangler deploy --env production` (only after the hostname placeholder was replaced through a reviewed PR); confirm the three hostname checks from Gate D; then set the Interactions Endpoint URL to `https://<production-hostname>/interactions` and let Discord's signed PING validate it.
4. First two cycles: no alert, heartbeat arriving, `/azerdex status` HEALTHY with real source data.
5. Controlled live test **only with explicit owner confirmation**: announce a maintenance window, run one synthetic acknowledgement flow, never alter production News, cron or collector settings to create a fault.
6. Confirm job 7 and jobs 3 to 6 unchanged (schedule and command md5), and no new application-role grant.

## Rollback triggers

Roll back ([rollback-plan.md](rollback-plan.md)) on any of: alert storm, false CRITICAL, a false HEALTHY found, an authorization bypass, secret exposure, repeated delivery duplication, cost above plan, or the owner's request.

## Sign-off

| Gate | Owner decision | Date |
| --- | --- | --- |
| A | | |
| B | | |
| C | | |
| D | | |
| E | | |
