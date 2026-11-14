\set ON_ERROR_STOP on
do $assert$
declare t record;
begin
  if (select version_id from admin_private.active_policy where singleton) <> 0
     or exists(select 1 from admin_private.staff_subjects)
     or has_schema_privilege('anon','editorial_private','USAGE')
     or has_schema_privilege('authenticated','editorial_private','USAGE')
     or has_schema_privilege('service_role','editorial_private','USAGE')
     or pg_has_role('authenticated','admin_executor','MEMBER') then
    raise exception 'private CMS boundary or deny-all changed';
  end if;
  for t in select c.oid,c.relname,c.relrowsecurity,c.relforcerowsecurity
           from pg_class c where c.relnamespace='editorial_private'::regnamespace
           and c.relkind='r' loop
    if not t.relrowsecurity or not t.relforcerowsecurity
       or has_table_privilege('anon',t.oid,'SELECT')
       or has_table_privilege('authenticated',t.oid,'SELECT')
       or has_table_privilege('service_role',t.oid,'SELECT')
       or has_table_privilege('authenticated',t.oid,'INSERT') then
      raise exception 'CMS table exposed: %',t.relname;
    end if;
  end loop;
  if (select count(*) from pg_class c where c.relnamespace='editorial_private'::regnamespace and c.relkind='r') <> 11
     or (select count(*) from editorial_private.articles)<>0
     or (select count(*) from editorial_private.delivery_outbox)<>0
     or (select count(*) from editorial_private.slug_reservations where kind='legacy_git')<>3 then
    raise exception 'CMS schema or legacy reservations incomplete';
  end if;
  for t in select p.oid,p.proname,p.prosecdef,p.proconfig,p.proowner
      from pg_proc p where p.pronamespace='public'::regnamespace
        and p.proname like 'fdb_cms_%' loop
    if not t.prosecdef or pg_get_userbyid(t.proowner)<>'admin_executor'
       or t.proconfig<>array['search_path=""']::text[]
       or has_function_privilege('anon',t.oid,'EXECUTE')
       or has_function_privilege('service_role',t.oid,'EXECUTE')
       or not has_function_privilege('authenticated',t.oid,'EXECUTE') then
      raise exception 'CMS RPC ACL or owner incorrect: %',t.proname; end if;
  end loop;
  if (select count(*) from pg_proc p where p.pronamespace='public'::regnamespace
        and p.proname like 'fdb_cms_%')<>8 then
    raise exception 'CMS RPC set changed'; end if;
  if (select payload from public.account_sentinel where id=1)<>'untouched'
     or (select payload from private.guildbook_sentinel where id=1)<>'untouched' then
    raise exception 'Account or Guildbook isolation changed';
  end if;
end $assert$;
