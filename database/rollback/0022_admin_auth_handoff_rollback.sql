-- Disposable rehearsal only. Preserve and escalate if any Admin state exists.
begin;
do $guard$
begin
    if to_regclass('admin_private.handoff_tokens') is null
       or to_regclass('admin_private.session_revocations') is null
       or (select version_id from admin_private.active_policy where singleton) <> 0
       or exists (select 1 from admin_private.staff_subjects)
       or exists (select 1 from admin_private.handoff_tokens)
       or exists (select 1 from admin_private.session_revocations) then
        raise exception '0022 rollback: Admin state exists; preserve and escalate';
    end if;
end $guard$;
drop function public.fdb_admin_handoff_redeem(text);
drop function public.fdb_admin_handoff_start(text);
drop function public.fdb_admin_session_revoke();
drop function public.fdb_admin_entry_ready();
drop function admin_private.fresh_totp_session(uuid,uuid);
drop table admin_private.handoff_tokens;
drop table admin_private.session_revocations;
commit;
