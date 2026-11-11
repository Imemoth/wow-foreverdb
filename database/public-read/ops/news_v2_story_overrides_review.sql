-- News Collector V2 / global story grouping - OWNER-REVIEWED STORY OVERRIDES (decisions of 2026-11-04). OPERATOR. NOT APPLIED.
-- Needs, in this order and each with its OWN explicit approval: (1) migration 0013 applied, (2) THIS script ("story overrides approved"),
-- (3) pub_admin.news_link_stories(true) (the story-link write), (4) the website deployment. Approving one is not approving the others.
-- Run as the platform admin. Writes exactly four rows to pub.news_story_overrides; it never calls news_link_stories(true) and touches
-- no news entry, version, tracked topic, member row or setting. Evidence per decision: docs/web/evidence/news-story-decisions-2026-11-04.json.
--   ALLOW  eu:topic:631316 / us:topic:2360696  WoW Forever Beta Development Notes (titles differ only by date wording; identical 420-char opener)
--   ALLOW  eu:topic:637043 / us:topic:2389565  The WoW: Forever Podcast: Episode 5 - End of Beta Special (empty excerpts; equivalence verified live)
--   ALLOW  eu:topic:638462 / us:topic:2395799  The WoW: Forever Podcast: Episode 6 - All About Tech (empty excerpts; equivalence verified live)
--   DENY   eu:topic:637055 / us:topic:2389633  The WoW Forever Beta Celebration is Underway (region-specific event times; excerpts differ)
-- Fail closed: every source opener must still be exactly what was reviewed (topic, post id, author, title wording, excerpt relation) and none of the
-- four pairs may already carry an override. Any difference aborts the whole transaction.
begin;
set local role foreverdb_pub_owner;

create temp table g_decisions on commit drop as
select * from (values
    ('eu:topic:631316', 'us:topic:2360696', 'allow', 'post:6391795',  'post:30185131', 'same', 'Verified equivalent announcement by the same author: identical 420-character opener; the titles differ only in the date wording (Updated November 2 / Updated 3 November). Owner decision 2026-11-04.'),
    ('eu:topic:637043', 'us:topic:2389565', 'allow', 'post:6446965',  'post:30577452', 'empty', 'Podcast Episode 5, same episode and author 47 seconds apart; the openers carry no excerpt, equivalence verified against the live US and EU posts. Owner decision 2026-11-04.'),
    ('eu:topic:638462', 'us:topic:2395799', 'allow', 'post:6462927',  'post:30671248', 'empty', 'Podcast Episode 6, same episode and author 28 seconds apart; the openers carry no excerpt, equivalence verified against the live US and EU posts. Owner decision 2026-11-04.'),
    ('eu:topic:637055', 'us:topic:2389633', 'deny',  'post:6447060',  'post:30578134', 'differs', 'Region-specific announcement: the event times and wording differ between the US and EU posts, so both regional cards are preserved. Owner decision 2026-11-04.')
) d(thread_a, thread_b, decision, eu_post, us_post, excerpt_relation, reason);

do $pre$
declare d record; eu record; us record; n integer;
begin
    if to_regclass('pub.news_story_overrides') is null or to_regprocedure('pub_admin.news_link_stories(boolean)') is null then
        raise exception 'story overrides precondition failed: migration 0013 is not applied';
    end if;
    for d in select * from g_decisions loop
        select count(*) into n from pub.news_entries e where e.thread_key = d.thread_a and e.source_post_number = 1 and e.status = 'published' and e.suppressed_at is null;
        if n <> 1 then raise exception 'story overrides precondition failed: % must have exactly one published opener (found %)', d.thread_a, n; end if;
        select count(*) into n from pub.news_entries e where e.thread_key = d.thread_b and e.source_post_number = 1 and e.status = 'published' and e.suppressed_at is null;
        if n <> 1 then raise exception 'story overrides precondition failed: % must have exactly one published opener (found %)', d.thread_b, n; end if;
        select * into eu from pub.news_entries e where e.thread_key = d.thread_a and e.source_post_number = 1;
        select * into us from pub.news_entries e where e.thread_key = d.thread_b and e.source_post_number = 1;
        if eu.source_entry_id <> d.eu_post or us.source_entry_id <> d.us_post or eu.author <> 'Kaivax' or us.author <> 'Kaivax'
           or eu.source_key <> 'blizzard-bluepost-eu' or us.source_key <> 'blizzard-bluepost-us' then
            raise exception 'story overrides precondition failed: the openers of % / % are not the reviewed posts (post id, author or source differs)', d.thread_a, d.thread_b;
        end if;
        if d.excerpt_relation = 'same'  and md5(eu.excerpt) <> md5(us.excerpt) then raise exception 'story overrides precondition failed: the excerpts of % / % are no longer identical', d.thread_a, d.thread_b; end if;
        if d.excerpt_relation = 'empty' and (length(btrim(eu.excerpt)) <> 0 or length(btrim(us.excerpt)) <> 0) then raise exception 'story overrides precondition failed: the excerpts of % / % are no longer empty', d.thread_a, d.thread_b; end if;
        if d.excerpt_relation = 'differs' and md5(eu.excerpt) = md5(us.excerpt) then raise exception 'story overrides precondition failed: the excerpts of % / % are now identical (re-review the DENY)', d.thread_a, d.thread_b; end if;
        if exists (select 1 from pub.news_story_overrides o where o.thread_a = d.thread_a and o.thread_b = d.thread_b) then
            raise exception 'story overrides precondition failed: % / % already has an override', d.thread_a, d.thread_b;
        end if;
    end loop;
end
$pre$;

create temp table g_before on commit drop as select count(*)::int as overrides, (select count(*) from pub.news_story_members)::int as members,
    (select count(*) from pub.news_entries)::int as entries from pub.news_story_overrides;

insert into pub.news_story_overrides (thread_a, thread_b, decision, reason, decided_by)
select thread_a, thread_b, decision, reason, 'owner (Imemoth)' from g_decisions;

do $post$
begin
    if (select count(*) from pub.news_story_overrides) <> (select overrides + 4 from g_before)
       or (select count(*) from pub.news_story_members) <> (select members from g_before)
       or (select count(*) from pub.news_entries) <> (select entries from g_before)
       or (select count(*) from pub.news_story_overrides o join g_decisions d using (thread_a, thread_b) where o.decision = d.decision and o.decided_by = 'owner (Imemoth)') <> 4 then
        raise exception 'story overrides postcondition failed: expected exactly four new override rows and nothing else changed';
    end if;
end
$post$;

commit;

-- Review the effect (read-only; still no link is written): expect the three ALLOW pairs as new stories, Beta Celebration untouched.
--   select pub_admin.news_link_stories(false);
-- ROLLBACK (rows only, refuses if someone edited them): ops/news_v2_story_overrides_rollback.sql
