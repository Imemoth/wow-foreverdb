-- Rolls back ops/news_v2_story_overrides_review.sql: deletes ONLY the four reviewed override rows, and only if each is still exactly as written
-- (decision, decided_by). It does not unlink stories: if news_link_stories(true) already ran, remove the affected story members separately
-- (delete from pub.news_story_members where thread_key in (<the six allow threads>)) - a different write with its own approval.
begin;
set local role foreverdb_pub_owner;
do $rb$
begin
    if (select count(*) from pub.news_story_overrides o where o.decided_by = 'owner (Imemoth)' and (o.thread_a, o.thread_b, o.decision) in (
            ('eu:topic:631316', 'us:topic:2360696', 'allow'), ('eu:topic:637043', 'us:topic:2389565', 'allow'),
            ('eu:topic:638462', 'us:topic:2395799', 'allow'), ('eu:topic:637055', 'us:topic:2389633', 'deny'))) <> 4 then
        raise exception 'story overrides rollback refused: the four reviewed rows are not all present exactly as written';
    end if;
end
$rb$;
delete from pub.news_story_overrides o where o.decided_by = 'owner (Imemoth)' and (o.thread_a, o.thread_b, o.decision) in (
    ('eu:topic:631316', 'us:topic:2360696', 'allow'), ('eu:topic:637043', 'us:topic:2389565', 'allow'),
    ('eu:topic:638462', 'us:topic:2395799', 'allow'), ('eu:topic:637055', 'us:topic:2389633', 'deny'));
commit;
