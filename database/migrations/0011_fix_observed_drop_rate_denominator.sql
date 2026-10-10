-- ForeverDB 0011: F-3 fix - correct the observed drop-rate denominator.
--
-- ROOT CAUSE (verified against the live definitions with pg_get_functiondef):
-- private.foreverdb_item_stats, foreverdb_source_stats and foreverdb_all_stats
-- INNER JOINed public.installation_source_stats to public.installation_item_stats
-- per installation and then summed ss.observations. An installation that observed a
-- source bucket but never received the target item has no installation_item_stats
-- row for it, so its observations were silently dropped from the denominator:
--     rate = drops / sum(observations of ONLY the installations that saw the item)
-- Example: A = 100 observations / 10 drops, B = 100 observations / 0 drops.
--     before: 10 / 100 = 10 %      after: 10 / 200 = 5 %
-- Single-installation buckets were never affected.
--
-- FIX: aggregate item drops and source observations INDEPENDENTLY, then join on the
-- full source identity (source_type, source_id, source_level, loot_kind):
--     observed_rate = SUM(drop_count) / SUM(source observations of ALL contributing
--                     installations for that exact source+loot_kind)
-- The source totals are computed once per source key (no join fan-out per item), so
-- adding items never multiplies the denominator. drop_count, quantity and
-- quest_drop_count are unchanged: they are still summed over the same item rows as
-- before (an item row counts only for an installation that also has the matching
-- source row, exactly like the old per-installation join).
--
-- SCOPE / SAFETY:
--   * Replaces ONLY the bodies of three existing private functions with
--     CREATE OR REPLACE. Signatures, return columns, owner, SECURITY DEFINER,
--     search_path = '' and every EXECUTE grant are preserved and ASSERTED below
--     (the transaction aborts if anything differs).
--   * No table, view, policy, grant or data change. No rewrite of collected data.
--   * Public wrappers (get_foreverdb_item_stats / get_foreverdb_source_stats), the
--     0009 request budgets and the anonymous-JWT contract are not touched.
--   * The Companion client computes its rate and Wilson score from the returned
--     observations and drop_count, so it is corrected without a client change.
--   * Added a deterministic ORDER BY (source_type, source_id, source_level,
--     loot_kind, item_id). The row set is the same as before; only when a result
--     exceeds the wrappers' LIMIT 500 (an item with more than 500 sources) does the
--     truncation differ: it was arbitrary and is now stable (lowest source ids
--     first). The Companion re-sorts after the cut, as before.
--
-- ROLLBACK: database/rollback/0011_restore_previous_observed_rate_functions.sql
-- (restores the exact previous definitions; reintroduces the F-3 inflation).
--
-- Numbering: 0010 is the prepared, unapplied public-projection export under
-- database/private-export/ and is intentionally unrelated to this migration.
--
-- Apply to production ONLY after explicit owner approval (see docs/f3-observed-rate-denominator.md).

begin;

-- Pre-flight: refuse to run against an unexpected schema.
do $preflight$
declare
    v_sig text;
    v_def text;
begin
    foreach v_sig in array array[
        'private.foreverdb_item_stats(bigint)',
        'private.foreverdb_source_stats(text,bigint,integer)',
        'private.foreverdb_all_stats()'
    ] loop
        if to_regprocedure(v_sig) is null then
            raise exception '0011 pre-flight: % is missing', v_sig;
        end if;
        if not (select p.prosecdef from pg_proc p where p.oid = to_regprocedure(v_sig)) then
            raise exception '0011 pre-flight: % is not SECURITY DEFINER', v_sig;
        end if;
        if has_function_privilege('anon', v_sig, 'execute')
           or has_function_privilege('authenticated', v_sig, 'execute') then
            raise exception '0011 pre-flight: % is executable by an API role', v_sig;
        end if;
    end loop;

    -- The public wrappers (0009) and their grants are verified, never changed, below.
    if to_regprocedure('public.get_foreverdb_item_stats(bigint)') is null
       or to_regprocedure('public.get_foreverdb_source_stats(text,bigint,integer)') is null then
        raise exception '0011 pre-flight: public stats wrappers are missing (apply 0009 first)';
    end if;

    if to_regclass('public.installation_item_stats') is null
       or to_regclass('public.installation_source_stats') is null then
        raise exception '0011 pre-flight: installation stats tables are missing';
    end if;
end $preflight$;

-- Snapshot owner/ACL/config so the post-condition can prove nothing else changed.
create temporary table _f3_before on commit drop as
select p.oid::regprocedure::text as sig,
       pg_get_userbyid(p.proowner) as owner,
       p.prosecdef,
       coalesce(p.proconfig, '{}') as config,
       coalesce(p.proacl::text, '') as acl,
       pg_get_function_result(p.oid) as result_type,
       pg_get_function_identity_arguments(p.oid) as args
from pg_proc p
where p.oid in (
    to_regprocedure('private.foreverdb_item_stats(bigint)'),
    to_regprocedure('private.foreverdb_source_stats(text,bigint,integer)'),
    to_regprocedure('private.foreverdb_all_stats()')
);

-- ---------------------------------------------------------------------------
-- Item view: one row per (source, level, loot kind) that dropped p_item_id.
-- ---------------------------------------------------------------------------
create or replace function private.foreverdb_item_stats(p_item_id bigint)
returns table (
    source_type text, source_id bigint, source_level integer, source_name text,
    loot_kind text, item_id bigint, item_name text, observations bigint,
    drop_count bigint, quantity bigint, quest_drop_count bigint,
    observed_drop_rate numeric
)
language sql
security definer
set search_path to ''
as $function$
    with item_totals as (
        -- Item side: only rows of the requested item, grouped by full source identity.
        select ii.source_type, ii.source_id, ii.source_level, ii.loot_kind, ii.item_id,
               sum(ii.drop_count) as drops,
               sum(ii.quantity) as qty,
               sum(ii.quest_drop_count) as quest_drops
        from public.installation_item_stats ii
        -- Numerator semantics are unchanged: an item row counts only for an installation
        -- that also recorded the matching source row (as the old per-installation join did).
        join public.installation_source_stats own
          on own.installation_id = ii.installation_id
         and own.source_type = ii.source_type
         and own.source_id = ii.source_id
         and own.source_level = ii.source_level
         and own.loot_kind = ii.loot_kind
        where ii.item_id = p_item_id
        group by ii.source_type, ii.source_id, ii.source_level, ii.loot_kind, ii.item_id
    ),
    source_totals as (
        -- Source side: ALL installations' observations of those source buckets,
        -- including installations that never received the item (zero-drop contributors).
        select ss.source_type, ss.source_id, ss.source_level, ss.loot_kind,
               sum(ss.observations) as obs
        from public.installation_source_stats ss
        where exists (
            select 1 from item_totals t
            where t.source_type = ss.source_type
              and t.source_id = ss.source_id
              and t.source_level = ss.source_level
              and t.loot_kind = ss.loot_kind
        )
        group by ss.source_type, ss.source_id, ss.source_level, ss.loot_kind
    )
    select s.source_type,
           s.source_id,
           s.source_level,
           s.name,
           t.loot_kind,
           i.item_id,
           i.name,
           st.obs::bigint,
           t.drops::bigint,
           t.qty::bigint,
           t.quest_drops::bigint,
           case
               when st.obs > 0
               then t.drops::numeric / st.obs::numeric
               else null
           end
    from item_totals t
    join source_totals st
      on st.source_type = t.source_type
     and st.source_id = t.source_id
     and st.source_level = t.source_level
     and st.loot_kind = t.loot_kind
    join public.sources s
      on s.source_type = t.source_type
     and s.source_id = t.source_id
     and s.source_level = t.source_level
    join public.items i
      on i.item_id = t.item_id
    order by s.source_type, s.source_id, s.source_level, t.loot_kind, i.item_id;
$function$;

-- ---------------------------------------------------------------------------
-- Source view: one row per (loot kind, item) of one exact source + level.
-- ---------------------------------------------------------------------------
create or replace function private.foreverdb_source_stats(
    p_source_type text, p_source_id bigint, p_source_level integer
)
returns table (
    source_type text, source_id bigint, source_level integer, source_name text,
    loot_kind text, item_id bigint, item_name text, observations bigint,
    drop_count bigint, quantity bigint, quest_drop_count bigint,
    observed_drop_rate numeric
)
language sql
security definer
set search_path to ''
as $function$
    with item_totals as (
        select ii.source_type, ii.source_id, ii.source_level, ii.loot_kind, ii.item_id,
               sum(ii.drop_count) as drops,
               sum(ii.quantity) as qty,
               sum(ii.quest_drop_count) as quest_drops
        from public.installation_item_stats ii
        join public.installation_source_stats own
          on own.installation_id = ii.installation_id
         and own.source_type = ii.source_type
         and own.source_id = ii.source_id
         and own.source_level = ii.source_level
         and own.loot_kind = ii.loot_kind
        where ii.source_type = p_source_type
          and ii.source_id = p_source_id
          and ii.source_level = p_source_level
        group by ii.source_type, ii.source_id, ii.source_level, ii.loot_kind, ii.item_id
    ),
    source_totals as (
        -- One row per loot kind of THIS source: computed before the item join, so
        -- several items from the same source never multiply the denominator.
        select ss.source_type, ss.source_id, ss.source_level, ss.loot_kind,
               sum(ss.observations) as obs
        from public.installation_source_stats ss
        where ss.source_type = p_source_type
          and ss.source_id = p_source_id
          and ss.source_level = p_source_level
        group by ss.source_type, ss.source_id, ss.source_level, ss.loot_kind
    )
    select s.source_type,
           s.source_id,
           s.source_level,
           s.name,
           t.loot_kind,
           i.item_id,
           i.name,
           st.obs::bigint,
           t.drops::bigint,
           t.qty::bigint,
           t.quest_drops::bigint,
           case
               when st.obs > 0
               then t.drops::numeric / st.obs::numeric
               else null
           end
    from item_totals t
    join source_totals st
      on st.source_type = t.source_type
     and st.source_id = t.source_id
     and st.source_level = t.source_level
     and st.loot_kind = t.loot_kind
    join public.sources s
      on s.source_type = t.source_type
     and s.source_id = t.source_id
     and s.source_level = t.source_level
    join public.items i
      on i.item_id = t.item_id
    order by s.source_type, s.source_id, s.source_level, t.loot_kind, i.item_id;
$function$;

-- ---------------------------------------------------------------------------
-- Legacy all-sources helper. EXECUTE is already revoked from every API role
-- (0008a); fixed for consistency so no defective copy of the formula remains.
-- ---------------------------------------------------------------------------
create or replace function private.foreverdb_all_stats()
returns table (
    source_type text, source_id bigint, source_level integer, source_name text,
    loot_kind text, item_id bigint, item_name text, observations bigint,
    drop_count bigint, quantity bigint, quest_drop_count bigint,
    observed_drop_rate numeric
)
language sql
security definer
set search_path to ''
as $function$
    with item_totals as (
        select ii.source_type, ii.source_id, ii.source_level, ii.loot_kind, ii.item_id,
               sum(ii.drop_count) as drops,
               sum(ii.quantity) as qty,
               sum(ii.quest_drop_count) as quest_drops
        from public.installation_item_stats ii
        join public.installation_source_stats own
          on own.installation_id = ii.installation_id
         and own.source_type = ii.source_type
         and own.source_id = ii.source_id
         and own.source_level = ii.source_level
         and own.loot_kind = ii.loot_kind
        group by ii.source_type, ii.source_id, ii.source_level, ii.loot_kind, ii.item_id
    ),
    source_totals as (
        select ss.source_type, ss.source_id, ss.source_level, ss.loot_kind,
               sum(ss.observations) as obs
        from public.installation_source_stats ss
        group by ss.source_type, ss.source_id, ss.source_level, ss.loot_kind
    )
    select s.source_type,
           s.source_id,
           s.source_level,
           s.name,
           t.loot_kind,
           i.item_id,
           i.name,
           st.obs::bigint,
           t.drops::bigint,
           t.qty::bigint,
           t.quest_drops::bigint,
           case
               when st.obs > 0
               then t.drops::numeric / st.obs::numeric
               else null
           end
    from item_totals t
    join source_totals st
      on st.source_type = t.source_type
     and st.source_id = t.source_id
     and st.source_level = t.source_level
     and st.loot_kind = t.loot_kind
    join public.sources s
      on s.source_type = t.source_type
     and s.source_id = t.source_id
     and s.source_level = t.source_level
    join public.items i
      on i.item_id = t.item_id
    order by s.source_type, s.source_id, s.source_level, t.loot_kind, i.item_id;
$function$;

-- Post-condition: nothing but the function bodies changed.
do $verify$
declare
    r record;
    v_after record;
begin
    for r in select * from _f3_before loop
        select pg_get_userbyid(p.proowner) as owner,
               p.prosecdef,
               coalesce(p.proconfig, '{}') as config,
               coalesce(p.proacl::text, '') as acl,
               pg_get_function_result(p.oid) as result_type,
               pg_get_function_identity_arguments(p.oid) as args
        into v_after
        from pg_proc p
        where p.oid = to_regprocedure(r.sig);

        if v_after.owner is distinct from r.owner
           or v_after.prosecdef is distinct from r.prosecdef
           or v_after.config is distinct from r.config
           or v_after.acl is distinct from r.acl
           or v_after.result_type is distinct from r.result_type
           or v_after.args is distinct from r.args then
            raise exception '0011 post-condition failed for %: owner/ACL/config/signature changed', r.sig;
        end if;

        if has_function_privilege('anon', r.sig, 'execute')
           or has_function_privilege('authenticated', r.sig, 'execute')
           or has_function_privilege('public', r.sig, 'execute') then
            raise exception '0011 post-condition failed for %: private function became executable', r.sig;
        end if;
    end loop;

    -- Public wrappers and the 0009 contract must be untouched (checked, not changed).
    if has_function_privilege('anon', 'public.get_foreverdb_item_stats(bigint)', 'execute')
       or has_function_privilege('anon', 'public.get_foreverdb_source_stats(text,bigint,integer)', 'execute') then
        raise exception '0011 post-condition failed: anon can call a stats RPC';
    end if;
    if not has_function_privilege('authenticated', 'public.get_foreverdb_item_stats(bigint)', 'execute')
       or not has_function_privilege('authenticated', 'public.get_foreverdb_source_stats(text,bigint,integer)', 'execute') then
        raise exception '0011 post-condition failed: authenticated lost a stats RPC';
    end if;
    if has_table_privilege('anon', 'public.installation_source_stats', 'select')
       or has_table_privilege('authenticated', 'public.installation_source_stats', 'select')
       or has_table_privilege('anon', 'public.installation_item_stats', 'select')
       or has_table_privilege('authenticated', 'public.installation_item_stats', 'select') then
        raise exception '0011 post-condition failed: raw installation stats exposed';
    end if;
end $verify$;

notify pgrst, 'reload schema';

commit;
