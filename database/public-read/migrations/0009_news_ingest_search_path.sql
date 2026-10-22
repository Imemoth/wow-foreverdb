-- ForeverDB PUBLIC READ MODEL 0009: harden the News ingestion session.
--
-- The role-specific revokes in 0008 remove all project ACLs. Supabase-owned
-- extension objects may still carry PUBLIC grants that cannot be denied to a
-- single role without changing shared platform behaviour. Restrict the
-- ingestion role's unqualified name resolution to its RPC schema and the
-- system catalog; the collector always calls the fully-qualified RPC.

begin;

alter role azerdex_news_ingest set search_path = pub_admin, pg_catalog;
revoke all on schema public, net, extensions, cron from azerdex_news_ingest;

do $verify$
declare
    v_config text[];
begin
    select rolconfig into v_config from pg_roles where rolname = 'azerdex_news_ingest';
    if not exists (
        select 1
        from unnest(coalesce(v_config, array[]::text[])) setting
        where setting = 'search_path=pub_admin, pg_catalog'
    ) then
        raise exception 'News ingestion role search_path is not restricted';
    end if;
end
$verify$;

commit;
