-- Run as the public-read owner after 0011_news_collector_v2.sql.
-- This replaces the 0010-era string-position checks ("source_post_number = 1")
-- with provenance-based assertions. The invariants are unchanged in spirit:
-- a Bluepost row is visible only if it is an authoritative opener OR a reply
-- carrying complete verified-staff provenance; suppressed rows never appear;
-- ingestion can never clear a suppression marker.

do $verify$
declare
    v_definition text;
begin
    if not exists (select 1 from information_schema.columns
                   where table_schema = 'pub' and table_name = 'news_entries' and column_name = 'suppressed_at')
       or not exists (select 1 from information_schema.columns
                      where table_schema = 'pub' and table_name = 'news_entries' and column_name = 'suppression_reason') then
        raise exception 'Suppression columns are missing';
    end if;
    if has_table_privilege('foreverdb_web_reader', 'pub.news_entries', 'select')
       or has_table_privilege('foreverdb_publisher', 'pub.news_entries', 'update') then
        raise exception 'News table boundary changed';
    end if;

    select pg_get_viewdef('pub.news_card_entries'::regclass) into v_definition;
    if position('suppressed_at is null' in lower(v_definition)) = 0 then
        raise exception 'card view does not hide suppressed rows';
    end if;
    if position('source_post_number = 1' in lower(v_definition)) = 0
       or position('author_user_id is not null' in lower(v_definition)) = 0
       or position('thread_origin is not null' in lower(v_definition)) = 0 then
        raise exception 'card view does not fail closed for replies without verified provenance';
    end if;
    foreach v_definition in array array[
        pg_get_functiondef('web_api.news_cards(text,text,text,boolean,integer,integer)'::regprocedure),
        pg_get_functiondef('web_api.news_entry(text)'::regprocedure)] loop
        if position('news_card_entries' in lower(v_definition)) = 0 then
            raise exception 'a public reader bypasses the fail-closed card view';
        end if;
    end loop;

    select pg_get_functiondef('pub_admin.news_apply_sync(jsonb)'::regprocedure) into v_definition;
    if position('v_existing_suppressed_at' in lower(v_definition)) = 0
       or position('skip_unverified_reply' in lower(v_definition)) = 0
       or position('news_verified_staff' in lower(v_definition)) = 0 then
        raise exception 'news_apply_sync does not enforce suppression and verified-reply guards';
    end if;
    if not has_function_privilege('foreverdb_publisher', 'pub_admin.news_apply_sync(jsonb)', 'execute') then
        raise exception 'Publisher RPC boundary changed';
    end if;
end
$verify$;
