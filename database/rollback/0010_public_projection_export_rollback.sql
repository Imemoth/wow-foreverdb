-- FULL ROLLBACK of migration 0010 (private aggregate export). Removes the export schema, its six functions and the
-- `foreverdb_projection_reader` role. Touches NO data table and NO other role; nothing in `public` or `private` changes.
-- Run on the PRIVATE project only, as the project owner. Stop the publisher first (see docs/web/public-publication-operations.md):
-- with the role gone, publisher runs fail closed with `private_export_not_configured` / authentication errors and the public
-- website keeps serving the last published version.
-- Re-applying 0010 afterwards restores the exact previous state (the role is recreated NOLOGIN: set a NEW password).
begin;
select pg_terminate_backend(pid) from pg_stat_activity where usename = 'foreverdb_projection_reader';
drop schema if exists publication_export cascade;
do $drop$
begin
    if exists (select 1 from pg_roles where rolname = 'foreverdb_projection_reader') then
        drop role foreverdb_projection_reader;
    end if;
end
$drop$;
-- Verification: nothing of the export boundary remains.
do $verify$
begin
    if exists (select 1 from pg_namespace where nspname = 'publication_export')
       or exists (select 1 from pg_roles where rolname = 'foreverdb_projection_reader') then
        raise exception 'Rollback incomplete';
    end if;
end
$verify$;
commit;
