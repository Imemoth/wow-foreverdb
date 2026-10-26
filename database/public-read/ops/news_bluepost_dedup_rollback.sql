-- Roll back only one named Bluepost suppression run. No rows or versions are deleted.
--   psql -X -v ON_ERROR_STOP=1 -v cleanup_id=20261023T000000Z \
--     -f database/public-read/ops/news_bluepost_dedup_rollback.sql

\if :{?cleanup_id}
\else
\echo 'Refusing rollback: pass the cleanup_id used by the apply script'
\quit 2
\endif

select set_config('azerdex.bluepost_cleanup_id', :'cleanup_id', false);

begin;
set local role foreverdb_pub_owner;

do $verify$
begin
    if current_setting('azerdex.bluepost_cleanup_id') !~ '^[0-9]{8}T[0-9]{6}Z$' then
        raise exception 'cleanup_id must be UTC YYYYMMDDTHHMMSSZ';
    end if;
end
$verify$;

update pub.news_entries
set suppressed_at = null,
    suppression_reason = null
where suppression_reason = 'bluepost_reply_dedup_v1:' || current_setting('azerdex.bluepost_cleanup_id');

select jsonb_build_object(
    'cleanup_id', current_setting('azerdex.bluepost_cleanup_id'),
    'remaining_marked_rows', count(*)
) as bluepost_dedup_rollback_report
from pub.news_entries
where suppression_reason = 'bluepost_reply_dedup_v1:' || current_setting('azerdex.bluepost_cleanup_id');

commit;
