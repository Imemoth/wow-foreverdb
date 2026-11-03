-- Read-only projected report for the Bluepost reply suppression.
-- Run before apply, against the isolated public-read database:
--   psql -X -v ON_ERROR_STOP=1 -f database/public-read/ops/news_bluepost_dedup_dry_run.sql

begin;
set local role foreverdb_pub_owner;

select jsonb_build_object(
    'total_stored_news_before', count(*),
    'published_news_before', count(*) filter (where n.status = 'published'),
    'published_blueposts_before', count(*) filter (where s.source_type = 'bluepost' and n.status = 'published'),
    'legitimate_bluepost_openers_after', count(*) filter (where s.source_type = 'bluepost' and n.source_post_number = 1 and n.status = 'published'),
    'published_bluepost_replies_to_suppress', count(*) filter (where s.source_type = 'bluepost' and n.source_post_number is distinct from 1 and n.status = 'published' and n.suppressed_at is null),
    'visible_published_news_after', count(*) filter (where n.status = 'published' and n.suppressed_at is null and (s.source_type <> 'bluepost' or n.source_post_number = 1)),
    'visible_published_blueposts_after', count(*) filter (where s.source_type = 'bluepost' and n.status = 'published' and n.suppressed_at is null and n.source_post_number = 1),
    'published_bluepost_topics_before', count(distinct n.source_topic_id) filter (where s.source_type = 'bluepost' and n.status = 'published'),
    'stored_bluepost_topics_all_statuses', count(distinct n.source_topic_id) filter (where s.source_type = 'bluepost'),
    'visible_bluepost_topics_after', count(distinct n.source_topic_id) filter (where s.source_type = 'bluepost' and n.status = 'published' and n.suppressed_at is null and n.source_post_number = 1)
) as bluepost_dedup_dry_run
from pub.news_entries n
join pub.news_sources s using (source_key);

rollback;
