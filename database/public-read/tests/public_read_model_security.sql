-- Ephemeral-DB ONLY security/behaviour test for the PUBLIC read model.
-- Precondition: 0001_public_read_model.sql applied and ONE publication active
-- (the publisher integration test creates it from synthetic data).
\set ON_ERROR_STOP 1

-- ---------------------------------------------------------------- web reader
set role foreverdb_web_reader;
do $t$
declare
    denied boolean;
    stmt text;
    n bigint;
begin
    -- Read API works.
    select count(*) into n from web_api.search('copper', null, null, null, 'relevance', 50, 0);
    if n = 0 then raise exception 'FAIL: web reader search returned nothing'; end if;

    -- No direct table access, no writes, no admin functions, no arbitrary SQL surface.
    foreach stmt in array array[
        'select 1 from pub.items limit 1',
        'select 1 from pub.publications limit 1',
        'select 1 from pub.audit_log limit 1',
        'insert into pub.items (publication_id, item_id, name, name_norm, source_count, total_drops) values (1, 1, ''x'', ''x'', 0, 0)',
        'update pub.state set active_publication_id = null',
        'select pub_admin.status()',
        'select pub_admin.begin_publication(''x'', now(), now(), ''{}''::jsonb)',
        'select pub_admin.activate_publication(1)'
    ] loop
        denied := false;
        begin
            execute stmt;
        exception when insufficient_privilege then denied := true;
        end;
        if not denied then raise exception 'FAIL: web reader was allowed: %', stmt; end if;
    end loop;

    -- Server-side bounds.
    foreach stmt in array array[
        'select * from web_api.search('''', null, null, null, ''relevance'', 50, 0)',
        'select * from web_api.search(''copper'', null, null, null, ''relevance'', 51, 0)',
        'select * from web_api.search(''copper'', null, null, null, ''relevance'', 50, 1001)',
        'select * from web_api.search(''c%'', null, null, null, ''relevance'', 10, 0)',
        'select * from web_api.search(repeat(''a'', 81), null, null, null, ''relevance'', 10, 0)',
        'select * from web_api.search(''copper'', ''guild'', null, null, ''relevance'', 10, 0)',
        'select * from web_api.search(''copper'', null, null, null, ''random()'', 10, 0)',
        'select * from web_api.zone_entities(1420, null, null, '''', 101, 0)',
        'select web_api.item(0)',
        'select web_api.source(''installation'', 1)',
        'select * from web_api.sitemap(''item'', 0, 5001)'
    ] loop
        denied := false;
        begin
            execute stmt;
        exception when invalid_parameter_value then denied := true;
        end;
        if not denied then raise exception 'FAIL: unbounded/invalid call accepted: %', stmt; end if;
    end loop;

    -- Injection attempts are inert data, not SQL.
    select count(*) into n from web_api.search('''); drop table pub.items; --', null, null, null, 'relevance', 10, 0);
    if n <> 0 then raise exception 'FAIL: injection string matched rows'; end if;

    raise notice 'PASS: web reader is read-only, bounded and limited to web_api';
end
$t$;
reset role;

-- ------------------------------------------------------------------ publisher
set role foreverdb_publisher;
do $t$
declare
    denied boolean;
    v_active bigint;
    v_new bigint;
begin
    -- No SELECT/UPDATE/DELETE on data.
    denied := false;
    begin perform 1 from pub.items limit 1; exception when insufficient_privilege then denied := true; end;
    if not denied then raise exception 'FAIL: publisher can SELECT data'; end if;
    denied := false;
    begin delete from pub.items; exception when insufficient_privilege then denied := true; end;
    if not denied then raise exception 'FAIL: publisher can DELETE data'; end if;
    denied := false;
    begin perform pub_admin.activate_publication(1); exception when insufficient_privilege then denied := true; end;
    if not denied then raise exception 'FAIL: publisher can roll back/activate publications'; end if;

    select (pub_admin.status()->>'active')::bigint into v_active;
    if v_active is null then raise exception 'FAIL: precondition: no active publication'; end if;

    -- RLS: cannot inject rows into the ACTIVE publication.
    denied := false;
    begin
        insert into pub.items (publication_id, item_id, name, name_norm, source_count, total_drops)
        values (v_active, 424242, 'Injected', 'injected', 0, 0);
    exception when insufficient_privilege then denied := true;
    end;
    if not denied then raise exception 'FAIL: publisher wrote into the active publication'; end if;

    -- Fail closed: a staging publication with mismatching counts never activates.
    begin
        v_new := pub_admin.begin_publication('test', now(), now(), '{}'::jsonb);
        insert into pub.items (publication_id, item_id, name, name_norm, source_count, total_drops)
        values (v_new, 424242, 'Orphan', 'orphan', 0, 0);
        perform pub_admin.finalize_publication(v_new, repeat('a', 64), '{"items": 99}'::jsonb, false, 3);
        raise exception 'FAIL: finalize accepted mismatching counts';
    exception when raise_exception then
        if sqlerrm like 'FAIL:%' then raise; end if;
    end;
    if (pub_admin.status()->>'active')::bigint <> v_active then
        raise exception 'FAIL: active publication changed after a failed finalize';
    end if;

    raise notice 'PASS: publisher is insert-only into staging, RLS-guarded and fail-closed';
end
$t$;
reset role;

-- ------------------------------------------------------- supabase API roles
do $t$
declare r text;
begin
    foreach r in array array['anon', 'authenticated'] loop
        if exists (select 1 from pg_roles where rolname = r)
           and (has_schema_privilege(r, 'pub', 'usage') or has_schema_privilege(r, 'web_api', 'usage')
                or has_schema_privilege(r, 'pub_admin', 'usage')) then
            raise exception 'FAIL: % can reach the public read model directly', r;
        end if;
    end loop;
    raise notice 'PASS: Supabase API roles (if present) have no access';
end
$t$;
