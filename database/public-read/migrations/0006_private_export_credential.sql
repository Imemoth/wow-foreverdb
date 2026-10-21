-- ForeverDB PUBLIC READ MODEL 0006: where the publisher finds the read-only private-export connection. Requires 0004. SUPABASE-ONLY (Vault).
--
-- The private export identity (foreverdb_projection_reader, EXECUTE on publication_export.* only) is stored ENCRYPTED in this project's
-- Vault, never in Git, never in the function bundle, never in an environment file. The Edge Function reads it through
-- pub_ops.private_export_url() (granted to the publisher role only) unless a PRIVATE_EXPORT_DATABASE_URL secret is set, which takes precedence.
-- set_private_export_url accepts ONLY a URL for that exact role, so no other credential can be parked here by mistake.
begin;

create function pub_ops.set_private_export_url(p_url text)
returns void language plpgsql security definer set search_path = ''
as $$
begin
    if p_url !~ '^postgres(ql)?://foreverdb_projection_reader(\.[a-z0-9]{20})?:[^@/\s]{16,}@[A-Za-z0-9.-]+(:[0-9]{2,5})?/[A-Za-z0-9_]+(\?[A-Za-z0-9=&_-]*)?$' then
        raise exception 'only a connection URL for the foreverdb_projection_reader role is accepted';
    end if;
    if exists (select 1 from vault.secrets where name = 'private_export_database_url') then
        perform vault.update_secret((select id from vault.secrets where name = 'private_export_database_url'), p_url);
    else
        perform vault.create_secret(p_url, 'private_export_database_url', 'Read-only export identity of the private project (publication_export.* only)');
    end if;
end;
$$;

create function pub_ops.private_export_url()
returns text language sql stable security definer set search_path = ''
as $$
    select decrypted_secret from vault.decrypted_secrets where name = 'private_export_database_url';
$$;

revoke all on function pub_ops.set_private_export_url(text) from public;
revoke all on function pub_ops.private_export_url() from public;
grant execute on function pub_ops.private_export_url() to foreverdb_publisher;
alter function pub_ops.private_export_url() set statement_timeout = '3s';

do $verify$
begin
    if has_function_privilege('foreverdb_publisher', 'pub_ops.set_private_export_url(text)', 'execute')
       or has_function_privilege('foreverdb_web_reader', 'pub_ops.private_export_url()', 'execute') then
        raise exception 'private export credential boundary FAILED';
    end if;
    if exists (select 1 from pg_roles where rolname = 'anon')
       and has_function_privilege('anon', 'pub_ops.private_export_url()', 'execute') then
        raise exception 'anon can read the export credential';
    end if;
end
$verify$;

commit;
-- Rollback contract (manual): drop function pub_ops.private_export_url(); drop function pub_ops.set_private_export_url(text);
--   delete from vault.secrets where name = 'private_export_database_url';
