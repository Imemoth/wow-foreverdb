-- Browser Pairing V1 safe rollback. Prefer 0016_kill_switch.sql for operational incidents.
-- Empty history removes the whole 0016 schema. Any pairing/audit/device provenance keeps the complete closed schema and live revocation trigger.
begin;
set local lock_timeout='10s';
set local statement_timeout='30s';

do $preflight$
declare v_name text; v_schema integer; v_functions integer; v_sig text; v_hash text; v_table regclass; v_actual text;
begin
  if to_regclass('supabase_migrations.schema_migrations') is not null
     and exists(select 1 from supabase_migrations.schema_migrations where name='browser_pairing_restore') then
    raise exception '0016 rollback refused: the single restore cycle was already used; use the kill switch or a newly reviewed restore migration';
  end if;
  select count(*) into v_schema from (values (to_regclass('private.device_pairing_config')),(to_regclass('private.device_pairings')),
    (to_regclass('private.device_pairing_audit')),(to_regclass('private.devices_one_per_pairing'))) s(oid) where oid is not null;
  select count(*) into v_functions from pg_proc where oid=any(array[
    to_regprocedure('private.fdb_pair_poll_global_budget()'),to_regprocedure('private.fdb_device_pair_native(uuid,text,boolean)'),
    to_regprocedure('private.device_pairing_revocation_trigger()'),to_regprocedure('public.fdb_device_pair_start(uuid,text,uuid,text,text,text)'),
    to_regprocedure('public.fdb_device_pair_poll(uuid,text)'),to_regprocedure('public.fdb_device_pair_cancel(uuid,text)'),
    to_regprocedure('public.fdb_account_device_pair_preview(uuid)'),to_regprocedure('public.fdb_account_device_pair_approve(uuid)'),
    to_regprocedure('public.fdb_account_device_pair_deny(uuid)')]::oid[]);
  if v_schema<>4 or v_functions<>9
     or not exists(select 1 from pg_attribute where attrelid='private.devices'::regclass and attname='pairing_id' and not attisdropped)
     or not exists(select 1 from pg_constraint where conrelid='private.devices'::regclass and conname='devices_exactly_one_provenance' and convalidated)
     or not exists(select 1 from pg_trigger where tgrelid='private.devices'::regclass and tgname='devices_propagate_pairing_revocation' and not tgisinternal)
     or not (select relrowsecurity and relforcerowsecurity from pg_class where oid='private.device_pairing_config'::regclass)
     or not (select relrowsecurity and relforcerowsecurity from pg_class where oid='private.device_pairings'::regclass)
     or not (select relrowsecurity and relforcerowsecurity from pg_class where oid='private.device_pairing_audit'::regclass) then
    raise exception '0016 rollback pre-flight: mixed or incomplete schema/function/trigger state';
  end if;
  if exists(select 1 from pg_policy where polrelid in ('private.device_pairing_config'::regclass,'private.device_pairings'::regclass,'private.device_pairing_audit'::regclass)) then
    raise exception '0016 rollback pre-flight: pairing private tables must remain FORCE-RLS with no policies';
  end if;
  for v_sig,v_hash in select * from (values
    ('private.fdb_pair_poll_global_budget()','3935a3f5cb1a54dc67428579ad6a9763'),
    ('private.fdb_device_pair_native(uuid,text,boolean)','4a815759c8213f55a41db8116ed76e8e'),
    ('private.device_pairing_revocation_trigger()','3b61ae3698bebae60d50507fddb44ab4'),
    ('public.fdb_device_pair_start(uuid,text,uuid,text,text,text)','bb21a8c21b7fcc4c633d1bdef3b0fefc'),
    ('public.fdb_device_pair_poll(uuid,text)','f55845835ebf3caef94cb1c2fe815ac1'),
    ('public.fdb_device_pair_cancel(uuid,text)','a38d2346be589791ffdeeca8e4a3daa8'),
    ('public.fdb_account_device_pair_preview(uuid)','638c37eb34e3956d2f7736f5e6a3258c'),
    ('public.fdb_account_device_pair_approve(uuid)','b7b8a854247cc7e9ef2e3d537f27ad9c'),
    ('public.fdb_account_device_pair_deny(uuid)','12568dcbc0e61fa72a3639887e1969a3')) expected(sig,hash) loop
    select md5(pg_get_functiondef(v_sig::regprocedure)) into v_actual;
    if v_actual is distinct from v_hash then raise exception '0016 rollback pre-flight: function hash mismatch for %',v_sig; end if;
  end loop;
  for v_table,v_hash in select * from (values
    ('private.device_pairing_config'::regclass,'ff2303be13914b4dff1fef1783a52626'),
    ('private.device_pairings'::regclass,'945f59954e48c3d50c8217ac398e1a26'),
    ('private.device_pairing_audit'::regclass,'40ddc4467f929ccf14492235167f374a'),
    ('private.devices'::regclass,'b6f7906a92f2d1cb0e42b90eaa4ae7e4')) expected(tbl,hash) loop
    select md5(coalesce((select string_agg(pg_get_constraintdef(x.oid),'|' order by x.conname) from pg_constraint x where x.conrelid=v_table),'')||'|'||
      coalesce((select string_agg(indexdef,'|' order by indexname) from pg_indexes where schemaname=split_part(v_table::text,'.',1) and tablename=split_part(v_table::text,'.',2)),'')||'|'||c.relrowsecurity||'|'||c.relforcerowsecurity)
      into v_actual from pg_class c where c.oid=v_table;
    if v_actual is distinct from v_hash then raise exception '0016 rollback pre-flight: object hash mismatch for %',v_table; end if;
  end loop;
end $preflight$;

lock table public.installations,private.account_installations,private.installation_claims,private.account_audit,
  private.enrollment_tickets,private.devices,private.device_audit,private.device_pairings,private.device_pairing_audit,
  public.installation_item_stats,public.installation_source_stats,public.installation_location_stats,
  public.installation_guilds,public.installation_guild_members,public.installation_guild_professions,public.sources,public.items in share mode;

create temporary table _fdb0016_rb_before on commit drop as
select 'public.installations' table_name,count(*) n,md5(coalesce(string_agg(to_jsonb(t)::text,'|' order by to_jsonb(t)::text),'')) hash from public.installations t union all
select 'private.account_installations',count(*),md5(coalesce(string_agg(to_jsonb(t)::text,'|' order by to_jsonb(t)::text),'')) from private.account_installations t union all
select 'private.installation_claims',count(*),md5(coalesce(string_agg(to_jsonb(t)::text,'|' order by to_jsonb(t)::text),'')) from private.installation_claims t union all
select 'private.account_audit',count(*),md5(coalesce(string_agg(to_jsonb(t)::text,'|' order by to_jsonb(t)::text),'')) from private.account_audit t union all
select 'private.enrollment_tickets',count(*),md5(coalesce(string_agg(to_jsonb(t)::text,'|' order by to_jsonb(t)::text),'')) from private.enrollment_tickets t union all
select 'private.devices',count(*),md5(coalesce(string_agg(to_jsonb(t)::text,'|' order by to_jsonb(t)::text),'')) from private.devices t union all
select 'private.device_audit',count(*),md5(coalesce(string_agg(to_jsonb(t)::text,'|' order by to_jsonb(t)::text),'')) from private.device_audit t union all
select 'private.device_pairings',count(*),md5(coalesce(string_agg(to_jsonb(t)::text,'|' order by to_jsonb(t)::text),'')) from private.device_pairings t union all
select 'private.device_pairing_audit',count(*),md5(coalesce(string_agg(to_jsonb(t)::text,'|' order by to_jsonb(t)::text),'')) from private.device_pairing_audit t union all
select 'public.installation_item_stats',count(*),md5(coalesce(string_agg(to_jsonb(t)::text,'|' order by to_jsonb(t)::text),'')) from public.installation_item_stats t union all
select 'public.installation_source_stats',count(*),md5(coalesce(string_agg(to_jsonb(t)::text,'|' order by to_jsonb(t)::text),'')) from public.installation_source_stats t union all
select 'public.installation_location_stats',count(*),md5(coalesce(string_agg(to_jsonb(t)::text,'|' order by to_jsonb(t)::text),'')) from public.installation_location_stats t union all
select 'public.installation_guilds',count(*),md5(coalesce(string_agg(to_jsonb(t)::text,'|' order by to_jsonb(t)::text),'')) from public.installation_guilds t union all
select 'public.installation_guild_members',count(*),md5(coalesce(string_agg(to_jsonb(t)::text,'|' order by to_jsonb(t)::text),'')) from public.installation_guild_members t union all
select 'public.installation_guild_professions',count(*),md5(coalesce(string_agg(to_jsonb(t)::text,'|' order by to_jsonb(t)::text),'')) from public.installation_guild_professions t union all
select 'public.sources',count(*),md5(coalesce(string_agg(to_jsonb(t)::text,'|' order by to_jsonb(t)::text),'')) from public.sources t union all
select 'public.items',count(*),md5(coalesce(string_agg(to_jsonb(t)::text,'|' order by to_jsonb(t)::text),'')) from public.items t;

update private.device_pairing_config set enabled=false where singleton;
revoke all on function public.fdb_device_pair_start(uuid,text,uuid,text,text,text),public.fdb_device_pair_poll(uuid,text),
  public.fdb_device_pair_cancel(uuid,text),public.fdb_account_device_pair_preview(uuid),public.fdb_account_device_pair_approve(uuid),
  public.fdb_account_device_pair_deny(uuid) from public,anon,authenticated,service_role;
drop function public.fdb_device_pair_start(uuid,text,uuid,text,text,text);
drop function public.fdb_device_pair_poll(uuid,text);
drop function public.fdb_device_pair_cancel(uuid,text);
drop function public.fdb_account_device_pair_preview(uuid);
drop function public.fdb_account_device_pair_approve(uuid);
drop function public.fdb_account_device_pair_deny(uuid);
drop function private.fdb_device_pair_native(uuid,text,boolean);
drop function private.fdb_pair_poll_global_budget();

do $schema$
declare v_pairings bigint; v_audit bigint; v_devices bigint;
begin
  select count(*) into v_pairings from private.device_pairings;
  select count(*) into v_audit from private.device_pairing_audit;
  select count(*) into v_devices from private.devices where pairing_id is not null;
  if v_pairings=0 and v_audit=0 and v_devices=0 then
    -- The predecessor row shape has no pairing_id column. Normalize the saved fingerprint before the intentional schema removal;
    -- retained-history rollback keeps the column and therefore keeps the original full-row fingerprint.
    update _fdb0016_rb_before set hash=(
      select md5(coalesce(string_agg((to_jsonb(t)-'pairing_id')::text,'|' order by (to_jsonb(t)-'pairing_id')::text),''))
      from private.devices t
    ) where table_name='private.devices';
    drop trigger devices_propagate_pairing_revocation on private.devices;
    drop function private.device_pairing_revocation_trigger();
    drop index private.devices_one_per_pairing;
    alter table private.devices drop constraint devices_exactly_one_provenance;
    alter table private.devices drop column pairing_id;
    alter table private.devices alter column ticket_id set not null;
    drop table private.device_pairing_audit;
    drop table private.device_pairings;
    drop table private.device_pairing_config;
    raise notice '0016 rollback: no pairing history; complete 0016 schema removed';
  else
    raise notice '0016 rollback: history retained (% pairings, % audit rows, % provenance devices); closed schema and trigger retained',v_pairings,v_audit,v_devices;
  end if;
end $schema$;

do $verify$
declare r record; a record;
begin
  for r in select * from _fdb0016_rb_before where table_name not in ('private.device_pairings','private.device_pairing_audit') loop
    execute format('select count(*) n,md5(coalesce(string_agg(to_jsonb(t)::text,''|'' order by to_jsonb(t)::text),'''')) hash from %s t',r.table_name) into a;
    if a.n is distinct from r.n or a.hash is distinct from r.hash then
      raise exception '0016 rollback post-condition: protected rows changed in %',r.table_name;
    end if;
  end loop;
  if to_regprocedure('public.fdb_device_pair_poll(uuid,text)') is not null or to_regprocedure('private.fdb_device_pair_native(uuid,text,boolean)') is not null then
    raise exception '0016 rollback post-condition: callable pairing surface remains';
  end if;
  if to_regclass('private.device_pairings') is not null then
    if not exists(select 1 from private.device_pairing_config where singleton and not enabled)
       or not exists(select 1 from pg_trigger where tgrelid='private.devices'::regclass and tgname='devices_propagate_pairing_revocation' and not tgisinternal) then
      raise exception '0016 rollback post-condition: retained schema is not closed and trigger-complete';
    end if;
    for r in select * from _fdb0016_rb_before where table_name in ('private.device_pairings','private.device_pairing_audit') loop
      execute format('select count(*) n,md5(coalesce(string_agg(to_jsonb(t)::text,''|'' order by to_jsonb(t)::text),'''')) hash from %s t',r.table_name) into a;
      if a.n is distinct from r.n or a.hash is distinct from r.hash then raise exception '0016 rollback post-condition: retained history changed'; end if;
    end loop;
  end if;
end $verify$;
notify pgrst,'reload schema';
commit;
