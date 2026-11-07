# AzerDex Operations Bot V1: test evidence

Run date: 2026-11-06 (sandbox, Node 22.23 locally; CI pins Node 24). All results below are from `cd ops-bot && npm test` and `npm run typecheck`.

**Everything in this document is SIMULATED / LOCAL evidence.** Unit, contract, integration and security tests run against fakes (Discord, health provider, heartbeat, fallback, clock) and against a D1-shaped adapter over SQLite that executes the real migration SQL. No Discord server, Cloudflare account, Supabase project or heartbeat service was contacted. Section 3 lists what only a staging run can prove.

## 1. Results

| Check | Result |
| --- | --- |
| `npm run typecheck` (strict TypeScript, `noUncheckedIndexedAccess`) | pass |
| `npm test` | **255 passed, 0 failed** in 15 files |
| `npm audit --omit=dev` / `npm audit` | 0 vulnerabilities / 0 vulnerabilities |
| Mutation check (deliberately broken behaviour must fail the suite) | 7 of 7 caught, source restored |
| Regression tests for the CodeQL findings | 4 of 18 failed on the unfixed code (the 200,000-character case took 65 s), all pass after the fix |

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
| `regex-safety.test.ts` | 18 | CodeQL findings: linear-time text helpers under adversarial input, parsed-URL credential detector |
| `routing-config.test.ts` | 12 | `wrangler.toml` routing and environment rules, documentation consistency |
| `worker-endpoint.test.ts` | 7 | the public endpoint through the real Worker `fetch`: signature, authorization, methods, paths |
| `preflight.test.ts` | 19 | read-only Discord preflight: permission arithmetic in Discord's documented order, every misconfiguration, read-only requests, token never leaked |
| `discord-topology.test.ts` | 10 | existing guild `1561649407584370809`: per-environment separation in configuration, documentation consistency |

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

## 5. Security gate (CodeQL code scanning) on PR #174

| Step | Result |
| --- | --- |
| Original head `7c2b4bd` | `Ops bot (typecheck, tests, audit)` passed; workflow job `codeql` passed; **GitHub's `CodeQL` code-scanning check failed with 2 new high alerts** |
| Findings | `messages.ts:55` polynomial regular expression (real, latent, not exploitable today); `security.test.ts:100` missing regular-expression anchor (test-only detector, genuinely weak, not a false positive) |
| Resolution | Linear `trimEnd()`; parsed-URL detector. No suppression, exclusion, dismissal or severity change. Details: [threat-model.md](threat-model.md) "Code-scanning findings and resolutions" |
| Local verification | `npm run typecheck` pass; `npm test` 207 passed; the 4 regression tests that failed before the fix pass after it |
| Re-scan on the updated head | Recorded in the PR #174 security-gate report (commit SHA and the complete check matrix); see the PR conversation |

## 6. Staging readiness gate: routing

| Check | Result |
| --- | --- |
| Cloudflare documentation (workers.dev, routes, custom domains, environments, preview URLs) | Verified 2026-11-06; rules summarised in the header of `ops-bot/wrangler.toml` and in the staging runbook section 4 |
| Defect found | Staging had `workers_dev = false` and no route, so no stable public hostname existed for Discord. The top level also relied on Cloudflare's default (`workers_dev` is true when no route is configured), so a bare `wrangler deploy` would have published an unconfigured Worker |
| Decision | Staging: `workers_dev = true` (no route, no custom domain, no DNS change). Production: `workers_dev = false` plus a Custom Domain placeholder, not activated. Every scope sets `workers_dev` and `preview_urls` explicitly |
| `wrangler deploy --dry-run` (Wrangler 4.158.0, scratch copy, no authentication, nothing created) | `--env staging`, `--env production` and the top level all parse and bundle (138 KiB gzipped); bindings listed as expected; a bare deploy is warned about and has no bindings. **Routing semantics cannot be shown by a dry run**, so they are covered by the documentation check and the static tests |
| Static and integration tests | 19 new tests (12 routing/configuration, 7 endpoint); mutation check: 6 deliberate breakages (staging `workers_dev=false`, top-level `workers_dev` removed, staging preview URLs on, production real-looking hostname, signature bypass, authorization bypass) all failed the suite, source restored |
| Still NOT verified | A real deployment, the actual `workers.dev` URL, DNS/certificate behaviour, Discord's endpoint validation, and Cloudflare Access absence: all require the staging run (runbook section 5, item 11a) |

## 7. Existing Discord server: documentation and configuration reconciliation

The official AzerDex Discord server exists (guild `1561649407584370809`). The staging runbook, production checklist, design record, threat model and PR description were corrected: no new server is created or required; staging uses `#ops-testing` and production `#ops-alerts` (proposed, not yet confirmed as created) in a private `OPERATIONS` category; separate Discord applications, tokens, Workers, D1 databases and heartbeat checks. The guild id became a plain var in both environments. Verified by `discord-topology.test.ts` (configuration and documentation). **Not verified:** that the channels exist, the permission overwrites, command visibility, the managed bot roles and the privacy of `OPERATIONS` when the server opens: all of that is owner-side Discord configuration (runbook 0.5), not done.

## 8. Staging preparation: read-only Discord preflight

`ops-bot/scripts/staging-preflight.ts` verifies the Discord configuration of an environment before deployment with five GET requests (no message, no permission change, no registration; the token is never printed). Its logic is tested against a fixture modelled on the AzerDex server layout (public START HERE and COMMUNITY categories, private STAFF ONLY, private OPERATIONS): a correct configuration passes; Administrator or other forbidden permissions, a moderator role on the bot, access to STAFF ONLY or to the other environment's channel, a missing Send Messages or Embed Links grant, a channel visible to `@everyone`, a channel outside OPERATIONS or with the wrong name, a public bot, privileged intents, a foreign token and a wrong guild each fail; inherited `Mention Everyone` only warns. Mutation check: 5 deliberate breakages (overwrite order, Administrator short-circuit, extra-channel check, public-bot check, guild check) all failed the suite. **Not verified:** the check against the real Discord API and the real server, which happens only when the owner runs it in a protected shell after creating the channel and the bot.
