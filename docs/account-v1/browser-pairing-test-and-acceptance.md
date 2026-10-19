# Browser Pairing V1 — automated test matrix and acceptance criteria

All integration tests use disposable local PostgreSQL, GoTrue, PostgREST and web instances. No test targets the production Supabase
project. Owner tests use a separately approved staging environment and universal installer; no public flag is enabled.

## Automated matrix

| ID | Scenario | Required proof |
| --- | --- | --- |
| BP-01 | successful new-installation pairing | pending -> approved -> connected; one owner, device, audit; manual ingest accepted |
| BP-02 | anonymous installation pairing | exact anonymous owner transfers; ID and all historical hashes/counts preserved |
| BP-03 | logged out -> login -> approval | signed pairing cookie survives fixed return path; page shows request and current account |
| BP-04 | expired request | DB clock wins under lock; no owner/device/provenance change; fresh Connect Account recovers |
| BP-05 | denied request | poll returns denied; no owner/device/provenance write; local pending secrets securely removed |
| BP-06 | Companion cancel pending/approved | terminal denied; no transfer; cancel after connected does not revoke device |
| BP-07 | locator replay | terminal request cannot approve/redeem again and reveals no account identity |
| BP-08 | poll-secret replay | wrong UID, wrong session of same UID, registered JWT and wrong secret all fail identically |
| BP-09 | token refresh | expired access token refreshed with same GoTrue session ID continues; new session ID is rejected |
| BP-10 | concurrent two-account approval | exactly one approved account, generic loser response, no owner change before poll |
| BP-11 | concurrent approval/deny/expiry | one valid transition; consistent timestamps; no partial writes |
| BP-12 | concurrent redemption | two polls create exactly one device/ownership update/provenance write/success audit; second is read-only |
| BP-13 | lost start reply | identical retry returns one row/same expiry; changed verifier conflicts |
| BP-14 | lost connected reply | repeat poll/device status confirms same credential; no extra writes |
| BP-15 | wrong registered account | existing account-owned installation cannot move; owner and device remain unchanged |
| BP-16 | account switches after page render | old CSRF fails; reload names new account; stale tab cannot target replaced cookie |
| BP-17 | session fixation attempts | forged/sibling/expired cookie and mismatched body ID fail; known valid locator can be selected but GET alone has no mutation and approval still needs current account/CSRF |
| BP-18 | CSRF/Origin/content-type attacks | cross-site approve/deny refused before RPC; no CORS; login CSRF covered |
| BP-19 | rate and poll interval | all budgets enforced; valid early poll backs off; invalid locator/secret/actor leaves per-pair budget, interval and next-poll timestamp unchanged |
| BP-20 | device revoked | owner revoke, credential reuse and replacement each trigger pairing revoked; status/ingest denied; controlled re-enrollment works |
| BP-21 | multiple installations/account | distinct devices and credentials; each can ingest only its own installation |
| BP-22 | installation/device substitution | start bindings immutable; poll input cannot override installation/device/hash/account |
| BP-23 | account unavailable | deleted/banned/unconfirmed account or revoked/expired approving session terminally denies at redemption; no partial transfer |
| BP-24 | initiating session revoked | poll/cancel fail; approval alone cannot transfer; request expires safely |
| BP-25 | existing active device | pairing is refused until the website revokes the active device; no second live device |
| BP-26 | `.fdbact` compatibility | ticket enrollment, rotation, revocation and lost-reply behavior retain current contract |
| BP-27 | existing registered-device compatibility | pre-0016 rows pass new provenance constraint and manual ingest unchanged |
| BP-28 | anonymous behavior | no pairing action means existing anonymous sync/collection unchanged |
| BP-29 | feature gates | DB false blocks all RPCs; web/Companion flags false hide/refuse; env alone cannot enable production |
| BP-30 | secret hygiene | URL/log/bundle/settings/artifacts contain no token, poll secret or device secret; fixed redacted strings only |
| BP-31 | migration/rollback | both PR #58 orderings, kill switch, empty/nonempty rollback and explicit 0016 restore preserve data/ledger; 0014/0012 rollback is blocked while pairing provenance remains |
| BP-32 | deadlock workload | pairing, claim, ticket enroll, ingest and revoke races finish within timeout with valid state |
| BP-33 | browser UI/accessibility | computer/account/expiry explicit; approve and deny keyboard/screen-reader usable; responsive |
| BP-34 | WPF states | waiting, approved, connected, expired, denied, revoked, offline, slow-down and retry text are correct |
| BP-35 | AutoSync guard | pairing never changes AutoSync; registered automatic upload remains blocked; manual Sync now works |
| BP-36 | controlled re-enrollment predicate | only latest revoked predecessor with same installation/account/initiator and allowed reason succeeds; active, wrong-field, disallowed-reason and stale-predecessor mutants fail |
| BP-37 | approving-session race | logout/password-reset/session revoke racing redemption yields connected or terminal denied, never a partial owner/device write |
| BP-38 | redemption failure classes | limit failures remain approved/retryable; ownership, predecessor, account/session and device-ID collisions terminally deny; gate/timeout failures do not mutate |
| BP-39 | credential/device ID binding | official Companion creates equal embedded/separate UUIDs; mismatch mutation is rejected locally before start |
| BP-40 | stolen anonymous bearer | bearer cannot redeem another pairing; attacker-started pairing still needs visible browser approval and expires/revokes safely |
| BP-41 | pairing audit contract | exact event allowlist/columns/ACLs; one row per transition, one deferred row per limit reason, no row for invalid/early/gate/rate/infrastructure failures; locator/session/secrets absent |

## Stage B implementation evidence checkpoint — 2026-10-19

All local mandatory database, web and real-stack suites pass on code head `2537ec4`; every run used disposable PostgreSQL/GoTrue/
PostgREST resources and zero required tests were skipped. This remains a checkpoint rather than a Stage B exit result because the
final documentation commit has not yet reported green exact-head CI, fresh independent final-diff reviewers could not run because the
agent workspace exhausted its review credits, and the Vercel duplicate-`Authorization` provider guarantee remains unresolved.

| Gate | Measured local result |
| --- | --- |
| Account V1 regression | 219/219, including commit-order and real-GoTrue revocation races |
| Enrollment and `.fdbact` regression | 99/99 after 0014 and before 0016 pairing assertions |
| Browser pairing database | 146/146, including five real-GoTrue validity/rotation/reuse/logout/substitution cases and 100-iteration ownership/device race groups |
| Mutation quality | 16/16 security/ownership mutants killed. The schema fixture applies each mutant to a pristine 0014 clone, so FORCE RLS, audit bounds and pairing provenance cannot pass against a pre-migrated database |
| Web unit/static | 474/474; TypeScript and ESLint pass |
| Builds and secret controls | normal OFF-state production build passes; disposable pairing E2E build passes; both scan 48 browser files with no canary/secret exposure; source/database OFF scanner passes |
| Real browser stack | 66/66 in 12 specs against GoTrue v2.197.0 and PostgREST 12.2.12, including six concurrent session-revocation acquisition-order cases |
| PR #58 migration order | exact PR #58 head `9af1ab0af2c94bc78990b5c8098f9fa08247cba2`: 0012 -> 0014 -> its `0015_azerdex_welcome_outbox.sql` -> 0016 -> rollback -> restore passes; the 0015 object/ACL/row snapshot stayed `438aab9e0147ae5d969c18424076f881`; all three database gates ended false |

| Acceptance checkpoints | Stage B status | Remaining work |
| --- | --- | --- |
| BP-01–03, BP-07–12, BP-15–17, BP-19, BP-21–33, BP-36–38, BP-40–41 | PASS locally across database, web and real-stack layers | Exact-head CI and final-diff review remain release gates |
| BP-04–06, BP-13–14, BP-20 | Server, browser and concurrency portions PASS | Stage C implements Companion expiry/denial/cancel/lost-response/credential-recovery UI and storage behavior |
| BP-18 | Origin, Fetch Metadata, JSON, CSRF and route-before-RPC refusal PASS | Vercel rejected 9/9 raw duplicate/case-variant probes, but no authoritative durable pre-application rejection guarantee was found |
| BP-34 | Not in Stage B | Stage C WPF state implementation and Windows tests |
| BP-35 | Database manual-ingest behavior and all OFF gates PASS | Stage C must prove pairing never enables Companion AutoSync and that manual Sync now remains explicit |
| BP-39 | Server canonical UUID/hash contract PASS | Stage C must enforce equal embedded/separate device UUIDs locally before start |
| OA-1–OA-10 | Not run | Stage C/Stage E Companion, signed universal installer and Windows 10/11 owner acceptance |

The earlier independent web security review found no Critical, High or Medium issue. Its page-binding contract and terminal-control Low
findings were fixed; the accepted residual Low is that a terminal GET cannot immediately clear the bounded five-minute HttpOnly locator
cookie because a Server Component cannot set response cookies. The terminal view is inert and subsequent terminal mutations clear it.
Fresh whole-branch architecture/security review is still mandatory before Stage B can be declared complete.

## Test layers

### Database

Real PostgreSQL 16 + GoTrue + PostgREST tests cover live sessions, Auth refresh/revocation, ACLs, FORCE RLS, function attributes,
transactional concurrency, preservation and rollback. Mutation tests must catch removal of the exact-session comparison, secret check,
expiry check, owner check, shared lock, state predicate, unique constraint, CSRF-independent DB authorization and feature gate.

### Web

Vitest contract/static tests cover closed routes/RPC registries, schemas, cookie MAC/expiry/body binding, safe return paths, fixed error
mapping, no logging and environment gates. Account E2E covers login continuation, approval/denial, session switching and CSRF/Origin.
Bundle-secret and source scans include the new route and UI.

### Companion

xUnit tests use the existing fake Supabase/device backend plus a real loopback boundary. They verify CSPRNG formats, DPAPI pending-store
atomicity, session refresh, browser launch allowlist, poll scheduling/backoff, crash/lost-response recovery, state messages, cancellation,
credential promotion and manual sync. Windows CI must run real DPAPI, WPF Release build, publish and cross-process lock tests.

### End-to-end and static security

The disposable stack runs Companion-protocol requests through Next.js -> PostgREST -> PostgreSQL, followed by device status and a
non-empty registered ingest. CI runs lint, typecheck, unit/E2E suites, migration conformance, release flag checks, bundle scan, CodeQL and
`git diff --check` on the exact final commit.

## Owner acceptance

| Gate | Owner action | Pass condition |
| --- | --- | --- |
| OA-1 | Install the same signed universal installer on Windows 10 and click Connect Account | default browser opens; no code/file/API key; named PC shown |
| OA-2 | Complete login then approve | Companion reaches Connected automatically within the enforced polling window |
| OA-3 | Website Your Computers | one device appears with correct label/installation and no secret |
| OA-4 | Manual Sync now with non-empty data | registered credential ingests; private Guildbook shows expected rows; AutoSync still off |
| OA-5 | Repeat on Windows 11/second PC | second distinct installation/device under same account; independent revoke/sync |
| OA-6 | Start while browser is signed into another account | account is prominent; cancel/switch works; existing registered owner cannot be changed |
| OA-7 | Deny, expire, close/reopen, go offline and lose a response | clear recoverable states; no local/history loss or duplicate device |
| OA-8 | Revoke then attempt sync and controlled re-enrollment | revoked credential denied; explicit same-account pairing restores one live device |
| OA-9 | Existing `.fdbact` and anonymous installations | both fallback paths still work and preserve historical data |
| OA-10 | Inspect installer/download/network/log evidence | identical installer bytes for users; no pairing/device/Auth secret exposed |

## Definition of done

Browser Pairing V1 is ready for owner production decision only when:

- BP-01 through BP-41 pass on the final commit, with no required job skipped;
- OA-1 through OA-10 are recorded against approved disposable/staging resources;
- independent security and architecture reviewers approve the final diff and all findings are fixed or explicitly owner-accepted;
- migration 0016, kill switch, rollback and ledger order with PR #58 are rehearsed;
- existing Account V1, `.fdbact`, anonymous operation and non-empty historical data preservation pass;
- universal installer acceptance passes with identical installer bytes and AutoSync off;
- every Browser Pairing, pilot and production source/database gate remains off in the merge candidate;
- the Draft PR documents exact commit, CI URLs/results, owner evidence, residual risks and production steps;
- no production deployment, live migration, merge or public enablement occurs without a separate owner authorization.

If any security, data-preservation, Windows or full-stack gate remains incomplete by 2026-10-30, ship no Browser Pairing activation.
Retain anonymous use and `.fdbact` enrollment as the release-safe fallback.
