# AzerDex Operations Bot V1: test evidence

Run date: 2026-11-06 (sandbox, Node 22.23 locally; CI pins Node 24). All results below are from `cd ops-bot && npm test` and `npm run typecheck`.

**Everything in this document is SIMULATED / LOCAL evidence.** Unit, contract, integration and security tests run against fakes (Discord, health provider, heartbeat, fallback, clock) and against a D1-shaped adapter over SQLite that executes the real migration SQL. No Discord server, Cloudflare account, Supabase project or heartbeat service was contacted. Section 3 lists what only a staging run can prove.

## 1. Results

| Check | Result |
| --- | --- |
| `npm run typecheck` (strict TypeScript, `noUncheckedIndexedAccess`) | pass |
| `npm test` | **189 passed, 0 failed** in 10 files |
| `npm audit --omit=dev` / `npm audit` | 0 vulnerabilities / 0 vulnerabilities |
| Mutation check (deliberately broken behaviour must fail the suite) | 7 of 7 caught, source restored, 189 pass |

| File | Tests | Covers |
| --- | --- | --- |
| `contract.test.ts` | 6 | strict versioned health contract, unknown-field rejection, paths-only errors |
| `evaluate.test.ts` | 16 | classification, G6 scenarios, freshness, reporting thresholds, schedule gap |
| `incidents.test.ts` | 19 | lifecycle, dedupe, races, reminders, recovery, ACK, maintenance, self-heal, retention |
| `outbox.test.ts` | 15 | delivery, duplicate attempts, leases, 429, 5xx/timeouts, DEAD, rendering |
| `cycle.test.ts` | 31 | healthy polling, failure/recovery, parallel runs, G6, Supabase failures, Discord failures, heartbeat |
| `interactions.test.ts` | 27 | signatures, replay, bounds, authorization, commands, button, deadline, mentions |
| `clients.test.ts` | 32 | Discord REST client, signed health client, retry policy, heartbeat and fallback adapters |
| `config.test.ts` | 16 | secret absence, invalid values, production guards, safe errors |
| `scenarios.test.ts` | 8 | staging synthetic scenarios |
| `security.test.ts` | 19 | log and payload secret hygiene, static guarantees, worker entry, rollback |

## 2. Required test matrix

| Required scenario | Where | Verified locally |
| --- | --- | --- |
| Healthy polling, no alerts | cycle: healthy polling | yes |
| Critical source failure | cycle: critical G2 source | yes |
| Recovery after critical failure | cycle: recovery; incidents: recovery | yes |
| Repeated identical critical events | cycle (60 min, 3 h, 8 h); incidents (ten identical) | yes |
| Parallel polling invocations | cycle: parallel; incidents: five racing; outbox: three workers | yes |
| Repeated ACK actions | incidents: ack (first wins, burst of six); interactions: command and button | yes |
| Unauthorized Discord user/guild | interactions: authorization (user, guild, DM, role, every subcommand, button) | yes |
| Invalid Discord signatures | interactions: bad/tampered/wrong key/missing/non-hex/whitespace | yes |
| Missing or expired monitoring responses | cycle: stale snapshot; evaluate: freshness; contract | yes |
| Supabase HTTP 401/403/429/500 and timeouts | cycle (7 parametrised cases incl. network and contract); clients: HttpHealthProvider | yes |
| Discord HTTP 429/500 and timeouts | outbox; cycle: Discord failures; clients: DiscordRestClient | yes |
| Duplicate message-delivery attempts | outbox: duplicate attempts, lease reclaim; incidents: idempotent enqueue | yes |
| Stopped G6 schedule | cycle: G6; evaluate: G6 | yes |
| Missing Cloudflare heartbeat | cycle: gap detection, crash `/fail`, misconfig `/fail`; security: worker entry | bot-side only; the external monitor's own missed-ping alert needs staging |
| Secret absence and invalid configuration | config (all required settings, production guards) | yes |
| No personal data or secrets in logs | security: canary scenario, redaction | yes |
| Rollback of all newly introduced components | security: rollback (down migration, isolation, self-contained tree); [rollback-plan.md](rollback-plan.md) | database and repository parts; runtime rollback needs staging |

## 3. NOT verified: requires staging (or later) validation

| Item | Why local tests cannot prove it |
| --- | --- |
| Ed25519 verification on the **Workers runtime** (and the `NODE-ED25519` fallback) | Tests use Node's WebCrypto |
| D1 specifics (`changes()` after batched statements, `RETURNING`, `ON CONFLICT DO NOTHING` on a partial unique index) | Tests use SQLite through `node:sqlite`, the same engine family but not D1 itself |
| Cron Trigger firing, jitter and overlap | Simulated with a fake clock |
| Real Discord behaviour: `nonce`/`enforce_nonce` duplicate suppression, real 429 payloads, message edit permissions, the 3-second interaction deadline under real latency, command-permission UI | Fakes only |
| Healthchecks-compatible service: ping URL shapes, `/log`, grace handling, alert routes independent of Discord | Fakes only |
| Fallback route delivery | Fake only |
| `wrangler` bundling, compatibility date, Worker size and CPU limits, plan limits and cost | `wrangler` is not installed or run in this workstream |
| **Supabase reporting endpoint** | Does not exist (design only): the bot has only run against mock data and synthetic scenarios |
| Any real G2/G6 data | Never read by this workstream |

## 4. Staging validation

*Not performed.* To be recorded here after the owner provides resources and confirms (see [staging-runbook.md](staging-runbook.md) §5).
