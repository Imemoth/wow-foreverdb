-- Immediate database gate disable. Data, ownership and RPC ACLs remain untouched.
begin;
set local lock_timeout='10s';
do $preflight$
begin
  if to_regclass('private.device_pairing_config') is null or (select count(*) from private.device_pairing_config)<>1 then
    raise exception '0016 disable pre-flight: complete pairing config required';
  end if;
end $preflight$;
update private.device_pairing_config set enabled=false where singleton;
commit;
