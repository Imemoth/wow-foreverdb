-- News Collector V2 - G0 PRE-MIGRATION checks. READ-ONLY (one SELECT; no writes, no DDL). Run as the platform `postgres`
-- admin on the azerdex-public-read project IMMEDIATELY before applying 0011. Every `result` must be PASS (INFO rows are values
-- to record). Any FAIL = STOP: do not apply the migration.
--
--   psql -X -v ON_ERROR_STOP=1 -f database/public-read/ops/news_v2_g0_preflight.sql
--
-- Counts, names, timestamps and md5 fingerprints only. Nothing here reads an excerpt, a credential or a connection string.
-- The function fingerprints below were recorded from production on 2026-11-03 and equal what migrations 0001-0010 produce.

with
fp(fn, md5) as (values
    ('pub_admin.news_apply_sync(jsonb)',            '91906882fa36f57541507da7c771908a'),
    ('web_api.news_entry(text)',                    '98330e35074fe6ef66d859add48da11a'),
    ('web_api.news_featured(integer)',              '3f70fbfca8e3d4322a3f44315dbcc345'),
    ('web_api.news_list(text,text,integer,integer)', '960b2e1e5b91e915703f7818213edae5')),
checks(ord, name, expected, actual, ok) as (
    select 10, 'database identity: News tables + 3 expected sources present', '3 sources',
           (select count(*)::text from pub.news_sources where source_key in ('blizzard-bluepost-us', 'blizzard-bluepost-eu', 'blizzard-news-us')) || ' sources',
           (select count(*) from pub.news_sources where source_key in ('blizzard-bluepost-us', 'blizzard-bluepost-eu', 'blizzard-news-us')) = 3
    union all
    select 11, 'database identity: ingest/web/publisher roles exist', '3 roles',
           (select count(*)::text from pg_roles where rolname in ('azerdex_news_ingest', 'foreverdb_web_reader', 'foreverdb_pub_owner')) || ' roles',
           (select count(*) from pg_roles where rolname in ('azerdex_news_ingest', 'foreverdb_web_reader', 'foreverdb_pub_owner')) = 3
    union all
    select 20, '0011 not applied: no V2 columns on pub.news_entries', '0',
           (select count(*)::text from information_schema.columns where table_schema = 'pub' and table_name = 'news_entries'
             and column_name in ('source_version', 'author_user_id', 'author_group', 'thread_origin', 'official_updated_at', 'observed_via')),
           (select count(*) from information_schema.columns where table_schema = 'pub' and table_name = 'news_entries'
             and column_name in ('source_version', 'author_user_id', 'author_group', 'thread_origin', 'official_updated_at', 'observed_via')) = 0
    union all
    select 21, '0011 not applied: no V2 tables/view/functions', '0',
           ((select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'pub'
               and c.relname in ('news_official_groups', 'news_verified_staff', 'news_tracked_topics', 'news_card_entries'))
            + (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where (n.nspname, p.proname) in (('web_api', 'news_cards'), ('pub_admin', 'news_revision_batch'), ('pub_admin', 'news_health_snapshot'))))::text,
           ((select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'pub'
               and c.relname in ('news_official_groups', 'news_verified_staff', 'news_tracked_topics', 'news_card_entries'))
            + (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where (n.nspname, p.proname) in (('web_api', 'news_cards'), ('pub_admin', 'news_revision_batch'), ('pub_admin', 'news_health_snapshot')))) = 0
    union all
    select 30, '0010 state: suppression columns present', '2',
           (select count(*)::text from information_schema.columns where table_schema = 'pub' and table_name = 'news_entries' and column_name in ('suppressed_at', 'suppression_reason')),
           (select count(*) from information_schema.columns where table_schema = 'pub' and table_name = 'news_entries' and column_name in ('suppressed_at', 'suppression_reason')) = 2
    union all
    select 40 + row_number() over (order by fp.fn), 'function body equals repository 0010: ' || fp.fn, fp.md5,
           coalesce((select md5(pg_get_functiondef(p.oid)) from pg_proc p where p.oid = to_regprocedure(fp.fn)), 'MISSING'),
           coalesce((select md5(pg_get_functiondef(p.oid)) from pg_proc p where p.oid = to_regprocedure(fp.fn)), 'MISSING') = fp.md5
      from fp
    union all
    select 50, 'boundary: News tables have RLS and no API-role access', 'none',
           (select count(*)::text from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'pub' and c.relname like 'news%' and c.relkind = 'r'
               and (not c.relrowsecurity
                    or has_table_privilege('foreverdb_web_reader', c.oid, 'select, insert, update, delete')
                    or has_table_privilege('foreverdb_publisher', c.oid, 'select, insert, update, delete')
                    or has_table_privilege('azerdex_news_ingest', c.oid, 'select, insert, update, delete')
                    or has_table_privilege('anon', c.oid, 'select') or has_table_privilege('authenticated', c.oid, 'select'))) || ' violations',
           not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where n.nspname = 'pub' and c.relname like 'news%' and c.relkind = 'r'
               and (not c.relrowsecurity
                    or has_table_privilege('foreverdb_web_reader', c.oid, 'select, insert, update, delete')
                    or has_table_privilege('foreverdb_publisher', c.oid, 'select, insert, update, delete')
                    or has_table_privilege('azerdex_news_ingest', c.oid, 'select, insert, update, delete')
                    or has_table_privilege('anon', c.oid, 'select') or has_table_privilege('authenticated', c.oid, 'select')))
    union all
    select 51, 'boundary: ingest role may execute exactly news_apply_sync', 'apply only',
           'apply=' || has_function_privilege('azerdex_news_ingest', 'pub_admin.news_apply_sync(jsonb)', 'execute')::text
           || ' schemas(pub,web_api)=' || (has_schema_privilege('azerdex_news_ingest', 'pub', 'usage') or has_schema_privilege('azerdex_news_ingest', 'web_api', 'usage'))::text,
           has_function_privilege('azerdex_news_ingest', 'pub_admin.news_apply_sync(jsonb)', 'execute')
           and not has_schema_privilege('azerdex_news_ingest', 'pub', 'usage') and not has_schema_privilege('azerdex_news_ingest', 'web_api', 'usage')
    union all
    select 52, 'boundary: web reader executes only the 3 web_api News functions', '3 / pub_admin none',
           (select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'web_api' and p.proname like 'news%' and has_function_privilege('foreverdb_web_reader', p.oid, 'execute')),
           (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'web_api' and p.proname like 'news%' and has_function_privilege('foreverdb_web_reader', p.oid, 'execute')) = 3
           and not has_function_privilege('foreverdb_web_reader', 'pub_admin.news_apply_sync(jsonb)', 'execute')
    union all
    select 60, 'V1 scheduler: 3 News cron jobs active with the expected schedules', '3',
           (select count(*)::text from cron.job where active and (jobname, schedule) in
              (('azerdex-news-blueposts', '*/10 * * * *'), ('azerdex-news-official', '*/30 * * * *'), ('azerdex-news-revisions', '0 */6 * * *'))),
           (select count(*) from cron.job where active and (jobname, schedule) in
              (('azerdex-news-blueposts', '*/10 * * * *'), ('azerdex-news-official', '*/30 * * * *'), ('azerdex-news-revisions', '0 */6 * * *'))) = 3
    union all
    select 61, 'V1 collector fresh: last success < 30 min (Tracker) / < 90 min (news)', 'all fresh',
           (select coalesce(string_agg(source_key || '=' || round(extract(epoch from now() - last_success_at) / 60)::text || 'min', ', ' order by source_key), 'none') from pub.news_sources),
           (select count(*) = 3 and bool_and(last_success_at > now() - case when source_type = 'official_news' then interval '90 minutes' else interval '30 minutes' end)
              from pub.news_sources)
    union all
    select 62, 'V1 collector: no failed/partial runs in the last 2 hours', '0',
           (select count(*)::text from pub.news_sync_runs where started_at > now() - interval '2 hours' and status in ('failed', 'partial')),
           (select count(*) from pub.news_sync_runs where started_at > now() - interval '2 hours' and status in ('failed', 'partial')) = 0
    union all
    select 63, 'V1 scheduler: no failed cron runs for News jobs in the last 2 hours', '0',
           (select count(*)::text from cron.job_run_details d join cron.job j using (jobid) where j.jobname like 'azerdex-news%' and d.start_time > now() - interval '2 hours' and d.status <> 'succeeded'),
           (select count(*) from cron.job_run_details d join cron.job j using (jobid) where j.jobname like 'azerdex-news%' and d.start_time > now() - interval '2 hours' and d.status <> 'succeeded') = 0
    union all
    select 70, 'no visible reply / future-dated row that V2 would hide', '0 / 0',
           (select count(*)::text from pub.news_entries n join pub.news_sources s using (source_key)
             where s.source_type = 'bluepost' and n.source_post_number is distinct from 1 and n.status = 'published' and n.suppressed_at is null)
           || ' / ' || (select count(*)::text from pub.news_entries where status = 'published' and suppressed_at is null and published_at > now() + interval '15 minutes'),
           (select count(*) from pub.news_entries n join pub.news_sources s using (source_key)
             where s.source_type = 'bluepost' and n.source_post_number is distinct from 1 and n.status = 'published' and n.suppressed_at is null) = 0
           and (select count(*) from pub.news_entries where status = 'published' and suppressed_at is null and published_at > now() + interval '15 minutes') = 0
    union all
    select 80, 'no long-running transaction that could block the DDL (> 2 min, other sessions)', '0',
           (select count(*)::text from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and xact_start < now() - interval '2 minutes' and state <> 'idle'),
           (select count(*) from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and xact_start < now() - interval '2 minutes' and state <> 'idle') = 0
    union all
    select 90, 'extensions pg_cron + pg_net present', '2',
           (select count(*)::text from pg_extension where extname in ('pg_cron', 'pg_net')),
           (select count(*) from pg_extension where extname in ('pg_cron', 'pg_net')) = 2
)
select check_name, expected, actual, result from (
    select ord, name as check_name, expected, actual, case when ok then 'PASS' else 'FAIL' end as result from checks
    union all
    select 1000, '== INFO: record as the BEFORE fingerprint ==', '', '', 'INFO'
    union all
    select 1001, 'counts', '',
           (select 'entries=' || count(*) || ' suppressed=' || count(*) filter (where suppressed_at is not null) || ' live=' || count(*) filter (where suppressed_at is null)
                  || ' versions=' || (select count(*) from pub.news_post_versions) from pub.news_entries), 'INFO'
    union all
    select 1002, 'max_entry_id (pass as :max_id to the post-check)', '', (select max(id)::text from pub.news_entries), 'INFO'
    union all
    select 1005, 'identity_md5 over id<=max_id: id|source_key|source_entry_id|slug (immutable columns) - pass as :pre_identity_md5', '',
           (select md5(string_agg(id || '|' || source_key || '|' || source_entry_id || '|' || slug, ';' order by id)) from pub.news_entries), 'INFO'
    union all
    select 1003, 'suppressed_md5 (suppressed rows incl. marker, reason, hash) - pass as :pre_suppressed_md5; MUST be unchanged', '',
           (select md5(coalesce(string_agg(id || '|' || suppressed_at::text || '|' || suppression_reason || '|' || content_hash, ';' order by id), '')) from pub.news_entries where suppressed_at is not null), 'INFO'
    union all
    select 1004, 'published_cards (live published threads; pass as :pre_cards)', '',
           (select count(*)::text from (select 1 from pub.news_entries n join pub.news_sources s using (source_key)
              where n.status = 'published' and n.suppressed_at is null and (s.source_type <> 'bluepost' or n.source_post_number = 1)
              group by coalesce(n.thread_key, 'entry:' || n.id)) q), 'INFO'
) r order by ord;
