do $security$
begin
  if (select enabled from editorial_private.delivery_control where singleton)
     or editorial_private.cms_mac('test')<>
       '248c3141988983387d02b1f0b0fd9f94b7ebef6f841a501a90deeaa2f72e5fd3'
     or has_schema_privilege('anon','editorial_private','USAGE')
     or has_table_privilege('azerdex_cms_dispatch','editorial_private.delivery_state','SELECT')
     or has_table_privilege('authenticated','editorial_private.delivery_state','SELECT')
     or has_table_privilege('azerdex_cms_dispatch','editorial_private.delivery_mac_key','SELECT')
     or has_function_privilege('authenticated',
       'editorial_private.cms_dispatch_claim(uuid)','EXECUTE')
     or has_function_privilege('authenticated',
       'editorial_private.supersede_pending_delivery()','EXECUTE')
     or has_function_privilege('azerdex_cms_dispatch',
       'editorial_private.cms_mac(text)','EXECUTE')
     or not has_function_privilege('azerdex_cms_dispatch',
       'editorial_private.cms_dispatch_claim(uuid)','EXECUTE')
     or not (select relforcerowsecurity from pg_class
       where oid='editorial_private.delivery_state'::regclass) then
    raise exception 'private CMS delivery isolation failed'; end if;
end $security$;
