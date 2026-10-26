-- Run over NEWS_DATABASE_URL as azerdex_news_ingest on the isolated
-- public-read project. The RPC call is transactional and leaves no rows
-- behind. The migration itself performs the administrator-side ACL checks.

do $identity$
begin
    if current_user <> 'azerdex_news_ingest' then
        raise exception 'Run this authentication test as azerdex_news_ingest, not %', current_user;
    end if;
end
$identity$;

do $verify$
begin
    if not exists (select 1 from pg_roles where rolname = 'azerdex_news_ingest' and rolcanlogin and not rolsuper
                   and not rolcreaterole and not rolcreatedb and not rolreplication and not rolbypassrls) then
        raise exception 'Dedicated News ingestion role is not a constrained LOGIN role';
    end if;
    if not has_schema_privilege('azerdex_news_ingest', 'pub_admin', 'usage')
       or not has_function_privilege('azerdex_news_ingest', 'pub_admin.news_apply_sync(jsonb)', 'execute') then
        raise exception 'Dedicated News ingestion role lacks the required RPC boundary';
    end if;
    if has_schema_privilege('azerdex_news_ingest', 'pub', 'usage')
       or has_schema_privilege('azerdex_news_ingest', 'web_api', 'usage') then
        raise exception 'Dedicated News ingestion role can resolve unrelated application schemas';
    end if;
    if exists (
        select 1
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('pub', 'pub_admin', 'web_api')
          and c.relkind in ('r', 'p', 'v', 'm', 'f')
          and (
              has_table_privilege('azerdex_news_ingest', c.oid, 'select')
              or has_table_privilege('azerdex_news_ingest', c.oid, 'insert')
              or has_table_privilege('azerdex_news_ingest', c.oid, 'update')
              or has_table_privilege('azerdex_news_ingest', c.oid, 'delete')
          )
    ) then
        raise exception 'Dedicated News ingestion role has direct application table privileges';
    end if;
end
$verify$;

begin;

do $rpc$
declare
    v_result jsonb;
begin
    select pub_admin.news_apply_sync(jsonb_build_object(
        'source', jsonb_build_object(
            'sourceKey', 'role-security-test',
            'sourceType', 'bluepost',
            'region', 'us',
            'endpointUrl', 'https://example.com/news',
            'enabled', true
        ),
        'run', jsonb_build_object(
            'status', 'succeeded',
            'fetchedCount', 0,
            'acceptedCount', 0,
            'rejectedCount', 0
        ),
        'entries', '[]'::jsonb
    )) into v_result;

    if (v_result ->> 'runId') is null then
        raise exception 'Dedicated News ingestion role RPC call returned no run id: %', v_result;
    end if;
end
$rpc$;

rollback;
