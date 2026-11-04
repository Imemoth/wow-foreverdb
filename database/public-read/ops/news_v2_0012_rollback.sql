-- News Collector V2 - revision scheduling: ROLLBACK of migration 0012. OPERATOR. Pure SQL (psql or SQL editor), one transaction.
--
-- Restores ONLY pub_admin.news_revision_batch(text, integer) to its exact 0011 definition (the strict `next_check_at <= now()` due test),
-- with the 0011 owner (foreverdb_pub_owner), volatility, SECURITY DEFINER, empty search_path and ACL. No table, row, other function,
-- grant or cron job is touched. It deliberately does NOT re-apply the whole of 0011, which would replace news_apply_sync, news_list,
-- news_featured, news_entry, news_cards, news_health_snapshot... again and silently revert any later change to them.
--
-- Fail-closed preconditions: the current body must be exactly the 0012 definition (md5 149f9bd8a0f5191163108026ccbdbd84); any other body (drift or an
-- already-rolled-back function) aborts. Postconditions (abort = nothing changed): the body is exactly the 0011 definition
-- (md5 56dca40c9936352bd768db0993ed82a4, identical to production before 0012), owner/volatility/security/config/ACL are as in 0011, and the fingerprint of every
-- OTHER function in pub, pub_admin and web_api is unchanged.
begin;
set local role foreverdb_pub_owner;

create temp table g_other_fn on commit drop as
select p.oid::regprocedure::text as fn, md5(p.prosrc || '|' || coalesce(p.proacl::text, '') || '|' || p.prosecdef::text || '|' || coalesce(p.proconfig::text, '') || '|' || pg_get_userbyid(p.proowner)) as fp
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname in ('pub', 'pub_admin', 'web_api') and p.oid <> 'pub_admin.news_revision_batch(text,integer)'::regprocedure;

do $pre$
begin
    if not exists (select 1 from pg_proc where oid = 'pub_admin.news_revision_batch(text,integer)'::regprocedure and md5(prosrc) = '149f9bd8a0f5191163108026ccbdbd84') then
        raise exception '0012 rollback precondition failed: pub_admin.news_revision_batch is not the 0012 definition (drift or already rolled back)';
    end if;
end
$pre$;

create or replace function pub_admin.news_revision_batch(p_source_key text, p_limit integer default 25)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    v_type text;
begin
    if p_source_key is null or p_limit is null or p_limit < 1 or p_limit > 50 then
        raise exception using errcode = '22023', message = 'invalid_news_revision_request';
    end if;
    select source_type into v_type from pub.news_sources where source_key = p_source_key;
    if v_type is distinct from 'bluepost' then
        raise exception using errcode = '22023', message = 'invalid_news_revision_request';
    end if;
    return jsonb_build_object(
        'verifiedStaff', coalesce((
            select jsonb_agg(jsonb_build_object('userId', s.user_id, 'group', s.group_name))
            from pub.news_verified_staff s
            join pub.news_official_groups g on g.group_name = s.group_name
            where s.source_key = p_source_key), '[]'::jsonb),
        'dueTopics', coalesce((
            select jsonb_agg(jsonb_build_object('topicId', d.topic_id, 'threadOrigin', d.thread_origin,
                                                'consecutiveFailures', d.consecutive_failures,
                                                'lastOfficialAt', d.last_official_at, 'firstSeenAt', d.first_seen_at,
                                                'officialPostIds', to_jsonb(d.official_post_ids)) order by d.next_check_at)
            from (select t.* from pub.news_tracked_topics t
                  where t.source_key = p_source_key and t.next_check_at <= now()
                  order by t.next_check_at asc, t.topic_id limit p_limit) d), '[]'::jsonb),
        'knownOrigins', coalesce((
            select jsonb_agg(jsonb_build_object('topicId', k.topic_id, 'threadOrigin', k.thread_origin))
            from (select t.topic_id, t.thread_origin from pub.news_tracked_topics t
                  where t.source_key = p_source_key and t.thread_origin is not null
                  order by t.last_official_at desc nulls last limit 500) k), '[]'::jsonb)
    );
end;
$$;

revoke all on function pub_admin.news_revision_batch(text, integer) from public;
grant execute on function pub_admin.news_revision_batch(text, integer) to azerdex_news_ingest;

do $post$
begin
    if not exists (select 1 from pg_proc p where p.oid = 'pub_admin.news_revision_batch(text,integer)'::regprocedure
                    and md5(p.prosrc) = '56dca40c9936352bd768db0993ed82a4' and p.provolatile = 's' and p.prosecdef
                    and exists (select 1 from unnest(p.proconfig) c where c in ('search_path=""', 'search_path='))
                    and pg_get_userbyid(p.proowner) = 'foreverdb_pub_owner'
                    and p.proacl::text = '{foreverdb_pub_owner=X/foreverdb_pub_owner,azerdex_news_ingest=X/foreverdb_pub_owner}')
       or has_function_privilege('foreverdb_web_reader', 'pub_admin.news_revision_batch(text,integer)', 'execute')
       or has_function_privilege('anon', 'pub_admin.news_revision_batch(text,integer)', 'execute') then
        raise exception '0012 rollback postcondition failed: news_revision_batch is not the exact 0011 definition/ACL';
    end if;
    if exists (
        (select fn, fp from g_other_fn except select p.oid::regprocedure::text, md5(p.prosrc || '|' || coalesce(p.proacl::text, '') || '|' || p.prosecdef::text || '|' || coalesce(p.proconfig::text, '') || '|' || pg_get_userbyid(p.proowner))
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('pub', 'pub_admin', 'web_api') and p.oid <> 'pub_admin.news_revision_batch(text,integer)'::regprocedure)
        union all
        (select p.oid::regprocedure::text, md5(p.prosrc || '|' || coalesce(p.proacl::text, '') || '|' || p.prosecdef::text || '|' || coalesce(p.proconfig::text, '') || '|' || pg_get_userbyid(p.proowner))
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('pub', 'pub_admin', 'web_api') and p.oid <> 'pub_admin.news_revision_batch(text,integer)'::regprocedure
         except select fn, fp from g_other_fn)) then
        raise exception '0012 rollback postcondition failed: another function changed';
    end if;
end
$post$;

commit;
