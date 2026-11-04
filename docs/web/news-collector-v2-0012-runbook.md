# Migration 0012 (revision due-time tolerance) — production runbook

Status: **prepared, NOT applied.** Needs the owner's explicit approval **for this specific migration** (`0012 approved`). Independent of G5 (no backfill, no flag, no cron or secret change).

## 1. What it changes

One function, `pub_admin.news_revision_batch(text, integer)`: a tracked topic is due when `next_check_at <= now() + interval '15 minutes'` (was `<= now()`). No table, row, other function, grant, role, cron job, secret or Edge Function is touched; signature and result shape are identical (Edge Function v4 needs no change). Why: the revision job fires at `:00:00` every 6 h but `next_check_at` is stamped seconds later inside the apply, so every topic skipped one whole cycle (6 h tier → 12 h, 24 h → 30 h, weekly → 7 d 6 h, back-offs 12/24/48 h → 18/30/54 h). Measured 2026-11-04: 12:00 run checked 27 US / 26 EU topics, 18:00 run checked 0.

## 2. Verified production facts (read-only, 2026-11-04 20:31 UTC)

| Fact | Value |
|---|---|
| Migration ledger (`azerdex-public-read`) | 13 entries; the latest is `20261104094201 news_collector_v2` (= repo 0011). **No 0012.** |
| Function owner / volatility / security | `foreverdb_pub_owner` / `STABLE` / `SECURITY DEFINER`, `search_path=""` |
| ACL | `{foreverdb_pub_owner=X/foreverdb_pub_owner, azerdex_news_ingest=X/foreverdb_pub_owner}` (not `PUBLIC`, not `anon`/`authenticated`/`foreverdb_web_reader`) |
| Body fingerprint (`md5(prosrc)`, length) | **`56dca40c9936352bd768db0993ed82a4`, 1916** — **identical** to the body built from repo migration 0011 (verified on PostgreSQL 17.5 and 16.15) ⇒ no production drift |
| Expected after 0012 | `149f9bd8a0f5191163108026ccbdbd84`, length 1940; everything else above unchanged |
| Overdue topics now | 21 EU + 22 US (due since 18:00:06–10 UTC; they wait for the 00:00 tick under the defect) |

## 3. Recovery point and rollback

* **Nothing but one function body changes, so there is no data to recover.** The recovery point is the exact 0011 definition: `ops/news_v2_0012_rollback.sql` embeds it (body fingerprint-checked against the production value above), plus the ledger entry above. The project is on the free plan (no automatic backups / PITR); that does not matter for a function-only change.
* **Rollback = `database/public-read/ops/news_v2_0012_rollback.sql`** (pure SQL, one transaction, owner `foreverdb_pub_owner`). It restores **only** this function (exact 0011 body, owner, volatility, security, `search_path`, ACL). It is **not** "re-apply 0011": re-applying 0011 replaces `news_apply_sync`, `news_list`, `news_featured`, `news_entry`, `news_cards`, `news_health_snapshot`… again (reverting any later hand/hotfix change to them) and re-runs seeding and grants.
* Fail-closed: refuses unless the current body is exactly the 0012 definition (drift or already rolled back ⇒ abort); postconditions (abort = nothing changed): body = 0011 fingerprint, owner/ACL exact, **every other function in `pub`, `pub_admin`, `web_api` byte-identical** (fingerprint before = after). Migration 0012 itself also refuses to overwrite any body that is neither the 0011 nor the 0012 definition.
* Tested on PostgreSQL 16.15 and 17.5 (`scripts/news-sql-tests.sh`): rollback restores the exact 0011 body and no other function; a second rollback is refused; a hand-edited (drifted) function is refused by both 0012 and the rollback and is left untouched; 0012 re-applies. Rollback consequence: the skip-a-cycle defect returns, nothing else.

## 4. Procedure (after `0012 approved`)

1. **Preflight (read-only):** `list_migrations` (no `…revision_due_tolerance`), then
   ```sql
   select md5(prosrc), length(prosrc), provolatile, prosecdef, proconfig, pg_get_userbyid(proowner), proacl::text
   from pg_proc where oid = 'pub_admin.news_revision_batch(text,integer)'::regprocedure;
   -- expect 56dca40c9936352bd768db0993ed82a4 | 1916 | s | t | {search_path=""} | foreverdb_pub_owner | {foreverdb_pub_owner=X/…,azerdex_news_ingest=X/…}
   select md5(string_agg(p.oid::regprocedure::text || md5(p.prosrc || coalesce(p.proacl::text,'')), ';' order by p.oid::regprocedure::text)) as other_functions_fp
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('pub','pub_admin','web_api') and p.oid <> 'pub_admin.news_revision_batch(text,integer)'::regprocedure;   -- keep
   ```
   Do not start within 10 minutes before a cron tick (`:00`) if a quiet window is preferred; the migration itself is atomic and instant.
2. **Apply only** `database/public-read/migrations/0012_news_revision_due_tolerance.sql` (name `news_revision_due_tolerance`) to `azerdex-public-read` (apply_migration). It aborts by itself on drift and self-checks body/ACL.
3. **Immediate post-checks (all must hold):**
   * the preflight query now returns `149f9bd8a0f5191163108026ccbdbd84 | 1940 | s | t | {search_path=""} | foreverdb_pub_owner | <same ACL>`; `other_functions_fp` equals the preflight value;
   * `has_function_privilege`: `azerdex_news_ingest` true; `foreverdb_web_reader`, `anon`, `authenticated` false;
   * ledger shows the new entry; `cron.job` still 3 active news jobs with unchanged schedules; no secret touched;
   * functional (read-only, as the owner role): `select jsonb_array_length(pub_admin.news_revision_batch('blizzard-bluepost-us', 50) -> 'dueTopics'), jsonb_array_length(pub_admin.news_revision_batch('blizzard-bluepost-eu', 50) -> 'dueTopics');` → at least the overdue counts of step 1 (≈ 22 / 21), never more than 50;
   * a topic due in the future beyond 15 minutes is still excluded: `select count(*) from pub.news_tracked_topics where next_check_at > now() + interval '15 minutes'` equals the count of topics absent from the batch;
   * the website and `/news`, `/news/rss.xml` still return 200.
4. **Only then merge [PR #162](https://github.com/Imemoth/wow-foreverdb/pull/162)** (squash) if its current HEAD is fully green and compatible (the migration file in the PR is byte-identical to what was applied). Merge triggers a production deployment of unchanged application code; verify it.
5. **Observe the next revision cycles** (`azerdex-news-revisions`, `0 */6 * * *`):
   * **00:00 UTC run:** `pub.news_sync_runs where mode='revision'` — each bluepost source reports `topicFetches` ≥ its previously overdue topics (cap 40 per source per run; `deferredTopics` must drain within the next run) and `topicChecks` > 0.
   * **06:00 UTC run (the real proof):** the 6 h-tier topics checked at 00:00:0x are due at 06:00:0x; `topicChecks` must be > 0 and ≈ the number of active-tier topics (before the fix this run checked 0). Health snapshot `overdueTopics` must stay 0.
   * Failure criteria (⇒ rollback script + investigation): `topicChecks = 0` at 06:00 while active topics exist; any run `failed`; `news_revision_batch` errors; an unexpected increase of HTTP 429.

## 5. Decisions needed from the owner

1. **`0012 approved`** — apply migration 0012 (and nothing else) to `azerdex-public-read`.
2. Resolve the dependency-audit PR choice ([#163](https://github.com/Imemoth/wow-foreverdb/pull/163) scoped override **or** [#164](https://github.com/Imemoth/wow-foreverdb/pull/164) narrowed exception); PR #162 cannot be merged while `Dependency audit (web)` / `Web release gate` fail on the base.
