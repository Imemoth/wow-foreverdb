# News Collector V2 — G4 / G5 / G6 execution log (2026-11-05)

Status (final, 20:45 UTC): **G4 COMPLETE (accepted). G5 SKIPPED – ACCEPTED HISTORICAL GAP (owner decision, §9). G6 COMPLETE (§7).** Nothing in production was changed except the single owner-approved G6 cron job.
This log supersedes the stale parts of `release-readiness-2026-11-05.md` (written before G2 and before promotion).
No production write was made while producing it: every database call below was a read-only `SELECT`; every web call was a `GET`.

## 0. Baseline reconciliation (all times UTC, 2026-11-05)

| Item | Readiness doc (historical) | Verified now |
| --- | --- | --- |
| Production deployment | staged, not aliased | `dpl_J8R8dVe7TonQSADZ86qwWVZ68ZEU`, READY, `release` @ `cd5d352`; `azerdex.com` and `www` aliases `completed` |
| Rollback target | `dpl_3uxBgrk7L4GZ44RqHd37LmgHvqfo` | still `isRollbackCandidate: true` (it is the pre-V2 site, `release` @ `1980042`) |
| G2 (`0018` monitoring) | not applied | applied 18:44:17 (`20261105184417 news_health_monitoring`) |
| Story overrides / members | 4 / 0 | 4 / 0 (unchanged) |
| Backup | none | owner's four-schema dump (see §4); off-machine copy **not confirmed** |

G2 re-verification (19:06–19:26): `private.azerdex_news_health()` md5 `f3c71a141583f45599aed3f03df7aaea`, `private.azerdex_news_assert_healthy()` md5 `c4715b2248888dba17026dff94f77e3d`, both `SECURITY DEFINER`, owner `postgres`, ACL `{postgres=X/postgres}`, `search_path=pg_catalog`. The 33-function fingerprint is `d46109d57106b5ec58bccad81ec8bd0d` (unchanged). Health at 19:06: `overall: ok`, three sources `healthy_no_new_content`, 0 consecutive failures, 0 overdue topics. `select private.azerdex_news_assert_healthy()` at 19:25:36 returned without raising.

## 1. G4 — production acceptance audit: **COMPLETE** (19:08–19:30)

| # | Check | Result |
| --- | --- | --- |
| 1 | `/`, `/news`, `/news/rss.xml`, `/blog`, both articles, `/sitemap.xml`, `/robots.txt` | all 200 |
| 2 | News contract: `category=bluepost` (12/page), `&region=eu` → 12 EU / 0 US, `&region=us` → 0 EU / 12 US, `q=gamepad` → 4, `q=zzzznomatch` → empty state, page 1 ∩ page 2 = ∅, 112 published entries, newest first (5 Nov 15:42 UTC) | pass |
| 3 | Dev Notes cards show **Official update** badge, "Updated 4 Nov 2026 · first posted 24 Sept 2026" (US and EU) — staff activity is thread activity | pass |
| 4 | RSS top 12 identical to web top 12, same order; RSS 30 items, `application/rss+xml` | pass |
| 5 | Both articles: canonical = own URL, `robots: index, follow`, OG/Twitter image = `-social.webp`, JSON-LD `BlogPosting` + `BreadcrumbList`, listed in sitemap; all six image variants 200 `image/webp` | pass |
| 6 | Apex: no `X-Robots-Tag`, `robots.txt` allows `/` (disallows `/api/`, `/verify`). `beta.azerdex.com`: `X-Robots-Tag: noindex, follow`. `wow-foreverdb.vercel.app`: 307 → apex | pass |
| 7 | Chromium 1440×900 and 390×844, 8 routes each: 0 px horizontal overflow, 0 broken images, h1 present | pass |
| 8 | CSP (nonce + `strict-dynamic`, `frame-ancestors 'none'`, `object-src 'none'`), HSTS, `nosniff`, `X-Frame-Options: DENY`, Referrer/Permissions-Policy present. `/account` → 307 `/account/login`; login/register/forgot-password 200; `/account/api/me` unauthenticated → 401; `/api/v1/search`, `/api/v1/meta`, `/item/1413`, `/zone/1420`, `/api/v1/item/1413`, `/about/privacy`, `/guides/races/human` 200; unknown slugs 404 | pass |
| 9 | Vercel runtime errors, 24 h: none. Runtime log levels, last 50 min: 28 `info`, 0 error/warning (Hobby retains 1 h) | pass |
| 10 | Aliases → `dpl_J8R8…`; rollback candidate present | pass |

Only console noise in the browser: the expected unauthenticated `401` from `/account/api/me` and aborted Next.js `_rsc` prefetches on navigation.

Observations, **not regressions**:
- `/news?page=N` for N ≥ 500 shows the "feed temporarily unavailable" panel (HTTP 200). Cause: `web_api.news_cards` deliberately rejects `p_offset > 5000` (migration 0011, line 572). Pages 11–499 fall back to page 1. Cosmetic edge case on nonsense input; no fix proposed.
- If the owner wants the share-link bypass entries from the staged-acceptance work revoked, that is a Vercel dashboard action; no secret value is recorded here.

## 2. G5-A — read-only preflight

Compatibility: migrations `0011`, `0012` (and `0013`, unused by released code) are applied; Edge Function `azerdex-news-collector` is v4 (G3, 2026-11-04 10:16). Cron jobs `azerdex-news-blueposts` (`*/10`), `azerdex-news-official` (`*/30`), `azerdex-news-revisions` (`0 */6`), `azerdex-publish-observations` (`*/15`) are active with 0 failures in 7 days (last successes 19:20, 19:00, 18:00, 19:15).

**Backfill flag state.** `AZERDEX_NEWS_BACKFILL_ENABLED` is a secret/env value; this session has no way to read it and does not try. The documented default is unset (apply returns 403 `backfill_apply_disabled`). The operator must confirm with `supabase secrets list --project-ref chcoypkjzxfznsqmmbrq` (names/digests only); the name `AZERDEX_NEWS_BACKFILL_ENABLED` must be absent or not `true`.

**Counters (19:26:18, "before" snapshot for the dry-run diff):**

| Counter | Value |
| --- | --- |
| `pub.news_entries` | 770 (max id 96909) |
| suppressed (`suppressed_at is not null`) | 343 |
| visible (`suppressed_at is null and status='published'`) | 117 (the site reports 112 *published entries*; the extra rows are non-card replies/openers) |
| `pub.news_post_versions` | 1006 (max id 4769) |
| `pub.news_tracked_topics` | 61 |
| `pub.news_verified_staff` | 7 |
| `pub.news_sync_runs` | 4761 (normal cron runs add rows; this counter is not a write-detector) |
| `pub.news_story_overrides` / `news_story_members` | 4 / 0 |
| `max(modified_at)` on entries | 2026-11-05 15:42:52 |

Read-only verify script (`database/public-read/ops/news_v2_backfill_verify.sql`, executed query-by-query as `foreverdb_pub_owner`): invariants 3a–3e returned **zero rows** earlier in this session.

**Dev Notes threads (production vs live Blizzard topic JSON, 19:30):**

| Thread | In production | Missing |
| --- | --- | --- |
| US 2360696 | opener `post:30185131` (official_updated 3 Nov 03:20:46), `post:30756539` (#10, 4 Nov) | **`post:30732723` (#9, staff, 2026-11-03 03:20:33 — inside the window)**; #7/#8 (26–27 Oct) absent and outside the window |
| EU 631316 | opener `post:6391795` (official_updated 3 Nov 03:21:37), #7 `6453379`, #8 `6454754`, #9 `6471288`, #10 `6475066` | nothing |

So production advanced since the rehearsal: ordinary revision runs already collected the EU thread, including #9 and a refreshed opener, and the US opener. Only US `post:30732723` is missing.

**Predicted dry-run (a prediction, not dry-run output):** US: `insert post:30732723`; opener `unchanged`; EU: all `unchanged`; Midnight hotfix replies `irrelevant`; other in-window threads (if any) `unchanged`. The US card headline would keep its 4 Nov update date; the thread would gain one earlier update entry. The historical expectation (US 2 inserts, EU 1 insert + 1 update) is **obsolete**; if the dry-run reports more than one `insert` or any `update`, stop and investigate.

Side observation (outside G5, not caused by G5): EU #7/#8 (26–27 Oct) are live, ingested 2026-11-04 12:00 by a V2 revision run. The "do not resurrect 26–27 Oct replies" rule therefore concerns the backfill window only; the backfill itself never admits replies outside the window (`collector.ts`, `admitTopicDoc` windowed filter).

## 3. G5-B — production dry-run: **not executed by this session**

Reason: the dry-run needs `x-azerdex-news-secret`. The sandbox has no such secret and reading it from Vault or calling `net.http_post` ad hoc would bypass the protected operator procedure. The operator runs it (nothing is written; response contains counts, per-entry actions, no secrets):

```powershell
$collectorSecret = Read-Host 'Collector secret' -AsSecureString
$secretBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($collectorSecret)
try {
    $secret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretBstr)
    $headers = @{ 'x-azerdex-news-secret' = $secret }
    $body = '{"mode":"backfill","since":"2026-10-30T00:00:00Z","until":"2026-11-03T23:59:59.999Z","dryRun":true}'
    Invoke-RestMethod -Method Post -Uri 'https://chcoypkjzxfznsqmmbrq.supabase.co/functions/v1/azerdex-news-collector' -Headers $headers -ContentType 'application/json' -Body $body | ConvertTo-Json -Depth 12
}
finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretBstr)
    Remove-Variable secret, headers, collectorSecret -ErrorAction SilentlyContinue
}
```

Paste the JSON back (it holds no credential). Then this session re-runs the "before" query set; the zero-write proof is: `entries`, `suppressed`, `max_entry_id`, `versions`, `max_version_id`, `tracked`, `verified_staff`, `max(modified_at)` identical to §2 apart from changes made by the scheduled normal/revision runs (compare against their `news_sync_runs` rows to attribute them); the dry-run itself must appear with `dryRun` and zero inserted/updated.

## 4. G5-C — GO/NO-GO checkpoint

**Recommendation: NO-GO for `dryRun:false` today. GO for the operator dry-run.**

- *Marginal value is one row* (US reply #9). Neither site correctness nor chronology depends on it; the card is already live with the 4 Nov update.
- *Backup:* the owner's dump (`azerdex-public-read-g2-20261105T182712Z.dump`, 688453 bytes, SHA-256 `818DB47BB8A2A6BABC63C467FE4C5A417961C497272A411041DF7BD47D2DE124`, schemas `pub`, `pub_admin`, `web_api`, `private`, scratch restore SUCCESS, 770 entries / 61 topics / 4 overrides / 0 members) is a verified four-schema logical backup. It is **not** a complete Supabase disaster-recovery backup (free plan: no automatic backups, no PITR). An encrypted off-machine copy has **not** been evidenced. Required before any material write: operator confirmation of the off-machine copy's location and a successful decrypt/restore test, or an explicit owner decision to accept the risk for a one-row additive insert.
- *Risks of the write:* the flag must be set and removed around a single call (cleanup is mandatory even on error); the additive row cannot be rolled back by deletion under the policy; collector cron keeps running concurrently.
- *Rollback:* additive, keep rows. Website rollback = Vercel Instant Rollback to `dpl_3uxBg…` (compatible: `web_api.news_list` still exists in V2). Full V2 rollback order is website → Edge Function → database (`database/public-read/ops/news_v2_rollback.sql`), never while a V2 website depends on `web_api.news_cards`.

**If the owner approves the write (G5-D), exact sequence:** (1) re-run dry-run and compare with this evidence; (2) set `AZERDEX_NEWS_BACKFILL_ENABLED=true` on the Edge Function; (3) invoke the same window with `dryRun:false` inside a `try/finally`; (4) `finally`: unset the variable; (5) confirm it is gone; (6) run `news_v2_backfill_verify.sql`, all invariants zero rows; (7) check US card; (8) compare unrelated entries/RSS; (9) repeat the call only if the flag is re-enabled for that purpose, expecting `inserted 0, updated 0`. No window expansion; no suppressed rows touched; no `news_link_stories`.

## 5. G6 — health-check scheduling: **prepared here, APPLIED and verified in §7**

Preparation checks (19:25–19:35):

1. Both functions exist and match (md5s in §0). 2. `assert_healthy()` succeeded live. 3. Existing jobs: ids 3–6 as in §2, all active, unchanged. 4. `azerdex-news-health` does **not** exist. 5. `0018_schedule_news_health_check.sql` (sha256 `a1db4a2a6dd40391a3c804a38ce2e70172db023474e98244718054aff9624857`) unschedules any job with that name, then schedules one; no other job is touched. 6. Permissions: only `postgres` can execute the functions; no application role has `USAGE` on schema `private` or `cron` (`cron` ACL: `supabase_admin`, `postgres`); `cron.job` and `cron.job_run_details` have RLS (`username = CURRENT_USER`). Scheduling grants nothing. 7. "No new Blizzard content" yields `healthy_no_new_content` / `ok` and never raises; only `critical` states raise (`fetch_failing` after 3 consecutive failures, `persistence_failing`, `collector_stopped`, `revision_stale` > 48 h). 8. A raise shows as `status = 'failed'` in `cron.job_run_details`.

**Alerting limitation:** this produces an operational signal only. There is no email, Discord or other notification; do not assume one. Someone must run the query below (or an external alerting design must be separately approved).

Expected `cron.job` change: **+1 row** — `jobname = azerdex-news-health`, `schedule = */15 * * * *`, `command = select private.azerdex_news_assert_healthy()`, `active = true`, running as `postgres`; jobs 3–6 unchanged.

Apply (after separate approval): `database/ops/0018_schedule_news_health_check.sql`

```sql
select cron.unschedule(jobid) from cron.job where jobname = 'azerdex-news-health';
select cron.schedule('azerdex-news-health', '*/15 * * * *', $$select private.azerdex_news_assert_healthy()$$);
```

Rollback: `database/ops/0018_unschedule_news_health_check.sql` (sha256 `62873f2fbc98592618e4068972c56feafd17b2878681b56d270e093f2d5b1664`)

```sql
select cron.unschedule(jobid) from cron.job where jobname = 'azerdex-news-health';
```

Post-apply verification: exactly one active job with the schedule/command above; wait for the first `*/15` tick and require `status = 'succeeded'`; jobs 3–6 unchanged; `private.azerdex_news_health()` still lists the three sources; ACL query unchanged.

Read-only operator query for failed runs (no `command` or `return_message` columns):

```sql
select j.jobname, d.status, d.start_time, d.end_time
from cron.job_run_details d join cron.job j on j.jobid = d.jobid
where d.status <> 'succeeded' and d.start_time > now() - interval '7 days'
order by d.start_time desc limit 50;
```

It returned zero rows at 19:30. Add `and j.jobname = 'azerdex-news-health'` to focus on the new job. To see the reason, run `select private.azerdex_news_health();` as `postgres`.

## 6. Final status

| Gate | State | Evidence | Remaining blocker | Next action |
| --- | --- | --- | --- | --- |
| G4 | **Complete** | §1: routes, News contract, RSS parity, articles, indexing, headers, desktop/mobile, 0 runtime errors, aliases, rollback candidate | none | close; optionally revoke share-link bypass entries |
| G5 | **SKIPPED – ACCEPTED HISTORICAL GAP** (not failed, not complete) | §2 preflight and read-only comparison: exactly one missing in-window entry, `post:30732723`; zero-row invariants; counters unchanged (§9) | none | none; backfill code retained for future maintenance |
| G6 | **Complete** | §7: job 7 applied 20:01:26, first scheduled run 20:15:00 `succeeded`, jobs 3–6 unchanged, no new grants, 3 sources `ok` | none | monitor with the failed-run query; external alerting needs a separate design |

Owner decisions recorded 2026-11-05: **G4 accepted/closed; G5 dry-run GO, production write NO-GO** (do not set `AZERDEX_NEWS_BACKFILL_ENABLED`, do not run `dryRun:false`, no window change; revisit only with independently verified off-machine backup evidence); **G6 approved**.

## 7. G6 execution evidence (production, project `chcoypkjzxfznsqmmbrq`, owner approval 2026-11-05)

Pre-apply re-confirmation (20:00:55 UTC): project `azerdex-public-read`, `ACTIVE_HEALTHY`, PostgreSQL 17; SQL file sha256 `a1db4a2a…4857` (schedule) and `62873f2f…1664` (unschedule) match §5; function md5s `c4715b22…dd3e` / `f3c71a14…aaea` and ACLs `{postgres=X/postgres}` unchanged; none of 7 application roles can execute either function; `azerdex-news-health` absent (4 jobs total); health `overall: ok`.

Pre-apply job fingerprints (id / schedule / md5 of command): 3 `*/10` `3b40ce6a…`, 4 `*/30` `9404cb9e…`, 5 `0 */6` `bde19667…`, 6 `*/15` `c5213c82…`, all active, user `postgres`.

Applied at 20:01:26 UTC: the two statements of `database/ops/0018_schedule_news_health_check.sql`, verbatim, via the Supabase SQL interface as `postgres` (`cron.schedule` returned job id 7).

Post-apply verification:

| Check | Result |
| --- | --- |
| Active `azerdex-news-health` jobs | exactly 1 (id 7), `*/15 * * * *`, command `select private.azerdex_news_assert_healthy()`, user `postgres`, md5 `41ef2dfe…` |
| First scheduled execution | `cron.job_run_details` jobid 7: **succeeded**, start 20:15:00.085, end 20:15:00.284 UTC |
| Jobs 3–6 | schedule, active flag and command md5 identical to the pre-apply fingerprints (rechecked 20:17) |
| Privileges | function ACLs unchanged; no application role has execute on either function or `USAGE` on schema `private` or `cron`; `private` ACL `{postgres=UC/postgres}`; `cron` ACL unchanged (`supabase_admin`, `postgres`). No grant was issued |
| Health (20:17) | `overall: ok`; `blizzard-bluepost-eu`, `blizzard-bluepost-us`, `blizzard-news-us` = `healthy_no_new_content` / `ok`, 0 consecutive failures |
| Failed cron runs, last 2 h | 0 |

Rollback was not needed. If ever required: `database/ops/0018_unschedule_news_health_check.sql` removes only job 7.

The job is an operational signal only: a critical state makes a run `failed` in `cron.job_run_details`. No email/Discord/webhook alerting exists. Inspect with the failed-run query in §5.

## 8. G5 operator actions (superseded by the §9 decision; kept for reference only)

1. Run the §3 dry-run block (`dryRun:true`, unchanged window) from the protected terminal and paste the JSON (no secrets in it).
2. This session then compares counters to the §2 baseline, writes the per-entry action report here, and keeps G5 on hold.
3. Optionally confirm the flag is absent: `supabase secrets list --project-ref chcoypkjzxfznsqmmbrq` must not show `AZERDEX_NEWS_BACKFILL_ENABLED=true`.
4. A production write requires a new explicit owner approval plus independently verified off-machine backup evidence.

## 9. G5 decision — SKIPPED, ACCEPTED HISTORICAL GAP (owner, 2026-11-05)

Decision: the historical backfill is **permanently waived for the current release**. The one missing historical entry, `post:30732723` (US Dev Notes thread 2360696, staff reply #9, created 2026-11-03 03:20:33 UTC), is an accepted historical coverage gap, not a functional production defect. Not executed and not authorised: the production backfill, `AZERDEX_NEWS_BACKFILL_ENABLED=true`, `dryRun:false`, any modification of existing News data, any window change. The backfill implementation (Edge Function `mode:"backfill"`, `news_v2_backfill_verify.sql`, §7 of `news-collector-v2.md`) is retained unchanged for future maintenance. Normal ingestion, revision tracking and the G6 monitor are unchanged.

State shown as **SKIPPED – ACCEPTED HISTORICAL GAP**, not FAILED and not COMPLETE.

Provenance of the evidence, stated precisely:

- **Operator dry-run output received after the decision above** (pasted into the session at ~20:45 UTC; `dryRun:true`, window 2026-10-30T00:00:00Z .. 2026-11-03T23:59:59.999Z, no credential in the response). This session never invoked the Edge Function itself and held no collector secret. The output **confirms** the earlier read-only comparison (2026-11-05 19:30 UTC) of the live Blizzard topic JSON against `pub.news_entries`; the prediction and the dry-run agree exactly.
- Comparison result: US had opener `post:30185131` and `post:30756539` (#10); `post:30732723` (#9, in window) absent; #7/#8 (26–27 Oct) absent and outside the window. EU was complete (opener `post:6391795`, #7–#10 incl. `post:6471288`).
Dry-run per-entry report (both sources `status: succeeded`, `dryRun: true`, `topicChecks: 3`):

| Source | fetched / accepted / rejected | inserted / updated / skipped | Per-entry actions | Reject reasons |
| --- | --- | --- | --- | --- |
| `blizzard-bluepost-us` | 40 / 4 / 36 | 1 / 0 / 3 | `unchanged` `post:30743268` (#1), `unchanged` `post:30741364` (#1), **`insert` `post:30732723` (#9, published)**, `unchanged` `post:30185131` (#1 opener) | `topic_group_not_allowlisted` 34, `irrelevant` 2 |
| `blizzard-bluepost-eu` | 13 / 4 / 9 | 0 / 0 / 4 | `unchanged` `post:6472787`, `unchanged` `post:6472597`, `unchanged` `post:6471288` (#9), `unchanged` `post:6391795` (opener) | `topic_group_not_allowlisted` 7, `irrelevant` 2 |

Totals: **1 insert, 0 updates, 7 unchanged**. No `update`, no `skip_suppressed`, no `skip_unverified_reply`, no `skip_feed_over_topic` actions appear. Matches the stated expectation for G5-C ("more than one insert or any update means stop") — it did not trip. Differences from the historical rehearsal (US 2 inserts, EU 1 insert + 1 update) are explained by production having advanced through ordinary revision runs. Read: all other in-window threads (`post:30743268`, `post:30741364`, `post:6472787`, `post:6472597`) are already collected and unchanged; the Midnight replies stay rejected as `irrelevant`.

Zero-write proof (read-only, 2026-11-05 20:45:41 UTC, after the dry-run) against the §2 baseline: `news_entries` 770 = 770; suppressed 343 = 343; max entry id 96909 = 96909; `news_post_versions` 1006 = 1006 (max id 4769 = 4769); tracked topics 61 = 61; verified staff 7 = 7; story members 0; `max(modified_at)` 2026-11-05 15:42:52 unchanged; `post:30732723` rows 0; `news_sync_runs` rows with `mode = 'backfill'`: 0. The preview caused no write of any kind.

- Consequence on the site: the US card keeps its 4 Nov official-update timestamp; the thread simply lacks one earlier update entry.

Counter reconciliation (read-only, 2026-11-05 20:43:59 UTC) against the §2 baseline (19:26:18): `news_entries` 770 = 770; suppressed 343 = 343; max entry id 96909 = 96909; `news_post_versions` 1006 = 1006 (max id 4769 = 4769); tracked topics 61 = 61; verified staff 7 = 7; story overrides 4, members 0 = unchanged; `post:30732723` rows 0. No News data changed during G4–G6 audit work, including by the normal cron runs in that interval. Cron: 5 active jobs (3–6 plus job 7), job 7 has 2 succeeded runs, 0 failed runs in 3 h.

## 10. Final audit summary

| Gate | State | Evidence | Remaining blocker | Next action |
| --- | --- | --- | --- | --- |
| G4 | **Complete** (owner accepted) | §1 | none | none |
| G5 | **Skipped – accepted historical gap** | §2, §9 | none | none; re-open only by a new owner decision plus verified off-machine backup evidence |
| G6 | **Complete** | §7 | none | operators watch failed `azerdex-news-health` runs (§5 query); external alerting is out of scope |

Known limitations carried forward: the owner's four-schema dump is not a full Supabase disaster-recovery backup (free plan; off-machine copy unconfirmed); `cron.job_run_details` is an operational signal, not a notification channel; `/news?page=500+` shows the "feed unavailable" panel by design (`p_offset <= 5000`). Not touched: story grouping (4 overrides, 0 members, no `news_link_stories`), G7, the Guildbook boundary, the website deployment, unrelated services. PR #167 remains Draft and unmerged pending normal review.

