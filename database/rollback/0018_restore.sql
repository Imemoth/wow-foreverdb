-- ForeverDB 0018 RESTORE: deliberately re-open parts of the Guildbook cloud paths that migration 0018 closed.
--
-- OPERATOR-RUN, OWNER-APPROVED, NEVER AUTOMATIC, NEVER APPLIED BY THE REPOSITORY. The owner policy is that Guildbook stays on the user's
-- computer; this script exists only so that a decision to the contrary (or a recovery drill on a disposable database) is explicit, narrow,
-- reviewable and reversible. Read docs/guildbook-local-only/server-deployment-runbook.md (section "Rollback considerations") first: in
-- almost every incident the right action is NOT this script.
--
--   psql -X -v ON_ERROR_STOP=1 \
--        -v confirm='REOPEN-GUILDBOOK-CLOUD-PATHS' \
--        -v scope='reads'            (reads | ingest | all) \
--        -v operator='<your name>' -v approval_ref='<ticket / written approval, no secrets>' \
--        -f database/rollback/0018_restore.sql
--
--   scope=reads   GRANT EXECUTE to `authenticated` ONLY on the two read RPCs of migration 0012 (exact signatures). It never grants public, anon or
--                 service_role, never touches any other function and any later account-scoped family, and leaves the ingest projection and the
--                 guard row in place: no new Guildbook row can appear, only historical rows become readable by their verified owner again.
--   scope=ingest  Removes the observation-only projection: the original legacy ingest body is renamed back to its original name, the helper
--                 projection function is dropped and the guard row is deleted. From that moment old Companion versions can write Guildbook rows
--                 to the cloud again (and every snapshot rewrites the installation's Guildbook rows, as before 0018). Refused when the
--                 account-scoped Guildbook tables exist (that shape depends on the wrapper; restore it with that migration's own procedure).
--   scope=all     Both.
--
-- It never deletes or alters a Guildbook, observation, installation, claim or device row, never writes the migration ledger (record the
-- operation yourself if you track restores there) and aborts with NOTHING applied if any precondition or post-condition fails. After a restore,
-- migration 0018 can be applied again (its body is idempotent; with a real ledger a new forward migration is needed, see the runbook).
\set ON_ERROR_STOP on
\if :{?confirm} \else \echo 'missing -v confirm: refusing to run'
select 1 / 0 as missing_confirm;
\endif
\if :{?scope} \else \echo 'missing -v scope (reads | ingest | all): refusing to run'
select 1 / 0 as missing_scope;
\endif
\if :{?operator} \else \echo 'missing -v operator: refusing to run'
select 1 / 0 as missing_operator;
\endif
\if :{?approval_ref} \else \echo 'missing -v approval_ref: refusing to run'
select 1 / 0 as missing_approval_ref;
\endif

begin;
set local lock_timeout = '15s';
set local statement_timeout = '60s';
select set_config('fdb.restore_confirm', :'confirm', true) as c1,
       set_config('fdb.restore_scope', :'scope', true) as c2,
       set_config('fdb.restore_operator', :'operator', true) as c3,
       set_config('fdb.restore_approval', :'approval_ref', true) as c4 \gset

do $restore$
declare
    v_confirm text := current_setting('fdb.restore_confirm');
    v_scope text := current_setting('fdb.restore_scope');
    v_operator text := current_setting('fdb.restore_operator');
    v_approval text := current_setting('fdb.restore_approval');
    v_sig text;
    v_src text;
begin
    if v_confirm is distinct from 'REOPEN-GUILDBOOK-CLOUD-PATHS' then
        raise exception '0018 restore refused: the confirmation text does not match';
    end if;
    if v_scope not in ('reads', 'ingest', 'all') then
        raise exception '0018 restore refused: scope must be reads, ingest or all';
    end if;
    if length(v_operator) not between 2 and 80 or length(v_approval) not between 3 and 120 then
        raise exception '0018 restore refused: malformed operator or approval reference';
    end if;
    if to_regclass('private.guildbook_cloud_sync_guard') is null
       or not exists (select 1 from private.guildbook_cloud_sync_guard where guard_name = 'disabled') then
        raise exception '0018 restore refused: the Guildbook local-only kill switch is not active here (nothing to restore)';
    end if;

    if v_scope in ('reads', 'all') then
        foreach v_sig in array array[
            'public.fdb_account_guildbook_guilds(text)',
            'public.fdb_account_guildbook_members(text,text,integer,integer)'
        ] loop
            if to_regprocedure(v_sig) is null then
                raise exception '0018 restore refused: % does not exist', v_sig;
            end if;
            execute format('grant execute on function %s to authenticated', v_sig);
        end loop;
    end if;

    if v_scope in ('ingest', 'all') then
        if to_regclass('private.account_guildbook_captures') is not null then
            raise exception '0018 restore refused: account-scoped Guildbook tables exist; the ingest wrapper cannot be removed from that shape';
        end if;
        if to_regprocedure('private.foreverdb_ingest_snapshot_impl_v1_legacy(jsonb)') is null
           or to_regprocedure('private.foreverdb_ingest_snapshot_impl_v1(jsonb)') is null then
            raise exception '0018 restore refused: the ingest wrapper or the legacy body is missing';
        end if;
        select p.prosrc into v_src from pg_proc p where p.oid = 'private.foreverdb_ingest_snapshot_impl_v1(jsonb)'::regprocedure;
        if v_src not like '%fdb_public_snapshot%' then
            raise exception '0018 restore refused: the current ingest implementation is not the 0018 wrapper';
        end if;
        select p.prosrc into v_src from pg_proc p where p.oid = 'private.foreverdb_ingest_snapshot_impl_v1_legacy(jsonb)'::regprocedure;
        if v_src not like '%pg_advisory_xact_lock%' or v_src not like '%Installation belongs to another authenticated client%' then
            raise exception '0018 restore refused: the retained legacy body is not the original implementation';
        end if;

        drop function private.foreverdb_ingest_snapshot_impl_v1(jsonb);
        alter function private.foreverdb_ingest_snapshot_impl_v1_legacy(jsonb) rename to foreverdb_ingest_snapshot_impl_v1;
        drop function private.fdb_public_snapshot(jsonb);
        revoke all on function private.foreverdb_ingest_snapshot_impl_v1(jsonb) from public, anon, authenticated, service_role;
        delete from private.guildbook_cloud_sync_guard where guard_name = 'disabled';
    end if;

    -- Post-conditions
    if v_scope in ('reads', 'all') then
        foreach v_sig in array array[
            'public.fdb_account_guildbook_guilds(text)',
            'public.fdb_account_guildbook_members(text,text,integer,integer)'
        ] loop
            if not has_function_privilege('authenticated', v_sig, 'execute')
               or has_function_privilege('public', v_sig, 'execute') or has_function_privilege('anon', v_sig, 'execute')
               or has_function_privilege('service_role', v_sig, 'execute') then
                raise exception '0018 restore failed for %', v_sig;
            end if;
        end loop;
    end if;
    if v_scope in ('ingest', 'all') then
        select p.prosrc into v_src from pg_proc p where p.oid = 'private.foreverdb_ingest_snapshot_impl_v1(jsonb)'::regprocedure;
        if v_src not like '%pg_advisory_xact_lock%' or v_src not like '%Installation belongs to another authenticated client%'
           or has_function_privilege('anon', 'private.foreverdb_ingest_snapshot_impl_v1(jsonb)', 'execute')
           or has_function_privilege('authenticated', 'private.foreverdb_ingest_snapshot_impl_v1(jsonb)', 'execute') then
            raise exception '0018 restore failed: the original ingest implementation was not restored correctly';
        end if;
    end if;
    raise notice '0018 restore applied: scope=% operator=% approval=%', v_scope, v_operator, v_approval;
end $restore$;

notify pgrst, 'reload schema';
commit;
