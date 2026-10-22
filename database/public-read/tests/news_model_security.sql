-- Run as the public-read owner after 0001_public_read_model.sql and
-- 0002_news_model.sql. This is intentionally a SQL assertion script, not a
-- fixture seeder.

do $verify$
declare
    t text;
begin
    foreach t in array ['news_sources', 'news_entries', 'news_post_versions', 'news_sync_runs'] loop
        if not (select relrowsecurity from pg_class where oid = format('pub.%s', t)::regclass) then
            raise exception 'RLS is disabled on pub.%', t;
        end if;
        if has_table_privilege('foreverdb_web_reader', format('pub.%s', t), 'select')
           or has_table_privilege('foreverdb_web_reader', format('pub.%s', t), 'insert')
           or has_table_privilege('foreverdb_publisher', format('pub.%s', t), 'select')
           or has_table_privilege('foreverdb_publisher', format('pub.%s', t), 'update') then
            raise exception 'News table boundary failed for %', t;
        end if;
    end loop;

    if not has_function_privilege('foreverdb_web_reader', 'web_api.news_list(text,text,integer,integer)', 'execute')
       or not has_function_privilege('foreverdb_web_reader', 'web_api.news_featured(integer)', 'execute')
       or not has_function_privilege('foreverdb_web_reader', 'web_api.news_entry(text)', 'execute') then
        raise exception 'News reader functions are not executable by the reader role';
    end if;
    if not has_function_privilege('foreverdb_publisher', 'pub_admin.news_apply_sync(jsonb)', 'execute') then
        raise exception 'News writer function is not executable by the publisher role';
    end if;
end
$verify$;
