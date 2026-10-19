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

## Stage B component evidence checkpoint

This checkpoint is intentionally not a Stage B exit result. Database Tasks 1–3 passed 127/127 tests at `4bf8e88`; Task 4 changes to
rollback, restore and mutation coverage still require a complete rerun. The web implementation through Task 8 passed 473/473 Vitest
tests, typecheck, lint, production build, a 48-file bundle scan, the OFF-gate scan and `git diff --check` at `330565d`. Those are
different commits and therefore do not satisfy the final exact-head gate. Task 9 real-stack tests, Task 10 exact-head CI, PR #58 order
rehearsal and both final-diff reviews remain mandatory.

`DB component pass` below refers to `database/tests/pairing/01`–`07` at `4bf8e88`. `Web component pass` refers to the pairing unit and
static suites included in the 473-test web run at `330565d`. A component pass proves only that layer; the last column names the work
that still blocks the acceptance row.

| ID | Stage B evidence at this checkpoint | Still required |
| --- | --- | --- |
| BP-01 | DB component pass: redemption and new-installation ownership (`03`, `05`) | Task 9 real PostgREST/browser flow; final exact-head rerun |
| BP-02 | DB component pass: anonymous owner transfer and preservation (`01`, `03`, `05`) | Task 9 historical-data flow; final exact-head rerun |
| BP-03 | Web component pass: signed handoff, login return, preview and named-account UI | Task 9 rendered login-to-approval flow |
| BP-04 | DB component pass: expiry under lock and safe fresh start (`02`, `03`) | Task 9 real stack; Stage C Companion recovery UI |
| BP-05 | DB + Web component pass: denial transition and decision route (`02`, `04`) | Stage C pending-secret cleanup and state UI |
| BP-06 | DB component pass: cancel and connected no-op semantics (`02`) | Stage C Companion cancellation behavior |
| BP-07 | DB + Web component pass: terminal replay and signed locator handling (`02`–`04`, cookie/browser suites) | Task 9 real browser/PostgREST replay |
| BP-08 | DB + Web component pass: exact initiator/session/proof checks and bearer boundary (`02`, `03`, route suite) | Named Task 9 GoTrue lifecycle gate |
| BP-09 | DB component pass: pinned real-GoTrue refresh/session behavior (`03`) | Named Task 9 refresh-rotation lifecycle gate |
| BP-10 | DB component pass: two-account approval race (`04`) | Task 9 real-stack two-account flow |
| BP-11 | DB component pass: approval/deny/expiry races (`03`, `04`) | Task 9 real-stack flow; final exact-head rerun |
| BP-12 | DB component pass: 100 double-redemption races and atomic effects (`03`) | Task 9 PostgREST concurrency proof |
| BP-13 | DB component pass: idempotent start/conflicting verifier (`02`, `03`) | Stage C lost-start recovery |
| BP-14 | DB component pass: connected replay is read-only (`03`) | Stage C credential promotion/recovery |
| BP-15 | DB component pass: foreign registered owner is immutable (`02`, `03`) | Task 9 real-stack owner-conflict flow |
| BP-16 | DB + Web component pass: exact session/account/body binding and stale action refusal (`04`, browser/UI suites) | Task 9 two-tab/account-switch browser flow |
| BP-17 | DB + Web component pass: locator/cookie fixation and GET non-mutation (`04`, cookie/browser/route suites) | Task 9 raw/browser flow; final ingress decision |
| BP-18 | Web component pass: Origin, Fetch Metadata, JSON and CSRF rejection before RPC | Task 9 real stack; durable duplicate-Authorization ingress guarantee |
| BP-19 | DB + Web component pass: budgets, poll backoff and strict route limiter (`02`, `04`, route suite) | Task 9 real-stack rate behavior |
| BP-20 | DB component pass: every device-revocation cause propagates and re-enrollment is controlled (`05`, `06`) | Task 9 real stack; Stage C recovery UI |
| BP-21 | DB component pass: account/device limits and distinct device rows (`03`, `05`) | Task 9 multi-installation account flow |
| BP-22 | DB + Web component pass: immutable start bindings and strict schemas (`01`, `02`, `05`, contract suite) | Task 9 transport substitution cases |
| BP-23 | DB component pass: unavailable account/session denies with rollback (`03`) | Named Task 9 GoTrue lifecycle gate |
| BP-24 | DB component pass: initiator session revocation blocks poll/cancel/redemption (`02`, `03`) | Named Task 9 GoTrue lifecycle gate |
| BP-25 | DB component pass: active device blocks pairing (`02`) | Task 9 real-stack regression |
| BP-26 | Pre-0016 enrollment regression evidence: 99/99 at `56d4a0a` | Final post-Task-4 exact-head enrollment rerun |
| BP-27 | DB component pass: existing rows, definitions, ACLs and history preserved (`01`, `03`) | Task 4 rollback/restore and final exact-head rerun |
| BP-28 | DB component pass: migration preserves anonymous owners and data (`01`) | Task 9 anonymous-use regression |
| BP-29 | DB + Web component pass: database gate and compiled source gate remain OFF (`01`, `02`, static suite) | Final exact-head OFF scan and CI result |
| BP-30 | Web component pass: secret/log/client-boundary checks and 48-file bundle scan | Task 9 artifact/log scan and final exact-head bundle scan |
| BP-31 | No completed Stage B evidence yet | Task 4 kill switch, rollback/restore, ledger and PR #58 order tests |
| BP-32 | DB component pass: 100-iteration claim/ticket/ingest/revoke mixed races (`03`, `07`) | Final exact-head rerun with Task 4 changes |
| BP-33 | Web component pass: explicit labels, one-shot controls and accessibility structure | Task 9 rendered accessibility/responsive checks |
| BP-34 | No Stage B component implements this Companion behavior | Stage C WPF state implementation and Windows tests |
| BP-35 | DB component pass: manual ingest serializes with redemption (`07`); source OFF scan passes | Stage C Companion AutoSync/manual-sync guards |
| BP-36 | DB component pass: every predecessor predicate and one-field mutant (`03`, `05`) | Final mutation and exact-head rerun |
| BP-37 | DB component pass: real-GoTrue logout/refresh/revoke races serialize (`03`) | Named Task 9 lifecycle gate, including concurrent revocation |
| BP-38 | DB component pass: retryable limits, terminal conflicts and rollback (`03`) | Task 9 fixed-error transport proof |
| BP-39 | DB + Web component pass: server-side canonical UUID/hash contract (`01`, `02`, contract suite) | Stage C Companion equal-ID preflight check |
| BP-40 | DB component pass: actor/proof isolation and safe expiry/revocation (`02`, `03`) | Task 9 stolen-bearer real-stack case |
| BP-41 | DB component pass: exact audit schema, ACLs, uniqueness and write classes (`01`, `06`) | Task 4 audit mutations and final exact-head rerun |

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
