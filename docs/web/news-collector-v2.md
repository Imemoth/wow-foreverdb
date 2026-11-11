# AzerDex News Collector V2 — official-update coverage, thread cards, revision tracking and monitoring

Status: implemented on branch `fix/news-collector-v2-official-updates` (Draft PR against `release`). **Nothing in this document has been
deployed or applied to production.** Evidence gathered on **2026-11-03 ~13:50–14:30 UTC** with read-only access to the
`azerdex-public-read` Supabase project (`SELECT`/catalog queries and function-source read only) and unauthenticated reads of Blizzard's
public Tracker/forum/news endpoints.

Companion documents: [news-integration.md](news-integration.md) (V1 design, credential procedure — still valid for roles and secrets).

---

## 1. Why no new Blue Post appeared after 30 October

### 1.1 Pipeline health (read-only production checks) — the collector was NOT down

| Check | Finding | Verified how |
|---|---|---|
| `pg_cron` jobs | 3 News jobs exist and are active: `azerdex-news-blueposts` `*/10 * * * *`, `azerdex-news-official` `*/30 * * * *`, `azerdex-news-revisions` `0 */6 * * *` (+ the unrelated publisher job) | `cron.job` |
| Executions (7 d) | blueposts 1008 / official 336 / revisions 28 runs, **all `succeeded`**; last run 13:40 / 13:30 / 12:00 UTC | `cron.job_run_details` |
| HTTP reached the function; auth OK | 73 `pg_net` responses retained (07:50–13:45 UTC), **all HTTP 200**, no error/timeouts | `net._http_response` (retention is only ~6 h, so earlier HTTP codes are **unverified**; the next row covers them) |
| Function fetched + persisted | 1,178 EU / 1,183 US / 416 official `succeeded` sync runs in 8 d; `last_success_at` 13:40 (Tracker) / 13:30 (news) | `pub.news_sync_runs`, `pub.news_sources` |
| Failures | 7 failed runs in 8 d, **all `source_http_503` from Blizzard** (EU ×6 on Oct 27 17:10–18:10, US ×1 on Oct 30 16:40); all recovered on the next run | `pub.news_sync_runs` |
| Deployed code = repo | Edge Function `azerdex-news-collector` v3, ACTIVE, `verify_jwt=false`, updated 2026-10-23 09:01 UTC. Source read via the Supabase API and compared to `release` — no divergence found (visual comparison, not a hash) | function source |
| Persisted data → website | `/news` newest card is 30 Oct (the DB's newest published row). RSS and archive use the same read path. No hiding defect for rows that exist | `azerdex.com/news`, DB |

Not examined: Edge Function execution logs (`query_logs`) — the sync-run rows already prove each invocation reached the database.

### 1.2 Confirmed root causes

| # | Cause | Evidence |
|---|---|---|
| **A** | **Official staff *replies* are rejected at three independent layers.** The Oct 23 hotfix `c99d30f` (correctly) stopped player replies flooding the feed, but did it with the blunt predicate `post_number = 1` in (1) `parseBluepostFeed`, (2) `pub_admin.news_apply_sync` and (3) all three `web_api.news_*` readers. A Kaivax update posted as a *reply* in the long-lived Dev Notes thread can never reach News. | Code (`collector.ts:152`, `0010…sql:70`, `0010…sql:187`); DB: **zero** rows for US topic 2360696; EU topic 631316 has only #1–#6 — #7 (Oct 26), #8 (Oct 27), #9 (Nov 3) were never stored |
| **B** | **Revision coverage depends on the newest 20 Tracker posts, and on *openers*.** The revision allow-list is built only from `post_number = 1` entries present in the newest page. A topic whose recent activity is a reply never enters it, so its opener is never re-read. | EU opener `post:6391795` is stale since 22 Oct: stored title *"Updated 15 October"*, `modified_at` 2026-10-16; the live topic is *"Updated 3 November"*, post v6 edited 2026-11-03T03:21:37Z |
| **C** | **Tracker pagination never advances.** `?page=N` is ignored by Blizzard; `?offset=` too. Six consecutive pages are byte-identical (same md5) for both regions, so the documented "up to 10 pages" is in practice **one page of 20 posts** (V1's own doc noted "no usable next_page"). A burst of >20 posts between two runs silently loses posts. `?before=<created_at>` *does* paginate exactly (crawled 180 US / 140 EU posts back to mid-Sep, 0 duplicates). | live feed, md5 comparison |
| **D** | **Feed vs topic observations overwrite each other (hash flip-flop).** The Tracker excerpt (≈308 chars, `&hellip;`, `[Title]` prefix) and the topic excerpt (≈401 chars) differ, so every revision run "updates" ~12 rows and the next normal run flips them back (≈392 EU + 422 US "updates" in 8 d from 32 revision runs). Not a cause of missing posts, but it corrupts `updated_count`/audit signals. | version snapshots of `news_entries.id = 55416` |
| **E** | **No model for a thread-level "latest official update".** `published_at` is (rightly) frozen for Blueposts and ordering uses it, so even a stored reply could not surface its thread. `featured/importance` were also overwritten on every Official News revision. | schema/`0002`,`0010` |
| **F** | **No observability.** `last_success_at` moved on any completed run even when everything was rejected; there is no per-source last-attempt, last-official-post, error category or HTTP status; "fetched but could not persist" leaves no DB trace at all. | schema, `pub.news_sources` |

Also observed, not part of the outage: Official News `published_at` can be overwritten on upsert and pre-dated articles were visible days early
(`article:24302547` ingested Oct 26 with `published_at` Oct 28). V2 hides entries dated in the future (15-minute tolerance).

### 1.3 Source inactivity (confirmed) vs ingestion failure vs filtering

* **Confirmed source inactivity — new topic openers.** The newest Tracker *opener* is 2026-10-29T21:02Z (EU) / 21:00Z (US) ("Forever Goes Live Globally November 4!"). The Official News river's newest relevant article is 2026-10-30T17:01Z (`24316094`); the only later article is *"Hotfixes: October 30, 2026"* (Midnight, correctly rejected).
* **Confirmed ingestion/filter exclusion — the Nov 2–3 Dev Notes updates** (causes A and B).
* **Presentation:** no defect for existing rows (the page renders the DB faithfully).

## 2. Source → database reconciliation, 30 Oct – 3 Nov 2026 (inclusive)

Blizzard Tracker (US 180 / EU 140 posts crawled) contains **exactly two staff posts per region in the window**, plus edits of the Dev Notes openers:

| Region | Topic | Post # / ID | Author (forum user id, group) | Published (UTC) | Modified / version | In Tracker | V1 collector | In DB before | Relevant |
|---|---|---|---|---|---|---|---|---|---|
| US | 2360696 Dev Notes | #9 / 30732723 | Kaivax (3390, community-manager) | 2026-11-03 03:20:33 | — | yes | **dropped** (reply) | **no** | yes |
| US | 2360696 | #1 / 30185131 (opener, 2026-09-24 22:23:24) | Kaivax (3390) | 2026-09-24 | edited 2026-11-03 03:20:46, **v6** | no (older than window) | never ingested | **no** | yes |
| EU | 631316 Dev Notes | #9 / 6471288 | Kaivax (11548, community-manager) | 2026-11-03 03:21:28 | — | yes | **dropped** (reply) | **no** | yes |
| EU | 631316 | #1 / 6391795 (opener) | Kaivax (11548) | 2026-09-24 22:37:36 | edited 2026-11-03 03:21:37, **v6** | no | refresh missed (cause B) | **stale** ("Updated 15 October") | yes |
| US | 2382684 Midnight Hotfixes | #150 / 30694131 | Linxy (985596) | 2026-10-31 02:17:54 | — | yes | dropped (reply) | no | **no** (Midnight) |
| EU | 635623 Midnight Hotfixes | #31 / 6465846 | Linxy-376595 (376595) | 2026-10-31 02:17:35 | — | yes | dropped (reply) | no | **no** (Midnight) |

Also relevant **before** the window but dropped by the same defect: Dev Notes #7 (Oct 26) and #8 (Oct 27) in both regions. They are intentionally *not* resurrected by the window backfill (see §6).

Official News (US `river.frag`): in-window articles = `24316094` (Oct 30 17:01, ingested, published), `24313107` (Oct 30 17:00, Midnight, rejected), `24307310` (hotfixes, rejected). Nothing newer exists.
New topic openers in the window: **none**.

## 3. Staff verification rules (fail closed)

Authority never comes from a display name or username.

1. **Region-scoped identity.** A forum *numeric user id* plus an **allow-listed group** (`community-manager`, `api_users`, `wow-developer` — all observed in the real Tracker) observed **in that region's authoritative Blizzard Tracker feed** (`/groups/blizzard-tracker/posts.json`, a Blizzard-managed group). Persisted in `pub.news_verified_staff(source_key, user_id)`. A US id never authorises an EU post even if the number coincides (regions have different ids: Kaivax is 3390 US, 11548 EU).
2. **Post checks.** regular post (`post_type = 1`), not hidden/deleted, carries an allow-listed group, `staff` flag not `false` (topic JSON), complete metadata.
3. **Thread origin.** A reply is admitted only after its thread's opener has been resolved: opener authored by a verified identity ⇒ `official`; otherwise `community` (player-created). Unresolved ⇒ rejected (`origin_unverified`), never published.
   * `official` thread: the reply must be Forever-relevant (title **or** excerpt) and ≥ 40 characters.
   * `community` thread: the topic title is player-controlled text, so relevance must come from the **staff post's own excerpt**. The player opener is **never** ingested or promoted; the card is labelled *Staff reply*.
4. **Defence in depth at the persistence boundary** (`pub_admin.news_apply_sync`): a reply row is written only with `authorUserId` ∈ `pub.news_verified_staff` for that source **and** an allow-listed group **and** `threadOrigin`, status `published`. Otherwise it is counted as `skip_unverified_reply`. The read view `pub.news_card_entries` independently hides any reply lacking those columns — so legacy or manually inserted rows cannot leak.
5. **Not admitted:** player replies, conversational staff replies (<40 chars), staff replies in irrelevant threads (e.g. Midnight hotfixes), unknown groups, openers/replies with missing metadata. If source data cannot establish authority the post is dropped, never published.

Limits (documented, not hidden): Tracker membership is the trust anchor (Blizzard-managed, not cryptographically provable); the group allow-list is static (new Blizzard groups fail closed until a migration adds them).

## 4. Thread cards and chronology

* **One card per region/topic.** `web_api.news_cards` collapses a thread to its latest verified official post; `news_list`, `news_featured` (unchanged signatures/columns) delegate to it, so the homepage, archive, pagination, search, region filter, detail page and RSS agree.
* **Three separate timestamps.** `published_at` (original, immutable for forum posts) · `official_updated_at` (latest verified official edit/post; a meaningful edit = post version > 1 **and** > 5 min after posting) · `ingested_at` (never shown). Cards show *Updated D · first posted D0*; the card's "Official source" link targets the relevant Blizzard post.
* **Ordering** by latest verified official activity; ordinary replies never refresh a thread (they are never stored). `featured` / `importance` are never overwritten by ingestion; a thread is featured if any of its posts is.
* **Region filter, search, totals** are executed in the database (the previous client-side scan with a 5,000-row ceiling is gone). Search matches any verified update in the thread.
* **Future-dated** official articles are hidden until their time.

## 5. Revision tracking (persistent, bounded, rate-limited)

* `pub.news_tracked_topics` records every topic with a verified official post (seeded at migration time from existing openers, staggered 2 min apart). A topic stays tracked **independently of the Tracker window**.
* Tiers: active (<14 d since last official activity) every 6 h · warm (<90 d) every 24 h · dormant weekly. Oldest-due first, so nothing starves. Failures back off exponentially (6 h × 2ⁿ, max 48 h); HTTP 429 stops further topic fetches for the run and leaves the rest due (not failed).
* **Due-time tolerance (migration 0012).** The revision cron job fires at exactly `:00:00` every 6 h, but `next_check_at` is stamped with the apply time, seconds to minutes *after* that tick. With a strict `next_check_at <= now()` every topic therefore skipped one whole cycle (measured on 2026-11-04: the 12:00 run checked 27 US / 26 EU topics, the 18:00 run checked 0 and left 21 + 21 overdue). `pub_admin.news_revision_batch` now treats a topic as due when it falls due **within 15 minutes after the current moment**. Effect per tier (interval = whole number of 6 h cron periods in every case): active 6 h (was effectively 12 h), warm 24 h (was 30 h), dormant 7 d (was 7 d 6 h), failure back-off 12 / 24 / 48 h (was 18 / 30 / 54 h). The tolerance is 4 % of the shortest interval, so a topic is never pulled forward by a whole cycle; stored intervals are unchanged. Rollback of 0012 is function-only (`ops/news_v2_0012_rollback.sql`, exact 0011 body, refuses on drift; runbook `news-collector-v2-0012-runbook.md`). Invariant to keep when changing the cron schedule or the tiers: tolerance ≥ longest run duration and ≪ the shortest interval; every interval must stay a multiple of the cron period (asserted by `tests/news_v2_revision_schedule.sql`). The health snapshot's *overdue* threshold (12 h) is unchanged and now genuinely signals a missed cycle.
* Per-run bounds: ≤ 40 topic fetches (RPC cap 50), concurrency 3, 150 ms pacing, 90 s wall-clock budget, per-request retry with back-off (3 attempts; 4xx other than 408/429 are not retried).
* A revision refreshes the opener always, known replies (edit refresh via `official_post_ids`), and replies newer than the topic's recorded coverage — it never resurrects older history.
* Tracker pagination uses `before=<created_at>`; a stalled cursor or a window truncated by the page cap is reported as `partial` with a category (`pagination_stalled`, `window_truncated`) instead of failing silently.
* Feed observations can no longer overwrite richer topic observations (`observed_via` precedence); the content hash excludes the forum's volatile `updated_at`.

## 6. Migration and compatibility

`database/public-read/migrations/0011_news_collector_v2.sql` — one additive, idempotent migration (re-apply tested). It does **not** edit 0001–0010.

| Object | Change |
|---|---|
| `pub.news_entries` | + `source_version, author_user_id, author_group, thread_origin, official_updated_at, observed_via` (nullable) |
| `pub.news_sources` / `news_sync_runs` | + attempt/fetch/official-post freshness, HTTP status, error category, mode, inserted/skipped counts |
| new tables | `news_official_groups`, `news_verified_staff`, `news_tracked_topics` (RLS on, no grants) |
| new view | `pub.news_card_entries` (internal; no role has access) |
| replaced functions (same signatures) | `news_apply_sync`, `news_list`, `news_featured`, `news_entry` |
| new functions | `news_revision_batch` (ingest role only), `news_health_snapshot` (admin only), `web_api.news_cards` (reader) |

Backward compatibility (verified by tests, including the unchanged V1 SQL tests): the **deployed V1 collector and V1 website keep working** against the migrated database — V1 payloads (no provenance) are accepted for openers and rejected for replies exactly as before; `news_list/news_featured/news_entry` keep their columns. Therefore the safe order is **database → Edge Function → website**. Merging the PR does **not** apply the migration or deploy the Edge Function. One-time effect: the first V2 pass re-hashes the ~50 existing openers (provenance fields join the hash) → one extra version row each. No row or version is deleted; `suppressed_at` rows stay immutable (5 EU Dev Notes replies #2–#6 stay hidden, so EU's thread card shows 2 updates, not 7).

Security boundaries preserved: `azerdex_news_ingest` keeps `EXECUTE` on exactly two `pub_admin` RPCs (`news_apply_sync`, `news_revision_batch`) and no table/schema access beyond `pub_admin` usage; the website role has `EXECUTE` on bounded `web_api` functions only; no role can read any News table or the view; every function is `SECURITY DEFINER` with an empty `search_path`; new functions are explicitly revoked from `PUBLIC`.

## 7. Backfill (30 Oct 00:00 – 3 Nov 23:59:59.999 UTC) — prepared, NOT executed in production

Invocation of the Edge Function (`x-azerdex-news-secret` header; see §10 for secret handling):

```json
{ "mode": "backfill", "since": "2026-10-30T00:00:00Z", "until": "2026-11-03T23:59:59.999Z", "dryRun": true }
```

* **Default is a read-only preview**: only an explicit `"dryRun": false` writes, and it additionally requires the owner to set the server-side variable `AZERDEX_NEWS_BACKFILL_ENABLED=true` (otherwise HTTP 403 `backfill_apply_disabled`). Window ≤ 31 days. Bluepost sources only.
* The preview runs the real persistence logic with `dryRun` (no writes of any kind — verified: entry/version/run/staff/topic counts unchanged) and returns a per-entry action: `insert | update | unchanged | skip_suppressed | skip_unverified_reply | skip_feed_over_topic`, plus reject reasons.
* Scope: in-window verified staff posts **plus the thread opener** (original date + edits) of every thread with an in-window Forever-relevant staff post. No ordinary replies; older replies (Oct 26/27) are not resurrected; suppressed rows are skipped; idempotent (a second run is `inserted 0, updated 0`).

**Dry-run rehearsal (executed by me, locally)** — real V2 collector code, **live** Blizzard feeds, DB side = a local PostgreSQL 16 holding the production EU Dev Notes rows (6 rows copied by read-only `SELECT`, excerpts abbreviated) with migrations 0001–0011 applied, writing through the real RPCs as the least-privilege `azerdex_news_ingest` role:

| Step | US | EU |
|---|---|---|
| preview | insert `post:30732723` (#9), insert `post:30185131` (opener) · rejected: 1 `irrelevant` (Midnight hotfix reply) | insert `post:6471288` (#9), **update** `post:6391795` (stale opener) · rejected: 1 `irrelevant` |
| DB after preview | unchanged (6 entries, 0 runs) | |
| apply | inserted 2, updated 0 | inserted 1, updated 1 |
| re-apply | inserted 0, updated 0, skipped 2 | inserted 0, updated 0, skipped 2 |
| normal run afterwards | fetched 0 (nothing in the last 6 h) → *healthy, no new content* | same |
| result (as the web reader) | 1 card, post_date 2026-09-24, *updated 2026-11-03 03:20*, 2 updates, title "…Updated November 2" | 1 card, *updated 2026-11-03 03:21*, 2 updates, title "…Updated 3 November"; #2–#6 still suppressed |

`database/public-read/ops/news_v2_backfill_verify.sql` (read-only) lists the window inventory and asserts invariants (all must return zero rows): no visible reply without provenance, no reply by an unverified identity, no duplicate card per thread, no modified suppressed row, no moved `published_at`.

**The production dry-run itself requires the migration and the deployed function** (blocker: out of scope for this task). It must be run by the owner (§10 step 6).

## 8. Monitoring and alerting

New data (migration 0011): per source `last_attempt_at`, `last_fetch_ok_at`, `last_success_at`, `last_official_post_at`, `last_http_status`, `last_error_category`; per run `mode`, fetched/accepted/rejected, inserted/updated/skipped, `fetch_ok`, `error_category`, `http_status`, and reject reasons / deferred topics in `diagnostics`; per tracked topic last check, next check, failures.

`private.azerdex_news_health()` (ops script `0018_news_health_monitoring.sql`, read-only, counts/codes/timestamps only) classifies each source:

| State | Meaning | Severity |
|---|---|---|
| `healthy_no_new_content` | executing and fetching; Blizzard published nothing relevant | ok — **never an alert** |
| `all_rejected` | reachable, every fetched entry correctly rejected | info |
| `fetch_failing` | ≥ 3 consecutive failed runs, or last successful fetch older than 3 intervals | **critical** |
| `persistence_failing` | no recent run in the DB while the function answers HTTP 207 (fetched but not saved) | **critical** |
| `collector_stopped` | no run recorded for 3 intervals; cause is `scheduler_not_running`, `function_rejecting_requests` (401/403/404/5xx) or `no_run_recorded…` | **critical** |
| `display_gap` | published rows the website cannot show | warning |
| `revision_stale` | tracked topic overdue > 12 h (warning) / > 48 h (critical) | warning → critical |

Alert policy (no external service): `private.azerdex_news_assert_healthy()` raises only on **critical** states, so the optional job `azerdex-news-health` (`*/15 * * * *`, `0018_schedule_news_health_check.sql`) shows as **failed** in `cron.job_run_details` — the same pattern as the existing retention monitor (`retention_cleanup_monitoring.sql`).

| Signal | Threshold | Owner action |
|---|---|---|
| Job `azerdex-news-health` `failed` | one failed run | `select private.azerdex_news_health();` → act on the listed state/cause |
| `collector_stopped` / `scheduler_not_running` | blueposts > 30 min, official > 90 min without a run | check `cron.job` active + Vault secret; re-run `0017` |
| `function_rejecting_requests` | repeated 401/403 | rotate/verify `azerdex_news_collector_secret` ↔ `AZERDEX_NEWS_COLLECTOR_SECRET`; 404 → function redeploy |
| `fetch_failing` | 3 consecutive (≈30 min for the Tracker) | check Blizzard status/IP blocks (`last_error_category`, HTTP status); transient 503 pairs do not alert |
| `persistence_failing` | any | check `NEWS_DATABASE_URL`/role password and the `pub_admin` RPC grants |
| `revision_stale` | 12 h warn / 48 h critical | check 429s and `deferredTopics` in the last revision run |
| quiet period | > 7 days without an official post | informational only |

## 9. Tests

| Layer | Where | Covers |
|---|---|---|
| Collector unit (41) | `web/tests/unit/news-collector.test.ts` | new opener; staff reply in official thread (origin by feed and by topic fetch); staff reply in player topic; player replies; spoofed names/ids/groups/staff flag/hidden; edits + grace period + re-bake; multiple updates per thread; US/EU isolation; old topic + fresh reply; missing/invalid metadata; cursor pagination, stalled cursor, truncation; retry/back-off, 4xx no-retry, timeout/network categories; persistence failure; partial runs; 429; revision of topics outside the Tracker window; known-reply edit refresh without resurrection; batch limit; idempotency; backfill window/dry-run/apply gating |
| Card contract (13) | `web/tests/unit/news-cards.test.ts` | thread collapse, fail-closed visibility, ordering, edit vs original date, regions, search, featured preservation, suppression/future-dated, detail |
| SQL (`scripts/news-sql-tests.sh`, now in CI) | `database/public-read/tests/news_v2_behavior.sql` (16 scenarios) `news_v2_security.sql`, `news_bluepost_dedup_security.sql` *(rewritten from string-position checks to provenance assertions)*, `news_model_*`, `news_bluepost_dedup`, `news_ingest_role_security`, `news_health_monitoring` | provenance, region boundary, edits, idempotency, suppression immutability, invalid payloads, dry-run, revision RPC, back-off, health states, roles/grants/ACL probes, rollback round-trip with data, migration applied as a **non-superuser** admin and re-applied |
| E2E (21, News spec) | `web/tests/e2e/news.spec.ts` | archive, thread card + labels, spoofed/unverified replies absent, staff reply in player topic, search, filters, pagination, RSS, detail, 7 viewports |
| Type/lint | `tsc`, `eslint`, `deno check` (new CI step) | |

## 10. Deployment sequence, owner gates and rollback

Merging the PR does **not** apply the migration or deploy the Edge Function; Vercel builds the website from `release`. **Gate G0: do not merge until step 2 (database) is done**, otherwise the new website queries `web_api.news_cards` before it exists (it would show the "temporarily unavailable" state; the homepage falls back to an empty section).

| # | Step | Owner gate | Verify | Rollback |
|---|---|---|---|---|
| 1 | Record "before": run `news_v2_backfill_verify.sql` and keep the output; confirm a recent Supabase backup/PITR point | – | counters saved | – |
| 2 | **Apply migration 0011** (additive). Run `news_v2_security.sql` + `news_v2_behavior.sql` (self-rolling-back) and `news_ingest_role_security.sql` over `NEWS_DATABASE_URL` | **G1** | tests print PASS; `web_api.news_cards(null,'',null,false,12,0)` as the reader returns the same cards as before; V1 collector/website still fine (wait one 10-min run) | `database/public-read/ops/news_v2_rollback.sql` (restores 0010 functions, drops only V2-only functions/view, **keeps every row**) |
| 3 | Apply `database/ops/0018_news_health_monitoring.sql` (functions only) | G2 | `select private.azerdex_news_health();` (sources show `last_attempt_at` within ~10 min) | drop the two `private.azerdex_news_*` functions |
| 4 | **Deploy the Edge Function** `azerdex-news-collector` (same secrets; `--no-verify-jwt` as today). Do **not** set `AZERDEX_NEWS_BACKFILL_ENABLED` | **G3** | manual `{"sourceKeys":["blizzard-bluepost-us"],"mode":"normal"}` ×2: second call `inserted 0, updated 0`; HTTP 200; health shows no critical | redeploy the previous function source (git `release` before this PR, function v3) |
| 5 | **Merge PR → website deploy** | **G4** | `/news`, `/`, `/news/rss.xml`, `/news/entry/<slug>` render; region filter and pagination work | Vercel "promote previous deployment" (compatible: DB keeps V1 signatures) |
| 6 | **Backfill**: (a) dry-run (§7) and compare with §2/§7 expectations; (b) **explicit owner approval G5**; (c) set `AZERDEX_NEWS_BACKFILL_ENABLED=true`, run with `"dryRun": false`, then **unset the variable**; (d) run `news_v2_backfill_verify.sql` — all invariants must be zero rows | **G5** | the Dev Notes cards for US and EU show *updated 3 Nov*; idempotent re-run | additive; to hide, run `news_v2_rollback.sql` (replies become invisible again; nothing deleted) |
| 7 | Optional: `0018_schedule_news_health_check.sql` | G6 | job appears in `cron.job` | `0018_unschedule_news_health_check.sql` |

**Rollback order and limits (measured, see [the G0 runbook](news-collector-v2-g0-runbook.md) §10).** `ops/news_v2_rollback.sql` restores the exact 0010 function bodies and ACLs and keeps every row. With only V1 code deployed it is safe. After the V2 website is deployed it **breaks the news pages** (`web_api.news_cards` is dropped): roll back **website → Edge Function → database**. A V2 backfill against a rolled-back database used to *write* despite `dryRun` (the 0010 apply ignores it); the Edge Function now refuses any backfill unless the V2 schema answers (`preflight`).

No cron schedule or secret is changed by this PR. Optional follow-up for the owner (gate G7): `net.http_post(timeout_milliseconds := 15000)` in `0017` may time out the client side of a large revision batch (the function still completes; pg_net just records a timeout) — consider 60000 for the revision job only.

Secret handling: use the same protected-prompt procedure as [news-integration.md](news-integration.md#operator-credential-procedure); never paste the collector secret into shell history, SQL, GitHub or chat.

## 11. Remaining risks

* **Reply volume.** Using the real Tracker history (45 days) as an **upper bound** (treating every thread as official): ≈ 23 US / 14 EU replies would pass the relevance+length screens, i.e. ≈ 3.6 and 2.1 per week, mostly the Dev Notes / Known Issues threads, collapsed into one card per thread. A few conversational replies by community managers in Forever threads (e.g. *Testing WoW Forever Today* #131) would bump a thread. No per-thread cooldown is implemented; if noisy, add one (the data is already in `official_updated_at`).
* Topic JSON exposes only the first ~20 posts of a topic; edits to replies beyond post 20 are not refreshed (new replies still arrive through the feed).
* Edit detection assumes Discourse `version`/`updated_at` semantics and a 5-minute grace period.
* Static group allow-list; Tracker-membership trust anchor (§3).
* `before=` is a Discourse parameter, not a Blizzard contract — a regression is detected (`pagination_stalled`) rather than prevented.
* The migration was validated on PostgreSQL 16 with Supabase stand-ins; the hosted project has not been touched. The production dry-run and post-deploy checks are owner steps.
* First V2 pass produces one extra version row for ~50 existing openers (expected).
