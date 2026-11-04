-- ForeverDB PUBLIC READ MODEL 0012: News revision scheduling - due-time tolerance.
--
-- Defect (observed in production 2026-11-04): the revision job fires at exactly :00:00 every 6 hours, but a topic's next_check_at is
-- computed with now() INSIDE news_apply_sync, i.e. a few seconds to a few minutes AFTER that tick (one run handles several sources
-- one after the other). At the next tick the topic was "not yet due" (next_check_at = tick + a few seconds) and waited a whole extra
-- cycle. Effective cadence: 6 h tier -> 12 h, 24 h tier -> 30 h, weekly tier -> 7 d 6 h, back-offs 12/24/48 h -> 18/30/54 h.
-- Measured: the 12:00 UTC run checked 27 US / 26 EU topics, the 18:00 run checked 0 and left 21 + 21 topics overdue until 00:00.
--
-- Fix: news_revision_batch treats a topic as due when it falls due within 15 minutes AFTER the current moment. 15 minutes covers the
-- longest observed apply delay with a wide margin (three sources, <= 90 s fetch budget each, pg_cron dispatch jitter) and is 4% of
-- the shortest interval (6 h), so a topic is never pulled forward by a whole cycle. Stored next_check_at values, intervals and the
-- tier rules are unchanged; overdue topics (the 42 waiting today) are simply picked up by the next tick after this migration.
--
-- Function-only, idempotent (CREATE OR REPLACE with the identical signature and result shape). Rollback: re-apply 0011 (restores
-- the strict `next_check_at <= now()` body; 0011 is idempotent). Order matters: after ANY re-application of 0011, re-apply 0012.

begin;
set local role foreverdb_pub_owner;

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
                  where t.source_key = p_source_key and t.next_check_at <= now() + interval '15 minutes'
                  order by t.next_check_at asc, t.topic_id limit p_limit) d), '[]'::jsonb),
        'knownOrigins', coalesce((
            select jsonb_agg(jsonb_build_object('topicId', k.topic_id, 'threadOrigin', k.thread_origin))
            from (select t.topic_id, t.thread_origin from pub.news_tracked_topics t
                  where t.source_key = p_source_key and t.thread_origin is not null
                  order by t.last_official_at desc nulls last limit 500) k), '[]'::jsonb)
    );
end;
$$;

-- CREATE OR REPLACE keeps the ACL; restate it so this migration is self-sufficient (idempotent).
revoke all on function pub_admin.news_revision_batch(text, integer) from public;
grant execute on function pub_admin.news_revision_batch(text, integer) to azerdex_news_ingest;

-- Self-check: the function keeps its security definition and ACL, and now carries the tolerance.
do $verify$
begin
    if not (select provolatile = 's' and prosecdef and exists (select 1 from unnest(proconfig) c where c in ('search_path=""', 'search_path='))
              and pg_get_functiondef(oid) like '%next_check_at <= now() + interval ''15 minutes''%'
            from pg_proc where oid = 'pub_admin.news_revision_batch(text,integer)'::regprocedure)
       or not has_function_privilege('azerdex_news_ingest', 'pub_admin.news_revision_batch(text,integer)', 'execute')
       or has_function_privilege('foreverdb_web_reader', 'pub_admin.news_revision_batch(text,integer)', 'execute')
       or has_function_privilege('anon', 'pub_admin.news_revision_batch(text,integer)', 'execute') then
        raise exception 'migration 0012 self-check failed: news_revision_batch definition or ACL is wrong';
    end if;
end
$verify$;

commit;
