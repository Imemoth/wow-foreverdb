-- ForeverDB F-3 ROLLBACK: restore the PRE-0011 aggregate functions.
--
-- These are the production definitions exactly as read with pg_get_functiondef
-- on 2026-10-10 (read-only metadata inspection), i.e. the DEFECTIVE per-installation
-- denominator that 0011 replaces. They were provisioned outside the numbered
-- migration history, so this file is the only in-repo copy of that state.
--
-- Use it (a) as the rollback for 0011 and (b) as the realistic "before" baseline
-- for database/tests/f3_drop_rate_denominator.sql.
--
-- CREATE OR REPLACE keeps owner, ACL and signatures; no grant changes are needed.
-- Rolling back reintroduces the F-3 inflation of observed drop rates.
begin;

CREATE OR REPLACE FUNCTION private.foreverdb_all_stats()
 RETURNS TABLE(source_type text, source_id bigint, source_level integer, source_name text, loot_kind text, item_id bigint, item_name text, observations bigint, drop_count bigint, quantity bigint, quest_drop_count bigint, observed_drop_rate numeric)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
    select
        s.source_type,
        s.source_id,
        s.source_level,
        s.name,
        ss.loot_kind,
        i.item_id,
        i.name,
        sum(ss.observations)::bigint,
        sum(ii.drop_count)::bigint,
        sum(ii.quantity)::bigint,
        sum(ii.quest_drop_count)::bigint,
        case
            when sum(ss.observations) > 0
            then sum(ii.drop_count)::numeric
                 / sum(ss.observations)::numeric
            else null
        end
    from public.installation_source_stats ss
    join public.sources s
      on s.source_type = ss.source_type
     and s.source_id = ss.source_id
     and s.source_level = ss.source_level
    join public.installation_item_stats ii
      on ii.installation_id = ss.installation_id
     and ii.source_type = ss.source_type
     and ii.source_id = ss.source_id
     and ii.source_level = ss.source_level
     and ii.loot_kind = ss.loot_kind
    join public.items i
      on i.item_id = ii.item_id
    group by
        s.source_type,
        s.source_id,
        s.source_level,
        s.name,
        ss.loot_kind,
        i.item_id,
        i.name;
$function$;

CREATE OR REPLACE FUNCTION private.foreverdb_item_stats(p_item_id bigint)
 RETURNS TABLE(source_type text, source_id bigint, source_level integer, source_name text, loot_kind text, item_id bigint, item_name text, observations bigint, drop_count bigint, quantity bigint, quest_drop_count bigint, observed_drop_rate numeric)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
    select
        s.source_type,
        s.source_id,
        s.source_level,
        s.name,
        ss.loot_kind,
        i.item_id,
        i.name,
        sum(ss.observations)::bigint,
        sum(ii.drop_count)::bigint,
        sum(ii.quantity)::bigint,
        sum(ii.quest_drop_count)::bigint,
        case
            when sum(ss.observations) > 0
            then sum(ii.drop_count)::numeric
                 / sum(ss.observations)::numeric
            else null
        end
    from public.installation_source_stats ss
    join public.sources s
      on s.source_type = ss.source_type
     and s.source_id = ss.source_id
     and s.source_level = ss.source_level
    join public.installation_item_stats ii
      on ii.installation_id = ss.installation_id
     and ii.source_type = ss.source_type
     and ii.source_id = ss.source_id
     and ii.source_level = ss.source_level
     and ii.loot_kind = ss.loot_kind
    join public.items i
      on i.item_id = ii.item_id
    where i.item_id = p_item_id
    group by
        s.source_type,
        s.source_id,
        s.source_level,
        s.name,
        ss.loot_kind,
        i.item_id,
        i.name;
$function$;

CREATE OR REPLACE FUNCTION private.foreverdb_source_stats(p_source_type text, p_source_id bigint, p_source_level integer)
 RETURNS TABLE(source_type text, source_id bigint, source_level integer, source_name text, loot_kind text, item_id bigint, item_name text, observations bigint, drop_count bigint, quantity bigint, quest_drop_count bigint, observed_drop_rate numeric)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
    select
        s.source_type,
        s.source_id,
        s.source_level,
        s.name,
        ss.loot_kind,
        i.item_id,
        i.name,
        sum(ss.observations)::bigint,
        sum(ii.drop_count)::bigint,
        sum(ii.quantity)::bigint,
        sum(ii.quest_drop_count)::bigint,
        case
            when sum(ss.observations) > 0
            then sum(ii.drop_count)::numeric
                 / sum(ss.observations)::numeric
            else null
        end
    from public.installation_source_stats ss
    join public.sources s
      on s.source_type = ss.source_type
     and s.source_id = ss.source_id
     and s.source_level = ss.source_level
    join public.installation_item_stats ii
      on ii.installation_id = ss.installation_id
     and ii.source_type = ss.source_type
     and ii.source_id = ss.source_id
     and ii.source_level = ss.source_level
     and ii.loot_kind = ss.loot_kind
    join public.items i
      on i.item_id = ii.item_id
    where s.source_type = p_source_type
      and s.source_id = p_source_id
      and s.source_level = p_source_level
    group by
        s.source_type,
        s.source_id,
        s.source_level,
        s.name,
        ss.loot_kind,
        i.item_id,
        i.name;
$function$;

notify pgrst, 'reload schema';

commit;
