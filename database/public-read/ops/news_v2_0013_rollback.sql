-- News global story grouping: ROLLBACK of migration 0013. OPERATOR. Pure SQL (psql or SQL editor), one transaction.
--
-- Removes ONLY what 0013 added: web_api.news_stories, web_api.news_story_entry, pub_admin.news_link_stories, pub_admin.news_norm_text and the
-- tables pub.news_story_members / pub.news_story_overrides. Source data is never touched (news_entries, news_post_versions, tracked topics,
-- sync runs, suppressed rows: fingerprint checked). The website falls back to web_api.news_cards / news_entry automatically (undefined function),
-- so rolling back the database does not break it; every region simply shows its own cards again.
--
-- The links in pub.news_story_members are DERIVED data (re-created by pub_admin.news_link_stories). The overrides are human decisions and are
-- NOT derivable: the rollback REFUSES while any override exists (export them first, then delete them deliberately).
begin;
set local role foreverdb_pub_owner;

create temp table g_src_fp on commit drop as
select md5(
    coalesce((select string_agg(e::text, ';' order by e.id) from pub.news_entries e), '') ||
    coalesce((select string_agg(v::text, ';' order by v.id) from pub.news_post_versions v), '') ||
    coalesce((select string_agg(t::text, ';' order by t.source_key, t.topic_id) from pub.news_tracked_topics t), '')) as fp;

do $pre$
begin
    if exists (select 1 from pub.news_story_overrides) then
        raise exception '0013 rollback refused: pub.news_story_overrides holds reviewed human decisions (export them, then delete them deliberately)';
    end if;
end
$pre$;

drop function if exists web_api.news_stories(text, text, text, boolean, integer, integer);
drop function if exists web_api.news_story_entry(text);
drop function if exists pub_admin.news_link_stories(boolean);
drop function if exists pub_admin.news_norm_text(text);
drop table if exists pub.news_story_members;
drop table if exists pub.news_story_overrides;

do $post$
begin
    if (select fp from g_src_fp) is distinct from md5(
        coalesce((select string_agg(e::text, ';' order by e.id) from pub.news_entries e), '') ||
        coalesce((select string_agg(v::text, ';' order by v.id) from pub.news_post_versions v), '') ||
        coalesce((select string_agg(t::text, ';' order by t.source_key, t.topic_id) from pub.news_tracked_topics t), '')) then
        raise exception '0013 rollback postcondition failed: a source row changed';
    end if;
    if to_regprocedure('web_api.news_cards(text,text,text,boolean,integer,integer)') is null or to_regprocedure('web_api.news_entry(text)') is null then
        raise exception '0013 rollback postcondition failed: the V2 read functions are missing';
    end if;
end
$post$;

commit;
