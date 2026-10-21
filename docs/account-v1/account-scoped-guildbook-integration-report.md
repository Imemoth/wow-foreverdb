# Account-scoped Guildbook integration report

Status: implementation prepared for owner acceptance on `feature/account-independent-collector-credentials`. Final verified head: `04e0ccef46f67f437807ca77f494ae1259ed047b`. PR [#91](https://github.com/Imemoth/wow-foreverdb/pull/91) is stacked on the unchanged PR [#88](https://github.com/Imemoth/wow-foreverdb/pull/88); PRs #81, #82, and #83 remain unchanged.

Implemented:

- Prompt 0 contract and integration plan.
- Migration 0016 with account-owned Guildbook tables, capture ledger, verified-session ingest, scoped reads, replay/staleness checks, and public-payload stripping. Migration number 0015 was already reserved by pending PR #58 (`0015_azerdex_welcome_outbox.sql`), so the collision was resolved before publication.
- Addon schema-9-compatible capture provenance and `/fdb guildbook refresh`.
- Companion separation of public collector sync from private Guildbook sync, account cache invalidation, session-bound freshness, camelCase payloads, and complete member pagination.
- Migration 0017 with durable per-installation collector credentials, same-device multi-installation enrollment, unchanged installation ownership, clear missing-enrollment status, and separate public/private sync outcomes.
- Disposable CI workflow coverage for migration 0016 and cross-account isolation.

Verification:

- Web: 397 tests passed; typecheck, lint, production build, bundle-secret scan passed.
- Addon: capture, collector, session, UI, and quest smoke suites passed.
- Companion static/account checks passed; Windows Release build and .NET tests are wired in `.github/workflows/companion-account-auth.yml`.
- Exact-head GitHub CI passed on `04e0ccef`: all 9 workflows, including disposable PostgreSQL/real GoTrue migration 0017 isolation, GoTrue/PostgREST end-to-end, Windows/.NET Release, Companion account tests, web, API, and addon checks.
- Normal Windows artifact: [ForeverDB-Companion-win-x64.zip](https://github.com/Imemoth/wow-foreverdb/actions/runs/39639853972/artifacts/12363528758), SHA-256 `132bdbfa08ec6138096d1d2392fbe9cda3a75232d788b4647ae47472c7419c7c`.
- No live migration or deployment was performed.

Owner acceptance checklist:

1. Anonymous mode: non-empty public SavedVariables snapshot uploads successfully with AutoSync enabled.
2. Sign in A: A's server Guildbook loads; sign out removes it immediately.
3. Sign in B: A's cache and stale local capture remain hidden/not uploaded; B's server Guildbook loads.
4. Capture a new B Guildbook after sign-in: B ingest succeeds and remains isolated from A.
5. Switch B → anonymous: public AutoSync still succeeds while private Guildbook is hidden.
6. Verify multiple installation IDs, independent credential revocation, and a clear initial-enrollment message for an account-owned installation without a collector credential.
7. Confirm public upload success is reported independently from private Guildbook upload success.
8. Run the disposable account SQL/GoTrue workflow and Windows Companion Release workflow.
