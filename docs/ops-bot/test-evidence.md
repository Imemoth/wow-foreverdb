# AzerDex Operations Bot V1: test evidence

Run date: 2026-11-06 (sandbox, Node 22.23 locally; CI pins Node 24). All results below are from `cd ops-bot && npm test` and `npm run typecheck`.

**Everything in this document is SIMULATED / LOCAL evidence.** Unit, contract, integration and security tests run against fakes (Discord, health provider, heartbeat, fallback, clock) and against a D1-shaped adapter over SQLite that executes the real migration SQL. No Discord server, Cloudflare account, Supabase project or heartbeat service was contacted. Section 3 lists what only a staging run can prove.

## 1. Results

| Check | Result |
| --- | --- |
| `npm run typecheck` (strict TypeScript, `noUncheckedIndexedAccess`) | pass |
| `npm test` | **286 passed, 0 failed** in 18 files |
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
| `preflight.test.ts` | 28 | read-only Discord preflight: permission arithmetic in Discord's documented order, every misconfiguration, read-only requests, token never leaked |
| `scripts.test.ts` | 5 | owner-run scripts exit through `process.exitCode` (Windows libuv assertion after a network call) |
| `workers-runtime-compat.test.ts` | 7 | clients under workerd's fetch restrictions (`redirect: "error"` throws), redirects are failures, source guard |
| `fault.test.ts` | 10 | staging-only Discord fault injection: never built outside staging, 429/403/503 handled by the real client and outbox, compare-and-set consumption |
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
| D1 specifics beyond those checked in section 11 (batched statements as one transaction, behaviour under real concurrent Workers) | Tests use SQLite through `node:sqlite`, the same engine family but not D1 itself; the single-statement behaviours were verified on the real staging D1 (section 11) |
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

## 9. Preflight diagnostics, found by the first real run

The owner's first preflight run printed four FAIL lines caused by one thing: Discord rejected the credential on the first call, and the script cascaded into vague messages. The script now (a) stops after the first failed call, (b) reports the HTTP status (401 rejected credential, 403, 429 rate limit, or network problem) with the typical causes, (c) tells a user-account credential and another application's token apart, and (d) runs an offline, advisory token-shape check (whitespace, `Bot ` prefix, Public Key/Client Secret/Application ID pasted instead of the token, token of another application) that prints a reason and never any part of the token. 9 new tests; the diagnoses are tested never to contain token text. **Not verified:** the actual cause of the owner's failure (a credential problem on the owner's machine, not visible from here); it is confirmed only when the owner's re-run prints READY.

## 10. Cloudflare staging resources (created with owner authorization)

On 2026-11-09 the owner confirmed the Cloudflare account and authorized the Cloudflare preparation. Before acting, the account was verified empty (0 D1 databases, 0 Workers). Exactly **one** resource was created, through the Cloudflare API connection of the agent session: D1 database `azerdex-ops-bot-staging`, id `8da3a092-eeee-4b83-8415-a396f9547fb7`, Western Europe hint, 0 tables, verified by `get` and `list`. Its id (not a secret) is recorded in `ops-bot/wrangler.toml` `[env.staging]` and the tests pin it. **Not created or done:** no Worker, no secret, no deployment, no migration (the owner runs the migration with `wrangler`), no production resource, no heartbeat check by the agent.

## 11. Real staging D1: migration and runtime semantics (2026-11-09)

- **Migration:** the owner applied `0001_ops_bot_init.sql` with `wrangler d1 migrations apply azerdex-ops-bot-staging --env staging --remote` (19 statements, success; this also confirmed the owner's `wrangler` login is in the account that owns the database). Verified read-only through the Cloudflare API connection: exactly the ten bot tables plus wrangler's `d1_migrations` (one row, `0001_ops_bot_init.sql`, applied 13:58:15 UTC), 8 indexes including `incidents_one_active_per_component` (`CREATE UNIQUE INDEX ... where status <> 'RESOLVED'`).
- **Synthetic runtime check on the real D1** (rows tagged `selftest`, all deleted afterwards; the database was verified empty again, every table at 0): (1) an incident insert with `on conflict do nothing` reported `changes: 1`; (2) a second incident for the same component was ignored by the database itself (`changes: 0`), so the partial unique index and `ON CONFLICT DO NOTHING` behave on D1 exactly as in the tests; (3) an outbox row with a deterministic key inserted once and the duplicate with `insert or ignore` was ignored (`changes: 0`); (4) the rate-limiter upsert with `RETURNING count` returned 1 then 2; (5) deleting the incident removed 2 rows (the incident and its outbox row), so foreign keys and `ON DELETE CASCADE` are enforced on D1.
- **Read-only Discord preflight, real server:** `READY`, 15 of 15 checks passed (private application, no privileged intents, no dangerous permissions, `#ops-testing` inside the private `OPERATIONS` category, the bot can post there, and the only private channel it can see is its own). The first run failed on a credential problem and the second on the channel being created inside STAFF ONLY; both were fixed on the Discord side and the check was re-run.
- **Superseded:** Worker deployment, endpoint validation, cron firing and the heartbeat are now recorded in section 12. Still NOT verified: real Discord message behaviour (nonce, 429) and the staging scenarios.

## 12. Staging Worker: deployment and live checks (2026-11-09)

- **Deployment (owner-run, after an explicit GO):** `azerdex-ops-bot-staging` at `https://azerdex-ops-bot-staging.imemoth.workers.dev`, secrets set through hidden `wrangler secret put` prompts (names verified with `wrangler secret list`, values never seen). No production resource exists.
- **Hostname behaviour (curl):** `/healthz` 200, unsigned `POST /interactions` 401, bad signature 401, `GET /interactions` 405, unknown paths 404. `preview_urls` is off and no Cloudflare Access sits in front (Discord cannot authenticate to it).
- **First cron cycle:** 14:25:44 UTC. Read from the real D1: six components HEALTHY, 0 incidents, 0 outbox rows, lock released, heartbeat attempt recorded. The 14:20 slot was missed because the cron schedule had not propagated after the deploy.
- **Slash-command registration:** guild-scoped, HTTP 200. The Windows `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` printed afterwards came from `process.exit()` right after a network call and did not affect the registration; fixed in `b6e171c` with a guard test.
- **Interactions Endpoint:** Discord accepted the URL, which exercises Ed25519 verification in the Workers runtime (PING). `/azerdex status` typed by the owner in `#ops-testing` returned an ephemeral reply: Overall HEALTHY, last cycle 14:30 UTC (29 s earlier), 0 open and 0 acknowledged incidents, heartbeat `ok`, six components HEALTHY. This also proves the signed command path, guild and operator authorization, and the D1 read path end to end.
- **Heartbeat caveat:** `ok` records that the ping was sent, not that Healthchecks received it; the owner confirms the check on the Healthchecks dashboard.
- **Still NOT verified:** real alert messages (OPEN with the Acknowledge button, ACK, RECOVERED), nonce dedupe and 429 behaviour on real Discord, fallback notifier, and the staging scenarios. They require the owner's separate GO because they post to `#ops-testing`. Production is untouched and still needs the reporting endpoint approval, a real hostname via reviewed PR, and the owner's GO.

## 13. Defect found by the first real staging alert (2026-11-09)

The `source_critical` scenario opened the incident correctly (one OPEN incident, one PENDING outbox row), but the Discord post failed with class `network` and nothing was delivered. **Cause:** the Discord client, health provider, heartbeat and fallback notifier passed `redirect: "error"` to `fetch`; Cloudflare Workers does not implement that mode and throws a `TypeError` before any request is sent (documented in the Workers `Request` reference). All 269 earlier tests used fakes that accept the option, so none could show it. **Consequence for the earlier evidence:** the `Heartbeat: ok` in `/azerdex status` only recorded an attempt, and the heartbeat ping very probably never left the Worker either. **Fix:** `redirect: "manual"` everywhere (a redirect is never followed, so credentials cannot be forwarded, and a 3xx counts as a failure). New `workers-runtime-compat.test.ts` stubs `fetch` like workerd, and one existing assertion that had pinned the bug was corrected. Mutation check: reverting the Discord client to `"error"` fails 3 tests. **Not verified until redeployed:** actual delivery, the heartbeat ping arriving at Healthchecks.

**Second defect, same alert (found after the redeploy of the first fix: attempt 3 failed the same way).** The clients stored the global `fetch` in a property and called it as `this.fetchFn(...)`; workerd throws `Illegal invocation` for any receiver other than the global, again surfaced as `network`. Reproduced first (a stub of the global `fetch` with that restriction failed the two new tests on the unfixed code), then fixed by wrapping (`(input, init) => fetch(input, init)`) in all five places, plus a source guard against a bare `?? fetch`. 276 tests in 17 files, `npm audit` 0 vulnerabilities. The lesson recorded here: fakes injected through `fetchFn` hide every runtime-binding problem; the only real proof is delivery on the Worker. **Still not verified until the next redeploy:** that the alert is actually posted.

## 14. First real incident lifecycle on staging (2026-11-09, scenario `source_critical`)

Run with the owner's GO, on Worker version `1849daf1` (both fixes of section 13), mock health provider, `#ops-testing` only. Timeline (UTC), read from D1 and confirmed by the owner's screenshots and the Healthchecks event log:

| Time | Event | Evidence |
| --- | --- | --- |
| 14:34 | scenario set to `source_critical` | `monitor_state.mock_scenario` |
| 14:35 | incident `INC-261109-F9K4` OPEN for `source:blizzard-bluepost-us` (`fetch_failing`), one OPEN outbox row, G6 shown as WARNING "explained by source" | D1 |
| 14:35 to 14:45 | delivery failed 3 times (class `network`), row stayed PENDING, no duplicate incident or outbox row, the cycle kept running | D1 (defects of section 13) |
| 14:50:42 | OPEN alert delivered after the second fix (attempt 4), one message with an Acknowledge button, no mention ping | D1 + screenshot |
| about 14:51 | owner tapped Acknowledge once: ACKNOWLEDGED, acknowledging user shown, the same message edited in place | D1 + screenshot |
| 14:52 | scenario set to `healthy` | D1 |
| 14:55 | healthy poll 1; the follow-up `EDIT_ALERT:ack` row sent on attempt 1, same message id, no second post | D1 |
| 15:00:39 | healthy poll 2: incident RESOLVED, exactly one RECOVERED message (`1569366134103220305`) | D1 + screenshot |

Also proven: the durable outbox retried a failing delivery without storms or duplicates; a click-time reply and the later durable edit coexist on one message; no reminder was queued while ACKNOWLEDGED (`reminder_count` 0); recovery needed two healthy polls. **Healthchecks:** the check went down at 14:48 (no ping had ever left the Worker, section 13), emailed the owner, and came up with the first real ping at 14:50; POSTs every 5 minutes after that. This is the independent monitor working as designed. **Not yet verified:** the other scenarios (`g6_stalled`, `g6_missing`, `g6_inactive`, `reporting_down`, `stale_snapshot`), a real Discord 429, the fallback notifier, the reminder after 120 minutes, `/azerdex maintenance`, and the delivery-recorded heartbeat status (`last_heartbeat` still records an attempt, not receipt). Production remains untouched.

## 15. Remaining staging acceptance, runtime evidence (2026-11-09 and 2026-11-10)

Everything below ran on the deployed staging Worker (mock health provider, staging D1, `#ops-testing` only) with the owner's explicit GO. Times are UTC and come from D1 timestamps; Discord-side facts come from the owner's screenshots. No production resource, no real Supabase job and no Quest branch was touched, and no real Discord rate limit was provoked. After every test the scenario was restored to `healthy` and the next test started only after the incident was RESOLVED (two healthy polls) with exactly one RECOVERED message.

| # | Scenario | OPEN | ACK | Recovery | Dedupe and notes |
| --- | --- | --- | --- | --- | --- |
| 1 | `g6_stalled` (`INC-261109-4TKP`) | opened 15:10:39, one alert at attempt 1 | button, 15:38 | RESOLVED 15:50:40, one RECOVERED | 6 occurrences, still one alert; a malformed id on `/azerdex ack` answered "Invalid incident id.", a repeat answered "already acknowledged, no change" |
| 2 | `g6_missing` (`INC-261109-CL3C`) | opened 16:05, one alert | button, 16:08 | RESOLVED 16:15:39, one RECOVERED | durable `EDIT_ALERT` followed on the same message |
| 3 | `g6_inactive` (`INC-261109-6SKA`) | opened 16:25:39, one alert | **slash command** `/azerdex ack`, 16:28 | RESOLVED 16:40:40, one RECOVERED | the alert message was edited at the next cycle (16:30:40), same message id |
| 4 | `reporting_down` (`INC-261109-EDH5`) | failures 1 and 2 (16:45, 16:50): nothing created; failure 3 (16:55:40): one CRITICAL alert | button, 17:04 | RESOLVED 17:35:39, one RECOVERED | outage lasted about 40 minutes, 7 occurrences, no second alert, no reminder |
| 5 | `stale_snapshot` (`INC-261109-VL58`) | failures 1 and 2: nothing (mid-check: `reporting_failures` 2, all components UNKNOWN, 0 incidents, outbox unchanged); failure 3 (18:15:40): one alert, reason `reporting_unavailable_stale` | button, 18:29 | RESOLVED 18:45:40, one RECOVERED | a 45-minute-old snapshot is a reporting failure, never health |
| 6 | `/azerdex maintenance` (`INC-261109-YPHL`) | mute on the source 18:38:56 to 18:48:56; incident opened 18:40:40 with `NOTIFY_SUPPRESSED`, no message; the deferred OPEN went out once at 18:50:41 (the first cycle after expiry) | button, 18:55 | RESOLVED, one RECOVERED | audit rows for start, a second mute on `bot:schedule` and its `end` (`ended=1`); `list` shows and clears; a bad component name is refused, a 1-minute duration is refused by Discord's own option bounds (the bot-side check is unit-tested only); invalid inputs left no records |
| 7 | Discord 429 (`INC-261110-Z5A4`, synthetic) | two injected 429s (07:50:40, 07:55:40), the OPEN row stayed PENDING with `attempts` 0 and the 20 s Retry-After applied; delivered at 08:00:42, one message | not performed (acknowledgement is covered by tests 1 to 6) | RESOLVED 08:15:40, one RECOVERED | no storm, no DEAD row, heartbeat stayed `ok` |
| 8 | Fallback (`INC-261110-Q63Z`, synthetic 403) | OPEN got 403, row DEAD after 1 attempt (`NOTIFY_DEAD`), no Discord message | none | RESOLVED 09:20:40, **one RECOVERED message was still sent** | exactly one fallback notice (`fallback_sent_at` 09:05:46, six seconds after the incident opened), never repeated |

Heartbeat behaviour (D1 `last_heartbeat` and the Healthchecks events and emails): `ok` every cycle; `supabase_degraded` during tests 4 and 5 (the bot is alive but cannot see Supabase; the Healthchecks event list for those windows was not reviewed); `delivery_failing` at 09:05:47 on test 8 sent the failure ping, Healthchecks emailed DOWN (body `delivery_failing`) and emailed UP 4 min 53 s later when the next cycle's `ok` arrived, a single failure with no flapping. After all tests: 9 incidents, 9 RESOLVED, exactly 9 RECOVERED rows (one each), 1 DEAD row, 1 fallback row, 0 active incidents, all six components HEALTHY, `fault_discord` removed.

**Fallback route:** the notice reached the owner's Make webhook, which sent an email ("Discord delivery failed for incident INC-261110-Q63Z (OPEN, auth). Check the staging/production runbook."), delivered at 09:07. The scenario was set to run on demand, so the email was only sent when the scenario was run; the Worker's call itself succeeded at once. **Production requirement:** the fallback scenario must run immediately when data arrives.

**Fault injection (staging only):** `src/discord/fault.ts`, section 5.1 of the staging runbook, `test/fault.test.ts`. A D1 counter makes the next N Discord channel-message calls return a synthetic 429, 503 or 403 that the real client code parses; interaction replies are never touched; production never builds it; mutation checks catch removing the staging gate, the compare-and-set and the host check.

## 16. Observations, residual risks and operator-process findings

1. **RECOVERED without a visible OPEN.** When the OPEN alert is DEAD (permanent failure), recovery still posts a RECOVERED message, so the channel shows a recovery for an incident nobody saw. Arguably useful, but confusing; consider labelling such a recovery "alert was not delivered". No change was made.
2. **A dead alert is never retried.** After DEAD, the engine keeps no pending OPEN, so only the one-time fallback notice reaches humans while the incident stays open. That is the intended role of the fallback, but its route must be reliable (see the Make note above).
3. **`last_error_class` is not cleared on success**, so a delivered row can still show an earlier class (cosmetic).
4. **A command acknowledgement edits the alert one cycle later** (about 2 minutes), the button edits at once; both end in the same state.
5. **`last_heartbeat` still records that a ping was attempted, not that Healthchecks received it.** The Healthchecks log and emails were the proof here.
6. **Not verified:** a real Discord 429 or 5xx from the real API (injected responses use the real parsing and retry code, but the real service was not stressed), the 120-minute reminder, the bot-side duration bounds of `maintenance` on staging, Healthchecks events during the `supabase_degraded` windows, and everything in production.
7. **Operator process:** the owner typed a webhook URL as a secret NAME, which would have made the Worker ignore it silently and put the token into pasted output. It was caught by `secret list`, the entry was deleted and the correct secret was set (the rotation of the exposed webhook URL was requested; its completion is the owner's to confirm) and the runbook now warns (section 2 of the staging runbook). Always run `secret list` after setting secrets.
8. **Platform lesson (sections 13):** fakes injected through `fetchFn` hid two Workers-runtime defects; only a delivery on the real Worker proves the transport.
9. **Session note:** the Cloudflare tooling and the session worker restarted several times during the run; results were re-read from D1 each time, and read races (reading while a cycle was running) were re-queried before drawing conclusions.
