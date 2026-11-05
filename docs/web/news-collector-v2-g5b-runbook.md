# News Collector V2 — G5b runbook (US Dev Notes replies #7, #8, #9)

**Status: PREPARED. No production write and no flag change is authorized. Apply needs an explicit owner approval of exactly this write set ("G5b approved").**
The earlier G5 runbook, its rollback v2 and its backup are **obsolete**: the normal collector inserted opener `post:30185131` and reply #10 `post:30756539`
of topic 2360696 on 2026-11-04 19:40 UTC and the topic is now tracked. Do not run them.

## Live state when this was prepared (read-only)
- US topic 2360696 holds opener `post:30185131` and reply #10 `post:30756539` (tracked topic). Missing: #7 `post:30624529` (2026-10-26 20:35:27Z), #8 `post:30634848` (2026-10-27 15:37:37Z), #9 `post:30732723` (2026-11-03 03:20:33Z).
- 0 backfill runs exist; `AZERDEX_NEWS_BACKFILL_ENABLED` is off (flag-off probe: 403).
- Fresh dry-runs on 2026-11-05 (request ids 4162 / 4163): window A (2026-10-26T19:00Z → 2026-10-27T18:00Z) = 2 inserts (#7, #8), 0 updates, 1 skipped; window B (2026-11-03T03:00Z → 04:00Z) = 1 insert (#9), 0 updates, 1 skipped. Payloads: `database/public-read/tests/g5b/window_{a,b}_payload.json`.

## Why an apply can end up partial, and what that means
`news_apply_sync` is **one transaction** and every write is `insert … on conflict` keyed by `(source_key, source_entry_id)`:
a raising apply leaves nothing behind (not even the run record); a window that already committed is a **no-op on retry** (0 inserted, 0 updated, only a new run record);
so retrying a window is always safe, and *roll forward is the preferred recovery*. The only unknown is an HTTP **timeout**: the request may or may not have committed.
Entries carry no run id, so the G5b runs are **discovered by their window** (`mode='backfill'`, US source, `diagnostics.since/until` = A or B, id above the PRE high-water mark).

| Situation | State | Recovery |
|---|---|---|
| A ok, B fails (function error) | #7 #8 present, nothing from B | retry B (roll forward) or roll back A |
| A ok, B fetch failure | + a `failed` run record, no entries | same; the failed record is part of the discovered run set |
| A ok, B times out, result unknown | #9 present or absent | **do not guess**: flag off, wait for the in-flight request to finish (≥ 150 s, `pg_stat_activity` shows no `news_apply_sync`), fresh capture decides; retry B (idempotent) or roll back |
| B committed after the capture was taken | capture stale | rollback refuses (run set mismatch); take a fresh capture |
| B retried after a failure / after a committed timeout | 3 or 4 run records | rollback handles any number of window runs |
| a normal revision cycle edits #7/#8/#9 before the rollback | target has a 2nd version | rollback **keeps** the edited target (and its tracked id and the run records); policy `abort` refuses instead |
| a collector write overlaps the rollback | race | `LOCK TABLE … SHARE ROW EXCLUSIVE` first; checks run under the lock; `lock_timeout` 5 s fails closed |

## Procedure (only after approval)
1. **PRE** — flag still off. `ops/news_v2_g5b_capture.sql` (read-only): require `targets_present = 0`; record `max_entry_id`, `max_run_id` (the high-water marks used by the rollback), `untouched_fp`, `suppressed_md5`, `tracked_official_post_ids`, `entries_total`. Export the tracked row and the thread rows (`select * from pub.news_tracked_topics where topic_id='topic:2360696'`, `select * from pub.news_entries where source_topic_id='topic:2360696'`) as the pre-image (free plan: no PITR; a `pg_dump` of `pub` is optional). Re-run both dry-runs; abort on anything but 2 + 1 inserts and 0 updates.
2. Set the flag on. **Apply window A, then window B, one request at a time, never concurrently.** After each: fresh capture.
3. Set the flag **off** immediately; probe with `sourceKeys:["probe-none"]` → 403.
4. **POST** — capture, `ops/news_v2_g5b_verify.sql` (8 checks; check 8 accepts failed/retried attempts), re-run both windows as dry-runs → 0 inserted / 0 updated.
5. **If anything is partial or uncertain** — flag off, no apply in flight, fresh capture, then either retry the missing window (roll forward) or run the rollback below. Never edit the scripts' guards.

## Rollback / recovery (`ops/news_v2_g5b_rollback.sql`, one transaction, five tokens)
`RUN_IDS` = `g5b_run_ids` of a **fresh** capture (may be empty), `PRE_MAX_ENTRY_ID` / `PRE_MAX_RUN_ID` from the PRE capture, `POST_STATE_VALUES` from the fresh capture (verbatim, one line), `MODIFIED_POLICY` = `'keep'` or `'abort'`.
1. Locks `news_sync_runs`, `news_entries`, `news_post_versions`, `news_tracked_topics` (SHARE ROW EXCLUSIVE; the website keeps reading), `lock_timeout 5 s`, `statement_timeout 120 s`. Collector writes wait; everything below is evaluated after the lock.
2. Run set: must **equal** the supplied ids (an unlisted retry or a wrong id aborts); a `running` record, or any other backfill run of the US source after PRE, aborts.
3. Per target: `absent` → nothing; `unchanged` (id above PRE_MAX_ENTRY_ID, exactly one version = the current content, fingerprints equal the capture) → deleted with its versions and its id removed from the tracked row; `modified` (a later legitimate change) → kept, or abort under policy `abort`; `preexisting` (id ≤ PRE_MAX_ENTRY_ID) or not in the capture → abort.
4. Run records are deleted only when no target is kept (otherwise they stay as the audit trail).
5. **Non-interference proof inside the transaction**: a fingerprint of every other entry / version / tracked topic (the tracked row except `official_post_ids`) / run, taken under the lock before and after, must be identical; counts and the tracked array are checked exactly. Opener #1, Kaivax reply #10, a later reply #11 and all legitimate revisions are untouched.
Not restored: `news_sources` freshness, `news_verified_staff.last_seen_at`, tracked-topic scheduling columns, identity gaps, cron runs, `net._http_response`, caches. A deployment of the website is not involved.

## Test evidence (`scripts/news-g5b-test.sh`, PostgreSQL 17.5, non-superuser admin, production-shaped seed incl. migration 0012, real payloads)
Apply A (2/0) + B (1/0) with 8 verify checks and idempotent re-apply; **S1** complete rollback (+ later reply #11 intact, second rollback refused); **S2** A ok / B raising apply (leaves nothing) / B failed record, partial rollback; **S2b** retry after failure verifies and rolls back (3 runs); **S3a/b/c** timeout outcomes (B committed + retried, B never committed, B committed after the capture → stale list refused); **S4/S4b/S4c** revision edit before/after the capture and a tampered fingerprint → target kept, policy abort refuses; **S5** pre-existing target refused; **S6** foreign / wrong-set / running runs and bad policy refused; unreplaced tokens fail closed; **C1** revision write in flight (rollback waited 4.6 s, then kept the revised row); **C2** rollback holds the lock while a collector apply arrives (apply waited 4.1 s, then ran on the rolled-back state); **C3** lock timeout fails closed, retry works; **C4** simultaneous rollbacks serialise. ALL PASSED.

## Remaining risks
- Nothing is applied: a real apply still depends on the Edge Function's behaviour in production (a timeout there cannot be simulated exactly; the design makes every outcome recoverable).
- Table-level `SHARE ROW EXCLUSIVE` also delays cron-driven collector writes for the rollback's duration (seconds); a deadlock with a collector apply is avoided by taking the locks in `news_apply_sync`'s first-touch order, and an unlucky overlap fails closed (lock timeout), never half-applied.
- `modified` is detected by "a second version exists or the fingerprint differs": an edit that produces an identical content hash is invisible, and then it is by definition the same content.
- Run discovery relies on `diagnostics.since/until` being the approved window strings the collector sends.
