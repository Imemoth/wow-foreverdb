# Zero-touch enrollment — acceptance record and owner-run instructions

Rule: **nothing is PASS unless it was executed and the evidence is named.** Rows marked NOT EXECUTED are owner/CI actions.

## 1. Executed by the author (disposable local stack: PostgreSQL 16 + real GoTrue v2.197.0 built from the pinned tag; Linux, no Windows)

| Gate | Command | Result |
| --- | --- | --- |
| Existing 0012 backend suite (before 0014) | `database/tests/account/stack.sh up && apply` then `node --test --test-concurrency=1 database/tests/account/*.test.mjs` | see PR description (run on the pre-0014 stack; the suite asserts "exactly the 0012 functions", so it must run **before** `apply14`) |
| 0014 migration | `stack.sh apply14` twice (idempotent body) | applied, in-migration assertions passed |
| Enrollment suite (privileges, tickets, flows A1/A2/B1/C1/C2, races, credentials, failure/recovery, preservation, real GoTrue, rollback rehearsal) | `node --test --test-concurrency=1 database/tests/enrollment/*.test.mjs` | see PR description for counts |
| Mutation check 0014 | `node database/tests/enrollment/mutation_check.mjs` | see PR description |
| Web | `cd web && npm run lint && npx tsc --noEmit && npx vitest run` | lint/tsc clean, vitest 395/395 |
| Companion Account library (Linux, test doubles) | `dotnet test tests/companion-account/... -p:EnableWindowsTargeting=true` | see PR description |

## 2. NOT EXECUTED (owner / CI): Windows, staging, production

| # | Scenario | Where | Expected |
| --- | --- | --- | --- |
| Z1 | Windows CI job "Companion account auth (Windows)" green on the final commit (real DPAPI + cross-process tests) | GitHub Actions | green, DPAPI tests ran |
| Z2 | **A1 first install**: sign in on the **staging** website → Account → Devices → *Download activation file* → install Companion (with the file next to `Setup.exe`, or in Downloads) → start with the staging gate (`FOREVERDB_ACCOUNT_MODE=staging …`) | Windows + staging project with 0012+0014 applied | Companion shows *Registered device* without any sign-in or code; exactly one device row on the website |
| Z3 | Click **Sync Now** once (AutoSync stays OFF) | same | snapshot reaches the account; `/account/guildbook` shows the Private Guildbook; AutoSync toggle does not upload for a registered device |
| Z4 | **A2 second PC**: repeat Z2 on another computer with a new activation file | second Windows machine | second, separate device and installation; each syncs only itself |
| Z5 | **A3**: restart Companion, reboot PC, sign the website out | Windows | device keeps syncing; no re-activation |
| Z6 | Revoke the device on the website | Windows + web | next Sync Now shows *Revoked device* with the recovery text; no data deleted |
| Z7 | Expired file: change nothing on the client; wait/advance (staging DB: `update private.enrollment_tickets set expires_at = now() - interval '1 minute' where id = …`) | staging | Companion shows *Expired activation*; downloading a new file on the website (no reinstall) activates it |
| Z8 | **B1**: an anonymous installation → register → `/account/link` claim (existing flow) → *Download activation file* → Companion picks it up | staging | claimed installation gets a device; history intact; old anonymous upload denied |
| Z9 | Conflict: use an activation file of account B on a machine whose installation belongs to account A | staging | *Ownership conflict* message; nothing transferred |
| Z10 | Copy an **unredeemed** file to a second PC and redeem there first | staging | succeeds for the copier (documented inherent risk, ADR-017 §4); the legitimate PC then gets `ticket_consumed`; revoke the device on the website → copy dead. Record this as an observation, not a failure |
| Z11 | `python3 scripts/check-pilot-flags.py --require-off` on the commit to be merged | repo | `OK` (see integration-and-release-order.md) |
| Z12 | Production: **only after explicit owner approval** — apply 0014, flip `ZeroTouchEnrollmentApproved`, repeat Z2–Z6 with the owner's own account | production | owner decision, not part of this PR |

Production data checks (read-only, before and after any production step): the six anonymous installation ids keep `owner_user_id` and row counts; linked
installation `2f8df8ba69345d0a14c8d56ac86d4b2e` keeps 140 source-stats and 46 Guildbook members. This PR did not touch production.

## 3. Remaining blockers and risks (owner decisions)

1. First-redeemer theft of an unused ticket is bounded, not prevented (ADR-017 §4). Decide on re-approval (`pending_approval` status is reserved).
2. No cryptographic proof-of-possession of a device key (needs an Edge Function backend, ADR-017 §6).
3. Public signed binary download does not exist yet; only the activation file is served (ZIP composition is later website work).
4. Pilot flags are still true on this stacked branch; merge only with `check-pilot-flags.py --require-off` (integration-and-release-order.md).
5. Windows real-DPAPI, WPF rendering and the installer change are verified only by CI/owner (Z1–Z10).
6. Anonymous-signup abuse on the shared Auth project (threat A24) is unchanged.
