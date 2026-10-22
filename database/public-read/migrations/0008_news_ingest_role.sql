-- ForeverDB PUBLIC READ MODEL 0008: dedicated News ingestion login.
--
-- This role is intentionally separate from foreverdb_publisher. The role is
-- created without a password; the operator provisions that credential out of
-- band. The Edge Function can then call only the SECURITY DEFINER RPC below.
-- Never put a password or a connection URL in this migration.

begin;

do $role$
declare
    v_role pg_roles;
begin
    select * into v_role from pg_roles where rolname = 'azerdex_news_ingest';

    if v_role.rolname is null then
        create role azerdex_news_ingest
            login noinherit nosuperuser nocreatedb nocreaterole
            noreplication nobypassrls;
    elsif v_role.rolsuper or v_role.rolcreaterole or v_role.rolcreatedb
          or v_role.rolreplication or v_role.rolbypassrls then
        raise exception 'azerdex_news_ingest exists with unsafe role attributes';
    else
        alter role azerdex_news_ingest login noinherit;
    end if;
end
$role$;

alter role azerdex_news_ingest connection limit 2;
alter role azerdex_news_ingest set statement_timeout = '120s';
alter role azerdex_news_ingest set idle_in_transaction_session_timeout = '60s';

-- The public-read model owns its application objects through this NOLOGIN
-- role. Perform ACL changes under that established ownership boundary.
set local role foreverdb_pub_owner;

-- Revoke any inherited or previously configured application access before
-- granting the single required schema/function boundary.
revoke all on schema pub, pub_admin, web_api from azerdex_news_ingest;
revoke all on all tables in schema pub, pub_admin, web_api from azerdex_news_ingest;
revoke all on all sequences in schema pub, pub_admin, web_api from azerdex_news_ingest;
revoke all on all functions in schema pub, pub_admin, web_api from azerdex_news_ingest;

grant usage on schema pub_admin to azerdex_news_ingest;
grant execute on function pub_admin.news_apply_sync(jsonb) to azerdex_news_ingest;

do $verify$
begin
    if not exists (select 1 from pg_roles where rolname = 'azerdex_news_ingest' and rolcanlogin and not rolsuper
                   and not rolcreaterole and not rolcreatedb and not rolreplication and not rolbypassrls) then
        raise exception 'News ingestion role attributes are unsafe or LOGIN is disabled';
    end if;
    if has_schema_privilege('azerdex_news_ingest', 'pub', 'usage')
       or has_schema_privilege('azerdex_news_ingest', 'web_api', 'usage') then
        raise exception 'News ingestion role has an unrelated application schema grant';
    end if;
    if not has_schema_privilege('azerdex_news_ingest', 'pub_admin', 'usage') then
        raise exception 'News ingestion role cannot resolve the apply RPC schema';
    end if;
    if not has_function_privilege('azerdex_news_ingest', 'pub_admin.news_apply_sync(jsonb)', 'execute') then
        raise exception 'News ingestion role cannot execute the apply RPC';
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
        raise exception 'News ingestion role has direct application table privileges';
    end if;
    if pg_get_userbyid((select datdba from pg_database where datname = current_database())) = 'azerdex_news_ingest' then
        raise exception 'News ingestion role owns the database';
    end if;
end
$verify$;

commit;
