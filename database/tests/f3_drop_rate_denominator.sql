-- F-3 regression suite: observed drop-rate denominator (migration 0011).
--
-- EPHEMERAL DATABASES ONLY. Seeds rows (ids 900001+, installations 'f3-*') and
-- removes them again at the end. NEVER run against production.
--
-- Prerequisites (same chain as .github/workflows/api-security.yml):
--   bootstrap -> 0001..0008b -> 0009.
-- Run from the repository root (uses \i with repo-relative paths):
--   psql -X -v ON_ERROR_STOP=1 -f database/tests/f3_drop_rate_denominator.sql
--
-- Flow:
--   1. Restore the PRE-FIX production definitions (the rollback file) as baseline.
--   2. Seed deterministic fixtures and capture baseline outputs.
--   3. Prove the baseline defect reproduces (so this is a real regression test).
--   4. Apply 0011 and verify scenarios A-J.
--   5. Round-trip: rollback restores the defect, 0011 re-applies cleanly.
--   6. Clean up all seeded rows.

\set ON_ERROR_STOP on

create function pg_temp.f3_assert(p_ok boolean, p_msg text) returns void
language plpgsql as $$
begin
    if p_ok is not true then
        raise exception 'FAIL: %', p_msg;
    end if;
end $$;

-- One row of the SOURCE view for (source, level, kind, item).
create function pg_temp.f3_row(p_type text, p_id bigint, p_lvl integer, p_kind text, p_item bigint)
returns table (obs bigint, drops bigint, qty bigint, quest bigint, rate numeric, n bigint)
language sql as $$
    select max(s.observations), max(s.drop_count), max(s.quantity), max(s.quest_drop_count),
           max(s.observed_drop_rate), count(*)
    from private.foreverdb_source_stats(p_type, p_id, p_lvl) s
    where s.loot_kind = p_kind and s.item_id = p_item;
$$;

-- Re-runnable: remove fixtures left behind by an aborted earlier run.
delete from public.installation_item_stats where installation_id like 'f3-%';
delete from public.installation_source_stats where installation_id like 'f3-%';
delete from public.installations where id like 'f3-%';
delete from public.sources where source_id between 900001 and 900015;
delete from public.items where item_id between 910001 and 910005;
delete from private.foreverdb_api_budgets where bucket like '%0000000000f3';

-- ---------------------------------------------------------------- 1. baseline
\i database/rollback/0011_restore_previous_observed_rate_functions.sql

create temporary table _f3_acl_before on commit preserve rows as
select p.oid::regprocedure::text as sig,
       pg_get_userbyid(p.proowner) as owner,
       coalesce(p.proacl::text, '') as acl,
       coalesce(p.proconfig, '{}') as config,
       pg_get_function_result(p.oid) as result_type
from pg_proc p
where p.pronamespace in ('private'::regnamespace, 'public'::regnamespace)
  and p.proname in ('foreverdb_item_stats','foreverdb_source_stats','foreverdb_all_stats',
                    'get_foreverdb_item_stats','get_foreverdb_source_stats');

-- ---------------------------------------------------------------- 2. fixtures
-- Items: X=910001, Y=910002, Z=910003, W=910004, 910005 = catalog item with no stats.
insert into public.items (item_id, name) values
    (910001,'F3 Item X'),(910002,'F3 Item Y'),(910003,'F3 Item Z'),
    (910004,'F3 Item W'),(910005,'F3 Item Unseen');
insert into public.installations (id, schema_version, addon_version) values
    ('f3-a',1,'test'),('f3-b',1,'test'),('f3-c',1,'test');

create temporary table _f3_src (inst text, st text, sid bigint, lvl int, kind text, obs bigint);
create temporary table _f3_item (inst text, st text, sid bigint, lvl int, kind text, item bigint,
                                 drops bigint, qty bigint, quest bigint);

insert into _f3_src values
 -- A: single installation, 100 obs
 ('f3-a','creature',900001,10,'mob',100),
 -- B: zero-drop contributor
 ('f3-a','creature',900002,10,'mob',100),('f3-b','creature',900002,10,'mob',100),
 -- C: three installations
 ('f3-a','creature',900003,10,'mob',100),('f3-b','creature',900003,10,'mob',200),('f3-c','creature',900003,10,'mob',100),
 -- D: several items from one source
 ('f3-a','creature',900004,10,'mob',100),('f3-b','creature',900004,10,'mob',100),
 -- E: same creature id at different levels (0 = historic level)
 ('f3-a','creature',900005,10,'mob',100),
 ('f3-a','creature',900005,11,'mob',50),('f3-b','creature',900005,11,'mob',50),
 ('f3-a','creature',900005,0,'mob',10),
 -- F: acquisition kinds
 ('f3-a','creature',900006,10,'mob',100),('f3-b','creature',900006,10,'mob',100),
 ('f3-a','creature',900006,10,'skinning',40),
 ('f3-a','gameobject',900007,0,'mining',30),('f3-b','gameobject',900007,0,'mining',30),
 ('f3-a','gameobject',900007,0,'herbalism',20),
 ('f3-b','gameobject',900007,0,'chest',10),
 ('f3-a','gameobject',900007,0,'gameobject',5),
 ('f3-a','fishing',900008,0,'fishing',80),('f3-b','fishing',900008,0,'fishing',20),
 ('f3-a','gameobject',900009,0,'fishing_pool',10),('f3-b','gameobject',900009,0,'fishing_pool',10),
 ('f3-a','item',900010,0,'disenchant',12),('f3-b','item',900010,0,'disenchant',12),
 -- G: zero / inconsistent observations
 ('f3-a','creature',900011,10,'mob',0),
 ('f3-a','creature',900012,10,'mob',0),
 -- Large counts (bigint precision)
 ('f3-a','creature',900013,10,'mob',4000000000000),('f3-b','creature',900013,10,'mob',4000000000000),
 ('f3-c','creature',900013,10,'mob',1000000000000);
-- Orphan: item row without any source row for its kind (900014): both versions must drop it.
insert into _f3_src values ('f3-a','creature',900014,10,'skinning',7);
-- 900015: installation b has an item row but NO source row for that kind (never produced by ingest,
-- possible only through manual repair). Old numerator semantics must hold: b's drops stay excluded.
insert into _f3_src values ('f3-a','creature',900015,10,'mob',100);

insert into _f3_item values
 ('f3-a','creature',900001,10,'mob',910001,10,10,0),
 ('f3-a','creature',900002,10,'mob',910001,10,25,0),
 ('f3-a','creature',900003,10,'mob',910001,20,20,0),('f3-c','creature',900003,10,'mob',910001,20,20,0),
 ('f3-a','creature',900004,10,'mob',910001,10,10,0),('f3-a','creature',900004,10,'mob',910002,5,5,0),
 ('f3-a','creature',900004,10,'mob',910003,0,0,0),('f3-b','creature',900004,10,'mob',910001,3,3,0),
 ('f3-a','creature',900005,10,'mob',910001,10,10,0),
 ('f3-a','creature',900005,11,'mob',910001,5,5,0),
 ('f3-a','creature',900005,0,'mob',910001,1,1,0),
 ('f3-a','creature',900006,10,'mob',910001,10,10,0),
 ('f3-a','creature',900006,10,'skinning',910001,8,8,0),
 ('f3-a','gameobject',900007,0,'mining',910001,3,3,0),
 ('f3-a','gameobject',900007,0,'herbalism',910002,4,4,0),
 ('f3-b','gameobject',900007,0,'chest',910003,1,1,1),
 ('f3-a','gameobject',900007,0,'gameobject',910004,5,5,0),
 ('f3-a','fishing',900008,0,'fishing',910001,8,8,0),
 ('f3-a','gameobject',900009,0,'fishing_pool',910002,2,2,0),
 ('f3-a','item',900010,0,'disenchant',910001,6,6,0),
 ('f3-a','creature',900011,10,'mob',910001,0,0,0),
 ('f3-a','creature',900012,10,'mob',910001,3,3,0),
 ('f3-a','creature',900013,10,'mob',910001,1000000000000,1000000000000,0);
-- Orphan row: kind 'mob' has NO source row for 900014 (only 'skinning' does).
insert into _f3_item values ('f3-a','creature',900014,10,'mob',910001,5,5,0);
insert into _f3_item values ('f3-a','creature',900015,10,'mob',910001,10,10,0),
                            ('f3-b','creature',900015,10,'mob',910001,50,50,0);

insert into public.sources (source_type, source_id, source_level, name)
select distinct st, sid, lvl, 'F3 source ' || sid from (
    select st, sid, lvl from _f3_src union select st, sid, lvl from _f3_item) k;
insert into public.installation_source_stats (installation_id, source_type, source_id, source_level, loot_kind, observations)
select inst, st, sid, lvl, kind, obs from _f3_src;
insert into public.installation_item_stats (installation_id, source_type, source_id, source_level, loot_kind, item_id, drop_count, quantity, quest_drop_count)
select inst, st, sid, lvl, kind, item, drops, qty, quest from _f3_item;

-- Baseline outputs (the defective, pre-fix behaviour) for every fixture source and item.
create temporary table _f3_old_src as
select k.sid as k_sid, s.* from (select distinct st, sid, lvl from _f3_src) k,
lateral private.foreverdb_source_stats(k.st, k.sid, k.lvl) s;
create temporary table _f3_old_item as
select i.item_id as k_item, s.* from (values (910001),(910002),(910003),(910004),(910005)) i(item_id),
lateral private.foreverdb_item_stats(i.item_id) s
where s.source_id between 900001 and 900015;

-- ---------------------------------------------------- 3. baseline defect proof
do $baseline$
begin
    perform pg_temp.f3_assert((select obs from pg_temp.f3_row('creature',900002,10,'mob',910001)) = 100
        and (select rate from pg_temp.f3_row('creature',900002,10,'mob',910001)) = 0.1,
        'baseline must reproduce F-3 (B: 10/100 = 10% instead of 5%)');
    perform pg_temp.f3_assert((select rate from pg_temp.f3_row('creature',900003,10,'mob',910001)) = 0.2,
        'baseline must reproduce F-3 (C: 40/200 = 20% instead of 10%)');
    perform pg_temp.f3_assert((select obs from pg_temp.f3_row('creature',900004,10,'mob',910002)) = 100,
        'baseline must reproduce F-3 (D: item Y denominator 100 instead of 200)');
    raise notice 'PASS: baseline reproduces the F-3 defect (B 10%%, C 20%%, D 100 obs)';
end $baseline$;

-- ----------------------------------------------------------- 4. apply 0011
\i database/migrations/0011_fix_observed_drop_rate_denominator.sql

do $scenarios$
declare
    r record;
begin
    -- A. Single installation: 100 obs, 10 drops -> 10 %.
    select * into r from pg_temp.f3_row('creature',900001,10,'mob',910001);
    perform pg_temp.f3_assert(r.obs = 100 and r.drops = 10 and r.rate = 0.1 and r.n = 1, 'A single installation 10%');

    -- B. Zero-drop contributor: 10 / 200 = 5 %.
    select * into r from pg_temp.f3_row('creature',900002,10,'mob',910001);
    perform pg_temp.f3_assert(r.obs = 200 and r.drops = 10 and r.rate = 0.05 and r.qty = 25 and r.n = 1,
        'B zero-drop installation must enter the denominator (5%) and quantity stays 25');

    -- C. Three installations: 40 / 400 = 10 %.
    select * into r from pg_temp.f3_row('creature',900003,10,'mob',910001);
    perform pg_temp.f3_assert(r.obs = 400 and r.drops = 40 and r.rate = 0.1, 'C three installations 10%');

    -- D. Several items from one source never multiply the denominator.
    perform pg_temp.f3_assert(
        (select count(*) from private.foreverdb_source_stats('creature',900004,10)) = 3
        and (select count(distinct observations) from private.foreverdb_source_stats('creature',900004,10)) = 1
        and (select max(observations) from private.foreverdb_source_stats('creature',900004,10)) = 200,
        'D each item shares ONE source denominator (200), not 200 x items');
    select * into r from pg_temp.f3_row('creature',900004,10,'mob',910001);
    perform pg_temp.f3_assert(r.drops = 13 and r.rate = 13.0/200, 'D item X 13/200');
    select * into r from pg_temp.f3_row('creature',900004,10,'mob',910002);
    perform pg_temp.f3_assert(r.drops = 5 and r.rate = 5.0/200, 'D item Y 5/200 (Y was not seen by installation b)');
    select * into r from pg_temp.f3_row('creature',900004,10,'mob',910003);
    perform pg_temp.f3_assert(r.drops = 0 and r.rate = 0, 'D item Z 0 drops -> 0, not null');

    -- E. Same creature id, different levels stay separate.
    select * into r from pg_temp.f3_row('creature',900005,10,'mob',910001);
    perform pg_temp.f3_assert(r.obs = 100 and r.rate = 0.1, 'E level 10');
    select * into r from pg_temp.f3_row('creature',900005,11,'mob',910001);
    perform pg_temp.f3_assert(r.obs = 100 and r.drops = 5 and r.rate = 0.05, 'E level 11 includes zero-drop contributor');
    select * into r from pg_temp.f3_row('creature',900005,0,'mob',910001);
    perform pg_temp.f3_assert(r.obs = 10 and r.rate = 0.1, 'E historic level 0 not mixed with real levels');
    perform pg_temp.f3_assert(
        (select count(*) from private.foreverdb_item_stats(910001) where source_id = 900005) = 3,
        'E item view returns one row per level');

    -- F. Acquisition kinds are never mixed.
    select * into r from pg_temp.f3_row('creature',900006,10,'mob',910001);
    perform pg_temp.f3_assert(r.obs = 200 and r.rate = 0.05, 'F mob');
    select * into r from pg_temp.f3_row('creature',900006,10,'skinning',910001);
    perform pg_temp.f3_assert(r.obs = 40 and r.drops = 8 and r.rate = 0.2, 'F skinning separate from mob');
    select * into r from pg_temp.f3_row('gameobject',900007,0,'mining',910001);
    perform pg_temp.f3_assert(r.obs = 60 and r.rate = 0.05, 'F mining');
    select * into r from pg_temp.f3_row('gameobject',900007,0,'herbalism',910002);
    perform pg_temp.f3_assert(r.obs = 20 and r.rate = 0.2, 'F herbalism');
    select * into r from pg_temp.f3_row('gameobject',900007,0,'chest',910003);
    perform pg_temp.f3_assert(r.obs = 10 and r.rate = 0.1 and r.quest = 1, 'F chest keeps quest drops');
    select * into r from pg_temp.f3_row('gameobject',900007,0,'gameobject',910004);
    perform pg_temp.f3_assert(r.obs = 5 and r.rate = 1, 'F gameobject kind');
    select * into r from pg_temp.f3_row('fishing',900008,0,'fishing',910001);
    perform pg_temp.f3_assert(r.obs = 100 and r.rate = 0.08, 'F fishing');
    select * into r from pg_temp.f3_row('gameobject',900009,0,'fishing_pool',910002);
    perform pg_temp.f3_assert(r.obs = 20 and r.rate = 0.1, 'F fishing_pool');
    select * into r from pg_temp.f3_row('item',900010,0,'disenchant',910001);
    perform pg_temp.f3_assert(r.obs = 24 and r.rate = 0.25, 'F disenchant');
    perform pg_temp.f3_assert(
        (select count(*) from private.foreverdb_source_stats('gameobject',900007,0)) = 4,
        'F four kinds on one gameobject remain four rows');

    -- G. Zero observations and empty data: no division by zero, no rows invented.
    select * into r from pg_temp.f3_row('creature',900011,10,'mob',910001);
    perform pg_temp.f3_assert(r.n = 1 and r.obs = 0 and r.rate is null, 'G zero observations -> null rate');
    select * into r from pg_temp.f3_row('creature',900012,10,'mob',910001);
    perform pg_temp.f3_assert(r.n = 1 and r.obs = 0 and r.drops = 3 and r.rate is null,
        'G inconsistent zero denominator -> null, no error');
    perform pg_temp.f3_assert((select count(*) from private.foreverdb_item_stats(910099)) = 0, 'G unknown item -> no rows');
    perform pg_temp.f3_assert((select count(*) from private.foreverdb_item_stats(910005)) = 0, 'G item without stats -> no rows');
    perform pg_temp.f3_assert((select count(*) from private.foreverdb_source_stats('creature',999999,10)) = 0, 'G unknown source -> no rows');
    perform pg_temp.f3_assert((select count(*) from private.foreverdb_item_stats(null)) = 0, 'G null item -> no rows');
    perform pg_temp.f3_assert((select count(*) from pg_temp.f3_row('creature',900014,10,'mob',910001) where n > 0) = 0,
        'G orphan item row without source row stays excluded (same as before)');

    -- Large counts: exact bigint sums, numeric division.
    select * into r from pg_temp.f3_row('creature',900013,10,'mob',910001);
    perform pg_temp.f3_assert(r.obs = 9000000000000 and r.drops = 1000000000000
        and abs(r.rate - 1.0/9) < 1e-12 and r.qty = 1000000000000, 'large counts keep precision');

    -- Item row without the installation's own source row never enters the numerator (old semantics).
    select * into r from pg_temp.f3_row('creature',900015,10,'mob',910001);
    perform pg_temp.f3_assert(r.obs = 100 and r.drops = 10 and r.qty = 10 and r.rate = 0.1,
        'numerator must exclude an installation that has an item row but no source row (rate must not exceed the old 10%)');

    raise notice 'PASS: scenarios A-G (single, zero-drop contributor, three installations, multi-item, levels, kinds, empty/zero, large)';
end $scenarios$;

-- Internal consistency: item view row == source view row for the same bucket.
do $consistency$
declare v_bad integer;
begin
    select count(*) into v_bad
    from private.foreverdb_item_stats(910001) i
    join lateral private.foreverdb_source_stats(i.source_type, i.source_id, i.source_level) s
      on s.loot_kind = i.loot_kind and s.item_id = i.item_id
    where i.source_id between 900001 and 900015
      and (i.observations, i.drop_count, i.quantity, i.quest_drop_count, i.observed_drop_rate)
          is distinct from (s.observations, s.drop_count, s.quantity, s.quest_drop_count, s.observed_drop_rate);
    perform pg_temp.f3_assert(v_bad = 0, 'item view and source view disagree on ' || v_bad || ' buckets');
    perform pg_temp.f3_assert(
        (select count(*) from private.foreverdb_all_stats() a
          where a.source_id between 900001 and 900015)
        = (select count(*) from _f3_old_src), 'all_stats row count differs from baseline');
    raise notice 'PASS: item view, source view and all_stats are internally consistent';
end $consistency$;

-- J. Non-F-3 behaviour is unchanged: same row set, same non-denominator columns,
-- single-installation buckets identical in observations and rate (the other columns are
-- covered by the non-denominator check above), and every corrected
-- denominator equals the fixture ground truth (sum of all installations).
create temporary table _f3_new_src as
select s.* from (select distinct st, sid, lvl from _f3_src) k,
lateral private.foreverdb_source_stats(k.st, k.sid, k.lvl) s;

do $semantics$
declare v_bad integer;
begin
    -- Same row set (key-wise), same non-denominator columns.
    select count(*) into v_bad from (
        (select source_type, source_id, source_level, loot_kind, item_id from _f3_old_src
         except select source_type, source_id, source_level, loot_kind, item_id from _f3_new_src)
        union all
        (select source_type, source_id, source_level, loot_kind, item_id from _f3_new_src
         except select source_type, source_id, source_level, loot_kind, item_id from _f3_old_src)) d;
    perform pg_temp.f3_assert(v_bad = 0, 'row set changed by the fix: ' || v_bad);

    select count(*) into v_bad
    from _f3_old_src o
    join _f3_new_src n using (source_type, source_id, source_level, loot_kind, item_id)
    where (o.source_name, o.item_name, o.drop_count, o.quantity, o.quest_drop_count)
          is distinct from (n.source_name, n.item_name, n.drop_count, n.quantity, n.quest_drop_count);
    perform pg_temp.f3_assert(v_bad = 0, 'non-denominator columns changed: ' || v_bad);

    -- Item view (all fixture items) vs the captured baseline: same keys, same non-denominator columns.
    select count(*) into v_bad from (
        (select source_type, source_id, source_level, loot_kind, item_id from _f3_old_item
         except select n.source_type, n.source_id, n.source_level, n.loot_kind, n.item_id
                from (values (910001),(910002),(910003),(910004),(910005)) i(item_id),
                lateral private.foreverdb_item_stats(i.item_id) n
                where n.source_id between 900001 and 900015)
        union all
        (select n.source_type, n.source_id, n.source_level, n.loot_kind, n.item_id
         from (values (910001),(910002),(910003),(910004),(910005)) i(item_id),
         lateral private.foreverdb_item_stats(i.item_id) n
         where n.source_id between 900001 and 900015
         except select source_type, source_id, source_level, loot_kind, item_id from _f3_old_item)) d;
    perform pg_temp.f3_assert(v_bad = 0, 'item view row set changed: ' || v_bad);
    select count(*) into v_bad
    from _f3_old_item o
    join lateral (select n.* from (values (910001),(910002),(910003),(910004),(910005)) i(item_id),
                  lateral private.foreverdb_item_stats(i.item_id) n
                  where n.item_id = o.item_id and n.source_id = o.source_id and n.source_level = o.source_level
                    and n.source_type = o.source_type and n.loot_kind = o.loot_kind) n on true
    where (o.drop_count, o.quantity, o.quest_drop_count, o.source_name, o.item_name)
          is distinct from (n.drop_count, n.quantity, n.quest_drop_count, n.source_name, n.item_name);
    perform pg_temp.f3_assert(v_bad = 0, 'item view non-denominator columns changed: ' || v_bad);

    -- Single-installation (source, level, kind) buckets: identical in every column.
    select count(*) into v_bad
    from _f3_old_src o
    join _f3_new_src n using (source_type, source_id, source_level, loot_kind, item_id)
    join (select st, sid, lvl, kind, count(distinct inst) n_inst from _f3_src group by 1,2,3,4) c
      on (c.st, c.sid, c.lvl, c.kind) = (o.source_type, o.source_id, o.source_level, o.loot_kind)
    where c.n_inst = 1
      and (o.observations, o.observed_drop_rate) is distinct from (n.observations, n.observed_drop_rate);
    perform pg_temp.f3_assert(v_bad = 0, 'single-installation buckets changed: ' || v_bad);

    -- Ground truth: new denominator == sum of observations over ALL installations.
    select count(*) into v_bad
    from _f3_new_src n
    join (select st, sid, lvl, kind, sum(obs) total from _f3_src group by 1,2,3,4) t
      on (t.st, t.sid, t.lvl, t.kind) = (n.source_type, n.source_id, n.source_level, n.loot_kind)
    where n.observations is distinct from t.total;
    perform pg_temp.f3_assert(v_bad = 0, 'denominator differs from the all-installation total: ' || v_bad);

    -- Direction: observations only grow, rates only fall or stay.
    select count(*) into v_bad
    from _f3_old_src o
    join _f3_new_src n using (source_type, source_id, source_level, loot_kind, item_id)
    where n.observations < o.observations
       or coalesce(n.observed_drop_rate, 0) > coalesce(o.observed_drop_rate, 0);
    perform pg_temp.f3_assert(v_bad = 0, 'a corrected rate rose or a denominator shrank');

    -- The fix must actually change the multi-installation buckets (guards a no-op).
    perform pg_temp.f3_assert(
        (select count(*) from _f3_old_src o join _f3_new_src n using (source_type, source_id, source_level, loot_kind, item_id)
          where o.observations is distinct from n.observations) = 11,
        'expected exactly 11 corrected buckets in the fixtures');
    raise notice 'PASS: unrelated columns, row sets and single-installation buckets unchanged; 11 corrected buckets, all lower rates';
end $semantics$;

-- H. Response contract and I. security: signature, owner, ACL and config are
-- byte-identical to the baseline; API roles still cannot reach private data.
do $contract$
declare v_bad integer;
begin
    select count(*) into v_bad
    from _f3_acl_before b
    join pg_proc p on p.oid = to_regprocedure(b.sig)
    where b.owner is distinct from pg_get_userbyid(p.proowner)
       or b.acl is distinct from coalesce(p.proacl::text, '')
       or b.config is distinct from coalesce(p.proconfig, '{}')
       or b.result_type is distinct from pg_get_function_result(p.oid);
    perform pg_temp.f3_assert(v_bad = 0, 'owner/ACL/config/result type changed on ' || v_bad || ' functions');
    perform pg_temp.f3_assert((select count(*) from _f3_acl_before) = 5, 'expected 5 audited functions');

    perform pg_temp.f3_assert(
        (select result_type from _f3_acl_before where sig like '%foreverdb_item_stats(bigint)' and sig like 'private.%')
        = 'TABLE(source_type text, source_id bigint, source_level integer, source_name text, loot_kind text, item_id bigint, item_name text, observations bigint, drop_count bigint, quantity bigint, quest_drop_count bigint, observed_drop_rate numeric)',
        'response column contract changed');
    raise notice 'PASS: response contract, owner, ACL and search_path identical to baseline';
end $contract$;

do $privileges$
begin
    perform pg_temp.f3_assert(
        not has_function_privilege('anon','private.foreverdb_item_stats(bigint)','execute')
        and not has_function_privilege('authenticated','private.foreverdb_item_stats(bigint)','execute')
        and not has_function_privilege('anon','private.foreverdb_source_stats(text,bigint,integer)','execute')
        and not has_function_privilege('authenticated','private.foreverdb_source_stats(text,bigint,integer)','execute')
        and not has_function_privilege('anon','private.foreverdb_all_stats()','execute')
        and not has_function_privilege('authenticated','private.foreverdb_all_stats()','execute'),
        'private aggregate functions must stay closed to API roles');
    perform pg_temp.f3_assert(
        not has_table_privilege('anon','public.installation_source_stats','select')
        and not has_table_privilege('authenticated','public.installation_source_stats','select')
        and not has_table_privilege('anon','public.installation_item_stats','select')
        and not has_table_privilege('authenticated','public.installation_item_stats','select'),
        'raw installation statistics must stay private');
    perform pg_temp.f3_assert(
        (select count(*) from pg_proc p where p.pronamespace = 'private'::regnamespace
           and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute')
                or has_function_privilege('public', p.oid, 'execute'))
           and p.proname like 'foreverdb\_%\_stats') = 0,
        'no private stats function may be executable by an API role or PUBLIC');
    perform pg_temp.f3_assert(
        (select bool_and(p.prosecdef and p.proconfig = array['search_path=""'])
           from pg_proc p where p.oid in (
             to_regprocedure('private.foreverdb_item_stats(bigint)'),
             to_regprocedure('private.foreverdb_source_stats(text,bigint,integer)'),
             to_regprocedure('private.foreverdb_all_stats()'))),
        'replaced functions must stay SECURITY DEFINER with empty search_path');
    raise notice 'PASS: no new access to private statistics (grants, SECURITY DEFINER, search_path)';
end $privileges$;

-- Real role behaviour through the unchanged public wrappers (0009 gate and quotas stay in force).
set role anon;
do $anon$
begin
    begin
        perform public.get_foreverdb_source_stats('creature',900002,10);
        raise exception 'FAIL: anon reached a stats RPC';
    exception when insufficient_privilege then null;
    end;
end $anon$;
reset role;

set role authenticated;
-- Session-scoped claims (psql autocommits, so a transaction-local setting would vanish).
select set_config('request.jwt.claim.sub','00000000-0000-4000-8000-0000000000f3',false) is not null as sub_set;
select set_config('request.jwt.claim.role','authenticated',false) is not null as role_set;
do $auth$
declare
    v_keys text;
    v_row jsonb;
begin
    select to_jsonb(s) into v_row from public.get_foreverdb_source_stats('creature',900002,10) s where s.item_id = 910001;
    select string_agg(k, ',' order by k) into v_keys from jsonb_object_keys(v_row) k;
    perform pg_temp.f3_assert(v_keys =
        'drop_count,item_id,item_name,loot_kind,observations,observed_drop_rate,quantity,quest_drop_count,source_id,source_level,source_name,source_type',
        'wrapper JSON keys changed: ' || v_keys);
    perform pg_temp.f3_assert((v_row->>'observations')::bigint = 200 and (v_row->>'drop_count')::bigint = 10
        and (v_row->>'observed_drop_rate')::numeric = 0.05, 'wrapper returns corrected values');
    perform pg_temp.f3_assert((select count(*) from public.get_foreverdb_item_stats(910001)) > 0, 'item wrapper works');
    begin
        perform * from private.foreverdb_item_stats(910001);
        raise exception 'FAIL: authenticated reached a private function';
    exception when insufficient_privilege then null;
    end;
    begin
        perform public.get_foreverdb_item_stats(-1);
        raise exception 'FAIL: invalid item id accepted';
    exception when sqlstate 'PT400' then null;
    end;
    raise notice 'PASS: authenticated wrappers keep contract, validation and corrected values; anon and private access denied';
end $auth$;
reset role;
select set_config('request.jwt.claim.sub','',false) is not null as sub_cleared;
select set_config('request.jwt.claim.role','',false) is not null as role_cleared;

-- ------------------------------------------------- 5. rollback round trip
\i database/rollback/0011_restore_previous_observed_rate_functions.sql
do $rollback$
begin
    perform pg_temp.f3_assert((select obs from pg_temp.f3_row('creature',900002,10,'mob',910001)) = 100,
        'rollback must restore the previous behaviour');
    perform pg_temp.f3_assert(
        (select count(*) from _f3_acl_before b join pg_proc p on p.oid = to_regprocedure(b.sig)
          where b.acl is distinct from coalesce(p.proacl::text,'')) = 0, 'rollback changed an ACL');
    raise notice 'PASS: rollback restores the previous functions with identical ACLs';
end $rollback$;

\i database/migrations/0011_fix_observed_drop_rate_denominator.sql
do $reapply$
begin
    perform pg_temp.f3_assert((select obs from pg_temp.f3_row('creature',900002,10,'mob',910001)) = 200
        and (select rate from pg_temp.f3_row('creature',900002,10,'mob',910001)) = 0.05, 'migration is re-appliable');
    raise notice 'PASS: migration re-applies cleanly after rollback (idempotent)';
end $reapply$;

-- ------------------------------------------------------------ 6. clean up
delete from public.installation_item_stats where installation_id like 'f3-%';
delete from public.installation_source_stats where installation_id like 'f3-%';
delete from public.installations where id like 'f3-%';
delete from private.foreverdb_api_budgets where bucket like '%0000000000f3';
delete from public.sources where source_id between 900001 and 900015;
delete from public.items where item_id between 910001 and 910005;
do $cleanup$
begin
    perform pg_temp.f3_assert(
        (select count(*) from public.installation_item_stats where installation_id like 'f3-%') = 0
        and (select count(*) from public.sources where source_id between 900001 and 900015) = 0,
        'fixtures were not fully removed');
    raise notice 'PASS: F-3 suite complete, fixtures removed';
end $cleanup$;
