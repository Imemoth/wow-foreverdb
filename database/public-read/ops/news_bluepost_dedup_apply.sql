-- Reversible, audited suppression of historical Bluepost replies.
-- The corrected collector must already be deployed and verified.
-- Required invocation (choose a unique UTC cleanup_id):
--   psql -X -v ON_ERROR_STOP=1 \
--     -v confirm=SUPPRESS_BLUEPOST_REPLIES \
--     -v cleanup_id=20261023T000000Z \
--     -f database/public-read/ops/news_bluepost_dedup_apply.sql
-- This script never deletes rows or version history.

\if :{?confirm}
\else
\echo 'Refusing cleanup: pass -v confirm=SUPPRESS_BLUEPOST_REPLIES'
do $refuse$
begin
    raise exception 'Refusing cleanup: confirmation token is required';
end
$refuse$;
\endif
\if :{?cleanup_id}
\else
\echo 'Refusing cleanup: pass a unique -v cleanup_id=...'
do $refuse$
begin
    raise exception 'Refusing cleanup: cleanup_id is required';
end
$refuse$;
\endif

select set_config('azerdex.bluepost_cleanup_id', :'cleanup_id', false);
select set_config('azerdex.bluepost_cleanup_confirm', :'confirm', false);

begin;
set local role foreverdb_pub_owner;

do $verify$
begin
    if current_setting('azerdex.bluepost_cleanup_confirm') <> 'SUPPRESS_BLUEPOST_REPLIES' then
        raise exception 'Cleanup confirmation token is invalid';
    end if;
    if current_setting('azerdex.bluepost_cleanup_id') !~ '^[0-9]{8}T[0-9]{6}Z$' then
        raise exception 'cleanup_id must be UTC YYYYMMDDTHHMMSSZ';
    end if;
end
$verify$;

do $apply$
declare
    v_cleanup_id text := current_setting('azerdex.bluepost_cleanup_id');
    v_reason text := 'bluepost_reply_dedup_v1:' || v_cleanup_id;
    v_suppressed_at timestamptz := clock_timestamp();
    v_changed integer;
begin
    update pub.news_entries n
    set suppressed_at = v_suppressed_at,
        suppression_reason = v_reason
    from pub.news_sources s
    where s.source_key = n.source_key
      and s.source_type = 'bluepost'
      and n.status = 'published'
      and n.source_post_number is distinct from 1
      and n.suppressed_at is null;
    get diagnostics v_changed = row_count;

    insert into pub.news_sync_runs(source_key, started_at, finished_at, status, fetched_count, accepted_count, rejected_count, diagnostics)
    select s.source_key, v_suppressed_at, clock_timestamp(), 'succeeded', count(*), 0, count(*),
           jsonb_build_object('operation', 'bluepost_reply_suppression', 'cleanupId', v_cleanup_id,
                              'suppressedAt', v_suppressed_at, 'rows', count(*))
    from pub.news_sources s
    join pub.news_entries n on n.source_key = s.source_key
    where s.source_type = 'bluepost'
      and n.suppression_reason = v_reason
    group by s.source_key;

    raise notice 'Suppressed % historical non-opener Bluepost rows with reason %', v_changed, v_reason;
end
$apply$;

select jsonb_build_object(
    'cleanup_id', current_setting('azerdex.bluepost_cleanup_id'),
    'suppressed_published_bluepost_replies', count(*) filter (where suppression_reason = 'bluepost_reply_dedup_v1:' || current_setting('azerdex.bluepost_cleanup_id')),
    'total_stored_news_rows', count(*),
    'visible_published_news_rows', count(*) filter (where n.status = 'published' and n.suppressed_at is null and (s.source_type <> 'bluepost' or n.source_post_number = 1)),
    'visible_published_bluepost_openers', count(*) filter (where s.source_type = 'bluepost' and n.status = 'published' and n.suppressed_at is null and n.source_post_number = 1),
    'version_rows', (select count(*) from pub.news_post_versions)
) as bluepost_dedup_apply_report
from pub.news_entries n
join pub.news_sources s using (source_key);

commit;
