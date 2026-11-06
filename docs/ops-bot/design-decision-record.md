# ADR-AZR-004: AzerDex Operations Bot (full Discord bot + Cloudflare Workers + D1 + read-only Supabase monitoring + independent heartbeat)

**Date:** 2026-11-06
**Status:** ACCEPTED by the owner (architecture), implementation in Draft PR (this branch). **Not deployed. No production activation is authorized by this document.**
**Supersedes:** the "Decision recommendation: Discord incoming webhook first, not a bot" section of `news-health-discord-alerting-design.md` and the "Interactive Discord bot ... PARKED" Idea Inbox row in `azerdex-product-roadmap.md`, both on Draft PR #172 (see [roadmap-change-proposal.md](roadmap-change-proposal.md); PR #172's branch is intentionally not modified here).
**Related:** [News V2](../web/news-collector-v2.md) §8, [G4/G5/G6 closure evidence](../web/g4-g5-g6-execution-log-2026-11-05.md), [release gates](../web/release-gates.md).

## Context

Production has G2 (`private.azerdex_news_health()`, `private.azerdex_news_assert_healthy()`) and G6 (`azerdex-news-health`, cron job 7, every 15 minutes). A critical state makes job 7 `failed` in `cron.job_run_details`. Nothing notifies a human, and an operator can only see the failure by running SQL. Discovery in PR #172 recommended a one-way webhook first. The owner has chosen a full bot instead, because two-way operation (acknowledge, see state, mute) and an independent failure domain are required.

## Decision

Build the **AzerDex Operations Bot V1** as a TypeScript Cloudflare Worker (`ops-bot/`):

| Concern | Choice |
| --- | --- |
| Discord inbound | **HTTPS Interactions Endpoint** (`POST /interactions`), Ed25519-verified. No Gateway connection. |
| Discord outbound | **Bot REST API** (create/edit message in one alert channel; edit original interaction response). |
| Scheduling | **Cloudflare Cron Trigger**, every 5 minutes. Independent of Supabase `pg_cron`. |
| State | **Cloudflare D1**: incidents, audit, durable outbox, maintenance, replay and rate-limit tables. Separate from every News/publication table. |
| Supabase | **Read-only**, through a single typed `HealthProvider` interface returning a strictly validated, versioned report. The bot holds no database credential. |
| Independent monitoring | **External heartbeat** (Healthchecks.io-compatible) plus a **separate fallback notification route**. |
| Public endpoint | Staging: `workers.dev` (`workers_dev = true`, no route). Production: a Custom Domain on an owner-controlled zone, documented and **not activated**. Preview URLs off everywhere; no Cloudflare Access on the endpoint (Discord cannot authenticate to it; the signature check is the access control). |
| Scope | **Read and acknowledge only.** No restart, remediation, backfill, deploy or settings command exists. |

```text
                 Cloudflare Worker (azerdex-ops-bot)                          Healthchecks.io-compatible
  Cron */5 ──►  runCycle ── lease(D1) ── HealthProvider ──(signed GET)──► [FUTURE] Supabase reporting endpoint
                    │            │                                          (read-only projection of G2 + job 7)
                    │            ▼
                    │     evaluate ► incident engine (D1: OPEN → ACKNOWLEDGED → RESOLVED, dedupe, reminders, recovery)
                    │            ▼
                    │      outbox (D1) ──► Discord REST ──► #ops-alerts   (429 / 5xx / timeout handled, bounded retry)
                    │            │ DEAD ──► FallbackNotifier (separate route)
                    ▼
        heartbeat ok / log / fail  ───────────────────────────────────────►  external monitor (alerts on MISSED pings)

  Discord ──► POST /interactions ──► verify Ed25519 ► replay ► authz (guild + operator) ► rate limit ► handler (D1 only)
```

## Failure domains (why each piece exists)

| What fails | What still works | How it is noticed |
| --- | --- | --- |
| Supabase / `pg_cron` / reporting endpoint | The bot cycles, records a `supabase:reporting` incident after the threshold, delivers it to Discord, and keeps every existing incident open (UNKNOWN never counts as healthy). | Discord alert; heartbeat `log` entry; `/azerdex status` shows UNKNOWN. |
| Discord API | Incidents and the outbox persist in D1; delivery retries with backoff, honours `Retry-After`, and after the retry budget the row is DEAD. | Fallback route announces each dead delivery once; heartbeat `/fail delivery_failing`. |
| D1 or a bot bug | Nothing in Supabase is affected. | Heartbeat `/fail cycle_error`, or missed pings if the Worker did not run at all. |
| Cloudflare Cron (missed executions) | On the next run the bot measures the gap and opens a `bot:schedule` incident. | External monitor alerts on missing pings. This is the one case no in-process code can detect. |
| Supabase **and** Cloudflare both down | n/a | The external monitor still alerts (no pings) through its own routes. |

## State machine and policy (retained from the PR #172 design, now implemented)

`HEALTHY → CRITICAL (incident OPEN) → ACKNOWLEDGED → RESOLVED`; `RECOVERED` is the confirmation transition. Per component, exactly one unresolved incident exists, enforced by a unique index. Critical opens one alert; at most one reminder after 120 minutes while OPEN; acknowledgement stops reminders; recovery needs two consecutive healthy polls and produces one RECOVERED message that references the incident. `warning` and `info` severities are logged and visible in `/azerdex status`, never paged. `healthy_no_new_content` and `all_rejected` are never failures. A changed root cause is one meaningful update, not a new incident. Malformed, stale or unavailable reports are UNKNOWN, and only escalate to a monitoring incident after 3 consecutive failed polls (2 for 401/403).

G6 correlation: job 7 fails *by design* while a source is critical. In that case the failed run is classified as explained (WARNING, no second incident). A failed run while all sources are healthy, a missing or inactive job, or a stalled schedule (no run for 45 minutes) is CRITICAL.

## Delivery semantics (stated honestly)

The bot guarantees: **idempotent enqueueing** (deterministic outbox keys, unique index), **at-least-once delivery attempts** with bounded retry, durable state across crashes, and best-effort duplicate suppression through Discord `nonce` + `enforce_nonce`. It does **not** claim global exactly-once delivery: a timeout after Discord accepted a message can, outside Discord's short nonce window, produce a duplicate message. Acknowledgements are exactly-once in effect (first acknowledgement wins, compare-and-set).

## Security boundaries

1. Discord is untrusted input: the Ed25519 signature is verified over the original bytes before JSON parsing; timestamp freshness (5 minutes), interaction-id replay protection, body size cap, strict schema.
2. Authorization is deny-by-default: configured guild ids **and** configured operator user or role ids, on every command and button. No operators configured is a startup error.
3. The bot's Supabase capability is one read-only, HMAC-signed GET of a narrow report. It has no database password, no service-role key, no `private`/`cron` schema access and no write path. The report contract is `.strict()`: unknown fields are rejected, so player or account data cannot ride along.
4. Commands change only bot-local state (acknowledgement, notification mute, audit). They cannot modify News data, cron jobs, credentials or production settings, and the repository tests assert the absence of such code paths.
5. Secrets exist only as Worker secrets; production refuses to start without heartbeat and fallback configuration, refuses the mock provider, and refuses a redirected Discord API base. Logs are redacted and operator ids are pseudonymised.
6. Messages disable mentions (`allowed_mentions.parse = []`) and sanitise all dynamic text.

Full analysis: [threat-model.md](threat-model.md).

## Alternatives considered

| Option | Why not chosen |
| --- | --- |
| Incoming webhook from a Supabase Edge Function (PR #172 recommendation) | One-way; shares the Supabase failure domain; no acknowledgement or state view. The owner superseded it. |
| Discord Gateway (always-connected) bot | Needs a persistent process; Workers cannot hold a Gateway connection. Interactions over HTTPS cover every V1 requirement. |
| `pg_net` call from the failing cron job | A raising job rolls back its own transaction (including the HTTP enqueue); also puts a secret in the pg_net queue. |
| Healthchecks.io alone | Detects silence, not a critical source state, and offers no incident lifecycle. Kept as the independent layer. |

## Consequences

- New operational surface: one Worker, one D1 database per environment, one Discord application, one external heartbeat check. Costs are expected to stay within Cloudflare's free tiers at a 5-minute cadence, and must be confirmed in staging.
- A **future, separately approved** Supabase component is required (the protected reporting endpoint, [supabase-reporting-contract.md](supabase-reporting-contract.md)). Until it exists, the bot can only run against the mock provider and synthetic scenarios.
- Job 7, the four collector/publisher jobs and every G2 function remain **unchanged**. The bot adds no database object to Supabase.

## Parallel-work exception (WIP record)

The roadmap sets a WIP limit of one main delivery initiative and names Q-001 (Issue #169, PRs #168/#170) the single active lane. The owner explicitly authorized AZR-004 to be developed **in parallel as an isolated, non-production workstream** on 2026-11-06 (instruction "AZR-004 Parallel Discord Operations Bot Development"). Conditions that remain in force: no merge, no production deployment, no Supabase production change, no real Discord posting, no interference with PRs #168/#170 or Quest/Addon/Companion/Guildbook work; production activation needs its own owner GO and the checklist in [production-release-checklist.md](production-release-checklist.md). Each workstream keeps independent ownership, acceptance gates and release authorization. The roadmap's safety gates (Draft PR review, CI, rollback, owner production GO) are preserved unchanged.
