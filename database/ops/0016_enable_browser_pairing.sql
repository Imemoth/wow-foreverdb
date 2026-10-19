-- Explicit operator action. Never invoked by migrations or deploy automation.
begin;
set local lock_timeout='10s';
do $preflight$
declare v_sig text; v_role text; v_hash text; v_actual text;
begin
  if to_regclass('private.device_pairing_config') is null
     or (select count(*) from private.device_pairing_config)<>1
     or not exists(select 1 from private.device_pairing_config where singleton and not enabled) then
    raise exception '0016 enable pre-flight: complete disabled config required';
  end if;
  if to_regclass('supabase_migrations.schema_migrations') is not null
     and (not exists(select 1 from supabase_migrations.schema_migrations where name='browser_pairing')
          or exists(select 1 from supabase_migrations.schema_migrations where name in ('rollback_browser_pairing','browser_pairing_restore'))) then
    raise exception '0016 enable pre-flight: unexpected migration ledger state';
  end if;
  foreach v_sig in array array['public.fdb_device_pair_start(uuid,text,uuid,text,text,text)','public.fdb_device_pair_poll(uuid,text)',
    'public.fdb_device_pair_cancel(uuid,text)','public.fdb_account_device_pair_preview(uuid)','public.fdb_account_device_pair_approve(uuid)',
    'public.fdb_account_device_pair_deny(uuid)'] loop
    if to_regprocedure(v_sig) is null or not has_function_privilege('authenticated',v_sig,'execute') then
      raise exception '0016 enable pre-flight: % missing or not executable',v_sig;
    end if;
    foreach v_role in array array['public','anon','service_role'] loop
      if has_function_privilege(v_role,v_sig,'execute') then raise exception '0016 enable pre-flight: unexpected % EXECUTE on %',v_role,v_sig; end if;
    end loop;
  end loop;
  for v_sig,v_hash in select * from (values
    ('public.fdb_device_pair_start(uuid,text,uuid,text,text,text)','bb21a8c21b7fcc4c633d1bdef3b0fefc'),
    ('public.fdb_device_pair_poll(uuid,text)','f55845835ebf3caef94cb1c2fe815ac1'),('public.fdb_device_pair_cancel(uuid,text)','a38d2346be589791ffdeeca8e4a3daa8'),
    ('public.fdb_account_device_pair_preview(uuid)','638c37eb34e3956d2f7736f5e6a3258c'),('public.fdb_account_device_pair_approve(uuid)','b7b8a854247cc7e9ef2e3d537f27ad9c'),
    ('public.fdb_account_device_pair_deny(uuid)','12568dcbc0e61fa72a3639887e1969a3')) expected(sig,hash) loop
    select md5(pg_get_functiondef(v_sig::regprocedure)) into v_actual;
    if v_actual is distinct from v_hash then raise exception '0016 enable pre-flight: function hash mismatch for %',v_sig; end if;
  end loop;
end $preflight$;
update private.device_pairing_config set enabled=true where singleton;
commit;
