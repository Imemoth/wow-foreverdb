-- ForeverDB 0012 INCIDENT RECOVERY: restore ONE installation to its previous (anonymous) owner.
--
-- OPERATOR-RUN, OWNER-APPROVED, NEVER AUTOMATIC. Use only for a mistaken or malicious claim, after the owner of the
-- project has approved the specific installation in writing. Runbook: docs/account-v1/0012-deployment-and-recovery.md (section 6).
--
--   psql -X -v ON_ERROR_STOP=1 \
--        -v installation_id='<installation id>' \
--        -v expected_account_uid='<uuid of the account that currently owns it, from the link row>' \
--        -v operator='<your name>' -v approval_ref='<ticket / approval reference, no secrets>' \
--        -f database/rollback/0012_recovery_restore_owner.sql
--
-- What it does, in ONE transaction, under the SAME advisory lock ingest takes:
--   1. refuses unless a link row exists for the installation and installations.owner_user_id still equals the linked account
--      AND equals -v expected_account_uid (so the operator has looked at the right record);
--   2. refuses unless the previous owner identity still exists, is not deleted and is still anonymous;
--   3. sets installations.owner_user_id back to private.account_installations.previous_owner_uid;
--   4. deletes the link row (the claim row stays 'consumed' as history);
--   5. writes an `ownership_restored` audit row carrying operator and approval reference (no secrets);
--   6. proves that no observation, location, item, source or Guildbook row of the installation changed.
-- It never deletes or alters observations. The Companion then reports `owned` to the previous owner again (the `transferred` signal is
-- derived from the link row, which is gone) and the account no longer lists the installation.
\if :{?installation_id} \else \echo 'missing -v installation_id: refusing to run'
select 1 / 0 as missing_installation_id;
\endif
\if :{?expected_account_uid} \else \echo 'missing -v expected_account_uid: refusing to run'
select 1 / 0 as missing_expected_account_uid;
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
select set_config('fdb.recovery_installation', :'installation_id', true),
       set_config('fdb.recovery_account', :'expected_account_uid', true),
       set_config('fdb.recovery_operator', :'operator', true),
       set_config('fdb.recovery_approval', :'approval_ref', true) \g /dev/null

do $recover$
declare
    v_inst text := current_setting('fdb.recovery_installation');
    v_expected text := current_setting('fdb.recovery_account');
    v_operator text := current_setting('fdb.recovery_operator');
    v_approval text := current_setting('fdb.recovery_approval');
    v_account uuid;
    v_previous uuid;
    v_claim uuid;
    v_owner uuid;
    v_before text;
    v_after text;
begin
    if v_inst !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' or v_expected !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or length(v_operator) not between 2 and 80 or length(v_approval) not between 3 and 120 then
        raise exception 'recovery refused: malformed installation id, account uid, operator or approval reference';
    end if;

    perform pg_advisory_xact_lock(hashtextextended(v_inst, 0));

    select l.account_uid, l.previous_owner_uid, l.claim_id into v_account, v_previous, v_claim
    from private.account_installations l where l.installation_id = v_inst for update;
    if not found then raise exception 'recovery refused: no link row for this installation (it was never claimed)'; end if;

    select i.owner_user_id into v_owner from public.installations i where i.id = v_inst for update;
    if v_owner is distinct from v_account or v_account::text <> lower(v_expected) then
        raise exception 'recovery refused: current owner / linked account / expected account do not all agree';
    end if;
    if not exists (select 1 from auth.users u where u.id = v_previous and u.is_anonymous and u.deleted_at is null) then
        raise exception 'recovery refused: the previous owner identity no longer exists as an active anonymous user; decide manually';
    end if;

    select md5(concat_ws('|',
        (select count(*) from public.installation_item_stats where installation_id = v_inst),
        (select count(*) from public.installation_source_stats where installation_id = v_inst),
        (select count(*) from public.installation_location_stats where installation_id = v_inst),
        (select count(*) from public.installation_guilds where installation_id = v_inst),
        (select count(*) from public.installation_guild_members where installation_id = v_inst),
        (select count(*) from public.installation_guild_professions where installation_id = v_inst),
        (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.installation_item_stats t where installation_id = v_inst),
        (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.installation_guild_members t where installation_id = v_inst)))
    into v_before;

    update public.installations set owner_user_id = v_previous where id = v_inst;
    delete from private.account_installations where installation_id = v_inst;
    insert into private.account_audit (event, account_uid, installation_id, claim_id, detail)
    values ('ownership_restored', v_account, v_inst, v_claim, left('operator=' || v_operator || '; approval=' || v_approval, 200));

    select md5(concat_ws('|',
        (select count(*) from public.installation_item_stats where installation_id = v_inst),
        (select count(*) from public.installation_source_stats where installation_id = v_inst),
        (select count(*) from public.installation_location_stats where installation_id = v_inst),
        (select count(*) from public.installation_guilds where installation_id = v_inst),
        (select count(*) from public.installation_guild_members where installation_id = v_inst),
        (select count(*) from public.installation_guild_professions where installation_id = v_inst),
        (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.installation_item_stats t where installation_id = v_inst),
        (select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) from public.installation_guild_members t where installation_id = v_inst)))
    into v_after;
    if v_after is distinct from v_before then
        raise exception 'recovery aborted: historical rows of the installation changed (must never happen)';
    end if;
    raise notice 'recovery done: installation % restored from account % to previous owner %', v_inst, v_account, v_previous;
end $recover$;

commit;
