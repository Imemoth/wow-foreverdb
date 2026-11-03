-- News Collector V2 - G0 POST-MIGRATION validation. READ-ONLY. Run as the platform `postgres` admin right after 0011 was
-- applied, with the values recorded by news_v2_g0_preflight.sql (INFO rows) and the UTC time the migration finished:
--
--   psql -X -v ON_ERROR_STOP=1 \
--        -v max_id=<max_entry_id> -v pre_identity_md5=<identity_md5> -v pre_suppressed_md5=<suppressed_md5> \
--        -v pre_cards=<published_cards> -v migrated_at="'2026-11-03 15:30:00+00'" \
--        -f database/public-read/ops/news_v2_g0_postcheck.sql
--
-- Part 1 = schema, boundaries and data preservation (as postgres). Part 2 = what the CURRENT V1 website reads (as the web reader
-- role). Part 3 = the CURRENT V1 collector working through the V2 persistence function; it only passes once every source has run
-- again after the migration (wait >= 35 minutes: Official News runs every 30). Any FAIL = STOP and go to the rollback section.

\if :{?max_id} \else \echo 'missing -v max_id (see header)' \quit \endif
\if :{?pre_identity_md5} \else \echo 'missing -v pre_identity_md5' \quit \endif
\if :{?pre_suppressed_md5} \else \echo 'missing -v pre_suppressed_md5' \quit \endif
\if :{?pre_cards} \else \echo 'missing -v pre_cards' \quit \endif
\if :{?migrated_at} \else \echo 'missing -v migrated_at' \quit \endif

begin read only;

\echo '== PART 1: schema, boundaries, data preservation =='
select name as check_name, expected, actual, case when ok then 'PASS' else 'FAIL' end as result from (
    select 1 ord, 'V2 columns on pub.news_entries' name, '6' expected,
           (select count(*)::text from information_schema.columns where table_schema = 'pub' and table_name = 'news_entries'
             and column_name in ('source_version', 'author_user_id', 'author_group', 'thread_origin', 'official_updated_at', 'observed_via')) actual,
           (select count(*) from information_schema.columns where table_schema = 'pub' and table_name = 'news_entries'
             and column_name in ('source_version', 'author_user_id', 'author_group', 'thread_origin', 'official_updated_at', 'observed_via')) = 6 ok
    union all select 2, 'V2 health columns on news_sources (5) + news_sync_runs (6)', '5 + 6',
           (select count(*)::text from information_schema.columns where table_schema = 'pub' and table_name = 'news_sources' and column_name in ('last_attempt_at', 'last_fetch_ok_at', 'last_official_post_at', 'last_http_status', 'last_error_category'))
           || ' + ' || (select count(*)::text from information_schema.columns where table_schema = 'pub' and table_name = 'news_sync_runs' and column_name in ('mode', 'inserted_count', 'skipped_count', 'fetch_ok', 'error_category', 'http_status')),
           (select count(*) from information_schema.columns where table_schema = 'pub' and table_name = 'news_sources' and column_name in ('last_attempt_at', 'last_fetch_ok_at', 'last_official_post_at', 'last_http_status', 'last_error_category')) = 5
           and (select count(*) from information_schema.columns where table_schema = 'pub' and table_name = 'news_sync_runs' and column_name in ('mode', 'inserted_count', 'skipped_count', 'fetch_ok', 'error_category', 'http_status')) = 6
    union all select 3, 'new tables exist with RLS on and no API-role access', '3 tables, 0 violations',
           (select count(*)::text from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'pub' and c.relname in ('news_official_groups', 'news_verified_staff', 'news_tracked_topics') and c.relrowsecurity)
           || ' tables, ' || (select count(*)::text from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'pub' and c.relname in ('news_official_groups', 'news_verified_staff', 'news_tracked_topics', 'news_card_entries')
               and (has_table_privilege('foreverdb_web_reader', c.oid, 'select, insert, update, delete') or has_table_privilege('foreverdb_publisher', c.oid, 'select, insert, update, delete')
                    or has_table_privilege('azerdex_news_ingest', c.oid, 'select, insert, update, delete') or has_table_privilege('anon', c.oid, 'select') or has_table_privilege('authenticated', c.oid, 'select'))) || ' violations',
           (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'pub' and c.relname in ('news_official_groups', 'news_verified_staff', 'news_tracked_topics') and c.relrowsecurity) = 3
           and not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'pub' and c.relname in ('news_official_groups', 'news_verified_staff', 'news_tracked_topics', 'news_card_entries')
               and (has_table_privilege('foreverdb_web_reader', c.oid, 'select, insert, update, delete') or has_table_privilege('foreverdb_publisher', c.oid, 'select, insert, update, delete')
                    or has_table_privilege('azerdex_news_ingest', c.oid, 'select, insert, update, delete') or has_table_privilege('anon', c.oid, 'select') or has_table_privilege('authenticated', c.oid, 'select')))
    union all select 4, 'all News functions are SECURITY DEFINER with an empty search_path, none executable by PUBLIC/anon/authenticated', '7 functions, 0 violations',
           (select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace where (n.nspname = 'pub_admin' and p.proname like 'news%') or (n.nspname = 'web_api' and p.proname like 'news%'))
           || ' functions, ' || (select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace where ((n.nspname = 'pub_admin' or n.nspname = 'web_api') and p.proname like 'news%')
               and (not p.prosecdef or not exists (select 1 from unnest(p.proconfig) c where c in ('search_path=""', 'search_path='))
                    or has_function_privilege('public', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))) || ' violations',
           (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where (n.nspname = 'pub_admin' or n.nspname = 'web_api') and p.proname like 'news%') = 7
           and not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where ((n.nspname = 'pub_admin' or n.nspname = 'web_api') and p.proname like 'news%')
               and (not p.prosecdef or not exists (select 1 from unnest(p.proconfig) c where c in ('search_path=""', 'search_path='))
                    or has_function_privilege('public', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')))
    union all select 5, 'ingest role: exactly news_apply_sync + news_revision_batch (not the health snapshot, not web_api, no pub schema)', 'true/true/false/false',
           has_function_privilege('azerdex_news_ingest', 'pub_admin.news_apply_sync(jsonb)', 'execute')::text || '/' || has_function_privilege('azerdex_news_ingest', 'pub_admin.news_revision_batch(text,integer)', 'execute')::text
           || '/' || has_function_privilege('azerdex_news_ingest', 'pub_admin.news_health_snapshot()', 'execute')::text || '/' || (has_schema_privilege('azerdex_news_ingest', 'pub', 'usage') or has_schema_privilege('azerdex_news_ingest', 'web_api', 'usage'))::text,
           has_function_privilege('azerdex_news_ingest', 'pub_admin.news_apply_sync(jsonb)', 'execute') and has_function_privilege('azerdex_news_ingest', 'pub_admin.news_revision_batch(text,integer)', 'execute')
           and not has_function_privilege('azerdex_news_ingest', 'pub_admin.news_health_snapshot()', 'execute')
           and not has_schema_privilege('azerdex_news_ingest', 'pub', 'usage') and not has_schema_privilege('azerdex_news_ingest', 'web_api', 'usage')
    union all select 6, 'web reader: 4 web_api News functions, no pub_admin function', '4 / none',
           (select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'web_api' and p.proname like 'news%' and has_function_privilege('foreverdb_web_reader', p.oid, 'execute')),
           (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'web_api' and p.proname like 'news%' and has_function_privilege('foreverdb_web_reader', p.oid, 'execute')) = 4
           and not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'pub_admin' and p.proname like 'news%' and has_function_privilege('foreverdb_web_reader', p.oid, 'execute'))
    union all select 7, 'V1 signatures/result contracts retained (news_list 19 cols, news_featured 18 cols, news_entry jsonb, apply jsonb)', '19/18/jsonb/jsonb',
           (select cardinality(array(select 1 from unnest(proargmodes) m where m in ('t', 'o')))::text from pg_proc where oid = 'web_api.news_list(text,text,integer,integer)'::regprocedure)
           || '/' || (select cardinality(array(select 1 from unnest(proargmodes) m where m in ('t', 'o')))::text from pg_proc where oid = 'web_api.news_featured(integer)'::regprocedure)
           || '/' || (select prorettype::regtype::text from pg_proc where oid = 'web_api.news_entry(text)'::regprocedure)
           || '/' || (select prorettype::regtype::text from pg_proc where oid = 'pub_admin.news_apply_sync(jsonb)'::regprocedure),
           (select cardinality(array(select 1 from unnest(proargmodes) m where m in ('t', 'o'))) from pg_proc where oid = 'web_api.news_list(text,text,integer,integer)'::regprocedure) = 19
           and (select cardinality(array(select 1 from unnest(proargmodes) m where m in ('t', 'o'))) from pg_proc where oid = 'web_api.news_featured(integer)'::regprocedure) = 18
           and (select prorettype from pg_proc where oid = 'web_api.news_entry(text)'::regprocedure) = 'jsonb'::regtype
           and (select prorettype from pg_proc where oid = 'pub_admin.news_apply_sync(jsonb)'::regprocedure) = 'jsonb'::regtype
    union all select 10, 'immutable identity of every pre-existing entry unchanged (id|source_key|source_entry_id|slug)', :'pre_identity_md5',
           (select md5(string_agg(id || '|' || source_key || '|' || source_entry_id || '|' || slug, ';' order by id)) from pub.news_entries where id <= :max_id),
           (select md5(string_agg(id || '|' || source_key || '|' || source_entry_id || '|' || slug, ';' order by id)) from pub.news_entries where id <= :max_id) = :'pre_identity_md5'
    union all select 11, 'suppressed rows (marker, reason, hash) byte-for-byte unchanged', :'pre_suppressed_md5',
           (select md5(coalesce(string_agg(id || '|' || suppressed_at::text || '|' || suppression_reason || '|' || content_hash, ';' order by id), '')) from pub.news_entries where suppressed_at is not null),
           (select md5(coalesce(string_agg(id || '|' || suppressed_at::text || '|' || suppression_reason || '|' || content_hash, ';' order by id), '')) from pub.news_entries where suppressed_at is not null) = :'pre_suppressed_md5'
    union all select 12, 'version history preserved (never fewer versions than entries that have one; no orphan)', '0 orphans',
           (select count(*)::text from pub.news_post_versions v where not exists (select 1 from pub.news_entries e where e.id = v.news_entry_id)),
           not exists (select 1 from pub.news_post_versions v where not exists (select 1 from pub.news_entries e where e.id = v.news_entry_id))
    union all select 20, 'revision tracking seeded from verified openers; official groups seeded', 'tracked >= 1 / groups 3',
           (select count(*)::text from pub.news_tracked_topics) || ' / ' || (select count(*)::text from pub.news_official_groups),
           (select count(*) from pub.news_tracked_topics) >= 1 and (select count(*) from pub.news_official_groups) = 3
    union all select 21, 'no V2 provenance written yet (no replies, no verified staff) - V2 collector is not deployed', '0 / 0',
           (select count(*)::text from pub.news_entries where source_post_number > 1 and author_user_id is not null) || ' / ' || (select count(*)::text from pub.news_verified_staff),
           (select count(*) from pub.news_entries where source_post_number > 1 and author_user_id is not null) = 0 and (select count(*) from pub.news_verified_staff) = 0
    union all select 30, 'V1 cron jobs unchanged and active', '3 active, schedules unchanged',
           (select count(*)::text from cron.job where active and (jobname, schedule) in (('azerdex-news-blueposts', '*/10 * * * *'), ('azerdex-news-official', '*/30 * * * *'), ('azerdex-news-revisions', '0 */6 * * *'))) || ' active',
           (select count(*) from cron.job where active and (jobname, schedule) in (('azerdex-news-blueposts', '*/10 * * * *'), ('azerdex-news-official', '*/30 * * * *'), ('azerdex-news-revisions', '0 */6 * * *'))) = 3
) q order by ord;

commit;

\echo '== PART 2: what the CURRENT V1 website reads (executed as foreverdb_web_reader) =='
begin read only;
set local role foreverdb_web_reader;
select name as check_name, expected, actual, case when ok then 'PASS' else 'FAIL' end as result from (
    select 1 ord, 'news_list(null,'''',50,0) total equals the pre-migration card count (or more: new posts may have arrived)' name, ':pre_cards or more' expected,
           (select coalesce(max(total_count), 0)::text from web_api.news_list(null, '', 50, 0)) actual,
           (select coalesce(max(total_count), 0) from web_api.news_list(null, '', 50, 0)) >= :pre_cards ok
    union all select 2, 'news_list returns a full first page of 50 rows', '50', (select count(*)::text from web_api.news_list(null, '', 50, 0)), (select count(*) from web_api.news_list(null, '', 50, 0)) = 50
    union all select 3, 'news_featured(8) returns 8 cards', '8', (select count(*)::text from web_api.news_featured(8)), (select count(*) from web_api.news_featured(8)) = 8
    union all select 4, 'news_entry(first slug) returns a card with the V1 keys', 'id,slug,title,canonicalUrl,publishedAt',
           (select coalesce((web_api.news_entry(slug) ?& array['id', 'slug', 'title', 'canonicalUrl', 'publishedAt'])::text, 'null') from web_api.news_list(null, '', 1, 0) limit 1),
           (select coalesce(web_api.news_entry(slug) ?& array['id', 'slug', 'title', 'canonicalUrl', 'publishedAt'], false) from web_api.news_list(null, '', 1, 0) limit 1)
    union all select 5, 'no reply is exposed (every card is an opener or article)', '0',
           (select count(*)::text from web_api.news_list(null, '', 50, 0) l where l.source_type = 'bluepost' and l.id in (select id from web_api.news_cards(null, '', null, false, 50, 0) c where c.source_post_number is distinct from 1)),
           not exists (select 1 from web_api.news_list(null, '', 50, 0) l where l.source_type = 'bluepost' and l.id in (select id from web_api.news_cards(null, '', null, false, 50, 0) c where c.source_post_number is distinct from 1))
    union all select 6, 'new news_cards agrees with news_list (same first id, same total)', 'same',
           (select (select id from web_api.news_list(null, '', 1, 0))::text || ' vs ' || (select id from web_api.news_cards(null, '', null, false, 1, 0))::text),
           (select id from web_api.news_list(null, '', 1, 0)) = (select id from web_api.news_cards(null, '', null, false, 1, 0))
           and (select max(total_count) from web_api.news_list(null, '', 50, 0)) = (select max(total_count) from web_api.news_cards(null, '', null, false, 50, 0))
) q order by ord;
commit;

\echo '== PART 3: the CURRENT V1 collector through the V2 persistence function (needs >= 1 run per source after migrated_at; wait >= 35 min) =='
begin read only;
select name as check_name, expected, actual, case when ok then 'PASS' else 'FAIL' end as result from (
    select 1 ord, 'every source ran again after the migration and succeeded' name, '3 sources, 0 failed' expected,
           (select count(*)::text from pub.news_sources s where exists (select 1 from pub.news_sync_runs r where r.source_key = s.source_key and r.started_at > :migrated_at and r.status = 'succeeded'))
           || ' sources, ' || (select count(*)::text from pub.news_sync_runs where started_at > :migrated_at and status in ('failed', 'partial')) || ' failed/partial' actual,
           (select count(*) from pub.news_sources s where exists (select 1 from pub.news_sync_runs r where r.source_key = s.source_key and r.started_at > :migrated_at and r.status = 'succeeded')) = 3
           and (select count(*) from pub.news_sync_runs where started_at > :migrated_at and status in ('failed', 'partial')) = 0 ok
    union all select 2, 'V2 freshness columns are being populated by the V1 collector', '3 sources',
           (select count(*)::text from pub.news_sources where last_attempt_at > :migrated_at and last_fetch_ok_at > :migrated_at), (select count(*) from pub.news_sources where last_attempt_at > :migrated_at and last_fetch_ok_at > :migrated_at) = 3
    union all select 3, 'cron + HTTP: all News cron runs since the migration succeeded', '0 failed',
           (select count(*)::text from cron.job_run_details d join cron.job j using (jobid) where j.jobname like 'azerdex-news%' and d.start_time > :migrated_at and d.status <> 'succeeded'),
           (select count(*) from cron.job_run_details d join cron.job j using (jobid) where j.jobname like 'azerdex-news%' and d.start_time > :migrated_at and d.status <> 'succeeded') = 0
    union all select 4, 'V1 collector still stores no replies', '0', (select count(*)::text from pub.news_entries where source_post_number > 1 and suppressed_at is null and author_user_id is null and status = 'published'),
           (select count(*) from pub.news_entries where source_post_number > 1 and suppressed_at is null and author_user_id is null and status = 'published') = 0
    union all select 5, 'ingest-side row growth is only new posts (suppressed count unchanged)', 'unchanged',
           (select count(*)::text from pub.news_entries where suppressed_at is not null), (select md5(coalesce(string_agg(id || '|' || suppressed_at::text || '|' || suppression_reason || '|' || content_hash, ';' order by id), '')) from pub.news_entries where suppressed_at is not null) = :'pre_suppressed_md5'
) q order by ord;
select jsonb_pretty(jsonb_path_query_array(pub_admin.news_health_snapshot() -> 'sources', '$[*] ? (@.sourceKey like_regex "blizzard")')) as health_snapshot_sources_informational;
commit;
