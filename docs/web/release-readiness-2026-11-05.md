# Production-readiness assessment: promoting `release` (cd5d352) to azerdex.com

> **Historical document.** Written before G2 and before promotion. Since then the owner applied G2 (18:44 UTC) and promoted
> `dpl_J8R8dVe7TonQSADZ86qwWVZ68ZEU` to azerdex.com; G4 was re-audited and is complete. Statements below such as "G2 not applied" or
> "staged, not promoted" describe the state at the time of writing. Current state and the G5/G6 checkpoints:
> `g4-g5-g6-execution-log-2026-11-05.md`.

Date: 2026-11-05 (evidence gathered 05:20-07:30 UTC; **revised at ~07:30 UTC** after the owner's decision to complete G2 before granting G4, and after a corrected read of the story overrides, section 4a). Scope: **assessment only.** Nothing in production was changed to produce it:
no promotion, redeploy, migration, data write or setting change. Production was read through catalog and `SELECT` queries on
`azerdex-public-read`, Vercel read APIs, public GETs of azerdex.com and GETs of the staged deployment.

**Decision needed from the owner: promotion of the staged build requires separate, explicit owner approval.** This document is the
input for that decision.

## 1. Decision summary (GO / NO-GO)

Owner decision of record (2026-11-05): **complete G2 before granting G4. Nothing is promoted, and G2 is not applied without separate explicit approval.**

| Decision | Verdict | Why |
| --- | --- | --- |
| **G2** database health monitoring (`0018`) | **NO-GO today; technically ready** | One blocker: **no usable, independently stored backup can be verified** (free plan: no automatic backups or PITR; no recorded dump; I have no credentials to make or inspect one). Everything else passes: project identity, privileges, extensions, no side effects, checksum recorded, rollback rehearsed, exact expected results known (section 10). **Becomes GO when the operator makes and verifies a dump (section 10.2) and the owner approves G2 separately.** |
| **G4** website promotion of `dpl_J8R8dVe7TonQSADZ86qwWVZ68ZEU` | **Technically GO, procedurally NO-GO** | Technical evidence is clean (sections 5, 6, 11). Procedurally it waits for the owner's explicit G4 approval, which the owner has sequenced after G2. Also decide the promotion day (`publishedAt`, section 9 step 2). |
| **Rollback plan** | **GO** | `dpl_3uxBgrk7L4GZ44RqHd37LmgHvqfo` is READY, still serves azerdex.com, and is flagged `isRollbackCandidate: true`; V1 database functions are intact, so a web rollback needs no database action (section 9). |

What changed since the first version of this document, read-only:

1. **Story overrides: 4 rows, not 0.** The owner inserted them at 06:25:06 UTC, after my first read. They are inert for the live and staged site (section 4a).
2. **G2 prepared in full** (section 10), including a rehearsal on a throwaway local database.
3. **Operational readiness re-checked** (section 11): collector healthy, revision runs checking topics, parity re-verified, share link still active (recommend revoking now).

**Recommended order:** (1) operator takes and verifies the backup; (2) owner approves G2; (3) G2 is applied and verified, then stop; (4) owner decides the promotion day and grants G4 separately; (5) promote, verify, watch. Keep PR #165 and the G5 backfill out of this release.

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
| 0013 (PR #165) | `news_global_story_grouping` | **Applied before its code merge; no linking performed** | ledger `20261105052509`; `pub.news_story_members` = 0 rows (nothing linked); `pub.news_story_overrides` = **4 rows**, inserted by the owner at 2026-11-05 06:25:06 UTC (section 4a) |

The runbook orders the website deploy (G4) **before** the backfill (G5), so the missing backfill does not block promotion; it only means
historical staff replies are absent until it runs.

### 4a. Story overrides (corrected and verified read-only, 07:03 UTC)

**Correction.** My first version said both story tables were empty. That was true when I read it (before 06:25 UTC) and is wrong now:

| | First version | Now |
| --- | --- | --- |
| `pub.news_story_overrides` | 0 rows | **4 rows** (3 `allow`, 1 `deny`), all `decided_by = owner (Imemoth)`, all `decided_at = 2026-11-05 06:25:06.806750 UTC` (one transaction) |
| `pub.news_story_members` | 0 rows | **0 rows**: no story linking has been performed |

The four rows match the owner decision file `docs/web/evidence/news-story-decisions-2026-11-04.json` (on the PR #165 branch) pair for pair:

| Decision | EU thread | US thread | Story |
| --- | --- | --- | --- |
| allow | `eu:topic:631316` | `us:topic:2360696` | WoW Forever Beta Development Notes |
| allow | `eu:topic:637043` | `us:topic:2389565` | Podcast Episode 5, End of Beta Special |
| allow | `eu:topic:638462` | `us:topic:2395799` | Podcast Episode 6, All About Tech |
| deny | `eu:topic:637055` | `us:topic:2389633` | The Beta Celebration is Underway |

**Do they affect the live or the staged website? No.** Verified:

- Only one function in production reads `pub.news_story_overrides`: `pub_admin.news_link_stories(boolean)`, the on-demand writer that nothing calls automatically. The web-facing `web_api.news_stories` and `news_story_entry` read `news_story_members` only, and the V1 functions (`news_cards`, `news_list`, `news_featured`, `news_entry`) read neither.
- Both tables have RLS enabled and are owner-only (`foreverdb_pub_owner`); `foreverdb_web_reader`, `anon`, `authenticated` and `azerdex_news_ingest` have no `SELECT`.
- The staged web build does not call `news_stories` at all (its only changed database calls are `news_cards`, section 6), and the live build calls only the V1 functions.
- All eight threads exist in `pub.news_entries` (10/2, 3/20, 11/20, 1/1 rows), and the stored rows satisfy the table constraints by construction.

**What would change them:** only a call to `pub_admin.news_link_stories(true)`, which would create `news_story_members` rows. That is story linking, so I did **not** run it, nor its dry-run form (`false`). When the owner runs the dry-run later, the expected plan is: the three `allow` pairs merge, the `deny` pair stays two cards.

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

**Eleven of eleven match on `md5(prosrc)`; zero mismatches; no extra function in either direction.** Re-verified with a fresh production read at ~07:25 UTC: unchanged. (One note on method: `news_norm_text` shows `length` 182 in production and 194 in my local database with an identical md5. The body contains six non-ASCII characters, which `length()` counts as characters in production's UTF-8 database and as bytes in my throwaway cluster. Identical md5 means identical bytes, so `md5` is the authoritative comparison.) That means no hand-edit or drift in these functions, and
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

## 7. Operational health (production, read-only; re-checked 07:00-07:30 UTC)

- **Sources** (`pub_admin.news_health_snapshot()`, 07:05 UTC): all three sources last attempted at 07:00 UTC with a successful fetch, `consecutiveFailures` 0, `overdueTopics` 0, published = visible (no display gap), no future-dated rows.
  Tracked topics: 28 (EU Blue Posts), 31 (US Blue Posts), 0 (US Official News).
- **Cron** (7 days): `azerdex-news-blueposts` 1008 runs, `azerdex-news-official` 336, `azerdex-news-revisions` 28, **all `succeeded`, none failed**; latest 07:00 UTC (revisions 06:00 UTC). `azerdex-publish-observations` active.
- **`pg_net`** (last 2 h): 25 responses OK, 0 partial, 0 bad.
- **Collector runs, 24 h:** 280 `normal` succeeded, 2 failed (23:10 UTC on 4 Nov, one US and one EU, both `source_http_503` from the Blizzard source; recovered on the next run); 12 `revision` succeeded.
- **Revision runs with real topic checks (the 0012 "real proof"):** the diagnostics field is `topicFetches`.

| Revision run (UTC) | US topics | EU topics | Deferred |
| --- | --- | --- | --- |
| 12:00 on 4 Nov (before 0012) | 27 | 26 | 0 |
| **18:00 on 4 Nov (the skip-a-cycle defect)** | **0** | **0** | 0 |
| 00:00 on 5 Nov (after 0012, applied 22:13) | 22 | 21 | 0 |
| **06:00 on 5 Nov** | **23** | **21** | 0 |

Verdict: the fix works. Both runs after 0012 checked topics, versus zero at 18:00 before it, and nothing was left deferred.

## 8. Blockers, risks and open items (ranked)

| # | Item | Severity | Owner action |
| --- | --- | --- | --- |
| 1 | No explicit owner approval to promote; promotion also ships V2 website code (G4) | **Gate** | Record approval, or promote after #165 |
| 2 | G2 monitoring functions missing in production | Medium (ops visibility, no website impact) | Owner has chosen to complete G2 first. Prepared and rehearsed (section 10); blocked only by the missing verifiable backup and by separate approval |
| 3 | `publishedAt` 2026-11-05 vs eventual promotion day | Low, but editorial | Step 2 of the plan |
| 4 | **Free Supabase plan (organization `Hearth & Byte`): no automatic backups or PITR; no Supabase branches; no recorded dump** | **Blocks G2** (and any later DB operation); none for a web-only promotion | Operator makes and verifies a dump (section 10.2) |
| 5 | 0013 is applied and 4 owner overrides are stored, while its code (PR #165) is unreleased | Low (inert: nothing links stories, section 4a) | Merge #165 on its own gates, or run `ops/news_v2_0013_rollback.sql` if abandoned (that drops the story tables, including the 4 override rows, so keep the decision file) |
| 6 | Schema parity only proven for functions (section 5 limits), plus the `private`-schema ACL and extension/privilege facts in section 10 | Low | Optional: run the repo's catalog/ACL checks read-only against production |
| 7 | Leftover `diag-db-host` Edge Function (ACTIVE, `verify_jwt=true`) on `azerdex-public-read` | Hygiene | Delete if no longer needed |
| 8 | The temporary Vercel share link for the staged deployment is **still active** (verified 07:25 UTC: the deployment redirects to SSO without it and serves pages with it); expires 2026-11-06 05:14 UTC; the connector cannot revoke it; its secret appeared in this session's tool output. It is deployment-scoped (it does not open the previous production deployment) | Low (public site content) | **Recommend revoking now** in Vercel (deployment `dpl_J8R8dVe7…` > shareable links, or `PATCH /aliases/{deploymentId}/protection-bypass` with `revoke`), then confirm the old secret redirects to SSO |
| 9 | The connector cannot filter by `rollbackCandidate` (HTTP 403), but the ordinary listing shows `dpl_3uxBg…` as READY and `isRollbackCandidate: true`; promotion itself cannot be tested without doing it | Low | Confirm once more in the dashboard right before promoting |
| 10 | `*.vercel.app` hosts add `X-Robots-Tag: noindex` themselves; the app's `index, follow` and apex canonical can only be fully checked on the apex | Expected | Re-check apex headers right after promotion |

## 9. Exact promotion plan (when, and only when, the owner approves)

1. **Approvals and prerequisites:** per the owner's decision, **G2 is completed first** (verified backup, separate G2 approval, applied and verified per section 10.6), and only then an explicit, separate **G4** approval (news V2 website). G2 approval is not G4 approval.
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

## 10. G2 preparation (prepared, **NOT applied**)

Source: `database/ops/0018_news_health_monitoring.sql` on `release` (`cd5d352`), 158 lines.
**SHA-256 `b94f04e04578564e21d4afab9ff4d99aec76342f501a24de327766743cffc79f`** (git blob `288e5adc5e75d428dd10ef0958dac6d6df685aa2`). If the file differs at apply time, stop.

### 10.1 What it does, and the prerequisite checks (all read-only, 07:00-07:25 UTC)

One transaction: `create schema if not exists private`; `revoke all on schema private from public, anon, authenticated`; create two `SECURITY DEFINER` functions (`private.azerdex_news_health()`, `private.azerdex_news_assert_healthy()`) with `search_path = pg_catalog`; revoke execute from `public, anon, authenticated`; grant execute to `postgres`. **No table, row, cron job, secret, Edge Function or existing function is touched.** It does not schedule anything (that is the separate `0018_schedule_news_health_check.sql`, gate G6).

| Prerequisite | Result |
| --- | --- |
| Exact project | ref `chcoypkjzxfznsqmmbrq`, name `azerdex-public-read`, eu-west-1, `ACTIVE_HEALTHY`, PostgreSQL 17.11, run as `postgres`; `pub.news_sources` = 3 (`blizzard-bluepost-eu`, `blizzard-bluepost-us`, `blizzard-news-us`). **Not** the private project `wow-forever` (`klxhikdlfwgxurdyexdi`) |
| `private` schema today | owner `postgres`, ACL `{postgres=UC/postgres}`: **already owner-only, so the `create schema if not exists` and the `revoke` are no-ops**. No default ACLs for it. Existing objects: table `azerdex_news_settings` (ACL `{postgres=arwdDxtm/postgres}`) and function `azerdex_news_schedule_request(text[],text)` (ACL `{postgres=X/postgres}`), both untouched |
| Collision | neither new function exists (`private` has exactly 1 function) |
| Extensions | `pg_cron` 1.6.4, `pg_net` 0.20.4, `supabase_vault` 0.3.1, `pgcrypto` 1.3 |
| Objects the functions read | `net._http_response(created, status_code, timed_out)`, `cron.job`, `cron.job_run_details(jobid, status, start_time)` all exist |
| Permissions of the executing owner (`postgres`, `bypassrls`, not superuser) | `EXECUTE` on `pub_admin.news_health_snapshot()`; `SELECT` on the three tables above; `USAGE` on `private`, `pub_admin`, `net`, `cron` |
| Wrapped function is read-only | `news_health_snapshot()` is `STABLE`, `SECURITY DEFINER`, no write statement in its body; unchanged fingerprint `2c9aec7f95ca54a4fbe0abb74f602779` |
| Side effects | none beyond the two new functions (above) |

### 10.2 Backup: **missing / cannot be verified. This is the blocker. Operator action required.**

- The organization `Hearth & Byte` is on the **free plan**: no automatic daily backups, no point-in-time recovery. There are no Supabase development branches. Nothing in the repository records an owner-made dump (the V2 G0 runbook only contains the instruction). I have no database credentials in this session, so I can neither create a dump nor inspect one stored elsewhere.
- Why the risk is still low: `0018` writes no data and only adds two functions, and its rollback is two `DROP`s. The backup protects against what no script can (an unforeseen platform fault), and you asked for it as a precondition.
- **What the operator must do (about 5 minutes), then record it on PR #167:**
  1. Make a dump with the password entered at the prompt (never in a command line, chat, GitHub or shell history):
     `pg_dump "host=db.chcoypkjzxfznsqmmbrq.supabase.co port=5432 dbname=postgres user=postgres sslmode=require" -W --no-owner --format=custom --schema=pub --schema=pub_admin --schema=web_api --schema=private -f g2-before-$(date -u +%Y%m%dT%H%M%SZ).dump`
     (if the direct host is IPv6-only from your network, use the project's pooler connection string instead).
  2. Store it **outside the repository, encrypted, in at least one location other than the machine that made it.**
  3. Verify it is usable: `pg_restore --list <file>` lists the four schemas; restore it into an empty scratch PostgreSQL and compare counts with production at dump time (record them): `pub.news_entries` (768 at 07:03 UTC, it grows), `pub.news_tracked_topics` (59), `pub.news_story_overrides` (4), `pub.news_story_members` (0).
  4. Record: file name, size, **SHA-256**, UTC timestamp of the dump, storage locations, scratch-restore counts, who did it.
  5. Optionally also save `select * from cron.job` (names and schedules only; **not** the `command` column) and the migration ledger listing (15 entries, latest `20261105052509`).
- Alternative: upgrade the project plan so that daily backups exist. That is an owner decision and is not required for a functions-only change.

### 10.3 Baseline recorded before any write (production, 07:10 UTC)

| Item | Value |
| --- | --- |
| Functions in `pub`, `pub_admin`, `web_api` | 33; fingerprint `d46109d57106b5ec58bccad81ec8bd0d` (`md5(string_agg(oid::regprocedure || md5(prosrc || coalesce(proacl::text,'')), ';' order by ...))`) |
| Functions in `private` | 1 (`azerdex_news_schedule_request`); fingerprint `ee07b3ca5c469a3932ae91a06e7c315f` |
| `private` schema ACL | `{postgres=UC/postgres}` |
| Cron jobs | 4: `azerdex-news-blueposts */10`, `azerdex-news-official */30`, `azerdex-news-revisions 0 */6`, `azerdex-publish-observations */15`, all active |
| Migration ledger | 15 entries, latest `20261105052509 news_global_story_grouping` |

Re-record these immediately before applying; they only change if someone else changes production in between.

### 10.4 Exact expected results after applying `0018`

Obtained by rehearsing the verbatim file (checksum above) on a throwaway local PostgreSQL 16 built from migrations `0001`-`0012`, as the cluster superuser so the owner is `postgres` as in production. The repository's own test `database/public-read/tests/news_health_monitoring.sql` also passes there.

| Check | Expected |
| --- | --- |
| `private.azerdex_news_health()` | exists; `SECURITY DEFINER`; `STABLE`; owner `postgres`; `proconfig = {search_path=pg_catalog}`; ACL `{postgres=X/postgres}`; returns `jsonb`; `md5(prosrc)` **`f3c71a141583f45599aed3f03df7aaea`**, body length 6071 chars |
| `private.azerdex_news_assert_healthy()` | exists; `SECURITY DEFINER`; volatile; owner `postgres`; same config and ACL; returns `void`; `md5(prosrc)` **`c4715b2248888dba17026dff94f77e3d`**, 481 chars |
| Who can execute | only `postgres`. `anon`, `authenticated`, `service_role`, `foreverdb_web_reader`, `azerdex_news_ingest`, `foreverdb_publisher` all false |
| Everything else | `private` schema ACL still `{postgres=UC/postgres}`; `azerdex_news_schedule_request` and `azerdex_news_settings` unchanged; **functions in `pub`/`pub_admin`/`web_api` byte-identical (fingerprint equals the baseline above)**; cron jobs unchanged (still 4, same schedules); **no row changed in any table** |
| Ledger | +1 entry if applied through `apply_migration` (recommended name `news_health_monitoring`, for an audit trail like 0011-0013); none if applied through the SQL editor. State which was used |
| Functional, read-only | `select private.azerdex_news_health()`: `overall` = **`ok`**; three sources each `state: healthy_no_new_content`, `severity: ok`, `causes: []`; `netLast2h` about `{ok: 25, partial207: 0, bad: 0, lastBadStatus: null}`. `select private.azerdex_news_assert_healthy()` returns without error. (Derived by applying the function's rules to the live 07:05 UTC snapshot: every source attempted within `3 x` its interval, fetch OK, 0 consecutive failures, accepted > 0, no display gap, 0 overdue topics. It changes only if the collector degrades.) |

### 10.5 Rollback (rehearsed locally)

```sql
begin;
drop function private.azerdex_news_assert_healthy();
drop function private.azerdex_news_health();
commit;
```

Rehearsed: after the drops, the `private` function count returns to its pre-apply value, the fingerprint of every other function is identical to before and after `0018`, the schema ACL is unchanged, and re-applying `0018` works (the script is idempotent). Because `0018` changes nothing else, this restores the exact prior state. Caveats: (a) if it was applied through `apply_migration`, the ledger entry remains as history and should be annotated, not deleted; (b) do the rollback **before** anyone applies `0018_schedule_news_health_check.sql` (not part of G2), otherwise unschedule it first with `0018_unschedule_news_health_check.sql`. No dump restore is needed or intended for this rollback.

### 10.6 Procedure once approved (do not start before then)

1. Operator backup recorded and accepted (10.2); **separate explicit owner approval for G2**; G4 is not implied.
2. Re-record the baseline (10.3); confirm the project ref (10.1) and the SHA-256; confirm the two functions are still absent.
3. Apply the file verbatim in one transaction.
4. Verify every row of 10.4. Any deviation: run the rollback (10.5) and stop.
5. Stop. Do not schedule the health check (G6), and do not promote.

## 11. Final operational readiness (read-only, 07:00-07:30 UTC)

| Check | Result |
| --- | --- |
| Collector execution health | Healthy (section 7) |
| Revision runs with topic checks > 0 | Yes: 23 US / 21 EU at 06:00 UTC, 22 / 21 at 00:00 UTC (section 7) |
| Production function and migration parity | 11/11 news functions identical on md5 to the repository migrations (+ 0013); ledger unchanged since 05:25 UTC (15 entries); cron unchanged (section 5, 10.3) |
| Compatibility with the 4 stored overrides | Inert for live and staged site; threads exist; RLS/ACL owner-only; only `news_link_stories` reads them (section 4a). The dry-run of that function was deliberately not run |
| Previous production deployment as rollback target | `dpl_3uxBgrk7L4GZ44RqHd37LmgHvqfo`: READY, commit `198004266b98aa40a515a1c12e88a5209bd3de73` (PR #149), serves azerdex.com, `isRollbackCandidate: true` |
| Staged deployment identity | `dpl_J8R8dVe7TonQSADZ86qwWVZ68ZEU`, READY, target production, commit `cd5d35277efe664637db8bb9611bc0e1c2d95710` (= `release` head), not aliased to azerdex.com |
| azerdex.com | still `dpl_3uxBg…` (alias `updatedAt` unchanged since 2 Nov); articles still 404 there |
| Share link | **Still active** for the staged deployment (deployment-scoped); **recommend revoking now** (risk 8) |
| Open items not touched | PR #165 not merged; G5 backfill not run; no story linking; no further migration |

## 12. Gate summary

| Gate | Status | Next action |
| --- | --- | --- |
| G2 (`0018`) | Prepared and rehearsed; **blocked on a verifiable backup**; needs separate approval | Operator backup (10.2), then owner approval |
| G4 (promotion) | Technically ready; **not approved**; owner sequenced it after G2 | Explicit owner approval, after G2 and the `publishedAt` decision |
| G5 (backfill) | Not run; out of scope for this release | None |
| #165 / story linking | Not merged; nothing linked | Separate gates |
| Rollback | Ready | Re-confirm in the dashboard right before promoting |

## 13. What I did and did not do

Did: read repo runbooks and the migration files (including `0018`); read-only catalog queries and migration-ledger/edge-function listings on `azerdex-public-read`; read-only Vercel
deployment/alias reads; GETs of azerdex.com and of the staged deployment (through a temporary share link); built and discarded a local PostgreSQL 16 reference database;
dispatched the read-only deployment-bound parity gate (GitHub run 41980365102).

Did not: promote, redeploy or roll back anything; apply or roll back any migration; write to any production table; change Vercel or Supabase settings; run PR #165's tests;
compare tables/grants/RLS/cron bodies/vault; read environment variable values (the connector cannot); create, inspect or restore any backup; run `news_link_stories` (even its dry-run); apply `0018` or any other SQL write. The G2 rehearsal ran only on a throwaway local PostgreSQL 16 that has been deleted.
