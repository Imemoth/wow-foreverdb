-- Operator-approved restoration for 0018 on a disposable/recovery database.
-- This restores only EXECUTE grants; it never drops or rewrites Guildbook data.
begin;
grant execute on function public.fdb_account_guildbook_guilds(text) to authenticated;
grant execute on function public.fdb_account_guildbook_members(text,text,integer,integer) to authenticated;
grant execute on function public.fdb_account_guildbook_ingest(text,text,bigint,text,jsonb) to authenticated;
grant execute on function public.fdb_account_guildbook_guilds_scoped(text) to authenticated;
grant execute on function public.fdb_account_guildbook_members_scoped(text,text,integer,integer) to authenticated;
notify pgrst, 'reload schema';
commit;
