-- Run as the public-read owner after 0010_news_bluepost_suppression.sql.

do $verify$
declare
    v_definition text;
begin
    if not exists (
        select 1 from information_schema.columns
        where table_schema = 'pub' and table_name = 'news_entries' and column_name = 'suppressed_at'
    ) then raise exception 'Suppression timestamp is missing'; end if;
    if not exists (
        select 1 from information_schema.columns
        where table_schema = 'pub' and table_name = 'news_entries' and column_name = 'suppression_reason'
    ) then raise exception 'Suppression reason is missing'; end if;
    if has_table_privilege('foreverdb_web_reader', 'pub.news_entries', 'select')
       or has_table_privilege('foreverdb_publisher', 'pub.news_entries', 'update') then
        raise exception 'News table boundary changed';
    end if;

    select pg_get_functiondef('web_api.news_list(text,text,integer,integer)'::regprocedure) into v_definition;
    if position('suppressed_at is null' in lower(v_definition)) = 0 then
        raise exception 'news_list does not suppress historical replies';
    end if;
    if position('source_post_number = 1' in lower(v_definition)) = 0 then
        raise exception 'news_list does not fail closed for non-opener Blueposts';
    end if;
    select pg_get_functiondef('web_api.news_featured(integer)'::regprocedure) into v_definition;
    if position('suppressed_at is null' in lower(v_definition)) = 0 then
        raise exception 'news_featured does not suppress historical replies';
    end if;
    if position('source_post_number = 1' in lower(v_definition)) = 0 then
        raise exception 'news_featured does not fail closed for non-opener Blueposts';
    end if;
    select pg_get_functiondef('web_api.news_entry(text)'::regprocedure) into v_definition;
    if position('suppressed_at is null' in lower(v_definition)) = 0 then
        raise exception 'news_entry does not suppress historical replies';
    end if;
    if position('source_post_number = 1' in lower(v_definition)) = 0 then
        raise exception 'news_entry does not fail closed for non-opener Blueposts';
    end if;
    select pg_get_functiondef('pub_admin.news_apply_sync(jsonb)'::regprocedure) into v_definition;
    if position('sourcepostnumber' in lower(v_definition)) = 0
       or position('v_existing_suppressed_at' in lower(v_definition)) = 0 then
        raise exception 'news_apply_sync does not enforce opener and suppression guards';
    end if;
    if not has_function_privilege('foreverdb_publisher', 'pub_admin.news_apply_sync(jsonb)', 'execute') then
        raise exception 'Publisher RPC boundary changed';
    end if;
end
$verify$;
