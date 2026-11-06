# AzerDex Operations Bot V1: threat model

Scope: the Worker in `ops-bot/`, its D1 database, the Discord application, the heartbeat and fallback routes, and the (future, undeployed) Supabase reporting endpoint. Method: assets and trust boundaries first, then STRIDE per boundary. "Test" names point to files under `ops-bot/test/`.

## Assets

| Asset | Why it matters |
| --- | --- |
| Discord bot token, application public key | The token can post as the bot; the public key authenticates inbound interactions. |
| Reporting secret (HMAC key shared with the future endpoint) | Authorises reads of the health report. Read-only, but must not be forgeable. |
| Heartbeat ping URL, fallback webhook URL | Possession lets an attacker send false "alive" pings, or post to the fallback channel. |
| Incident, audit and outbox state in D1 | Operational truth; contains operator Discord ids but no player, Guildbook or account data. |
| Integrity of "healthy" | A false green is the worst failure of a monitor. |
| Existing production (Supabase, News, cron jobs) | Must be unreachable from the bot except by one read-only report. |

## Trust boundaries

1. Internet to `POST /interactions` (anyone can send requests; only Discord-signed ones are valid).
2. Discord operators to the bot (authenticated by Discord, authorised by the bot).
3. Worker to the reporting endpoint (future): Worker to Supabase.
4. Worker to Discord REST, to the heartbeat service and to the fallback route.
5. Worker to D1.

## STRIDE

| # | Threat | Mitigation in V1 | Test |
| --- | --- | --- | --- |
| S1 | Forged interaction (anyone posts a fake "ack" or "maintenance") | Ed25519 signature over `timestamp + original bytes` before any parsing; 401 on any failure; wrong application id also 401 | interactions: bad signature, tampered body, wrong key, missing headers, whitespace-different body |
| S2 | Replayed valid interaction | 5-minute timestamp window; interaction id stored in `seen_interactions` (unique); second use is 401 | interactions: replay |
| S3 | Impersonated operator or guild | Authorization on every command **and** button: guild allowlist and user or role allowlist; DMs denied; no operators configured is a startup error | interactions: authorization (negative); config |
| S4 | Spoofed reporting response (false green, or forged critical) | Responses are only accepted through the signed GET to the configured https URL, `redirect: "error"`, strict schema, freshness window; anything else is UNKNOWN | clients: HttpHealthProvider; cycle: stale snapshot |
| S5 | False "alive" heartbeat | Ping URL is a secret and `config` refuses non-https; pings carry a fixed vocabulary; a leaked URL is rotated in the heartbeat service (runbook) | clients: heartbeat; security: logs |
| T1 | Tampering with incident state through the commands | Commands only run fixed, parameterised statements on bot tables; ids validated by regex; ACK changes only the incident row; maintenance only mutes notifications (max 24 h, audited) | interactions: commands, maintenance; incidents: ack |
| T2 | SQL injection via command options or health fields | Parameter binding everywhere; ids regex-validated; contract rejects unexpected fields and free text | interactions: invalid ids; contract |
| T3 | Tampering with the health contract to smuggle data | `.strict()` schema, bounded arrays and strings, code-shaped fields | contract |
| R1 | Operator denies acknowledging or muting | `incident_events` and `audit_log` record actor id and time; first acknowledgement wins and is never overwritten | incidents: ack |
| I1 | Secret leakage through logs, errors or Discord payloads | Redacting logger (keys, webhook URLs, bot/bearer tokens, hex blobs, mentions), operator ids pseudonymised, generic user-facing errors, `ConfigError` carries codes not values | security: canary scenario, redaction, config |
| I2 | Information leak to unauthorised Discord users | Refusals are generic and reveal no ids or configuration; all replies are ephemeral | interactions: authorization |
| I3 | Personal data in monitoring payloads | Contract contains counts, source keys, codes and timestamps only; strict schema | contract |
| I4 | Disclosure through `/healthz` | Liveness only: static `{ok:true}` | security: worker entry |
| D1 | Flooding the endpoint | Cloudflare edge; body cap (64 KiB) before parsing; signature failure is cheap; per-operator rate limit (10 per minute) | interactions: bounded input, rate limit |
| D2 | Alert storm (flapping, repeated events, Discord outage) | One incident per component (unique index), idempotent outbox keys, reminder throttle, recovery confirmation, bounded retries, batch limit | incidents, cycle, outbox |
| D3 | Overlapping cron invocations | D1 lease with compare-and-set; stale lease reclaimed | cycle: parallel invocations |
| D4 | Dependency outage (Supabase, Discord, heartbeat) | Failure is data, not exceptions; each classified and bounded; heartbeat or fallback failure never breaks the cycle | cycle, clients |
| D5 | Unbounded growth | Retention purge (resolved incidents 90 days, replay ids 1 day, rate limits 1 h) | incidents: retention |
| E1 | Privilege escalation to Supabase or News | The bot has no database credential and the provider interface has one read-only method; tests assert no service-role, DB URL, cron or News-write code exists | security: static guarantees |
| E2 | Mention abuse (`@everyone`) through source-controlled text | `allowed_mentions.parse = []` on every payload; text sanitised | interactions: mentions |
| E3 | Command surface growth | Commands are hidden by default (`default_member_permissions: "0"`) and limited to five read/ack subcommands; test pins the list | security: static guarantees |
| M1 | Misconfiguration (mock provider, wrong environment, mixed secrets) | Production refuses the mock provider, a redirected Discord API base, and missing heartbeat or fallback; staging messages carry an `[staging]` footer; separate resources per environment (wrangler has no default env) | config; security: wrangler |
| M2 | Blind spots (the monitor itself stops) | External heartbeat (missed ping), `/fail` on cycle error or config error, gap detection on the next run, fallback route for dead Discord deliveries | cycle: heartbeat, gap; security: worker entry |

## Residual risks and open items

- **Runtime differences are not proven by unit tests.** The tests run the real migration SQL on SQLite (D1's engine) and use WebCrypto Ed25519, but D1 specifics, the Workers runtime, real Discord behaviour (nonce enforcement, 429 shapes) and real cron firing must be validated in staging ([staging-runbook.md](staging-runbook.md)).
- **A compromised operator account can acknowledge and mute.** Impact is bounded (no data or control actions, mutes limited to 24 hours, everything audited); mitigate with Discord role hygiene and 2FA.
- **Cloudflare account compromise** exposes Worker secrets; use a dedicated account or limited API tokens and enable 2FA (owner decision).
- **Heartbeat URL leakage** allows false "ok" pings; rotate it in the heartbeat service and via `wrangler secret put`.
- **Duplicate Discord messages** can still occur after an ambiguous timeout outside Discord's nonce window (documented in the ADR, not hidden).
- **Reporting endpoint** is undeployed. Its threat model (secret handling in the Edge Function, HMAC verification, database role) must be reviewed with the owner before any production step ([supabase-reporting-contract.md](supabase-reporting-contract.md)).
- **Clock skew** beyond 5 minutes between Discord and the Worker would reject valid interactions (fail closed); Cloudflare time is NTP-synchronised.
- **`node:sqlite` is experimental**; it is a test-only dependency and does not ship in the Worker.
