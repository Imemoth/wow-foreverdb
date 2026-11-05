# Production-readiness assessment: promoting `release` (cd5d352) to azerdex.com

Date: 2026-11-05 (evidence gathered 05:20-06:40 UTC). Scope: **assessment only.** Nothing in production was changed to produce it:
no promotion, redeploy, migration, data write or setting change. Production was read through catalog and `SELECT` queries on
`azerdex-public-read`, Vercel read APIs, public GETs of azerdex.com and GETs of the staged deployment.

**Decision needed from the owner: promotion of the staged build requires separate, explicit owner approval.** This document is the
input for that decision.

## 1. Verdict and recommendation

**Technically ready, with two small prerequisites and one real decision.** I found no technical blocker to promoting the staged
build `dpl_J8R8dVe7TonQSADZ86qwWVZ68ZEU` (commit `cd5d352`): production's news functions are byte-identical to what the release
migrations build, the staged build renders the same news as the live build from the same database, the deployment-bound parity gate
and functional probe pass, and instant rollback to the current production deployment is database-compatible.

What is *not* a technical question, and is why I did not promote:

1. **Promotion publishes more than the two articles.** `azerdex.com` still serves the 2 Nov build. Four changes merged to `release`
   since (#160 news Collector V2, #161, #163, #162) have never been promoted, and V2's own runbook makes the website deploy an owner
   gate (**G4**). Promoting `release` ships them together with the articles.
2. **One V2 gate is verifiably not done: G2** (`0018_news_health_monitoring.sql`). The `private.azerdex_news_health*` functions do not exist
   in production. This does not affect the website, but the operator health check the runbook relies on is missing.
3. **`publishedAt` is 2026-11-05.** If promotion happens on another day, both articles need their date updated first (section 8, step 2).

**Safest next action (recommended):** the owner records an explicit **G4 approval** (accepting news V2 on the website), decides whether
to apply G2 first, fixes the promotion day, then promotes the already-verified staged deployment using the runbook in section 8.
Keep PR #165 (story grouping) and the G5 backfill out of this promotion: they are database-first operations with their own gates and
no dependency in either direction (section 4). If the owner prefers to bundle the news rollout, wait and promote after #165.

## 2. State of play (verified)

| Item | Value |
| --- | --- |
| Live on azerdex.com | `dpl_3uxBgrk7L4GZ44RqHd37LmgHvqfo`, commit `1980042` (PR #149), alias set 2026-11-02 19:00 UTC; alias `updatedAt` unchanged by this work |
| Staged, unpromoted | `dpl_J8R8dVe7TonQSADZ86qwWVZ68ZEU`, target production, commit `cd5d352`, READY 2026-11-05 06:10 UTC, only alias `wow-foreverdb-git-release-imemoths-projects.vercel.app` |
| `release` head | `cd5d352` (PR #166 squash). GitHub CI on the PR head `868dddb`: 16 of 16 executed checks green incl. the six required ones (`Supabase Preview` skipped, not required) |
| Articles on azerdex.com | not live: both URLs 404, absent from the production sitemap, `/blog` shows only the old sample card |
| Open PRs against `release` | #165 (news story grouping, draft), #151 / #150 (dependency refreshes, draft), #124 (Nozdormu PoC, draft) |

Mechanics: a merge to `release` builds a **staged** production deployment that is not aliased to `azerdex.com`; promotion is a separate
step (`docs/web/release-parity.md`, runbook). Auto-assign of custom production domains stays disabled.

## 3. What promotion would publish

Commits between the live build and `release`: `edf837e` #160, `8d033a4` #161, `1814d10` #163, `902b6e7` #162, `cd5d352` #166.

- **Web runtime source changed** (17 files): news presentation only (`app/news/rss.xml`, `app/sitemap.ts`, `NewsArchive`, `NewsCard`,
  `NewsDetail`, `lib/news/*`, `lib/data/{postgres,fixture}-adapter`, `lib/data/types`) plus the blog work (hero, card, hub, reader,
  article-media, article views). **Not changed:** CSP/proxy, env policy, security libraries, `next.config`, robots, API routes, auth,
  talents, maps.
- **Dependency delta:** one scoped npm override (`@typescript-eslint/typescript-estree` > `minimatch ^11.0.4`), dev tooling only.
- **Already live regardless of promotion** (independent of the web build): migrations 0011 and 0012 and the Edge Function v4, see
  section 4. The web promotion changes only what the website reads and renders.

## 4. News Collector V2 gate ledger (docs/web/news-collector-v2.md section 10)

| Gate | Step | Status | Evidence |
| --- | --- | --- | --- |
| G0 / G1 | Migration `0011_news_collector_v2` | **Done** | ledger `20261104094201 news_collector_v2` |
| G2 | `database/ops/0018_news_health_monitoring.sql` (functions) | **NOT done** | `private.azerdex_news_health*` absent; only `private.azerdex_news_schedule_request` exists |
| G3 | Edge Function `azerdex-news-collector` | **Done** | version 4, updated 2026-11-04 10:16 UTC, `verify_jwt=false` as the runbook specifies |
| (0012) | `news_revision_due_tolerance` | **Done** | ledger `20261104221331`; `news_revision_batch` body md5 `149f9bd8a0f5191163108026ccbdbd84`, length 1940 = the runbook's expected value |
| G4 | Merge, website deploy | **Merged and staged, not promoted** | this document |
| G5 | Backfill (owner approval, dry-run first) | **Not executed** | no `mode='backfill'` rows in `pub.news_sync_runs` |
| G6 / G7 | Optional health-check schedule / timeout tuning | Not applied | cron has the three news jobs plus `azerdex-publish-observations`, all active |
| 0013 (PR #165) | `news_global_story_grouping` | **Applied before its code merge** | ledger `20261105052509`; `pub.news_story_members` = 0 and `pub.news_story_overrides` = 0 rows, so it is dormant |

The runbook orders the website deploy (G4) **before** the backfill (G5), so the missing backfill does not block promotion; it only means
historical staff replies are absent until it runs.

## 5. Migration history and schema parity

**Ledger** (`azerdex-public-read`, 15 entries) against the repository:

| Production ledger | Repository |
| --- | --- |
| `public_read_prelude_extensions`, `0001`-`0006` | `database/public-read/migrations/0001`-`0006` |
| `public_read_0007_news_model` | `0002_news_model.sql` (applied under a different label) |
| `public_read_0008`, `0009` | `0008_news_ingest_role`, `0009_news_ingest_search_path` |
| `public_read_0010_news_vault_scheduler` | no repository file (project-specific scheduler/vault setup) |
| `news_bluepost_suppression_v1` | `0010_news_bluepost_suppression.sql` |
| `news_collector_v2`, `news_revision_due_tolerance` | `0011`, `0012` |
| `news_global_story_grouping` | **not in `release`**: `0013_news_global_story_grouping.sql` on `feat/news-global-story-grouping` (PR #165) |

So production = every migration in `release` **plus 0013**. The repository is not behind production for anything in `release`; production is
ahead by exactly one additive migration.

**Function-level parity (verified by byte comparison).** I built a throwaway local PostgreSQL 16 from the repository's own migrations
(`0001`, `0002_news`, `0008`-`0012`, applied as a non-superuser admin the way the repo's harness does), fingerprinted
`md5(prosrc)` for every news function in `web_api` and `pub_admin`, then applied 0013 from the PR #165 branch and fingerprinted again.
Compared with production:

| Function | prod vs release migrations | prod vs +0013 |
| --- | --- | --- |
| `pub_admin.news_apply_sync`, `news_health_snapshot`, `news_revision_batch` | match | match |
| `web_api.news_cards`, `news_entry`, `news_featured`, `news_list` | match | match |
| `pub_admin.news_link_stories`, `news_norm_text`, `web_api.news_stories`, `news_story_entry` | not in release | match |

**Eleven of eleven match; zero mismatches; no extra function in either direction.** That means no hand-edit or drift in these functions, and
the 0013 applied in production is the same SQL as on the PR #165 branch.

**Limits (not verified):** tables, columns, indexes, RLS policies, grants/ACLs, `cron.job` command bodies, vault secrets, and the
`private` schema contents were not compared. The repository's own CI (`scripts/news-sql-tests.sh`) covers those on an ephemeral database
but cannot see production. The 0013 migration states it is additive (new tables and functions; V1 functions keep their signatures and behaviour);
I confirmed the V1 signatures are still present in production, but I did not run its test suite.

## 6. Compatibility of the staged release with the production database

| Check | Result |
| --- | --- |
| Database calls that differ between the live and the staged build | only two, verified in the adapter diff: `news_list` becomes `web_api.news_cards(category, query, region, false, limit, offset)` and `news_featured` becomes `news_cards(null, '', null, true, limit, 0)`; `news_entry` is unchanged. `news_cards` and `news_entry` exist in production with the exact bodies the build was developed against (section 5), so the parity proof covers the whole changed contract |
| Functions the *live* build calls (`news_list`, `news_featured`, `news_entry`) | still present with V1 signatures in production, so rollback is DB-compatible |
| News pages, staged vs live, same database | `/news`, `/news?page=2`, `/`: identical entry links, identical order. `?category=bluepost&region=eu` / `us`: 12/12 EU / 12/12 US posts on both builds. `/news/rss.xml`: 30 items both, same first item. Entry detail: both 200 with the same H1 |
| Staged build, other pages | all internal links of both articles return 200 (24/24); nine class pages pass the runbook probe (icons present) |
| Trusted parity gate, deployment-bound (`dpl_J8R8…`, `--expect-sha cd5d352`) | success (GitHub run 41980365102) |
| Functional probe (`release-parity.mjs --probe`) of the staged deployment | exit 0, nine class pages PASS |
| Story grouping (0013) vs the staged web build | the staged build does not call `news_stories`; with zero members it would return the same cards as `news_cards` anyway. Dormant either way |

## 7. Operational health (production, read-only)

- Collector, last 24 h: 280 `normal` runs succeeded, **2 failed** (23:10 UTC on 4 Nov, one US and one EU, both `source_http_503` from the Blizzard source,
  recovered on the next run; latest success 06:20 UTC today). 12 `revision` runs succeeded (latest 06:00 UTC today).
- Cron: `azerdex-news-blueposts` `*/10`, `azerdex-news-official` `*/30`, `azerdex-news-revisions` `0 */6`, `azerdex-publish-observations` `*/15`, all active.
- Data: 768 news entries, 59 tracked topics.
- Not verified: that the 06:00 revision run checked a non-zero number of topics (the 0012 runbook's "real proof"); `news_health_snapshot()` output.

## 8. Blockers, risks and open items (ranked)

| # | Item | Severity | Owner action |
| --- | --- | --- | --- |
| 1 | No explicit owner approval to promote; promotion also ships V2 website code (G4) | **Gate** | Record approval, or promote after #165 |
| 2 | G2 monitoring functions missing in production | Medium (ops visibility, no website impact) | Apply `0018_news_health_monitoring.sql` per the V2 runbook (needs its own approval and a backup), or accept the gap in writing |
| 3 | `publishedAt` 2026-11-05 vs eventual promotion day | Low, but editorial | Step 2 of the plan |
| 4 | Free Supabase plan: no automatic backups or PITR. The G0 runbook requires an owner-made `pg_dump` before DB changes | Medium for #165 apply, G5 and G2; none for a web-only promotion | Take a dump before any of those |
| 5 | 0013 is applied while its code is unreleased | Low (dormant, tables empty) | Merge #165 on its own gates, or run `ops/news_v2_0013_rollback.sql` if abandoned |
| 6 | Schema parity only proven for functions (section 5 limits) | Low | Optional: run the repo's catalog/ACL checks read-only against production |
| 7 | Leftover `diag-db-host` Edge Function (ACTIVE, `verify_jwt=true`) on `azerdex-public-read` | Hygiene | Delete if no longer needed |
| 8 | A temporary Vercel share link for the staged deployment was used for acceptance and expires 2026-11-06 05:14 UTC; the connector cannot revoke it, and its secret appeared in this session's tool output | Low (public site content) | Revoke in Vercel if you want it gone sooner |
| 9 | Connector cannot list rollback candidates (HTTP 403) | Low | Confirm `dpl_3uxBg…` is promotable in the dashboard before promoting |
| 10 | `*.vercel.app` hosts add `X-Robots-Tag: noindex` themselves; the app's `index, follow` and apex canonical can only be fully checked on the apex | Expected | Re-check apex headers right after promotion |

## 9. Exact promotion plan (when, and only when, the owner approves)

1. **Approvals recorded:** G4 (news V2 website), and a decision on G2.
2. **If the promotion day is not 2026-11-05:** open a small PR to `release` that sets `publishedAt` in
   `web/content/blog/wow-forever-beginners-guide-2026.md` and `wow-forever-new-race-class-combinations.md` to the real day, and updates the
   date constant asserted in `web/tests/unit/launch-articles.test.ts`. After CI is green and it is merged, **a new staged deployment is created:
   run steps 3-4 against that one, not against `dpl_J8R8…`.** (Sitemap `lastmod` and the BlogPosting `datePublished` follow this field.)
3. **Re-run the gates on the exact deployment to be promoted:** Actions > "Release parity gate (trusted)" with `deployment=<dpl>` and
   `expect_sha=<release sha>`; then `node web/scripts/release-parity.mjs --probe <staged url> --share-env <var>` with a short-lived, deployment-scoped
   share link (revoke afterwards).
4. **Staged acceptance** as in section 6 (articles, hub, images byte-identical, links, news pages vs live, sitemap).
5. **Promote exactly that deployment** to `azerdex.com` and `www.azerdex.com` (Vercel dashboard "Promote", or `request_promote` with the project and
   deployment id). Keep `dpl_3uxBgrk7L4GZ44RqHd37LmgHvqfo` for rollback. Confirm both aliases mapped (`list_promote_aliases`).
6. **Live acceptance on the apex, all mandatory:**
   - `/blog`, both article URLs, `/sitemap.xml`, `/robots.txt`, `/news`, `/news/rss.xml`, `/guides/classes/mage` return 200; both articles are in the sitemap with
     the intended `lastmod`; the editorial sample is not.
   - Per article: canonical = apex URL; `<meta name="robots">` = `index, follow`; **no** `X-Robots-Tag: noindex` on the apex; `og:image` and `twitter:image`
     resolve (`image/webp`, 1200x630); hero and mobile images load; `BlogPosting` JSON-LD valid; alt text present.
   - Headers unchanged (CSP, HSTS, `X-ForeverDB-Deployment: production`); no new console or network errors; `beta.azerdex.com` and previews still `noindex`.
   - Mobile (390/320) and desktop (1440/1920) visual check.
7. **Watch for 30-60 minutes:** Vercel runtime errors and logs; `pub.news_sync_runs` (no new failures beyond upstream 5xx); the 06:00/12:00 UTC revision runs check
   topics (`topicChecks > 0`).

**Rollback plan.**

- **Web:** Vercel Instant Rollback, i.e. promote `dpl_3uxBgrk7L4GZ44RqHd37LmgHvqfo` again. No database action is needed: V1 `news_list`, `news_featured` and `news_entry`
  still exist with V1 signatures (verified), which is exactly why the V2 runbook calls this rollback compatible.
- **Articles only:** set `status: draft` in both files (one line each), PR, merge, promote the new staged build. Slower than rolling back, and it keeps the news V2 UI.
- **If #165 is merged later and then rolled back:** the runbook order is **website, then Edge Function, then database**; do not run `news_v2_rollback.sql` while a V2 website is live
  (it drops `web_api.news_cards`). 0013 has its own `ops/news_v2_0013_rollback.sql`.

## 10. What I did and did not do

Did: read repo runbooks and the migration files; read-only catalog queries and migration-ledger/edge-function listings on `azerdex-public-read`; read-only Vercel
deployment/alias reads; GETs of azerdex.com and of the staged deployment (through a temporary share link); built and discarded a local PostgreSQL 16 reference database;
dispatched the read-only deployment-bound parity gate (GitHub run 41980365102).

Did not: promote, redeploy or roll back anything; apply or roll back any migration; write to any production table; change Vercel or Supabase settings; run PR #165's tests;
compare tables/grants/RLS/cron bodies/vault; read environment variable values (the connector cannot).
