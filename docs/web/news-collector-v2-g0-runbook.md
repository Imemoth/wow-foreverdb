# News Collector V2 — G0 runbook: apply migration `0011` to production

**Scope: the database migration only.** It does not merge PR #160, deploy the Edge Function or the website, change a cron
schedule, run a backfill or touch a secret. After G0 the *currently deployed* V1 collector and V1 website must keep working
unchanged; G1 (Edge Function) is a separate approval.

Status of this document: **prepared and rehearsed, NOT executed in production.** Production was only read (SELECT / catalog
queries). Every statement below that says "verified" names how.

---

## 1. Target identity (verify before anything else)

| Item | Value | Verified how |
|---|---|---|
| Supabase project | **`azerdex-public-read`** — ref `chcoypkjzxfznsqmmbrq` | `list_projects`/`get_project` 2026-11-03 |
| Organization / region / status | `Hearth & Byte` / eu-west-1 / `ACTIVE_HEALTHY` | `get_project` |
| Engine | PostgreSQL **17.11** (aarch64) | `select version()` |
| Database | `postgres`, run as the platform `postgres` role | `current_database()`, `current_user` |
| **NOT** this project | `wow-forever` (ref `klxhikdlfwgxurdyexdi`) — the private project that the GitHub "Supabase Preview" check points at. Never run anything here against it. | `list_projects` |

Confirm in the dashboard URL (`…/project/chcoypkjzxfznsqmmbrq`) and with `select count(*) from pub.news_sources` = 3.

## 2. Artifact to apply (verified file, checksum)

* Source: PR #160 branch `fix/news-collector-v2-official-updates` (**not merged** — do not merge before G1/G4; merging deploys the website).
* File: `database/public-read/migrations/0011_news_collector_v2.sql`, 756 lines
  **SHA-256 `a8c42dc74f98a5d70e7f4195d93c5c79d09a306b1d7af2845f98e7d28ab0fd96`** (identical at PR HEAD `a3084e9` and at every later PR commit; only the Edge Function, its tests and docs changed afterwards).
* Verify before applying: `sha256sum database/public-read/migrations/0011_news_collector_v2.sql` must print the value above. If it differs, STOP.
* Companion scripts (read-only unless stated), same branch: `ops/news_v2_g0_preflight.sql`, `ops/news_v2_g0_postcheck.sql`, `ops/news_v2_rollback.sql` (**writes**), `database/ops/0018_*` (not part of G0).

## 3. Recovery readiness — **BLOCKED until the owner creates a manual backup**

* The organization is on the Supabase **free plan**: **no automatic daily backups and no point-in-time recovery** (Supabase docs: free projects must export manually with `db dump`). I cannot create a dump (no database credentials in this session).
* Required before step 5 (owner, 5 minutes) — use the dashboard's password prompt or `~/.pgpass`; never put the password in a command line, chat, GitHub or shell history:

```bash
pg_dump "host=db.chcoypkjzxfznsqmmbrq.supabase.co port=5432 dbname=postgres user=postgres sslmode=require" -W \
  --no-owner --schema=pub --schema=pub_admin --schema=web_api -f g0-before-$(date -u +%Y%m%dT%H%M%SZ).sql
```

  Store the file outside the repo. Size is small (News tables ≈ 4 MB). A restore of this dump into an empty database is *not* the plan for a failed migration (see §10); it is the last-resort record.
* Why the risk is nevertheless low: the migration is **one transaction** (all-or-nothing), purely additive (§5), and has a rehearsed rollback that keeps every row (§10). The dump protects against what no script can: an unforeseen platform fault.

## 4. Pre-migration checks (read-only) — all must PASS

Run immediately before step 5:

```bash
psql -X -v ON_ERROR_STOP=1 -f database/public-read/ops/news_v2_g0_preflight.sql
```

(the same single `SELECT` can be pasted into the SQL editor). **Observed on production 2026-11-03 14:5x UTC: 19/19 PASS**, including:
V2 absent; the four existing News functions are **byte-identical** to what repository migrations 0001–0010 produce (md5 `91906882…`, `98330e35…`, `3f70fbfc…`, `960b2e1e…`); RLS on and no API-role table access; ingest role has only `news_apply_sync`; three cron jobs active with the expected schedules; last success 8/8/28 min ago; 0 failed runs in 2 h; no future-dated/visible reply rows; no long transactions; `pg_cron`+`pg_net` present.

Record the INFO rows — they are the BEFORE fingerprint (values observed at 15:01 UTC; **re-record at execution time**, the collector keeps updating rows):

| INFO | Observed |
|---|---|
| `max_entry_id` → `-v max_id` | `61233` |
| `identity_md5` → `-v pre_identity_md5` | `f1a2ac5d40b35cc9067cfa7ed0083aae` |
| `suppressed_md5` → `-v pre_suppressed_md5` | `6e9867eac6889cb8a6654ca3ffa7f094` |
| `published_cards` → `-v pre_cards` | `96` |
| counts | entries 748 · suppressed 343 · live 405 · versions 848 |

Stopping conditions (any one): a FAIL row · `sha256sum` mismatch · backup missing · an active incident on the News jobs · the Supabase dashboard shows the project paused/unhealthy.

## 5. What the migration does (reviewed in full)

Verified by reading all 756 lines and by tests (§8):

* **No destructive operation**: no `DROP TABLE/COLUMN`, no `DELETE`, no `TRUNCATE`, no `UPDATE` of existing rows. The only drops are `DROP CONSTRAINT IF EXISTS` of its *own* two new check constraints (re-apply). Existing rows, version history and `suppressed_at/suppression_reason` markers are untouched (fingerprints in §7).
* **Additive schema**: 6 nullable columns on `news_entries`; 5 nullable columns + 6 columns (2 `NOT NULL DEFAULT 0`, constant defaults ⇒ metadata-only, no table rewrite) on `news_sources` / `news_sync_runs`; 3 new tables (RLS on, all privileges revoked from PUBLIC and the API roles); 1 internal view (no grants); seeding of `news_tracked_topics` from existing verified openers (**expected 49 rows**, staggered 2 min apart) and `news_official_groups` (3 rows).
* **Functions**: replaces `news_apply_sync`, `web_api.news_list/news_featured/news_entry` with **identical signatures**; `news_list` keeps its 19 result columns, `news_featured` 18, `news_entry` still `jsonb`, `apply` still `jsonb` with `inserted`/`updated` (old keys retained). New: `web_api.news_cards`, `pub_admin.news_revision_batch`, `pub_admin.news_health_snapshot`. All `SECURITY DEFINER`, empty `search_path`, explicitly revoked from PUBLIC; `CREATE OR REPLACE` preserves the existing ACLs.
* **Privileges**: `azerdex_news_ingest` gains exactly one function (`news_revision_batch`); the web reader gains `news_cards`; `postgres` gets the health snapshot. No schema usage is added for any API role; there are no default ACLs in `pub`/`pub_admin`/`web_api` (production `pg_default_acl` checked), so new objects cannot inherit grants.
* **Locks / impact**: table is tiny (748 + 848 + 3,997 rows, 4 MB). `ALTER TABLE … ADD COLUMN` (nullable / constant default) and two `CHECK` constraints on ≤ 748 rows take brief ACCESS EXCLUSIVE locks. **Measured 64 ms** on PG 17.5. The V1 collector's transactions last milliseconds. Production has 6 Supabase event triggers (PostgREST schema-cache reload, graphql, pg_cron/pg_net access); they are benign for DDL.
* **Execution identity**: the file starts `set local role foreverdb_pub_owner`. Production `postgres` has `SET` (not `INHERIT`) on that role — the same shape the CI harness reproduces — and `foreverdb_pub_owner` owns the three schemas and has `CREATE` on them (checked).
* **Idempotent**: re-applied repeatedly in CI and locally (including after a rollback) with no change and no error.

**V1 impact prediction (read-only, on production data):** the V2 read path returns the *same 96 cards in the same order* as today (0 order differences, 0 future-dated rows, 0 visible legacy replies).

## 6. Execution method (after explicit G0 approval only)

Prefer the Supabase integration, because the existing migrations in the ledger were applied that way
(`public_read_0008_news_ingest_role`, `news_bluepost_suppression_v1`):

1. Project `azerdex-public-read` → apply migration **name `news_collector_v2`**, SQL = the verified file **verbatim** (it contains its own `begin;`/`commit;`, like 0008–0010).
2. **Timing**: start at a minute ending in 3–8 (the collector fires at :00/:10/:20…; Official News at :00/:30). Do not run within ±2 minutes of `00:00`, `06:00`, `12:00`, `18:00` UTC (revision job).
3. If the call has not returned after **30 s**, cancel it: the transaction rolls back as a whole (no partial state). Re-run `news_v2_g0_preflight.sql`, then retry once.
4. Alternative (equivalent; no ledger row): `psql -X -v ON_ERROR_STOP=1 -f database/public-read/migrations/0011_news_collector_v2.sql` as `postgres`.

**Expected result:** no error, no output rows, < 1 s. Then immediately record `migrated_at` = `select now()`.

## 7. Post-migration validation (read-only) — all must PASS before anything else happens

```bash
psql -X -v ON_ERROR_STOP=1 \
  -v max_id=61233 -v pre_identity_md5=f1a2ac5d40b35cc9067cfa7ed0083aae -v pre_suppressed_md5=6e9867eac6889cb8a6654ca3ffa7f094 \
  -v pre_cards=96 -v migrated_at="'<UTC time recorded after the migration>'" \
  -f database/public-read/ops/news_v2_g0_postcheck.sql        # use the values you re-recorded in §4
```

* **Part 1 (immediately)**: V2 columns/tables/functions present; RLS on, no API access; every News function SECURITY DEFINER + empty search_path + not executable by PUBLIC/anon/authenticated; ingest role has exactly `apply`+`revision_batch`; web reader has the 4 `web_api` functions and no `pub_admin` function; V1 result contracts unchanged; **identity and suppressed fingerprints unchanged**; no orphan versions; tracking seeded (expect one row per live published opener: **49** on 3 Nov, **53** on 4 Nov); **no V2 provenance written** (V2 collector not deployed); cron jobs unchanged.
* **Part 2 (immediately; runs through the schema-owner role because production's `postgres` cannot `SET ROLE` to the web reader — the reader's grants are asserted in Part 1)**: `news_list` total ≥ pre_cards and a full page of 50; `news_featured(8)` = 8; `news_entry` keys; no reply exposed; `news_cards` agrees with `news_list`.
* **Part 3 (≥ 35 min later; Official News runs every 30)**: every source ran again after `migrated_at` and **succeeded** (the V1 collector now talks to the V2 persistence function); V2 freshness columns populated by V1 payloads; no failed cron run; still no replies stored.
* **Production smoke tests of the live V1 website/collector** (no change expected):
  * `curl -s -o /dev/null -w '%{http_code}\n' https://azerdex.com/news` → `200`; `…/news/rss.xml` → `200`; the first card is still *"Prepare for Forever, Try Midnight's Talebound, and Discover Sweet Treats in WoW Weekly"* (30 Oct 2026, US, Official News — the newest card today); the card total is unchanged; `https://azerdex.com/` renders the "Latest from Azeroth" section.
  * The web layer caches for ~1 minute, so allow 2 minutes after the migration before judging.

**Stop conditions after execution** (go to §10 immediately): any FAIL in Parts 1–2 · `news_list`/`news_featured` error or fewer cards than before · a failed or missing collector run after `migrated_at` (+12 min for Tracker sources, +35 min for Official News) · a failed cron run · HTTP 5xx on `/news` or `/`.

## 8. Evidence for each claim (reproducible)

| Claim | Evidence |
|---|---|
| CI | PR #160 checks on `a3084e9`: 17 success + 1 skipped (Supabase Preview), 0 failed — and on the later commit (see PR) |
| Local = CI | `scripts/news-sql-tests.sh` on **PostgreSQL 16.15 and 17.5**: identical PASS lists (migrations as a non-superuser admin, idempotent re-apply, V1 + V2 behaviour, security/ACL probes, thread reads, revision tracking, monitoring, rollback round-trip with data, seeding) |
| V1 website compatible | the **`release` website code** (`postgres-adapter`) read a production-shaped DB before and after the migration: **byte-identical** output (53 rows/total, bluepost 14, official 39, search, `newsFeatured(8)`, 15 detail payloads, not-found) |
| V1 collector compatible | the **`release` collector code**, live Blizzard feeds, through the real RPC as `azerdex_news_ingest`, before and after: identical behaviour (normal ×2 idempotent, revision updates as before), no replies, identity fingerprint unchanged; V2 freshness columns filled by V1 payloads |
| Official News path | V1-shaped Official News update through the V2 function: date follows source (V1 semantics), editorial `featured/importance` now preserved (intentional change), version history +1 |

## 9. Failure modes of the migration itself

| Symptom | Meaning | Action |
|---|---|---|
| `permission denied` / `must be owner` | executing role not `postgres`, or SET ROLE blocked | nothing was changed (transaction); verify identity (§1), retry |
| `lock timeout` / hang > 30 s | long transaction on a News table | cancel; nothing changed; preflight check 80; retry later |
| `News boundary FAILED after V2 migration` / `News V2 RPC grants are wrong` | the migration's own safety assertions failed | transaction aborts; **do not retry**; investigate with the preflight output |
| success but postcheck FAIL | environment differs from the rehearsal | §10 rollback, then analyse |

## 10. Rollback — what is actually tested, and what is not

`database/public-read/ops/news_v2_rollback.sql` (psql only: it uses `\ir`; run from the repository root as `postgres`):

1. re-applies migration **0010** (idempotent: `create or replace` + `add column if not exists`), which restores the previous bodies of `news_apply_sync`, `news_list`, `news_featured`, `news_entry`;
2. drops **only** the V2-only objects: `web_api.news_cards`, `pub_admin.news_revision_batch`, `pub_admin.news_health_snapshot`, view `pub.news_card_entries`.

**Verified (rehearsal on PG 17.5):** restored function bodies have **exactly the production md5s** (`91906882…`, `98330e35…`, `3f70fbfc…`, `960b2e1e…`) and the **same ACL** as production; the script exits 0; **no row is deleted** (entries, versions, tracked topics, verified staff all kept); re-applying 0011 afterwards restores everything.

**What it does NOT do (by design):** it keeps the new columns, tables and seeded/ingested data (harmless to V1; lets a re-apply resume). It does not undo anything the V2 collector stored — V2 replies simply become invisible again because the 0010 read functions only expose `post_number = 1`.

**Behaviour measured with each component (important):**

| State when the rollback runs | Result |
|---|---|
| **G0 state — V1 collector + V1 website only (this runbook)** | ✅ **Safe and tested.** V1 website output unchanged; V1 collector unaffected (same results before/after) |
| V2 website deployed | ❌ **Breaks the news pages**: `web_api.news_cards` no longer exists → `public_data_unavailable` (homepage falls back to an empty section). Roll the **website back first** (Vercel "promote previous deployment"; it is compatible with the DB at every stage) |
| V2 Edge Function deployed, normal/revision runs | works (replies are skipped by the 0010 guard; revision context RPC missing is tolerated) |
| V2 Edge Function, **backfill** | **Hazard found and fixed in this PR**: the 0010 `news_apply_sync` ignores `dryRun`, so a preview *wrote* 34 rows in the rehearsal. The function now refuses any backfill unless the V2 schema answers (`preflight`), without fetching or writing; verified against the rolled-back DB (0 writes) |

So the safe rollback order, once later gates are done, is **website → Edge Function → database**. At G0 only the last step exists.

If a **restore from the dump** were ever needed instead (platform fault): restore into a *new* project first and compare with the §4 fingerprint; this path is untested here and is the last resort only.

## 11. After G0

Leave everything else untouched. G1 (deploy the Edge Function, manual run ×2) needs its own approval; the order remains database → Edge Function → merge/website → backfill.
