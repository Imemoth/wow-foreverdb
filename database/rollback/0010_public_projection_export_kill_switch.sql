-- KILL SWITCH for the private aggregate export (migration 0010). Reversible, instant, deletes nothing.
-- Effect: the export identity can no longer log in; every running export session is ended. The functions, grants and the
-- schema stay in place, so `0010_public_projection_export_kill_switch_restore.sql` re-enables it without re-running 0010.
-- The public website keeps serving the last published version; the publisher reports `failed` runs until restored.
-- Run on the PRIVATE project only, as the project owner.
begin;
alter role foreverdb_projection_reader nologin;
select pg_terminate_backend(pid) from pg_stat_activity where usename = 'foreverdb_projection_reader';
commit;
