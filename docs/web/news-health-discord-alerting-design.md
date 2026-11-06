# G6 → Discord: alerting architecture exploration (AZR-004)

**Date:** 2026-11-06  
**Status:** DISCOVERY / design proposal, **not an implementation or deployment approval**  
**Related:** [Product roadmap](azerdex-product-roadmap.md), [News V2](news-collector-v2.md), [G4/G5/G6 closure evidence](g4-g5-g6-execution-log-2026-11-05.md).

## Current truth

- Production G2 provides `private.azerdex_news_health()` (JSON; three sources, reasons, severities) and `private.azerdex_news_assert_healthy()`.
- Production G6 `azerdex-news-health` is job **7** every **15 minutes**; its critical exception appears as `failed` in `cron.job_run_details`. First scheduled run passed. No external notification currently exists.
- No actionable alert is caused merely by Blizzard not publishing new content.
- Existing permissions: internal monitoring functions are admin-only, not public Data API endpoints; do not loosen ACLs.
- Existing production `pg_cron` has four other jobs whose identity, schedule and command must be preserved.

## Decision recommendation: Discord incoming webhook first, not a bot

**MVP:** write a small, server-only **Supabase Edge Function** acting as an alert dispatcher and deliver notifications with a **Discord channel incoming webhook**. A bot application is unnecessary for one-way incidents and incurs permissions, operation and moderation complexity. A future slash-command/ACK/control-plane requirement may justify a separate least-privilege bot later.

Discord webhook URL is a secret with authority to post to a specific channel: keep it in server-side secret storage only; never embed in SQL files, repo, frontend, public logs or webhook output. Avoid `@everyone` by default; escape/filter mentions and set `allowed_mentions: { parse: [] }`. If intentional on-call pings are required, explicitly allow only a reviewed role ID and test it. No secrets, URLs with query tokens, raw source payloads or personal information in messages.

The Edge Function should not trust a caller-supplied `overall=critical` payload. It must authenticate the scheduled caller and compute its own limited read-only health snapshot via an internal, narrowly authorized server-side path. Do not grant `anon`, `authenticated` or a general-purpose client access to private monitoring RPCs. Evaluate whether a dedicated least-privilege reporting function or a restricted database connection can be introduced without expanding existing table access. Obtain explicit approval for any new production SQL/role/grant.

## Proposed flow

```text
Existing job 7: private.azerdex_news_assert_healthy() [unchanged]
                    |
          production health snapshot (admin only)
                    |
  NEW independent read-only alert evaluation schedule (candidate */5 or */15)
                    |
      authenticated internal evaluator / Edge Function
                    |
        durable incident state and dedupe
                    |
       Discord webhook + delivery audit/retry
                    |
          #azerdex-ops-alerts (private)
```

**Important:** a cron job that raises an exception is not a reliable place to send a webhook in the same transaction: a failure rolls back transactional database writes/request enqueueing. Use a separate successful evaluation/delivery path. Do not replace or weaken job 7. Choose one of two implementation patterns during discovery:

- **A (Supabase-only MVP):** a new authenticated cron-triggered Edge Function checks the authoritative source snapshot and maintains durable state. Simple and cheap, but **shares the failure domain** with Supabase scheduler/project.
- **B (independent monitor):** an external checker, with narrow protected status endpoint and independent clock, evaluates freshness and delivery. More robust against database/scheduler/project outage, but needs separate hosting/security, credentials and costs. Recommend an external heartbeat/availability check at minimum even if A is selected.

An isolated monitor that only reads `cron.job_run_details` can detect recorded failures but cannot conclude all-clear if both job 7 and the monitor stop. Monitor *missing expected executions* explicitly.

## Alert state machine / policy (proposal)

```text
HEALTHY --critical--> OPEN
OPEN --critical--> OPEN (no duplicate; bounded reminder only)
OPEN --healthy--> RECOVERED (single notification)
RECOVERED --healthy--> HEALTHY
ANY --unknown / probe failure--> MONITOR_DEGRADED (separate alert after threshold)
```

Key incidents by stable `sourceKey` + `state` (or a documented stable reason); changed root cause may update the ongoing incident rather than spam. The authoritative decision source is server-generated `private.azerdex_news_health()`. Preserve the current severity distinctions: `warning` may be logged, but pages only on `critical`; `healthy_no_new_content` and `all_rejected` do not page. The existing `revision_stale` escalation remains respected.

- **Open:** one alert on a confirmed critical state; include first-seen timestamp, source, state, safe cause, count, last healthy/fetch attempt and safe dashboard link.
- **Repeat:** one bounded reminder after an agreed interval (candidate 60–120 minutes); limit across multiple sources and persistent outages.
- **Recovery:** one alert when healthy again (optionally require 2 consecutive fresh successes before recovery to avoid oscillation).
- **Delivery reliability:** handle Discord 429 with `Retry-After`, exponential backoff, bounded retry budget and dead-letter/safe audit; never claim delivered merely because queued. Deduplicate across overlapping invocations with atomic compare-and-set/unique key.
- **Fail closed:** malformed/unavailable health probe must show `UNKNOWN` and produce a monitor-failure signal after threshold; never silently report green.
- **No-data monitoring:** no fresh Blizzard posts is not a fault. Collector stopped with no schedule execution **is** a fault.
- **Rate/control:** sanitize embed content and use timestamps, no raw exceptions or stack traces in Discord.

## Security, ownership and data separation

- Use a dedicated private Discord channel with least-privilege webhook and tested deletion/rotation.
- Never send the Postgres password, Supabase API keys, collector secret, raw inbound headers, webhook URL or any Vault values to Discord.
- Keep health snapshots minimized to counts, source keys, state and timestamps.
- Only scheduled, authenticated internal invocations may trigger evaluation. Design replay protection (timestamp/signature or credential + narrow endpoint), bounded work and rate limits.
- Clearly separate operational alert state from News content tables. Prefer a dedicated private store with retention; do not mutate published News rows.
- Test least-privilege SQL/RLS/Edge auth end to end; a secret in `pg_net`'s pending HTTP queue may be visible to database roles before dispatch, so validate the chosen signed-request / auth approach explicitly.
- Do not add a bot token or broad guild permissions for the MVP.

## Acceptance criteria for MVP

1. Normal G6 operation: no Discord messages.
2. Controlled, synthetic CRITICAL (isolated environment): one actionable message in the selected channel; no mutation of real News rows.
3. Ten repeated critical polls: at most one OPEN notification until reminder threshold.
4. Controlled recovery: exactly one RECOVERED message, no repeated recoveries.
5. Failed Discord delivery (429, timeout, 5xx): bounded retry, durable state, real delivery status and no message storm.
6. Failed health probe or paused scheduled evaluation: independent monitor/heartbeat raises an explicit UNKNOWN/STALLED signal; never sends false healthy.
7. A malicious or unauthenticated call cannot send an arbitrary Discord message.
8. No secret or unnecessary PII in logs, Discord payloads, CI artifacts or Git changes.
9. Existing job 7 and all four original schedules stay byte-identical; rollback removes only the new monitor components.
10. Test/runbook includes operator setup, rotation, rate limits, outage recovery and a staged → production gate.

## Decisions required BEFORE coding

1. Destination: existing private operations Discord server/channel or a new one?
2. Severity: critical-only MVP, with warnings silent but logged?
3. Mentions: no pings (default) or one explicitly approved on-call role?
4. Operational preference: (A) Supabase-only MVP plus external heartbeat, or (B) independent monitor from day one?
5. External check provider/hosting cost and acceptable notification latency (e.g. < 10–20 minutes).

## Suggested implementation slices (separate PRs, no deployment implied)

- **AZR-004A (design/spike):** read-only inventory of Supabase role boundaries and available health channels; evaluate A/B failure modes, persist ADR and test plan.
- **AZR-004B (server-side alert MVP):** guarded evaluator, isolated state, Discord integration, test fixtures, security tests and operational runbook, Draft PR.
- **AZR-005 (noise/recovery):** transition handling, dedupe, rate limit, retry and escalation acceptance.
- **AZR-006 (release):** owner-provided webhook secret via protected channel, staging synthetic fault/recovery and independent availability signal; separate owner production GO.

**Non-goals:** deploy a Discord bot, respond to slash commands, post news automatically, run story linking, change G5, modify Guildbook/account permissions, activate G7 or send production test alerts without approval.
