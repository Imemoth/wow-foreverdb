# Account-scoped Guildbook integration report

Status: implementation prepared for owner acceptance on `feature/account-scoped-guildbook-integration`. The final verified commit SHA is reported with the handoff; PRs #81, #82, and #83 remain unchanged.

Implemented:

- Prompt 0 contract and integration plan.
- Migration 0016 with account-owned Guildbook tables, capture ledger, verified-session ingest, scoped reads, replay/staleness checks, and public-payload stripping. Migration number 0015 was already reserved by pending PR #58 (`0015_azerdex_welcome_outbox.sql`), so the collision was resolved before publication.
- Addon schema-9-compatible capture provenance and `/fdb guildbook refresh`.
- Companion separation of public collector sync from private Guildbook sync, account cache invalidation, session-bound freshness, camelCase payloads, and complete member pagination.
- Disposable CI workflow coverage for migration 0016 and cross-account isolation.

Verification:

- Web: 397 tests passed; typecheck, lint, production build, bundle-secret scan passed.
- Addon: capture, collector, session, UI, and quest smoke suites passed.
- Companion static/account checks passed; Windows Release build and .NET tests are wired in `.github/workflows/companion-account-auth.yml`.
- Real PostgreSQL/GoTrue and Windows/.NET execution were not available in this workspace; no live migration or deployment was performed.

Owner acceptance checklist:

1. Anonymous mode: non-empty public SavedVariables snapshot uploads successfully with AutoSync enabled.
2. Sign in A: A's server Guildbook loads; sign out removes it immediately.
3. Sign in B: A's cache and stale local capture remain hidden/not uploaded; B's server Guildbook loads.
4. Capture a new B Guildbook after sign-in: B ingest succeeds and remains isolated from A.
5. Switch B → anonymous: public AutoSync still succeeds while private Guildbook is hidden.
6. Run the disposable account SQL/GoTrue workflow and Windows Companion Release workflow.
