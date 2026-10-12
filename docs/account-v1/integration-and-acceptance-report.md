# Account System V1 — PR E: integration and acceptance report

Branch `account/v1-end-to-end-integration`, base `main` `0b05c26`. **Nothing here was deployed, applied to a hosted project, or activated.** This report keeps the evidence states apart; none implies another.

## 1. Evidence ledger (PR E)

| Capability | IMPLEMENTED | CI VERIFIED | STAGING VERIFIED | WINDOWS VERIFIED | PRODUCTION APPROVED |
| --- | --- | --- | --- | --- | --- |
| Website linking (`/account/link`, `/account/api/link`), fresh password, same-UID check, temporary-session revocation | yes | see §2 (run URLs recorded in the PR) | **no** (needs the owner's staging project) | n/a | **no** |
| Closed PostgREST client; installation list; private Guildbook | yes | see §2 | **no** | n/a | **no** |
| Real GoTrue + real PostgREST + PostgreSQL integrated suite | yes | see §2 | **no** (a hosted project is a different gateway/version/settings; see the runbook) | n/a | **no** |
| Website redemption -> Companion `transferred` -> account-owned sync (W8) | website half yes; Companion half merged in PR D | server half exercised by Companion-style test clients (scenario 19); **the Windows application itself was not run** | no | **PENDING (owner)** | no |
| Windows scenarios W1a, W1b, W2..W10 | n/a | Companion CI only (compilation, test doubles) | n/a | **PENDING (owner)**: checklist in [windows-acceptance-checklist.md](windows-acceptance-checklist.md) | no |
| Direct-Auth abuse criteria L-1..L-8, M-1..M-8, AT-1..AT-7, A24 | n/a | n/a | **PENDING (owner)** | n/a | no |
| Production activation | blocked in code (`PRODUCTION_ACCOUNT_AUTH_APPROVED = false`, `ProductionAccountAuthApproved = false`, `ACCOUNT_AUTH_MODE` default `disabled`) | — | — | — | **NO** |

BLOCKED / PENDING items are enumerated in §6 so they stay discoverable.

## 2. CI evidence

Recorded in the PR description / final report with run URLs once the checks finish on the final head: `Account end-to-end (GoTrue + PostgREST)` (new), `Account web auth (real GoTrue)`, `Account ownership SQL + real GoTrue`, `Companion account auth (Windows)`, the Web CI checks and CodeQL. Local runs by the author before pushing (disposable local cluster, Node 22 locally; CI uses the pinned Node 24): unit/static 327 tests; integrated suite 39 tests against real GoTrue v2.197.0 (commit `4eee58f2…`) + PostgREST v12.2.12 + PostgreSQL 16.15 + Mailpit v1.31.5; SQL suite 219 tests (unchanged behaviour after the shared-script edits); PR B web-auth suite 50 tests (unchanged).

## 3. Integrated scenario map (mandatory scenarios 1-30)

All against real GoTrue + real PostgREST + PostgreSQL (`web/tests/account-e2e/`). "Companion" = a test client holding real GoTrue tokens (anonymous, or registered via password grant); it is **not** the Windows application.

| # | Scenario | Test |
| --- | --- | --- |
| 1-2 | register A and B, verify via captured mail | every spec (`webUser`: register -> Mailpit -> `POST /confirm`); `01` first test |
| 3-5 | anonymous session; real ingest of loot, source, location, quest, Guildbook, professions | `01` first test (rows counted per table) |
| 6-8 | website login; claim code from the anonymous owner's RPC; link page shows the verified e-mail, GET has no side effect | `01` first test; `04` journey |
| 9-11 | no / wrong / foreign password refused; no temporary session left | `01` "9-11" (accounts have distinct passwords) |
| pre-hijack | attacker-registered account confirmed by the victim cannot be used to transfer without its password | `01` "pre-hijack" |
| 12 | revoked, copied, replaced web session refused; claim survives | `01` "12"; unit `recheckIdentity`; `01` "recipient binding" |
| 13-15 | transfer exactly once; A sees installation + Guildbook; B sees none | `01` "13-15" |
| 16 | two accounts + anonymous owner + overlapping guild keys/names | `02` "privacy" |
| 17-19 | former owner loses ingest, gets `transferred`; new owner ingests without duplicates | `01` "17-19" |
| 20-22 | consumed, expired, malformed, replaced, revoked, issuer-revoked codes: one answer; malformed codes never reach the database | `01` "20-22" |
| 23 | 50 cap does not consume the code (another account redeems it) | `02` "23" |
| 24 | website logout is session-local | `01` "24" |
| 25 | recovery / password-reset sessions cannot bypass | `01` "25" |
| 26 | concurrent redemption atomic (blocked on the installation lock, observed in `pg_stat_activity`, exactly one winner) | `01` "26" (website) and "26b" (PostgREST direct, four sessions) |
| 27 | counters survive wrong-code transactions; `Prefer: tx=rollback` ignored on `commit`, shown to roll back on `commit-allow-override`; PT429 -> 429 | `03` "27" |
| 28-29 | row counts + stable hashes of every history table, aggregate statistics unchanged | `02` "28-29" |
| 30 | private tables unreachable (anon, anonymous user, owner, other account; profile headers) | `03` "30" |
| PostgREST | schema-cache reload after 0012; JWT validation; role/EXECUTE; PT401/403/429/400; response shapes | `03`; LS-1..LS-8 through PostgREST over dead-session states: `07` |
| failure | lost reply after commit (unknown outcome, one request forwarded), hung reply, unrevocable temporary session, per-account and per-address budgets, dead limiter (fail closed) | `05` |
| web security | CSRF/Origin/Fetch-Metadata matrix on every private POST, headers, redirect allowlist, XSS | `06` |
| UI | journey, code hygiene (URL/storage/cookie/requests), installation list, Guildbook paging, axe WCAG 2.2 AA, 375 px, revocation drops private UI | `04` |

Defects the browser tests found and that were fixed in this PR: horizontal page scroll of the Guildbook at 375 px; a scrollable table region that was not keyboard-focusable.

## 4. Real-PostgREST observations (facts about v12.2.12)

PT401/PT403/PT400/PT429 -> HTTP 401/403/400/429 with the SQL message and no `Retry-After` (the website defaults to 60 s); an `anon` call to an EXECUTE-revoked function is 401 `42501`; an invalid/expired JWT is 401 `PGRST301` (`JWT expired` in the message; v13+ reports `PGRST303`); `params=single-object` makes the function "not found" (404, nothing runs); the reviewed `db-tx-end = commit` ignores `Prefer: tx=rollback`, `commit-allow-override` honours it and thereby un-counts wrong guesses (so the deployment checklist pin matters); `RETURNS TABLE` -> JSON array, `jsonb` -> bare object, `bigint` -> JSON number; the functions appear after the migration's `NOTIFY pgrst, 'reload schema'` without restart (~0.2 s); OpenAPI lists the RPCs but no private-schema table. No conflict with the approved SQL assumptions was found (no blocking security finding from the real HTTP behaviour).

## 5. Independent reviews (fresh context, static, no conclusions supplied)

**Security review** (pre-hijack, recipient binding, temporary session, bearer theft, replay, wrong-account Guildbook, rate limits, CSRF/XSS, closed client):

| # | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| S1 | **High** | pre-registering attacker keeps a session issued before the victim's password reset (I-1) and can later read the Guildbook / act as owner through a Companion login | **OPEN, owner decision, merge gate.** The fix (`logout?scope=others` after a reset) changes the pinned Auth allowlist and signs the Companion out; not made unilaterally. Mitigation shipped: the link page warns and points to password reset. See [security.md §6](security.md) |
| S2 | Medium | a session swap in another tab plus the automatic CSRF retry could redeem to account B while the page showed A | **fixed**: the request carries the displayed account id (`409 account_changed`), no CSRF auto-retry for the link route; test `recipient binding` |
| S3 | Medium (0012) | ~12 cheap accounts calling PostgREST directly can hold `claim_redeem:global` at 429 | accepted/documented; owner decision on 0012 later; monitor M-7 |
| S4 | Medium/Low (0012) | account reads share `read:global` with the public API | accepted/documented |
| S5 | Low | per-address login budget shared with link allows a link lock-out; `Retry-After` was 300 for a 900 s window | `Retry-After` fixed; coupling kept deliberately (one pool of password guesses) and documented |
| S6 | Low | an unparseable 2xx grant may leave an unseen session | logged by name (`reauth_grant_unparseable`) |
| S7 | Low | an exception after a refresh dropped the rotated cookie | **fixed** (`guarded()` persists it) |
| S8 | Low | redirect loop when the database refuses a session Auth still accepts | **fixed** (pages show "session could not be verified", no loop) |
| S9-S10 | Info | fresh password is website-only (by design); fragment decode crash; single-session-per-user would couple sessions (already forbidden) | documented / fixed (fragment) |

**Architecture and test-validity review:**

| # | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| A1 | High | scenario 26 was not really concurrent | **fixed**: lock-gated race, observed in `pg_stat_activity` (26 and 26b) |
| A2 | Medium | malformed-code budget check could not fail | **fixed** (sum of calls + rejection audit rows) |
| A3 | Medium | per-account budget test masked by the login budget | **fixed** (one session from six addresses) |
| A4 | Medium | statistics comparison could pass on error bodies | **fixed** (status and non-empty asserted) |
| A5 | Medium | harness grants stricter than hosted Supabase (no default privileges, 0007 skipped) | **documented limitation**; staging must repeat test 30 and probe `observed_loot_stats` ([staging-runbook.md](staging-runbook.md)) |
| A6 | Medium | LS-1..LS-8 only partly repeated through PostgREST | **fixed** in `07` (every registered function x signed-out / `not_after` / deleted / banned, `claim_start` after sign-out, LS-6). LS-11 stays covered by the SQL suite |
| A7 | Medium | 404/405/406/415 from PostgREST were reported as unknown outcome | **fixed** (unavailable); a gateway 401 is still shown as "signed out" (documented; staging check) |
| A8-A9 | Low | tautological/vacuous assertions; budget resets and fixed-IP overlap | **fixed** |
| A10-A11 | Low | cache key omitted the GoTrue build script; no host guard before destructive DB calls | **fixed** (hash in key; loopback guard in `up.sh`) |
| A12-A13 | Low/Info | doc drift; what the stack cannot prove | **fixed / documented** (README, report §4, runbook) |

## 6. Pending gates (owner)

1. Decide S1 (global/other-session sign-out on password reset). **Merge hold until decided.**
2. Add the check `Account end-to-end (GoTrue + PostgREST)` to ruleset `24853899` after it reports consistently (GitHub Actions app, integration id 15368; readback must show ten unique checks). Not done by this PR.
3. Create the isolated staging project and run [staging-runbook.md](staging-runbook.md) (nothing was created, configured, migrated or billed).
4. Run the Windows scenarios W1a, W1b, W2..W10 and record them in [windows-acceptance-checklist.md](windows-acceptance-checklist.md).
5. L-1..L-8, M-1..M-8, AT-1..AT-7 (A24), shared-egress attribution (L-8/AT-7), claim DoS ceilings (S3), audit retention/pruning, alert routing and incident rehearsal ([acceptance §5](acceptance-and-owner-actions.md)).
6. Compare the hosted staging GoTrue / PostgREST versions and `db-tx-end` with the CI stack ([e2e-stack README](../../web/tests/e2e-stack/README.md)).
7. Any production consideration: separate owner approval; `release`, Vercel Production Branch and the production Supabase project were not touched.

## 7. Explicit non-actions

No migration applied to any hosted project (`0010` unapplied; `0013` recovery-only, never applied outside the SQL suite's clones); no Supabase/Vercel/GitHub-ruleset setting changed; no production owner UID touched; no staging credential or claim code can reach the production project (config validators unchanged); `PRODUCTION_ACCOUNT_AUTH_APPROVED` and `ProductionAccountAuthApproved` remain `false`.
