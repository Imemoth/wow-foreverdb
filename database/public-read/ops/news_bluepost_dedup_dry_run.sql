-- Read-only projected report for the Bluepost reply suppression.
-- Run before apply, against the isolated public-read database:
--   psql -X -v ON_ERROR_STOP=1 -f database/public-read/ops/news_bluepost_dedup_dry_run.sql

begin;
set local role foreverdb_pub_owner;

select jsonb_build_object(
    'stored_rows_before', count(*),
    'published_rows_before', count(*) filter (where n.status = 'published'),
    'published_blueposts_before', count(*) filter (where s.source_type = 'bluepost' and n.status = 'published'),
    'retained_originals_after', count(*) filter (where s.source_type = 'bluepost' and n.source_post_number = 1 and n.status = 'published'),
    'reply_rows_to_suppress', count(*) filter (where s.source_type = 'bluepost' and n.source_post_number is distinct from 1 and n.status = 'published' and n.suppressed_at is null),
    'published_rows_after', count(*) filter (where n.status = 'published' and n.suppressed_at is null and (s.source_type <> 'bluepost' or n.source_post_number = 1)),
    'visible_blueposts_after', count(*) filter (where s.source_type = 'bluepost' and n.status = 'published' and n.suppressed_at is null and n.source_post_number = 1),
    'historical_bluepost_topics', count(distinct n.source_topic_id) filter (where s.source_type = 'bluepost'),
    'visible_bluepost_topics_after', count(distinct n.source_topic_id) filter (where s.source_type = 'bluepost' and n.status = 'published' and n.suppressed_at is null and n.source_post_number = 1)
) as bluepost_dedup_dry_run
from pub.news_entries n
join pub.news_sources s using (source_key);

rollback;
