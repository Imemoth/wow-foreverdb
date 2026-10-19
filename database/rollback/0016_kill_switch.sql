-- Browser Pairing V1 kill switch: gate OFF plus removal of all client EXECUTE privileges. Idempotent and non-destructive.
begin;
set local lock_timeout='10s';
do $preflight$
declare v_sig text; v_hash text; v_actual text;
begin
  if to_regclass('private.device_pairing_config') is null or (select count(*) from private.device_pairing_config)<>1 then
    raise exception '0016 kill-switch pre-flight: complete config required';
  end if;
  foreach v_sig in array array['public.fdb_device_pair_start(uuid,text,uuid,text,text,text)','public.fdb_device_pair_poll(uuid,text)',
    'public.fdb_device_pair_cancel(uuid,text)','public.fdb_account_device_pair_preview(uuid)','public.fdb_account_device_pair_approve(uuid)',
    'public.fdb_account_device_pair_deny(uuid)'] loop
    if to_regprocedure(v_sig) is null then raise exception '0016 kill-switch pre-flight: % missing',v_sig; end if;
  end loop;
  for v_sig,v_hash in select * from (values
    ('public.fdb_device_pair_start(uuid,text,uuid,text,text,text)','bb21a8c21b7fcc4c633d1bdef3b0fefc'),
    ('public.fdb_device_pair_poll(uuid,text)','f55845835ebf3caef94cb1c2fe815ac1'),('public.fdb_device_pair_cancel(uuid,text)','a38d2346be589791ffdeeca8e4a3daa8'),
    ('public.fdb_account_device_pair_preview(uuid)','638c37eb34e3956d2f7736f5e6a3258c'),('public.fdb_account_device_pair_approve(uuid)','b7b8a854247cc7e9ef2e3d537f27ad9c'),
    ('public.fdb_account_device_pair_deny(uuid)','12568dcbc0e61fa72a3639887e1969a3')) expected(sig,hash) loop
    select md5(pg_get_functiondef(v_sig::regprocedure)) into v_actual;
    if v_actual is distinct from v_hash then raise exception '0016 kill-switch pre-flight: function hash mismatch for %',v_sig; end if;
  end loop;
end $preflight$;
update private.device_pairing_config set enabled=false where singleton;
revoke all on function public.fdb_device_pair_start(uuid,text,uuid,text,text,text),public.fdb_device_pair_poll(uuid,text),
  public.fdb_device_pair_cancel(uuid,text),public.fdb_account_device_pair_preview(uuid),public.fdb_account_device_pair_approve(uuid),
  public.fdb_account_device_pair_deny(uuid) from public,anon,authenticated,service_role;
notify pgrst,'reload schema';
commit;
