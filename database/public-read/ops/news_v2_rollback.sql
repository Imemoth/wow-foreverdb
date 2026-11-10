-- News Collector V2 rollback. OPERATOR, explicit owner approval required. Run as the platform admin.
-- Restores the 0010 definitions of pub_admin.news_apply_sync and web_api.news_list/news_featured/news_entry (0010 is
-- idempotent: create or replace + add column if not exists) and drops ONLY the V2-only functions and view.
-- It KEEPS every table, column and row (entries, versions, verified staff, tracked topics, run history): nothing is deleted,
-- so a later re-apply of 0011 resumes exactly where this left off. Replies with V2 provenance simply become invisible again,
-- because the 0010 read functions only expose post_number = 1.
--
-- Roll the Edge Function back FIRST (or concurrently): a V2 collector calling the 0010 RPC would have its reply entries
-- skipped by the 0010 guard, which is safe but wasteful.

\ir ../migrations/0010_news_bluepost_suppression.sql

begin;
set local role foreverdb_pub_owner;
drop function if exists web_api.news_cards(text, text, text, boolean, integer, integer);
drop function if exists pub_admin.news_revision_batch(text, integer);
drop function if exists pub_admin.news_health_snapshot();
drop view if exists pub.news_card_entries;
commit;
