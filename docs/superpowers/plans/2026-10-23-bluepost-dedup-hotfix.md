# AzerDex Bluepost Deduplication Hotfix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish exactly one verified Blizzard Tracker topic opener per US/EU Bluepost topic, suppress historical replies safely, and keep every News read surface reply-free.

**Architecture:** Filter Bluepost records at the collector boundary to `post_number = 1`, using the authoritative Tracker feed identity to validate revision openers. Add a reversible suppression marker and defense-in-depth filtering to the existing public-read RPC without changing the isolated auth boundary; provide a dry-run/audited cleanup SQL script and rollback procedure.

**Tech Stack:** Deno-compatible TypeScript Edge Function, PostgreSQL/Supabase SQL migrations and assertion scripts, Next.js 16 App Router, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-23-azerdex-bluepost-dedup-hotfix.md`

## Global Constraints

- Only `sourcePostNumber === 1` may be published as a Bluepost.
- The original must be proven to come from the authoritative Blizzard Tracker feed; a Blizzard reply must not promote a user-created topic.
- Replies never alter the original publication timestamp, homepage order, featured status, or US/EU separation.
- Official News ingestion remains unchanged.
- Existing rows and post-version history are preserved; suppression is reversible and audited.
- Website reads remain bounded `web_api` functions; collector writes remain through `pub_admin.news_apply_sync`.
- Do not touch production, Companion, Account, or Maps; do not execute live cleanup or deploy database changes without explicit authorization and verification.

## Review Focus

- A topic with only a Blizzard reply in the Tracker feed must not promote its user opener; test the revision authorization map.
- A revision payload containing a newer reply must leave the opener's `publishedAt`, featured flag, and source identity unchanged.
- A previously suppressed reply must remain hidden if accidentally submitted again; test both existing and unseen replies at the RPC boundary.
- A suppressed row must remain absent from list, featured, detail, archive pagination, search, RSS, sitemap, and homepage projections.
- Invalid or missing post numbers must fail closed for Blueposts while Official News remains accepted unchanged.

### Task 1: Collector admission and revision authorization

**Files:**
- Modify: `supabase/functions/azerdex-news-collector/collector.ts`
- Test: `web/tests/unit/news-collector.test.ts`
- Add/modify: `web/tests/fixtures/news/*.json` for representative Tracker and topic responses if useful

**Interfaces:**
- `parseBluepostFeed(body: string, source: BluepostSource, options?: BluepostParseOptions): NormalizedNewsEntry[]`
- `BluepostParseOptions.authoritativePostIds?: ReadonlySet<string>` identifies post IDs proven by the Tracker feed.
- `collectNews(options: CollectorOptions): Promise<SyncReport[]>` remains unchanged for callers.

- [x] **Step 1: Write failing parser and collector tests** for a Tracker opener being published; player replies, Blizzard staff replies, and missing/invalid post numbers being ignored; a user-created topic with only a Blizzard reply not being promoted; revision updates applying only to the known opener; repeated normal/revision runs remaining one-entry/idempotent; and US/EU separation.
- [x] **Step 2: Run the focused collector tests and verify the new assertions fail for the current all-post parser.**
- [x] **Step 3: Implement minimal admission filtering**: normal Tracker payloads may establish authoritative opener IDs, topic JSON may emit only post 1 whose ID is in that allow-list, and revision topic URLs are derived only from admitted openers. Preserve `created_at` as `publishedAt` and use `updated_at` only as `modifiedAt`.
- [x] **Step 4: Run collector tests, including existing Official News tests, and verify all pass.**

### Task 2: Reversible suppression schema, RPC guard, and cleanup artifacts

**Files:**
- Create: `database/public-read/migrations/0010_news_bluepost_suppression.sql`
- Create: `database/public-read/tests/news_bluepost_dedup.sql`
- Create: `database/public-read/tests/news_bluepost_dedup_security.sql`
- Create: `database/public-read/ops/news_bluepost_dedup_dry_run.sql`
- Create: `database/public-read/ops/news_bluepost_dedup_apply.sql`
- Create: `database/public-read/ops/news_bluepost_dedup_rollback.sql`

**Interfaces:**
- Add nullable `suppressed_at` and `suppression_reason` to `pub.news_entries`.
- `pub_admin.news_apply_sync(jsonb)` skips all non-opener Bluepost entries and cannot republish suppressed replies.
- `web_api.news_list`, `web_api.news_featured`, and `web_api.news_entry` exclude suppressed rows and non-opener Blueposts.
- Dry-run returns projected before/after counts; apply records an audit row in the existing sync-run audit table and updates only suppression fields; rollback clears only the cleanup marker identified by its audit/run timestamp.

- [x] **Step 1: Write failing SQL assertions** for public functions hiding suppressed/non-opener rows, preserving version rows, refusing/rejecting reply upserts, and retaining reader/publisher privilege boundaries.
- [ ] **Step 2: Run SQL/security tests against the available disposable public-read harness; record an unavailable result if no database is configured.** BLOCKED: this environment has no `psql`/PostgreSQL server and Docker daemon access is denied.
- [x] **Step 3: Implement the additive migration** with suppression columns/index, fail-closed RPC guard, reader predicates, and no direct grants.
- [x] **Step 4: Implement dry-run, apply, and rollback scripts** with explicit transaction boundaries, exact count reporting, no deletes, and a required operator confirmation variable for apply.
- [ ] **Step 5: Re-run SQL/static checks and verify the projected counts are 371 stored before, 28 visible after, 343 suppressed replies, 28 retained originals, and 29 distinct historical topics represented.** Static checks and the projection are complete; disposable SQL execution is blocked by the environment.

### Task 3: Web-facing regression coverage

**Files:**
- Modify: `web/tests/unit/news-selection.test.ts`
- Modify: `web/tests/unit/news-collector.test.ts` if shared fixtures require it
- Add/modify: `web/tests/unit/news-read-model.test.ts` only if a pure read-model helper is needed
- Modify: `web/tests/e2e/news.spec.ts` only for stable News V1 assertions that do not disturb editorial coverage

**Interfaces:**
- Existing `NewsEntry`/`PublicDataAdapter` contracts remain stable.
- All web projections consume already-filtered published rows; homepage selection must not be the only deduplication layer.

- [x] **Step 1: Write failing unit assertions** that homepage selection keeps only original Blueposts, preserves publication ordering/featured state, and keeps US/EU topics separate.
- [x] **Step 2: Run focused web tests and verify they fail against reply-shaped fixtures.**
- [x] **Step 3: Implement only the necessary defensive selection/read filtering** without changing Official News or editorial routes.
- [ ] **Step 4: Run focused unit tests and relevant News E2E tests, including archive pagination, search, region filters, RSS, and detail/sitemap smoke coverage where the environment supports it.** Unit coverage passes; E2E is blocked because the sandbox cannot bind the Next server port and the optimized build hangs.

### Task 4: Verification, review, branch, and PR handoff

**Files:**
- Modify: `docs/web/news-integration.md` with actual verification evidence, projected counts, deployment order, and rollback instructions
- Modify: `docs/superpowers/plans/2026-10-23-bluepost-dedup-hotfix.md` only for completed evidence if the repository convention requires it

- [ ] **Step 1: Run focused collector tests, SQL/security tests, Web E2E, lint, typecheck, build, bundle-secret checks, and required CI; record exact PASS/PARTIAL/BLOCKED results.** Unit, lint, and typecheck pass; SQL, build, bundle scan, E2E, and CI are environment-blocked.
- [ ] **Step 2: Verify live source fixtures/read-only counts if credentials are available, without printing secrets; do not execute cleanup or database migration against live data without explicit authorization.** Live forum reads returned HTTP 403; repository fixtures cover the representative Discourse payload shapes.
- [x] **Step 3: Inspect the diff for scope boundaries and request an independent review before push/PR creation.** No independent reviewer tool is available in this session; completed a focused self-review and kept changes within News/public-read/docs.
- [ ] **Step 4: Push the dedicated branch and open a PR targeting `web/azerdex-beta`; do not merge or deploy.**
- [x] **Step 5: Report exact before/after projected counts and the safe order: deploy collector code, verify collector tests/health, run dry-run, authorize and apply suppression, verify public reads/counts, then monitor; rollback clears only the suppression marker if validation fails.**
