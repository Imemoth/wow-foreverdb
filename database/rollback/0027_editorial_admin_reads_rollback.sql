-- Rolls back 0027 (read-only RPCs). It holds no data, so it is always safe while nothing else depends on it.
begin;
do $preflight$
begin
  if to_regprocedure('public.fdb_cms_articles(integer)') is null then
    raise exception '0027 rollback: not applied';
  end if;
  if not has_database_privilege(current_user,current_database(),'CREATE')
     or not exists(select 1 from pg_roles where rolname=current_user and rolcreaterole and (rolbypassrls or rolsuper)) then
    raise exception '0027 rollback: reviewed migration operator required';
  end if;
  if exists(select 1 from pg_depend d join pg_proc p on p.oid=d.refobjid
            where p.pronamespace in ('public'::regnamespace,'editorial_private'::regnamespace)
              and p.proname in ('fdb_cms_context','fdb_cms_articles','fdb_cms_article_detail','fdb_cms_revision','fdb_cms_audit',
                                'read_actor','audit_reader','intent_delivery')
              and d.deptype='n' and d.classid<>'pg_proc'::regclass) then
    raise exception '0027 rollback: an object depends on a 0027 function';
  end if;
end $preflight$;
drop function public.fdb_cms_context();
drop function public.fdb_cms_articles(integer);
drop function public.fdb_cms_article_detail(uuid);
drop function public.fdb_cms_revision(uuid,uuid);
drop function public.fdb_cms_audit(integer,bigint);
drop function editorial_private.intent_delivery(uuid);
drop function editorial_private.audit_reader();
drop function editorial_private.read_actor(uuid);
notify pgrst, 'reload schema';
commit;
