# AzerDex News Integration V1

## Source findings

Verified on 2026-10-22 from the feature branch environment:

- US Blue Tracker: `https://us.forums.blizzard.com/en/wow/groups/blizzard-tracker/posts.json` returned HTTP 200 JSON with a top-level `posts` array of 20 records. Records exposed stable `id`, `topic_id`, `post_number`, `posts_count`, `username`, `name`, `created_at`, optional `updated_at`, `category_id`, `topic_title`, `topic_slug`, `excerpt`, and a relative `url`. The first page included current WoW: Forever posts from Zorbrix, BlizzardEntertainment, and Kaivax as well as unrelated Midnight posts.
- EU Blue Tracker: `https://eu.forums.blizzard.com/en/wow/groups/blizzard-tracker/posts.json` returned the same shape and 20 records. It included the EU-localized WoW: Forever posts and replies. The collector keeps US and EU `source_key`, region, topic, and post IDs separate.
- Official news: `https://worldofwarcraft.blizzard.com/en-us/news` returned HTTP 200 HTML. The page uses the first-party `https://worldofwarcraft.blizzard.com/en-us/news/river.frag?page=N` fragment for its paginated news river. The fragment exposes article IDs in `/news/<id>/<slug>` links, titles, short descriptions, and ISO timestamps in `data-props`. No supported RSS/JSON feed was found in the page or its linked resources, so the fragment is the least fragile official method currently available and is covered by parser tests.

The Blue Tracker endpoint did not expose a usable `next_page` value during verification; the collector treats the returned page as the incremental window and follows pagination only when the response explicitly declares a next page. Official news follows the first-party fragment for up to three pages and stops on a short or repeated page. This limits external requests and avoids pretending that an unsupported `page` parameter is pagination.

Relevance is conservative. A record is published only when its title/excerpt clearly identifies WoW: Forever. Records with an ambiguous standalone “Forever” mention are stored as `review`; Retail, Midnight, Classic, and unrelated Blizzard records remain `rejected`. Patch Notes are only labelled when the title explicitly contains “patch notes” or “hotfix”.

## Storage and boundary

`database/public-read/migrations/0002_news_model.sql` adds independent `pub.news_sources`, `pub.news_entries`, `pub.news_post_versions`, and `pub.news_sync_runs` tables. The collector calls `pub_admin.news_apply_sync(jsonb)`, which is idempotent on `(source_key, source_entry_id)` and stores a version snapshot only when the content hash changes. The web reader can execute only the bounded `web_api.news_list`, `web_api.news_featured`, and `web_api.news_entry` functions; it has no table privileges and no write path.

`database/public-read/migrations/0008_news_ingest_role.sql` creates the separate `azerdex_news_ingest` LOGIN role and `0009_news_ingest_search_path.sql` restricts its session `search_path` to `pub_admin, pg_catalog`. It has `USAGE` only on `pub_admin` and `EXECUTE` only on `pub_admin.news_apply_sync(jsonb)`. It has no direct project table privileges, no `pub` or `web_api` schema usage, and does not replace or alter the existing `foreverdb_publisher` NOLOGIN boundary. The password is provisioned out of band and is never stored in the repository. `database/public-read/tests/news_ingest_role_security.sql` is run over the real ingestion connection after password provisioning; it verifies the authenticated identity, RPC execution, and transactional rollback.

Supabase-owned extension objects are a platform-level exception: this project cannot deny PUBLIC grants on `net` objects to only one login role without changing shared `pg_net` behaviour. The News role has no project ACLs on those objects, and its restricted `search_path` prevents accidental unqualified resolution. The authenticated test and application privilege audit treat project tables/functions as the enforceable boundary and record platform residuals separately.

The existing editorial Markdown system remains the AzerDex-authored archive. Database-backed news uses `/news/entry/<slug>`, leaving the established `/news/<slug>` editorial route unchanged.

`database/public-read/tests/news_model_security.sql` checks RLS, direct table privileges, and function grants. `database/public-read/tests/news_model_behavior.sql` runs transactional insert, identical-hash no-op, revision snapshot, and partial-error audit assertions, then rolls everything back.

## Bluepost deduplication hotfix

The collector now admits only `post_number = 1` from the authoritative US/EU
Blizzard Tracker feed. Revision mode may refresh a topic only when its opener's
post ID was already proven by that feed; a full topic response containing a
player opener and a Blizzard reply is therefore ignored. Revision updates keep
the opener's `created_at` publication timestamp and do not change its featured
state. Official News parsing is unchanged.

`database/public-read/migrations/0010_news_bluepost_suppression.sql` adds only
the nullable `suppressed_at` and `suppression_reason` markers and defense-in-
depth predicates/ingestion guards. It does not modify historical rows. Public
list, featured, and detail functions hide both marked rows and any non-opener
Bluepost, while the existing `pub_admin`/`web_api` least-privilege boundary is
retained.

The confirmed cleanup projection is:

| Measure | Before | After cleanup |
| --- | ---: | ---: |
| Total stored News rows | 701 | 701 |
| Published News rows visible | 409 | 66 |
| Published Blueposts visible | 371 | 28 |
| Legitimate Bluepost openers retained | 28 | 28 |
| Published Bluepost replies visible | 343 | 0 |
| Published Bluepost replies suppressed | 0 | 343 |
| Published Bluepost topics represented | 29 | 28 |
| Stored Bluepost topics across all statuses | 43 | 43 |
| Distinct visible Bluepost topics | 29 | 28 |

These are projected counts from the confirmed live-read findings; run
`database/public-read/ops/news_bluepost_dedup_dry_run.sql` first and attach its
JSON output to the change record. The safe order is:

1. Deploy and health-check the corrected collector code.
2. Apply `0010_news_bluepost_suppression.sql` on the isolated public-read database and run its SQL/security tests.
3. Run the dry-run report and compare its counts with the table above.
4. After explicit operator authorization, run `news_bluepost_dedup_apply.sql` with a unique UTC `cleanup_id` and the required confirmation token.
5. Re-run public read checks for archive pagination, search, RSS, sitemap, detail, homepage, and US/EU filters.

The apply script updates only suppression markers, writes an auditable
`pub.news_sync_runs` record, and never deletes entries or
`pub.news_post_versions`. If validation fails, run
`news_bluepost_dedup_rollback.sql` with the same `cleanup_id`; this clears only
that cleanup's marker. Non-opener Blueposts remain hidden after rollback by the
correctness invariant, and no unsafe reply publication is restored.

## Scheduling and activation

The intended Supabase `pg_cron` jobs are defined in `database/ops/0017_schedule_news_collector_vault.sql`:

| Job | Schedule | Sources |
| --- | --- | --- |
| `azerdex-news-blueposts` | every 10 minutes | US and EU Blue Tracker |
| `azerdex-news-official` | every 30 minutes | US official news |
| `azerdex-news-revisions` | every 6 hours | all sources, revision mode |

Before enabling the schedule, deploy `supabase/functions/azerdex-news-collector` and create the Vault secret `azerdex_news_collector_secret` in the `azerdex-public-read` project. The scheduler reads that secret at execution time; it never stores it in `private.azerdex_news_settings`, SQL source, or cron command text. The Edge Function needs a server-only `NEWS_DATABASE_URL` for the public-read `azerdex_news_ingest` role and `AZERDEX_NEWS_COLLECTOR_SECRET`. The unschedule script is `database/ops/0016_unschedule_news_collector.sql`.

### Operator credential procedure

Use the `azerdex-public-read` Supabase Dashboard and an operator password manager. Do not place any generated value in Git, a PR, a chat message, a shell command, or SQL Editor history. Do not rotate the existing `foreverdb_web_reader`, `foreverdb_publisher`, or account-system credentials.

1. Generate one strong database password and one independent collector/scheduler secret (at least 24 characters) in the password manager.
2. Set only the new role's password through an interactive direct database session. The command below contains no password; `psql` prompts for the existing admin password and `\password` prompts twice for the new role password without putting either value in command history:

   ```powershell
   psql -X -W "host=db.chcoypkjzxfznsqmmbrq.supabase.co port=5432 dbname=postgres user=postgres sslmode=require"
   \password azerdex_news_ingest
   \q
   ```

   Confirm the password prompt is completed before leaving the terminal. Do not use an `ALTER ROLE ... PASSWORD '...'` statement in SQL Editor.
3. In Supabase Dashboard → Edge Functions → `azerdex-news-collector` → Secrets, add/update exactly these two server-side secrets. Paste values directly from the password manager; do not put them into chat, GitHub, a repository file, or shell history:

   ```text
   NEWS_DATABASE_URL=postgresql://azerdex_news_ingest.chcoypkjzxfznsqmmbrq:<url-encoded-database-password>@aws-0-eu-west-1.pooler.supabase.com:6543/postgres?sslmode=require
   AZERDEX_NEWS_COLLECTOR_SECRET=<the-same-collector-scheduler-secret>
   ```

   The pooler endpoint is the verified EU Supavisor transaction-pooler endpoint for this project. Keep `sslmode=require`; the Deno PostgreSQL client used by the Edge Function accepts this standard PostgreSQL URL. URL-encode reserved characters in the password. If CLI provisioning is required instead, use `supabase secrets set --project-ref chcoypkjzxfznsqmmbrq --env-file <protected-temporary-file>` and delete the file immediately after confirmation.
4. In Supabase Dashboard → Database → Vault, create/update the secret with name `azerdex_news_collector_secret`. Do not paste the value into SQL Editor history, GitHub, chat, or a local file. The configured Vault value must be the same shared value already stored as `AZERDEX_NEWS_COLLECTOR_SECRET` in the Edge Function.

   Do not run the deprecated local helper `database/ops/configure_news_scheduler_secret.ps1`; it is intentionally disabled.


5. From the protected environment, run `database/public-read/tests/news_ingest_role_security.sql` through the new `NEWS_DATABASE_URL`:

   ```powershell
   psql -X -W "host=aws-0-eu-west-1.pooler.supabase.com port=6543 dbname=postgres user=azerdex_news_ingest.chcoypkjzxfznsqmmbrq sslmode=require" -f .\database\public-read\tests\news_ingest_role_security.sql
   ```

   The password is entered only at the prompt. Then call the Edge Function twice from the protected terminal with the matching `x-azerdex-news-secret` header and the same `{}` body. Record each response's source/run counts, and after each call run the read-only persistence query below as an administrator connection. The second call must not increase `pub.news_entries` or `pub.news_post_versions` for unchanged content; `pub.news_sync_runs` may increase because each attempt is audited.

   ```powershell
   $collectorSecret = Read-Host 'Collector secret' -AsSecureString
   $secretBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($collectorSecret)
   try {
       $secret = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretBstr)
       $headers = @{ 'x-azerdex-news-secret' = $secret }
       Invoke-RestMethod -Method Post -Uri 'https://chcoypkjzxfznsqmmbrq.supabase.co/functions/v1/azerdex-news-collector' -Headers $headers -ContentType 'application/json' -Body '{}'
   }
   finally {
       [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretBstr)
       Remove-Variable secret, headers, collectorSecret -ErrorAction SilentlyContinue
   }
   ```

   Repeat that block once more with the same protected secret. It keeps the secret out of the command line, PowerShell history, SQL Editor history, GitHub, and chat. Do not redirect the response to a file that is committed or shared.

   For each checkpoint, the administrator-only persistence query is:

   ```sql
   select
     (select count(*) from pub.news_sources) as sources,
     (select count(*) from pub.news_entries) as entries,
     (select count(*) from pub.news_post_versions) as post_versions,
     (select count(*) from pub.news_sync_runs) as sync_runs;
   ```

   Continue only if the role test passes, the collector returns success for the live US/EU/official sources, entries are persisted, and the repeated call is idempotent.

6. After the authenticated role test, manual ingestion, and idempotency check pass, apply `database/ops/0017_schedule_news_collector_vault.sql` through the authenticated Supabase integration. It creates only the URL row, reads the Vault secret at each execution, and creates/replaces only the three News jobs. It does not touch existing cron jobs.

   Verify all three jobs and their latest execution:

   ```sql
   select j.jobname, j.schedule, j.active,
          r.status, r.start_time, r.end_time, r.return_message
   from cron.job j
   left join lateral (
     select status, start_time, end_time, return_message
     from cron.job_run_details
     where jobid = j.jobid
     order by start_time desc
     limit 1
   ) r on true
   where j.jobname in ('azerdex-news-blueposts', 'azerdex-news-official', 'azerdex-news-revisions')
   order by j.jobname;
   ```

The schedule is activated through the Supabase integration after the live ingestion gates pass; it does not require a Vercel redeployment.

## Manual diagnostics

Send a POST to the deployed function with the configured `x-azerdex-news-secret` header. Use `{}` for the normal run, `{"sourceKeys":["blizzard-bluepost-us"],"mode":"normal"}` for one source, or `{"mode":"revision"}` for the six-hour mode. The response contains per-source counts and failures; one failed region does not disable the other sources. Published rows remain available during source outages.

The web layer has a one-minute in-process data TTL. The page itself remains dynamic because the existing CSP nonce architecture requires it, so new database rows become visible without a deployment after the TTL expires.
