# AzerDex News Integration V1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a source-backed, automatically ingestible AzerDex news system that stores Blizzard Blueposts, relevant official WoW news, and future AzerDex entries in the existing isolated public-read database and renders them on the homepage and `/news` archive.

**Architecture:** Keep the website on the existing `foreverdb_web_reader` boundary. Add independent `pub.news_*` tables and bounded `web_api.news_*` functions to the public-read database; ingestion writes only through a `pub_admin` security-definer apply function. A portable collector implements source parsing, relevance classification, pagination/stop rules, deduplication, and run logging, with a Supabase Edge entry point for scheduled execution. Next.js reads stored news through the existing `PublicDataAdapter` and retains the current editorial Markdown archive as a separate AzerDex-authored source.

**Tech Stack:** PostgreSQL/Supabase SQL migrations, Deno-compatible TypeScript Edge Function, Next.js 16 App Router, React Server Components, TypeScript, Vitest, existing Tailwind 4 styles.

**Spec:** `C:/Users/Imemoth/.codex/attachments/3d59a58f-0138-4323-b2f3-ea3f3c2a02ff/Beillesztett szöveg.txt`

## Global Constraints

- Preserve the existing cinematic homepage and unrelated database/account/addon/companion pipelines.
- Do not create another Supabase project; keep privileged keys server-side and never expose them to the browser.
- Automatically publish only reliably classified WoW Forever records; ambiguous records remain unpublished.
- Preserve original source URLs and publication timestamps; store excerpts, not full Blizzard articles.
- Deduplicate by stable source identifiers and do not silently merge US/EU records.
- Keep previously published records available during source or database failures.
- Homepage and archive read stored database data; they never block initial rendering on live Blizzard requests.
- Use additive, non-destructive migrations and the repository's existing migration layout.

## Review Focus

- A Blue Tracker feed item with a Forever topic but a later developer reply must not create duplicate homepage stories; test thread grouping/selection in Task 4.
- A Blizzard source response may omit optional excerpt, author, updated timestamp, or category data; test conservative normalization in Task 2.
- The EU endpoint may fail independently from US; test per-source failure isolation and preserved stored data in Task 4.
- An unchanged source record must not create a database update or version row; test content-hash idempotency in Task 3.
- Existing editorial `/news/[slug]` routes must remain valid beside database-backed detail URLs; test route/data boundaries in Task 6.

### Task 1: Public-read news schema and bounded API

**Files:**
- Create: `database/public-read/migrations/0002_news_model.sql`
- Test: `database/public-read/tests/news_model_security.sql`
- Create: `docs/web/news-integration.md`

**Interfaces:**
- Produces `pub.news_sources`, `pub.news_entries`, `pub.news_post_versions`, `pub.news_sync_runs`.
- Produces `pub_admin.news_apply_sync(jsonb)` and `web_api.news_list(text,text,integer,integer)`, `web_api.news_featured(integer)`, `web_api.news_entry(text)`.

- [ ] **Step 1: Write security and contract assertions** for RLS, no direct table privileges, bounded reader functions, unique `(source_id, source_entry_id)`, allowed source/category/status values, and preservation of published rows after an unsuccessful sync.
- [ ] **Step 2: Run the SQL assertions against the available database harness**; record the expected unavailable result if no public-read Postgres is configured.
- [ ] **Step 3: Implement the additive migration** with source metadata, normalized entries, optional post versions, sync-run audit, indexes, a security-definer idempotent apply function, public-read functions, grants, and boundary assertions.
- [ ] **Step 4: Add the source reliability/runbook document** describing the verified US/EU JSON shape, EU graceful disable behavior, official `news/river.frag?page=N` fragment, filtering limitations, schedules, required secrets, and manual diagnostics.
- [ ] **Step 5: Re-run SQL/static checks** and inspect the migration diff for unrelated objects.

### Task 2: Collector parsing, filtering, and normalization

**Files:**
- Create: `supabase/functions/azerdex-news-collector/collector.ts`
- Create: `supabase/functions/azerdex-news-collector/collector.test.ts`
- Create: `supabase/functions/azerdex-news-collector/index.ts`
- Modify: `supabase/config.toml`

**Interfaces:**
- `parseBluepostFeed(body: string, source: BluepostSource): NormalizedNewsEntry[]`
- `parseOfficialNewsFragment(body: string, source: OfficialNewsSource): NormalizedNewsEntry[]`
- `classifyRelevance(title: string, excerpt: string, sourceType: NewsSourceType): Relevance`
- `collectNews(options: CollectorOptions): Promise<SyncReport>`

- [ ] **Step 1: Write failing parser tests** for real Blue Tracker fields, US/EU canonical URLs, official-news fragment fields, malformed/missing metadata, Forever-vs-Retail filtering, patch-note categorization, and stable IDs.
- [ ] **Step 2: Run the collector tests and verify they fail for missing exports.**
- [ ] **Step 3: Implement pure parsing/normalization** with HTML entity decoding, excerpt stripping/truncation, ISO timestamp validation, source-region preservation, stable source IDs, conservative relevance classification, and no invented metadata.
- [ ] **Step 4: Implement source fetch orchestration** with timeout/rate-limit handling, US/EU isolation, official-news page iteration with repeated-page/old-record stop rules, and a six-hour revision-check mode.
- [ ] **Step 5: Implement the Edge Function entry point** with fail-closed shared-secret authentication and a Postgres RPC client using the existing project configuration; update `supabase/config.toml` without changing the welcome worker.
- [ ] **Step 6: Run parser tests and source smoke tests** against the live endpoints; record actual source counts and any unavailable source as evidence.

### Task 3: Web data-access contract and database-backed views

**Files:**
- Modify: `web/src/lib/data/types.ts`
- Modify: `web/src/lib/data/index.ts`
- Modify: `web/src/lib/data/postgres-adapter.ts`
- Modify: `web/src/lib/data/fixture-adapter.ts`
- Create: `web/src/lib/news/selection.ts`
- Create: `web/tests/unit/news-selection.test.ts`

**Interfaces:**
- Add `NewsEntry`, `NewsCategory`, `NewsSourceType`, `NewsQuery`, and `NewsPage` DTOs.
- Add `newsList(query)`, `newsFeatured(limit)`, and `newsEntry(slug)` to `PublicDataAdapter`.
- `selectHomepageNews(entries: NewsEntry[], limit: number): { featured: NewsEntry | null; recent: NewsEntry[] }` groups Bluepost thread keys before selection.

- [ ] **Step 1: Write failing selection and adapter-contract tests** for newest-first filtering, title/excerpt search, category tabs, thread grouping, featured importance/recency, and empty results.
- [ ] **Step 2: Run the focused tests and verify they fail.**
- [ ] **Step 3: Implement the DTOs, selection helper, TTL-cached adapter methods, bounded Postgres calls, and deterministic fixture behavior.**
- [ ] **Step 4: Run focused tests plus existing data tests.**

### Task 4: Homepage and archive integration

**Files:**
- Create: `web/src/components/NewsCard.tsx`
- Create: `web/src/components/NewsSection.tsx`
- Modify: `web/src/app/page.tsx`
- Modify: `web/src/app/news/page.tsx`
- Modify: `web/src/app/news/rss.xml/route.ts`
- Modify: `web/src/components/SiteHeader.tsx`
- Modify: `web/src/app/globals.css` only if a reusable news style is needed

- [ ] **Step 1: Add component tests/markup assertions** for the exact “Latest from Azeroth” title/subtitle, category labels, dates, source links, View All News, no unrelated records, and accessible search/filter controls.
- [ ] **Step 2: Verify the new assertions fail before implementation.**
- [ ] **Step 3: Implement the homepage section** with one featured card and three recent cards from stored data, a branded no-art fallback, and unchanged hero/entry-point sections.
- [ ] **Step 4: Implement the searchable `/news` archive** with All News, Blue Posts, Official News, AzerDex tabs; query-param pagination; loading/empty/error-safe UI; existing editorial content retained as a secondary archive section.
- [ ] **Step 5: Update RSS to include database-backed published entries** while retaining existing editorial items and canonical source URLs where applicable.
- [ ] **Step 6: Run unit tests and render/build checks.**

### Task 5: Database-backed detail page and SEO boundaries

**Files:**
- Create: `web/src/app/news/entry/[slug]/page.tsx`
- Create: `web/src/components/NewsDetail.tsx`
- Modify: `web/src/app/sitemap.ts`
- Create: `web/tests/unit/news-detail.test.ts`

- [ ] **Step 1: Write failing tests** for a published DB entry, an unpublished/unknown entry, original-source CTA, author/region/date metadata, and coexistence with editorial `/news/[slug]` routes.
- [ ] **Step 2: Verify focused tests fail.**
- [ ] **Step 3: Implement the shareable internal detail page** with short excerpt, source attribution, prominent original link, no full-article reproduction, and grouped-thread context where available.
- [ ] **Step 4: Add only published database entries to the production sitemap** and preserve preview/local noindex rules.
- [ ] **Step 5: Run focused tests and route/build checks.**

### Task 6: Verification, review, activation, and PR

**Files:**
- Modify: `docs/web/news-integration.md` with actual verification evidence
- No unrelated files

- [ ] **Step 1: Run `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, and `npm run check:bundle-secrets`; record exact results, including the pre-existing baseline failure.
- [ ] **Step 2: Run the collector smoke test and, if credentials/database are available, verify persisted counts and public reads without printing secrets.**
- [ ] **Step 3: Inspect the diff, run the verification-before-completion checklist, and request an independent code review before PR creation.**
- [ ] **Step 4: Commit the feature, push `feature/azerdex-news-v1`, create a PR targeting `web/azerdex-beta`, and attach the PR URL to the task.**
- [ ] **Step 5: Report PASS/PARTIAL/BLOCKED/NOT VERIFIED per deliverable, including branch, commit, PR, migration, source findings, schedules, UI verification, test evidence, blockers, and exact beta testing instructions.**
