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
- **Option G (gated Data API RPC, not applied):** removes the direct database login, so a leaked credential is no longer a SQL session with the platform's `PUBLIC` grants (pg_net). Residual risks, all measured or bounded in [reporting-gated-rpc.md](reporting-gated-rpc.md): the RPC is callable by anyone with the public key (refusals cost about 0.24 s of database CPU per 1,000 requests and did not starve a legitimate caller at 128 concurrent flooders, but hosted pool pressure is not measurable outside production); a captured request signature replays a read-only report for at most 60 s; the gate key lives in one Edge secret and in the database, rotated or revoked with one SQL call; a verbose `log_statement=all` server logs signatures (never the key), the documented hosted default does not.

## Code-scanning findings and resolutions (PR #174 security gate)

GitHub's code-scanning check (CodeQL, separate from the passing `codeql` workflow job) reported **2 new high-severity alerts** on commit `7c2b4bd`. Both were inspected from the check-run annotations; nothing was dismissed, suppressed, excluded or downgraded. The alerts API itself returned 403 for the session integration, so rule ids below are taken from the annotation titles and the standard CodeQL query names they correspond to.

| # | Location (at `7c2b4bd`) | Rule (annotation title) | Root cause | Exploitability | Resolution | Regression tests |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `ops-bot/src/discord/messages.ts:55` | "Polynomial regular expression used on uncontrolled data" (js/polynomial-redos) | `ephemeralLines` trimmed each line with a trailing-whitespace regex. On a long run of whitespace followed by a non-space character the engine retries from every start position, so cost is quadratic. Measured: 10,000 characters 86 ms, 30,000 characters 745 ms, 60,000 characters 3.06 s, 200,000 characters about 65 s. | **Confirmed defect, not exploitable today**: every current caller passes text that is already whitespace-collapsed and bounded (`sanitizeText`, fixed strings, integers), so an attacker cannot deliver a long whitespace run to it. It was nevertheless a latent denial-of-service in an exported function, and a Worker invocation would be killed by the CPU limit. | Replaced with `String.prototype.trimEnd()` (linear, same whitespace set; the 60,000-character case now takes about 0.04 ms). One-line change in `ephemeralLines`. | `regex-safety.test.ts`: 200,000-character runs of tab, space, NBSP and EM SPACE complete in under 250 ms (**these failed on the unfixed code**, 65 s); trailing-whitespace semantics are checked identical to the removed regex across all 16 JavaScript whitespace/line-terminator characters; an adversarial-input budget runs `sanitizeText`, `redactString`, `redact`, `ephemeral`, `ephemeralLines` and `renderIncidentMessage` over ten pathological inputs (the same defect class: the other helpers were already linear); a source scan fails if the flagged regex shape is reintroduced. |
| 2 | `ops-bot/test/security.test.ts:100` | "Missing regular expression anchor" (js/regex/missing-regexp-anchor) | A **test-only** secret detector matched a hostname-shaped regex (`https://discord(app)?.com/api/webhooks/...`) against file text. A hostname regex is a weak host check: it also accepts look-alike hosts, and it **misses** `http://`, subdomains (`canary.discord.com`), ports and upper case. | **No runtime impact**: it never ran in the Worker and never gated a request. It was a real quality defect in the detector (false negatives for credential leaks), so it is not dismissed as a false positive. | Replaced by `test/helpers/secret-scan.ts`: URL candidates are extracted, **parsed with `new URL`**, the hostname is compared exactly (`discord.com`, `discordapp.com` and their subdomains) and the path shape is validated. | `regex-safety.test.ts`: detects https/http, subdomains, upper case, ports and API versions; rejects look-alike hosts (`notdiscord.com`, `discord.com.evil.example`) and userinfo tricks (`https://discord.com@evil.example/...`); requires the webhook path and token length; ignores unparsable candidates; linear on adversarial input. |

Other patterns commonly reported by CodeQL's JavaScript security queries were reviewed in `ops-bot/` (insecure randomness, regex injection, incomplete string sanitization, URL substring checks, dynamic code execution, DOM sinks): none found. Identifiers and tokens come from `crypto.getRandomValues`; every regular expression is a literal with no nested or overlapping quantifiers (checked by the adversarial-input budget). **Residual item:** the dedicated CodeQL check must be confirmed green on the updated head; the result is recorded in [test-evidence.md](test-evidence.md) section 5.

## Public endpoint exposure (staging routing gate)

Discord can only deliver interactions to a public HTTPS URL, so the staging Worker is deliberately reachable on `workers.dev` (`workers_dev = true`, no route; verified against Cloudflare's documentation on 2026-11-06). Production will use a Custom Domain on an owner-controlled zone, documented but **not** activated (placeholder `REPLACE-WITH-PRODUCTION-OPS-HOSTNAME.invalid`).

| # | Threat | Mitigation | Test |
| --- | --- | --- | --- |
| X1 | Anyone on the internet can send requests to the public hostname | Reachability grants nothing: Ed25519 signature over the original body, timestamp window, replay protection, application id check, operator authorization, rate limit. Unsigned or wrongly signed requests get 401 before any state is touched; `GET /interactions` is 405; every other path is 404 except the static liveness reply | `worker-endpoint.test.ts` (through the real Worker `fetch` with a complete staging configuration, on several hostnames including a spoofed Host) |
| X2 | A bare `wrangler deploy` without `--env` publishes an unconfigured Worker (Cloudflare defaults `workers_dev` to true when no route exists) | The top level states `workers_dev = false` and `preview_urls = false` and defines no bindings, routes or cron; wrangler warns when no environment is given | `routing-config.test.ts`; wrangler dry-run of the top level shows no bindings |
| X3 | A second public hostname appears through preview/version URLs (Wrangler 4.44 and later default `preview_urls` to the `workers_dev` value) | `preview_urls = false` in every scope | `routing-config.test.ts` |
| X7 | The staging-only Discord fault injection runs, or ships, in production | It lives in `src/index.staging.ts` only (`[env.staging] main`); production and the top level use `src/index.ts`. A runtime `BOT_ENV` gate remains. Real `wrangler --dry-run` bundles checked: production has no injection code | `test/final-corrections.test.ts` bundles both entries with esbuild, checks `wrangler.toml` and the importers; mutation-checked |
| X4 | Production accidentally served from `workers.dev`, or deployed before a hostname is chosen | `workers_dev = false`; Custom Domain route with a `.invalid` placeholder, so the deploy cannot succeed until a reviewed PR replaces it; checklist Gate D | `routing-config.test.ts`; production checklist |
| X5 | Cloudflare Access enabled "for safety" on the interactions hostname breaks Discord validation, and then someone weakens signature checks to compensate | Runbook and checklist state explicitly that Access must not protect this hostname and that the signature check is the access control | `routing-config.test.ts` (documentation checks) |
| X6 | Staging mistaken for production, or staging hostname leaking information | Staging messages carry an `[staging]` footer; names are neutral (`workers.dev` hostnames are public certificate records); `/healthz` returns only `{"ok":true}`; no account id, zone id, database id or hostname is committed | `routing-config.test.ts`, `worker-endpoint.test.ts` |

Optional hardening for the owner to decide after staging: a Cloudflare WAF or rate-limiting rule on the interactions hostname. It is not required for correctness, because every unauthenticated request already fails cheaply at the signature check.

## Shared guild: staging and production separation

Both environments live in the owner's existing AzerDex server (guild `1561649407584370809`). Separation does not rely on the server boundary:

| # | Threat | Mitigation | Test |
| --- | --- | --- | --- |
| G1 | Staging posts into the production channel (mistyped channel id, copied secret) | Different Discord applications and tokens; the staging bot's only explicit grant is `#ops-testing`, and `OPERATIONS` denies `@everyone`, so a post to `#ops-alerts` gets 403 and the outbox row ends DEAD (reported on the fallback route); staging messages carry an `[staging]` footer; the preflight proves the bot cannot see any other private channel | `outbox.test.ts` (403 is permanent: DEAD, no retry storm); runbook acceptance 11b |
| G2 | An interaction signed by one environment's application is accepted by the other environment's Worker | Each Worker verifies the Ed25519 public key and the application id of its own application only | `interactions.test.ts` (wrong key, wrong application) |
| G3 | Commands used in the wrong channel or by unintended staff | Commands hidden by default; allowed only for the operators and only in the environment's channel (Integrations settings); the Worker enforces guild and operator allowlists per environment | `interactions.test.ts` (authorization); `discord-topology.test.ts` |
| G4 | Ops channels exposed to the community when the server opens to the public | `OPERATIONS` is a private category (`@everyone` denied View Channel); the owner re-checks with "View Server As Role" at opening and verifies Onboarding's default channels (checklist Gate D) | documentation gate; owner check |
| G5 | Bot invite grants more than needed, or disturbs the community configuration | Invite with `permissions=0`; per-channel overwrite for View Channel, Send Messages and Embed Links only; not a public bot; no privileged intents; no existing channel, role, onboarding or permission is modified | `discord-topology.test.ts` (documentation checks) |
| G6 | Guild allowlist drift | The guild id is a reviewable plain var in `wrangler.toml` for both environments; a missing allowlist is a startup error | `discord-topology.test.ts`, `config.test.ts` |

### Inherited `@everyone` access and the read-only preflight

A bot is a guild member, so it inherits whatever `@everyone` may do in public channels (and may inherit `Mention Everyone` where the server grants it). This does not weaken the separation above, which concerns **private** channels, and it is bounded by the Worker only posting to its configured channel id and by `allowed_mentions.parse = []` on every payload. The risk that remains is a grant that is broader than intended (an Administrator role, a moderator role, access to STAFF ONLY or to the other environment's channel). `ops-bot/scripts/staging-preflight.ts` (GET requests only, token never printed, runnable by the owner before deployment) detects exactly that: forbidden server-level permissions, a public bot, privileged intents, a channel that `@everyone` can see, and any private channel other than the bot's own that the bot can see. Covered by `test/preflight.test.ts`.
