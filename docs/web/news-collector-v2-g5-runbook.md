# News Collector V2 — G5 runbook: US Dev Notes backfill (corrected)

Status: **prepared, NOT executed.** Production writes need the owner's explicit `G5 approved`. G0 (migration 0011), G1 (Edge Function v4) and the first revision cycles are accepted.

## 1. Scope and agreed write set

US source `blizzard-bluepost-us` only, window `2026-10-26T00:00:00Z` … `2026-11-03T23:59:59.999Z` (owner selected "Option A").

| # | Posts (`source_entry_id`) | Change |
|---|---|---|
| 1–4 | `post:30185131` (opener #1), `post:30624529` (#7), `post:30634848` (#8), `post:30732723` (#9) — Kaivax, user id 3390, `community-manager` | **insert** (topic 2360696, the missing US Beta Development Notes thread) |
| 5 | `post:30743268` (Explore WoW: Forever with a Gamepad, `api_users` 520262) | **update** — a genuine new Blizzard edit (live version 13 vs stored 9); `modified_at`, `official_updated_at`, `source_version`, `content_hash` |
| 6–10 | `post:30623027`, `post:30638690`, `post:30639364`, `post:30640021`, `post:30644593` — hidden `rejected`/`irrelevant` Oct 26–27 US posts | **update** — exactly five columns each: `author_user_id`, `author_group`, `thread_origin` (`official`), `observed_via` (`feed`) go from NULL to a value (the V2 content hash includes provenance) and `content_hash` changes. **Unchanged:** `status`, `relevance`, `published_at`, `ingested_at`, `title`, `excerpt`, `slug`, `importance`, `featured`, `modified_at`, `official_updated_at`, `source_version`, suppressed marker. Still invisible on the site. |
| – | 8 US openers (`30741364 30675695 30673599 30671248 30658235 30650104 30638185 30622338`) | `unchanged` (skipped) |

Verified on an isolated, production-shaped **PostgreSQL 17.5** database (`scripts/news-g5-rollback-test.sh`): the real collector payload gives `inserted 4 / updated 6 / skipped 8 / skippedUnverified 0`, exactly the production dry-run. The column-level diff above comes from that rehearsal.

Other tables the real apply touches (not part of the 10-entry write set, recomputed every cron cycle): one `news_sync_runs` row; the US `news_sources` freshness columns; `last_seen_at` of the 3 US `news_verified_staff` rows; `news_tracked_topics` — a new row for `topic:2360696` plus `last_official_at`/`official_post_ids`/check scheduling of the topics seen in the window. Expected: entries +4, versions +10, cards +1 (a new US Dev Notes card).

## 2. Gates (all must be true before the apply)

| Gate | Evidence |
|---|---|
| G-A Owner says `G5 approved` | owner message |
| G-B Backup decision made (see §7: row-level backup exists and is verified; a full `pg_dump` is the owner's call) | this document §7 |
| G-C 22/22 backup fingerprints still match production | §4 step 1 |
| G-D Fresh US-only dry-run reconciles with §1 (only additional *genuine edit* updates are acceptable) | §4 step 2 |
| G-E `news_v2_g5_rollback.sql` tested (PG 17.5) | `scripts/news-g5-rollback-test.sh` |
| G-F Flag is off (§4 step 3) and the owner will set it, or explicitly authorises the agent to set it, for the window only | — |

Do not proceed on any other deviation: extra inserts, updates to rows outside §1, `skip_suppressed`/`skip_unverified_reply`, a failed dry-run, a non-200 response, or changed suppressed fingerprint.

## 3. Request shapes (the shared secret is never printed)

Dry-run and apply are `POST` to the collector URL (`private.azerdex_news_settings`, key `news_collector_url`) with header `x-azerdex-news-secret`. From SQL the secret is read **inside** the statement (it is never selected or logged):

```sql
select net.http_post(
  url := (select s.value from private.azerdex_news_settings s where s.key = 'news_collector_url'),
  headers := jsonb_build_object('content-type','application/json',
             'x-azerdex-news-secret',(select ds.decrypted_secret from vault.decrypted_secrets ds where ds.name = 'azerdex_news_collector_secret')),
  body := jsonb_build_object('mode','backfill','sourceKeys',jsonb_build_array('blizzard-bluepost-us'),
             'since','2026-10-26T00:00:00Z','until','2026-11-03T23:59:59.999Z','dryRun',true),   -- apply: 'dryRun', false
  timeout_milliseconds := 140000) as request_id;
-- read the answer: select status_code, content from net._http_response where id = <request_id>;
```

The apply response contains `"runId"`: **write it down** — the rollback needs it.

## 4. Procedure (after `G5 approved`)

1. **Reconfirm the backup.** Run the fingerprint query (22 `md5(row::text)` values: 6 entries + 16 versions, listed in `news_v2_g5_rollback.sql` as `g5_expect_pre`). All 22 must equal production. Then run `ops/news_v2_g5_capture.sql` (**PRE** capture) and keep the output (`suppressed_md5`, `suppressed_count`, `entries_total`, `versions_total`, `backfill_runs` must be 0).
2. **Fresh dry-run** (§3, `dryRun:true`). Compare with §1. Re-run the PRE capture if more than a few minutes pass.
3. **Flag on (owner or explicitly authorised agent):** Edge Function secret `AZERDEX_NEWS_BACKFILL_ENABLED=true`. No other secret, no cron and no code change. Time-box: minutes.
4. **Apply once** (§3, `dryRun:false`). Expect HTTP 200, `ok:true`, `inserted 4`, `updated 6` (+ at most genuine-edit updates), `skipped ≈ 8`, `dryRun:false`. Note `runId`. **Never repeat the apply "to be sure".**
5. **Flag off immediately** (set to `false` or unset). Prove it with the **safe probe**: the same request with `dryRun:false` and `sourceKeys:["probe-none"]` — no source matches, so nothing can be written even if the flag were still on; expect **HTTP 403 `backfill_apply_disabled`** (HTTP 200 with empty `reports` means the flag is STILL ON: switch it off again and re-probe).
6. **POST capture** (`ops/news_v2_g5_capture.sql`); keep `post_state_values` for the rollback. Expect `target_entries_present 10`, `target_versions 26`, `us_topic_2360696_rows 4`, `suppressed_md5` = PRE, `entries_total` = PRE + 4, `versions_total` = PRE + 10, `backfill_runs` 1.
7. **Verify:** `ops/news_v2_g5_verify.sql` (11 checks, all `PASS`); `ops/news_v2_backfill_verify.sql` (invariants must return **zero** rows; from PR #161 on — before it is merged ignore the single `duplicate_cards_for_thread` row with a NULL key, a false positive of the Official News cards); web check of `/news?region=us`, the new card detail page and `/news/rss.xml` (one card, links to #9, "first posted 24 Sep"); `cron.job_run_details` all `succeeded`.
8. **Idempotency:** a second **dry-run** (`dryRun:true`) must report `inserted 0`, `updated 0` (only a genuine new edit may show an update) and everything else `unchanged`. After the next two cron cycles re-run steps 6–7 comparisons: no new rows, no failures.
9. **Decision:** any failed check → §6 rollback. Otherwise record the result and close G5.

## 5. Expected values to compare (point-in-time 2026-11-04, drift allowed only as stated)

* Before: entries 757 (758 after the 18:00 Official News insert), suppressed 343 (md5 `6e9867eac6889cb8a6654ca3ffa7f094`), US topic 2360696 rows 0, backfill runs 0, cards 102.
* After: entries +4, versions +10, cards +1, suppressed unchanged, US topic 2360696 rows 4, backfill runs 1.
* Always re-derive from the PRE capture of the day.

## 6. Rollback (`ops/news_v2_g5_rollback.sql`, version 2)

Pure SQL, one transaction, **fail-closed**. It deletes only the ten write-set entries (4 inserted + 6 updated) and their version rows, the tracked-topic row `topic:2360696`, and **exactly one** sync-run record: the G5 `runId` you supply (never "all backfill runs"). It restores the 6 pre-G5 entries and 16 versions from the verified backup embedded in the script.

It **refuses to run, changing nothing,** unless all are true: the tokens were replaced (an unreplaced token is a syntax error); the run id is one `mode='backfill'` run of `blizzard-bluepost-us`; all ten entries exist and **every write-set entry and version row still equals the POST capture** (so a later legitimate change — a revision edit, a new version, a manual edit — blocks the rollback instead of being overwritten); topic 2360696 still holds exactly the four G5 rows (a later reply #10 blocks it). Postconditions before `COMMIT`: the 22 restored rows equal the pre-G5 fingerprints, the inserted rows are gone, the G5 run record is gone, the suppressed fingerprint is unchanged, `entries_total` fell by exactly 4.

Steps: replace `<<G5_RUN_ID>>`, `<<SUPPRESSED_MD5>>`, `<<SUPPRESSED_COUNT>>` (PRE capture) and `<<POST_STATE_VALUES>>` (POST capture, verbatim), run as the platform admin (`psql -v ON_ERROR_STOP=1 -f …` or the SQL editor), then re-run the capture and verify scripts. If the precondition fails because of a later legitimate change, **do not force it**: decide manually (the version snapshots keep every earlier state; the pre-G5 rows are in the backup).

Tested on PostgreSQL 17.5 (`scripts/news-g5-rollback-test.sh`): correct run restores 22/22 fingerprints; only the G5 run record is removed (decoy backfill/normal runs survive); refused and unchanged on: later edit of an updated entry, new version of a legacy row, later reply #10, another source's backfill run id, a cron run id, a tampered fingerprint, a wrong suppressed fingerprint (postcondition aborts the whole transaction), unreplaced tokens and a second run.

## 7. Backup and recovery limits

* **No platform backup:** free plan, no automatic backups, no point-in-time recovery; the project has no branches.
* **What exists:** a row-level logical backup of the rows the apply can overwrite or whose history matters — the 6 `news_entries` rows and their 16 `news_post_versions` rows (`news_g5_backup_20261104.sql`, also embedded in the rollback script). Verified by restore into a scratch database: 22/22 `md5(row::text)` fingerprints match production. Unchanged since export (scope fingerprint `ba244cd8…` re-checked 18:07 UTC).
* **Not covered:** anything outside the write set (table corruption, a bad migration, a lost project). Only a platform-level dump covers that — the owner can take one with `pg_dump` against the project's database (connection string stays with the owner).
* The apply never edits or deletes existing version rows; each updated entry's current state is already in its latest version snapshot (second recovery source).

## 8. What a rollback does NOT restore (and why it is harmless)

| Not restored | Why |
|---|---|
| `news_sources` (US) freshness columns: `last_attempt_at`, `last_fetch_ok_at`, `last_success_at`, `last_official_post_at`, `updated_at`, `last_http_status`, `last_error*` | operational timestamps, rewritten by every cron run every 10 minutes |
| `news_verified_staff.last_seen_at` (3 US rows) | rewritten every cron run |
| `news_tracked_topics` of **other** topics: `last_checked_at`, `next_check_at`, `state`, `last_official_at`, `official_post_ids`, `consecutive_failures` | derived scheduling state; recomputed by revision runs (the row for `topic:2360696` **is** removed) |
| `news_sync_runs` of cron runs that happened after G5 | they really happened; only the G5 run record is deleted |
| Identity sequences (`news_entries`, `news_post_versions`, `news_sync_runs`) | not rewound; ids of deleted rows are simply skipped |
| `net._http_response` rows (dry-run / apply answers; ~6 h retention) | transient |
| Website caches (ISR/CDN) | refresh within the revalidation window; re-check `/news` after a rollback |

## 9. Known risks and open items

1. No full-database backup (§7). The apply is bounded to 10 entry rows; only those are recoverable.
2. Edit drift between the dry-run and the apply (Blizzard keeps editing; e.g. Gamepad version 9 → 13). Mitigated by the fresh dry-run and the POST capture.
3. While the flag is on any holder of the shared secret can write backfills: minutes only; verify with the safe probe (§4 step 5).
4. **Revision cadence defect (separate, [PR #162](https://github.com/Imemoth/wow-foreverdb/pull/162), Draft, migration 0012 not applied):** tier-6 h topics are effectively checked every 12 h. Not a G5 blocker. After G5, topic 2360696 is tracked like every other.
5. The dry-run and apply use the Vault secret server-side inside one SQL statement (never printed); no secret, cron or code is changed.
6. Idempotency was verified in rehearsal and in production repeat runs, not in a production apply; §4 step 8 is the production proof.
