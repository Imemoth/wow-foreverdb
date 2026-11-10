-- Run as a privileged test user after 0011_news_collector_v2.sql. Assertion-only
-- (role-switch probes run inside a transaction that is rolled back).

do $verify$
declare
    t text; f text; r text;
    v_def text;
    v_roles text[] := array['foreverdb_web_reader', 'foreverdb_publisher', 'azerdex_news_ingest', 'anon', 'authenticated'];
begin
    -- 1. No API/ingest role has any privilege on any News storage object (tables or the card view).
    foreach t in array array['news_sources', 'news_entries', 'news_post_versions', 'news_sync_runs',
                             'news_official_groups', 'news_verified_staff', 'news_tracked_topics', 'news_card_entries'] loop
        foreach r in array v_roles loop
            continue when not exists (select 1 from pg_roles where rolname = r);
            if has_table_privilege(r, format('pub.%s', t), 'select, insert, update, delete, truncate, references, trigger') then
                raise exception 'role % has a privilege on pub.%', r, t;
            end if;
        end loop;
        if t <> 'news_card_entries' and not (select relrowsecurity from pg_class where oid = format('pub.%s', t)::regclass) then
            raise exception 'RLS disabled on pub.%', t;
        end if;
        if has_table_privilege('public', format('pub.%s', t), 'select') then
            raise exception 'PUBLIC can read pub.%', t;
        end if;
    end loop;

    -- 2. Function ACLs: PUBLIC/anon/authenticated never execute; each role gets only its own RPCs.
    foreach f in array array['pub_admin.news_apply_sync(jsonb)', 'pub_admin.news_revision_batch(text,integer)',
                             'pub_admin.news_health_snapshot()', 'web_api.news_cards(text,text,text,boolean,integer,integer)',
                             'web_api.news_list(text,text,integer,integer)', 'web_api.news_featured(integer)', 'web_api.news_entry(text)'] loop
        if has_function_privilege('public', f, 'execute') then raise exception 'PUBLIC can execute %', f; end if;
        foreach r in array array['anon', 'authenticated'] loop
            continue when not exists (select 1 from pg_roles where rolname = r);
            if has_function_privilege(r, f, 'execute') then raise exception '% can execute %', r, f; end if;
        end loop;
        -- every News function is SECURITY DEFINER with an empty search_path
        if not exists (select 1 from pg_proc p where p.oid = f::regprocedure and p.prosecdef
                       and exists (select 1 from unnest(p.proconfig) c where c in ('search_path=""', 'search_path='))) then
            raise exception '% is not SECURITY DEFINER with an empty search_path', f;
        end if;
    end loop;

    if not has_function_privilege('azerdex_news_ingest', 'pub_admin.news_apply_sync(jsonb)', 'execute')
       or not has_function_privilege('azerdex_news_ingest', 'pub_admin.news_revision_batch(text,integer)', 'execute') then
        raise exception 'ingest role lost its two RPCs';
    end if;
    if has_function_privilege('azerdex_news_ingest', 'pub_admin.news_health_snapshot()', 'execute')
       or has_function_privilege('azerdex_news_ingest', 'web_api.news_cards(text,text,text,boolean,integer,integer)', 'execute')
       or has_function_privilege('azerdex_news_ingest', 'web_api.news_list(text,text,integer,integer)', 'execute') then
        raise exception 'ingest role can execute a function outside its boundary';
    end if;
    if has_schema_privilege('azerdex_news_ingest', 'pub', 'usage') or has_schema_privilege('azerdex_news_ingest', 'web_api', 'usage') then
        raise exception 'ingest role can resolve unrelated schemas';
    end if;
    if has_function_privilege('foreverdb_web_reader', 'pub_admin.news_apply_sync(jsonb)', 'execute')
       or has_function_privilege('foreverdb_web_reader', 'pub_admin.news_revision_batch(text,integer)', 'execute')
       or has_function_privilege('foreverdb_web_reader', 'pub_admin.news_health_snapshot()', 'execute') then
        raise exception 'web reader can execute a pub_admin function';
    end if;
    if not has_function_privilege('foreverdb_web_reader', 'web_api.news_cards(text,text,text,boolean,integer,integer)', 'execute')
       or not has_function_privilege('foreverdb_web_reader', 'web_api.news_list(text,text,integer,integer)', 'execute')
       or not has_function_privilege('foreverdb_web_reader', 'web_api.news_featured(integer)', 'execute')
       or not has_function_privilege('foreverdb_web_reader', 'web_api.news_entry(text)', 'execute') then
        raise exception 'web reader lost a bounded read function';
    end if;

    -- 3. Provenance-based invariants are present in the persistence boundary and the read path.
    select pg_get_functiondef('pub_admin.news_apply_sync(jsonb)'::regprocedure) into v_def;
    foreach f in array array['news_verified_staff', 'news_official_groups', 'skip_unverified_reply', 'v_existing_suppressed_at',
                             'threadorigin', 'authoruserid', 'skip_missing_post_number'] loop
        if position(lower(f) in lower(v_def)) = 0 then raise exception 'news_apply_sync lost guard: %', f; end if;
    end loop;
    select pg_get_viewdef('pub.news_card_entries'::regclass) into v_def;
    foreach f in array array['suppressed_at IS NULL', 'author_user_id IS NOT NULL', 'author_group IS NOT NULL', 'thread_origin IS NOT NULL',
                             'source_post_number = 1', 'status = ''published'''] loop
        if position(lower(f) in lower(v_def)) = 0 then raise exception 'news_card_entries lost predicate: %', f; end if;
    end loop;
    foreach f in array array['web_api.news_cards(text,text,text,boolean,integer,integer)', 'web_api.news_entry(text)'] loop
        select pg_get_functiondef(f::regprocedure) into v_def;
        if position('news_card_entries' in lower(v_def)) = 0 then raise exception '% does not read through the fail-closed view', f; end if;
    end loop;
    -- the legacy readers delegate to the card function (no private predicate copies that can drift)
    foreach f in array array['web_api.news_list(text,text,integer,integer)', 'web_api.news_featured(integer)'] loop
        select pg_get_functiondef(f::regprocedure) into v_def;
        if position('news_cards' in lower(v_def)) = 0 then raise exception '% does not delegate to news_cards', f; end if;
    end loop;
end
$verify$;

-- 4. Real role-switch probes (as the website role the News tables are unreachable).
begin;
do $probe$
declare v_state text;
begin
    set local role foreverdb_web_reader;
    perform * from web_api.news_cards(null, '', null, false, 1, 0);
    begin perform 1 from pub.news_entries limit 1; raise exception 'reader selected news_entries';
    exception when insufficient_privilege then null; end;
    begin perform 1 from pub.news_card_entries limit 1; raise exception 'reader selected news_card_entries';
    exception when insufficient_privilege then null; end;
    begin perform 1 from pub.news_verified_staff limit 1; raise exception 'reader selected news_verified_staff';
    exception when insufficient_privilege then null; end;
    begin perform pub_admin.news_apply_sync('{}'::jsonb); raise exception 'reader executed news_apply_sync';
    exception when insufficient_privilege then null; end;
    -- bounded inputs
    begin perform * from web_api.news_cards(null, '', null, false, 51, 0); raise exception 'unbounded limit';
    exception when sqlstate '22023' then null; end;
    begin perform * from web_api.news_cards(null, '', 'moon', false, 10, 0); raise exception 'invalid region accepted';
    exception when sqlstate '22023' then null; end;
    begin perform * from web_api.news_cards(null, '100%', null, false, 10, 0); raise exception 'wildcard accepted';
    exception when sqlstate '22023' then null; end;
    reset role;
end
$probe$;
rollback;

begin;
do $probe$
begin
    if exists (select 1 from pg_roles where rolname = 'azerdex_news_ingest') then
        set local role azerdex_news_ingest;
        begin perform 1 from pub.news_entries limit 1; raise exception 'ingest role selected news_entries';
        exception when insufficient_privilege then null; end;
        begin perform * from web_api.news_cards(null, '', null, false, 1, 0); raise exception 'ingest role executed a web_api function';
        exception when insufficient_privilege then null; end;
        begin perform pub_admin.news_health_snapshot(); raise exception 'ingest role executed the health snapshot';
        exception when insufficient_privilege then null; end;
        reset role;
    end if;
end
$probe$;
rollback;

do $done$ begin raise notice 'PASS: News V2 security boundaries (privileges, ACLs, definer settings, provenance guards, role probes)'; end $done$;
