# News Collector V2 — G5b runbook (US Dev Notes replies #7, #8, #9)

**Status: PREPARED. No production write is authorized. Apply needs an explicit owner approval of exactly this write set ("G5b approved").**
The earlier G5 runbook, its rollback v2 and its backup are **obsolete** (the normal collector inserted opener `post:30185131` and
reply #10 `post:30756539` of topic 2360696 on 2026-11-04 19:40 UTC and the topic is now tracked): do not run them.

## Live state when this was prepared (read-only, 2026-11-04)
- US topic 2360696 holds opener `post:30185131` and reply #10 `post:30756539` (two US Dev Notes entries); tracked row `news_tracked_topics` exists.
- Still missing: reply #7 `post:30624529` (2026-10-26 20:35:27Z), #8 `post:30634848` (2026-10-27 15:37:37Z), #9 `post:30732723` (2026-11-03 03:20:33Z).
- No backfill run exists for this work; `AZERDEX_NEWS_BACKFILL_ENABLED` is off (flag-off probe returns 403).

## Dry-runs (read-only, `dryRun:true`, run one at a time)
| Window | Source | since → until | Result |
|---|---|---|---|
| A | blizzard-bluepost-us | 2026-10-26T19:00Z → 2026-10-27T18:00Z | 2 inserted (#7, #8), 0 updated, 1 skipped (irrelevant) |
| B | blizzard-bluepost-us | 2026-11-03T03:00Z → 2026-11-03T04:00Z | 1 inserted (#9), 0 updated, 1 skipped |

The real collector payloads are in `database/public-read/tests/g5b/window_{a,b}_payload.json`. Both windows are pure inserts; **zero updates** to any existing row.

## "Fresh backup"
The project is on the free plan (no automatic backups/PITR) and the write set is 3 INSERTs + 3 versions + 2 run records + one array append
on the tracked row. The backup is therefore a **pre-image capture**, taken immediately before the apply:
1. `ops/news_v2_g5b_capture.sql` (read-only) → record `untouched_fp`, `suppressed_md5/count`, `entries_total`, `versions_total`, `backfill_runs`, `tracked_official_post_ids`.
2. Export of the tracked row and of the thread rows (`select * from pub.news_tracked_topics where topic_id='topic:2360696'`, `select * from pub.news_entries where source_topic_id='topic:2360696'`) stored with the capture. A full `pg_dump` of the `pub` schema is an optional owner decision.

## Procedure (only after approval)
1. Re-run capture (PRE) and a fresh dry-run of A and B; abort if anything other than the 3 expected inserts / 0 updates appears.
2. Set `AZERDEX_NEWS_BACKFILL_ENABLED=true`; apply window A, then window B (`dryRun:false`, single request each, never concurrently).
3. Set the flag back off immediately; probe with `sourceKeys:["probe-none"]` and confirm 403.
4. Run capture (POST) → its `post_state_values` feeds the rollback; run `ops/news_v2_g5b_verify.sql` (8 PASS/FAIL checks); re-run both windows as dry-runs: 0 inserted / 0 updated.

## Rollback (`ops/news_v2_g5b_rollback.sql`)
Fills four tokens (`<<RUN_IDS>>`, `<<SUPPRESSED_MD5>>`, `<<SUPPRESSED_COUNT>>`, `<<POST_STATE_VALUES>>`) from the POST capture. One transaction: refuses unless
both run ids are succeeded backfill runs of blizzard-bluepost-us, the 3 targets exist and are byte-identical to the POST capture (no later edit), and the tracked row still holds the 3 ids.
It deletes only the 3 entries + versions, removes only the 3 ids from the tracked row (the row stays tracked), removes the 2 run records, and aborts if the suppressed fingerprint changed.
A later unrelated reply survives. Unreplaced tokens fail closed.

## Test evidence
`scripts/news-g5b-test.sh` (PostgreSQL 17.5, non-superuser admin, production-shaped seed, real payloads): apply A (2/0) then B (1/0), 8 verify checks PASS, idempotent re-apply, rollback with a later reply #11 surviving, second rollback refused, and 6 negative cases refused with the database unchanged — ALL PASSED.
