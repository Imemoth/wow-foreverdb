# Zero-touch enrollment — acceptance record and owner-run instructions

Rule: **nothing is PASS unless it was executed and the evidence is named.** Rows marked NOT EXECUTED are owner/CI actions.

## 1. Executed by the author (disposable local stack: PostgreSQL 16 + real GoTrue v2.197.0 built from the pinned tag; Linux, no Windows)

| Gate | Command | Result |
| --- | --- | --- |
| Existing 0012 backend suite (before 0014) | `database/tests/account/stack.sh up && apply` then `node --test --test-concurrency=1 database/tests/account/*.test.mjs` | **219/219 pass** (fresh stack; must run **before** `apply14`: the suite asserts "exactly the 0012 functions") |
| 0014 migration | `stack.sh apply14` twice (idempotent body) | applied, in-migration assertions passed |
| Enrollment suite (privileges, tickets, flows A1/A2/B1/C1/C2, races, credentials, failure/recovery, preservation, real GoTrue, rollback rehearsal, existing-regression SQL) | `node --test --test-concurrency=1 database/tests/enrollment/*.test.mjs` | **98/98 pass** |
| Mutation check 0014 | `node database/tests/enrollment/mutation_check.mjs` | 33/33 effective mutants killed; 2 equivalent defence-in-depth mutants documented in the script (a first run: 32/35 with those 3 survivors, then analysed) |
| Web | `cd web && npm run lint && npx tsc --noEmit && npx vitest run` | lint/tsc clean, vitest 395/395 |
| Companion Account library (Linux, test doubles) | `dotnet test tests/companion-account/... -p:EnableWindowsTargeting=true` | **572 passed, 3 skipped (Real_DPAPI, Windows only), 0 failed**; `scripts/check-companion-account.py` passes. The WPF project could **not** be built on Linux (missing WindowsDesktop SDK targets): UI edits are uncompiled until Windows CI |

## 2. Windows CI and first isolated-user installer smoke (2026-10-13)

**Z1 — CI PASS, on tested build SHA `a63db2557ce11a46f9056b8d9276fc73fb13755c`.**
[Companion account auth Windows run](https://github.com/Imemoth/wow-foreverdb/actions/runs/38381031964/job/115241382317):
WPF Release build PASS; 575/575 Windows Account tests PASS, 0 skipped (real DPAPI and cross-process tests executed); win-x64 publish PASS.
[Installer run](https://github.com/Imemoth/wow-foreverdb/actions/runs/38384054712):
Inno Setup build PASS, uploaded `ForeverDB-Companion-Setup` (artifact 11805095310), setup filename `ForeverDB-Companion-Setup-0.9.0-alpha.exe`.

**Isolated Windows local-user offline installation smoke — PASS (owner-reported, 2026-10-13; no independent screenshot/log):**
the installation completed without error; the application launched; the main window and tabs rendered; the ACCOUNT tab opened; the owner observed no automatic sync. Owner tested with a separate local Windows user, offline, not on their live Companion profile. This is a user report of observable UI/startup behavior; it does **not** establish network sync blocking, actual device enrollment, authenticated ownership, or upload security.

The production project was not used in this smoke test. **No Z2-Z12 staging/production E2E PASS is claimed.**
A fresh checkout/CI run is required if later documentation or code commits change the final SHA.

## 3. Activation-download 403 repair evidence (2026-10-14)

Root cause is **CONFIRMED**: Account HTML sent `Referrer-Policy: no-referrer`; a native non-CORS form POST therefore reached the Preview with
literal `Origin: null`, and the fail-closed proxy correctly returned 403 before the enrollment route. The fix changes only Account HTML to
`strict-origin`. Account paths, queries and `token_hash` values remain absent from Referer; Account API/file responses remain `no-referrer`;
literal `null`, foreign/cross-site requests and invalid HMAC tokens remain refused.

Local evidence on the fix branch before GitHub CI:

| Gate | Result |
| --- | --- |
| TDD reproduction | **RED as expected:** proxy Account-page response was `no-referrer`, not required `strict-origin` |
| Focused unit/static/security suite | **140/140 pass**: proxy metadata and null-Origin edge check; enrollment route matrix; CSRF library; enrollment/account static boundaries |
| TypeScript | `tsc --noEmit` **pass** |
| Independent security review | **PASS after fixes**: root cause independently reproduced; no Critical production issue; one Important Playwright interception flaw fixed; no ticket RPC in corrected test |
| Real-browser native form regression | corrected test submits through the real proxy/handler with a deliberately invalid token; Web E2E and Account web-auth (real GoTrue) **PASS** on `1b4d59c` |
| Local lint/build/security | lint, TypeScript, production build, 47-file bundle-secret scan and production dependency audit **PASS**; audit: 0 production vulnerabilities |
| Local full unit/static/security suite | **396/397** on Windows: only the unchanged CRLF-sensitive Markdown-fence check fails; the other **360/360 pass** when that file is excluded; Linux CI is authoritative |
| GitHub CI and CodeQL | **PASS** on `1b4d59c`: Web quality/E2E/release gate, Account web-auth/E2E/ownership SQL, Windows Companion, publisher/pipeline, collector smoke and CodeQL. SQL race job passed isolated rerun after one stochastic `device_limit` failure; no source change. |
| Fix-branch Vercel Preview | **READY** on `1b4d59c`: `wow-foreverdb-git-fix-zero-touch-enrol-c79f66-imemoths-projects.vercel.app`; protected runtime header check and owner download **PENDING**. Do not use the old #56 Preview as fix evidence. |

No Production deployment, Supabase migration/schema/data change, ticket issuance, AutoSync change, installer rebuild or live activation occurred.
The detailed security argument and Preview/Windows continuation gate are in [activation-download-origin-fix.md](activation-download-origin-fix.md).

## 3b. Owner pilot on the live private project (2026-10-16) — summary; full record in [zero-touch-pilot-closure.md](zero-touch-pilot-closure.md)

| Item | Status |
| --- | --- |
| #59 protected Preview: account HTML `strict-origin`; activation download POST 200 | **PASS** (owner-reported) |
| #57 pilot: one `.fdbact` consumed, one registered device on the web (pilot subset of Z2) | **PASS** (owner-reported) |
| Companion 0.9.0-alpha sign-in; registered-device manual Sync Now, AutoSync OFF, Last Error None (pilot subset of Z3) | **PASS** (owner-reported), **0 sources / 0 Guildbook members — empty payload only** |
| Non-empty ingest, Guildbook view of uploaded data, 6 anonymous / 140 / 46 preservation re-check | **NOT TESTED** / **NOT VERIFIED here** |
| Installation panel `Not checked yet` after successful upload | **defect fixed in code; Windows CI PASS on `92d8e80`; owner on-screen check NOT TESTED** |
| Z4–Z10, Z11 on a merge commit, Z12 | **NOT TESTED** |
| Z13 | **NOT IMPLEMENTED / BLOCKED** for public release |

## 4. Remaining owner / staging / production acceptance (Z2-Z12 not executed)



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
| Z13 — PUBLIC RELEASE ONLY | Website account signed in → **one downloadable installer package** → run installation → **automatic activation** with no separate `.fdbact` download, drag/drop, new login or code; repeat on second PC, test anon-first, expiry/recovery and browser/download caches | Windows 10 & 11, protected web then release candidate | **NOT EXECUTED; blocking public release. #57 pilot is explicitly exempt.** |

Production data checks (read-only, before and after any production step): the six anonymous installation ids keep `owner_user_id` and row counts; linked
installation `2f8df8ba69345d0a14c8d56ac86d4b2e` keeps 140 source-stats and 46 Guildbook members. This PR did not touch production.

## 5. Remaining blockers and risks (owner decisions)

1. First-redeemer theft of an unused ticket is bounded, not prevented (ADR-017 §4). Decide on re-approval (`pending_approval` status is reserved).
2. No cryptographic proof-of-possession of a device key (needs an Edge Function backend, ADR-017 §6).
3. **PUBLIC RELEASE BLOCKER (Z13, owner decision 2026-10-13):** one download must deliver a securely integrated installer + activation handoff, with no manually managed `.fdbact`. Current web delivers only the activation file; a ZIP requiring manual placement of the activation file is **not enough**. The owner-only #57 split-file pilot remains valid for backend E2E, but cannot satisfy Z13. Installer signing and secure non-cached bootstrap transport need design and verification.
4. Pilot flags are still true on this stacked branch; merge only with `check-pilot-flags.py --require-off` (integration-and-release-order.md).
5. Z1 Windows WPF build, real DPAPI, win-x64 publish and installer compilation PASS on SHA `a63db255`; an isolated local-user offline installer/UI smoke also PASS by owner report. **The live activation, staged installation handoff, device authentication and Z2-Z12 acceptance are NOT executed.**
6. Anonymous-signup abuse on the shared Auth project (threat A24) is unchanged.
