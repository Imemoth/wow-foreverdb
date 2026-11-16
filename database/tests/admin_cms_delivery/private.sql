do $security$
begin
  if (select enabled from editorial_private.delivery_control where singleton)
     or has_schema_privilege('anon','editorial_private','USAGE')
     or has_table_privilege('azerdex_cms_dispatch','editorial_private.delivery_state','SELECT')
     or has_table_privilege('authenticated','editorial_private.delivery_state','SELECT')
     or has_function_privilege('authenticated',
       'editorial_private.cms_dispatch_claim(uuid)','EXECUTE')
     or not has_function_privilege('azerdex_cms_dispatch',
       'editorial_private.cms_dispatch_claim(uuid)','EXECUTE')
     or not (select relforcerowsecurity from pg_class
       where oid='editorial_private.delivery_state'::regclass) then
    raise exception 'private CMS delivery isolation failed'; end if;
end $security$;
