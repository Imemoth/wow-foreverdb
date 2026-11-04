#!/usr/bin/env bash
# Applies the public-read + News migrations (0001, 0002_news, 0008-0011) the way Supabase's hosted `postgres` role does
# (a NON-superuser admin with CREATEROLE) and runs every News SQL test: model security/behaviour, the V1 dedup invariants,
# the V2 provenance/thread/revision behaviour and the V2 security boundaries, and the monitoring SQL (ops script).
# EPHEMERAL SERVER ONLY. Env: PGHOST PGPORT PGUSER (superuser of a FRESH throwaway cluster: roles are cluster-wide).
set -euo pipefail
cd "$(dirname "$0")/.."
: "${PGHOST:?}" "${PGPORT:?}" "${PGUSER:?}"
case "${PGHOST}" in localhost|127.0.0.1|/tmp|/var/run/postgresql|/var/tmp/*) ;; *) echo "Refusing non-local PGHOST=${PGHOST}"; exit 2;; esac
DB=${NEWS_TEST_DB:-az_news_sql}
for r in anon authenticated service_role; do psql -X -q -d postgres -c "create role $r nologin" 2>/dev/null || true; done
ADMIN_PW=${ADMIN_PW:-it-only-admin}
psql -X -q -d postgres -c "create role sbadmin login createrole createdb bypassrls inherit" 2>/dev/null || true
psql -X -q -v ON_ERROR_STOP=1 -d postgres -c "alter role sbadmin password '$ADMIN_PW'"
psql -X -q -v ON_ERROR_STOP=1 -d postgres -c "drop database if exists $DB" -c "create database $DB owner sbadmin" >/dev/null
SU="psql -X -q -v ON_ERROR_STOP=1 -d $DB"
$SU -f database/public-read/tests/hosted-stubs/supabase_stubs.sql >/dev/null
$SU -c "alter schema extensions owner to sbadmin" \
    -c "grant usage on schema vault, cron, net to sbadmin" \
    -c "grant select on vault.decrypted_secrets to sbadmin" -c "grant select, insert, update on vault.secrets to sbadmin" \
    -c "grant execute on all functions in schema vault, cron, net to sbadmin" \
    -c "grant select, insert, update, delete on all tables in schema cron to sbadmin" \
    -c "grant select, insert, update, delete on all tables in schema net to sbadmin" \
    -c "grant usage on all sequences in schema cron, net to sbadmin" >/dev/null
A="env PGPASSWORD=$ADMIN_PW psql -X -q -v ON_ERROR_STOP=1 -U sbadmin -d $DB"
$A -tc "select 'admin is superuser: ' || rolsuper from pg_roles where rolname = current_user" | grep -q "false" || { echo "FAIL: admin must not be superuser"; exit 1; }
for m in 0001_public_read_model 0002_news_model 0008_news_ingest_role 0009_news_ingest_search_path 0010_news_bluepost_suppression 0011_news_collector_v2 0012_news_revision_due_tolerance; do
  $A -f "database/public-read/migrations/$m.sql" >/dev/null 2>&1 || { echo "FAIL: migration $m"; $A -f "database/public-read/migrations/$m.sql" 2>&1 | tail -5; exit 1; }
done
echo "PASS: migrations 0001, 0002(news), 0008-0012 applied as a non-superuser admin"
# 0011 must be re-runnable (idempotent) and must not disturb the V1 migrations when re-applied after 0010.
$A -f database/public-read/migrations/0011_news_collector_v2.sql >/dev/null 2>&1 || { echo "FAIL: 0011 is not idempotent"; exit 1; }
echo "PASS: 0011 is idempotent"
# 0012 (revision due-time tolerance) replaces ONE function of 0011: re-applying 0011 above restored the strict body, so apply 0012 again
# (the real deployment order) and prove it is idempotent as well.
$A -f database/public-read/migrations/0012_news_revision_due_tolerance.sql >/dev/null 2>&1 || { echo "FAIL: 0012 did not re-apply"; exit 1; }
$A -f database/public-read/migrations/0012_news_revision_due_tolerance.sql >/dev/null 2>&1 || { echo "FAIL: 0012 is not idempotent"; exit 1; }
echo "PASS: 0012 is idempotent"
# Assertion scripts need catalog/owner visibility, so they run as the throwaway cluster's superuser; the migrations above
# (where privilege mistakes matter) ran as the hosted-like non-superuser admin.
for t in news_model_security news_model_behavior news_bluepost_dedup news_bluepost_dedup_security news_v2_security news_v2_behavior news_v2_revision_schedule; do
  out=$($SU -f "database/public-read/tests/$t.sql" 2>&1) || { echo "FAIL: $t"; echo "$out" | tail -8; exit 1; }
  echo "PASS: $t"
done
# 0012 rollback path: ops/news_v2_0012_rollback.sql restores ONLY news_revision_batch to its exact 0011 definition (a topic due 6 s after
# the tick is skipped again = the defect) and refuses on drift; re-applying 0012 restores the tolerance. All checked through the real RPC.
due_in_6s() { $SU -tA <<'SQL' | tail -1
begin;
insert into pub.news_sources (source_key, source_type, region, endpoint_url) values ('probe-us', 'bluepost', 'us', 'https://example.com/p');
insert into pub.news_tracked_topics (source_key, topic_id, thread_origin, last_official_at, next_check_at, official_post_ids)
values ('probe-us', 'topic:9', 'official', now(), now() + interval '6 seconds', array[9]);
select jsonb_array_length(pub_admin.news_revision_batch('probe-us', 25) -> 'dueTopics');
rollback;
SQL
}
body_md5() { $SU -tA -c "select md5(prosrc) from pg_proc where oid = 'pub_admin.news_revision_batch(text,integer)'::regprocedure"; }
others_fp() { $SU -tA -c "select md5(string_agg(p.oid::regprocedure::text || md5(p.prosrc || coalesce(p.proacl::text, '')), ';' order by p.oid::regprocedure::text)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('pub','pub_admin','web_api') and p.oid <> 'pub_admin.news_revision_batch(text,integer)'::regprocedure"; }
[ "$(due_in_6s)" = "1" ] || { echo "FAIL: 0012 tolerance not active"; exit 1; }
[ "$(body_md5)" = "149f9bd8a0f5191163108026ccbdbd84" ] || { echo "FAIL: 0012 body fingerprint"; exit 1; }
OTHERS_BEFORE=$(others_fp)
$A -f database/public-read/ops/news_v2_0012_rollback.sql >/dev/null 2>&1 || { echo "FAIL: 0012 rollback script"; $A -f database/public-read/ops/news_v2_0012_rollback.sql 2>&1 | tail -3; exit 1; }
[ "$(due_in_6s)" = "0" ] || { echo "FAIL: the 0012 rollback must restore the strict due test"; exit 1; }
[ "$(body_md5)" = "56dca40c9936352bd768db0993ed82a4" ] || { echo "FAIL: rollback did not restore the exact 0011 body"; exit 1; }
[ "$(others_fp)" = "$OTHERS_BEFORE" ] || { echo "FAIL: the narrow rollback changed another function"; exit 1; }
$A -f database/public-read/ops/news_v2_0012_rollback.sql >/dev/null 2>&1 && { echo "FAIL: a second rollback must be refused"; exit 1; }
$A -f database/public-read/migrations/0012_news_revision_due_tolerance.sql >/dev/null 2>&1 || { echo "FAIL: re-apply 0012"; exit 1; }
[ "$(due_in_6s)" = "1" ] || { echo "FAIL: re-applying 0012 must restore the tolerance"; exit 1; }
# Drift: a hand-edited function is neither the 0011 nor the 0012 definition. Both 0012 and its rollback must REFUSE to overwrite it.
$A >/dev/null <<'SQL'
begin; set local role foreverdb_pub_owner;
create or replace function pub_admin.news_revision_batch(p_source_key text, p_limit integer default 25) returns jsonb language plpgsql stable security definer set search_path = '' as $f$ begin return '{"drift": true}'::jsonb; end; $f$;
commit;
SQL
$A -f database/public-read/migrations/0012_news_revision_due_tolerance.sql >/dev/null 2>&1 && { echo "FAIL: 0012 must refuse to overwrite a drifted function"; exit 1; }
$A -f database/public-read/ops/news_v2_0012_rollback.sql >/dev/null 2>&1 && { echo "FAIL: the rollback must refuse a drifted function"; exit 1; }
$SU -tA -c "select prosrc like '%drift%' from pg_proc where oid = 'pub_admin.news_revision_batch(text,integer)'::regprocedure" | grep -qx t || { echo "FAIL: a refused script changed the drifted function"; exit 1; }
# Test-database recovery only: 0011 restores its definition, then 0012 applies again.
$A -f database/public-read/migrations/0011_news_collector_v2.sql >/dev/null 2>&1 || { echo "FAIL: re-apply 0011 (test recovery)"; exit 1; }
$A -f database/public-read/migrations/0012_news_revision_due_tolerance.sql >/dev/null 2>&1 || { echo "FAIL: re-apply 0012 after recovery"; exit 1; }
[ "$(due_in_6s)" = "1" ] && [ "$(body_md5)" = "149f9bd8a0f5191163108026ccbdbd84" ] || { echo "FAIL: final state must be the 0012 definition"; exit 1; }
echo "PASS: 0012 narrow rollback restores the exact 0011 body/ACL and no other function; both scripts refuse a drifted function; 0012 re-applies"
# Operator monitoring (cron/net stubs stand in for the platform extensions).
# On Supabase this script is run by the platform `postgres` admin; the throwaway cluster's equivalent is its superuser.
$SU -tc "select has_function_privilege('postgres', 'pub_admin.news_health_snapshot()', 'execute')" | grep -q "t" || { echo "FAIL: platform admin cannot run the health snapshot"; exit 1; }
$SU -f database/ops/0018_news_health_monitoring.sql >/dev/null 2>&1 || { echo "FAIL: 0018 monitoring did not apply"; $SU -f database/ops/0018_news_health_monitoring.sql 2>&1 | tail -5; exit 1; }
out=$($SU -f database/public-read/tests/news_health_monitoring.sql 2>&1) || { echo "FAIL: news_health_monitoring"; echo "$out" | tail -8; exit 1; }
echo "PASS: news_health_monitoring"
# Rollback must restore the V1 read/write functions and keep every stored row. Use real committed data this time.
$SU >/dev/null <<'SQL'
select pub_admin.news_apply_sync(jsonb_build_object(
  'source', jsonb_build_object('sourceKey','rb-us','sourceType','bluepost','region','us','endpointUrl','https://us.forums.blizzard.com/en/wow','enabled',true),
  'run', jsonb_build_object('status','succeeded','verifiedStaff', jsonb_build_array(jsonb_build_object('userId',3390,'username','Kaivax','group','community-manager'))),
  'entries', jsonb_build_array(
    jsonb_build_object('sourceEntryId','post:1','sourceTopicId','topic:7','sourcePostNumber',1,'threadKey','us:topic:7','canonicalUrl','https://us.forums.blizzard.com/en/wow/t/x/7/1','title','WoW Forever rollback opener','author','Kaivax','region','us','publishedAt','2026-10-01T00:00:00Z','excerpt','e','category','bluepost','relevance','relevant','status','published','contentHash',repeat('a',64),'authorUserId',3390,'authorGroup','community-manager','threadOrigin','official'),
    jsonb_build_object('sourceEntryId','post:2','sourceTopicId','topic:7','sourcePostNumber',2,'threadKey','us:topic:7','canonicalUrl','https://us.forums.blizzard.com/en/wow/t/x/7/2','title','WoW Forever rollback opener','author','Kaivax','region','us','publishedAt','2026-11-01T00:00:00Z','excerpt','e2','category','bluepost','relevance','relevant','status','published','contentHash',repeat('b',64),'authorUserId',3390,'authorGroup','community-manager','threadOrigin','official'))));
SQL
[ "$($SU -tAc "select count(*) from web_api.news_cards(null,'',null,false,50,0) where source_post_number = 2")" = "1" ] || { echo "FAIL: V2 reply not visible before rollback"; exit 1; }
before=$($SU -tAc "select (select count(*) from pub.news_entries) || '/' || (select count(*) from pub.news_post_versions)")
$A -f database/public-read/ops/news_v2_rollback.sql >/dev/null 2>&1 || { echo "FAIL: rollback script"; $A -f database/public-read/ops/news_v2_rollback.sql 2>&1 | tail -5; exit 1; }
after=$($SU -tAc "select (select count(*) from pub.news_entries) || '/' || (select count(*) from pub.news_post_versions)")
[ "$before" = "$after" ] || { echo "FAIL: rollback changed stored rows ($before -> $after)"; exit 1; }
[ "$($SU -tAc "select count(*) from web_api.news_list(null,'',50,0) where title like 'WoW Forever rollback%'")" = "1" ] || { echo "FAIL: V1 reader must show exactly the opener after rollback"; exit 1; }
[ "$($SU -tAc "select count(*) from web_api.news_list(null,'',50,0) where source_entry_id = 'post:2'")" = "0" ] || { echo "FAIL: V1 reader exposed a reply after rollback"; exit 1; }
$A -f database/public-read/migrations/0011_news_collector_v2.sql >/dev/null 2>&1 || { echo "FAIL: re-apply 0011 after rollback"; exit 1; }
[ "$($SU -tAc "select count(*) from web_api.news_cards(null,'',null,false,50,0) where source_post_number = 2")" = "1" ] || { echo "FAIL: reply not restored after re-applying 0011"; exit 1; }
# Seeding: openers that exist when 0011 is (re-)applied are enrolled in revision tracking, staggered into the future.
$SU -c "delete from pub.news_tracked_topics where source_key = 'rb-us'" >/dev/null
$A -f database/public-read/migrations/0011_news_collector_v2.sql >/dev/null 2>&1 || { echo "FAIL: re-apply 0011 for seeding"; exit 1; }
[ "$($SU -tAc "select count(*) from pub.news_tracked_topics where source_key = 'rb-us' and topic_id = 'topic:7' and official_post_ids = array[1::bigint] and next_check_at > now()")" = "1" ] || { echo "FAIL: existing opener was not seeded into revision tracking"; exit 1; }
echo "PASS: existing verified openers are seeded into revision tracking"

echo "PASS: rollback restores V1 functions without touching rows; re-applying 0011 restores the verified reply"
# Operator backfill verification script (read-only): on healthy data none of its invariant queries may return a row. Regression:
# Official News cards have NO thread key; several of them used to be reported as "duplicate_cards_for_thread" (NULL grouped together).
$SU >/dev/null <<'SQL'
insert into pub.news_sources (source_key, source_type, region, endpoint_url) values ('vf-news', 'official_news', 'us', 'https://example.com/vf')
  on conflict do nothing;
insert into pub.news_entries (source_key, source_entry_id, slug, canonical_url, title, region, published_at, category, relevance, status, content_hash)
select 'vf-news', 'article:' || g, 'vf-article-' || g, 'https://example.com/vf/' || g, 'World of Warcraft: Forever verification article ' || g, 'us',
       now() - (g || ' days')::interval, 'official_news', 'relevant', 'published', encode(sha256(convert_to('vf' || g, 'UTF8')), 'hex')
  from generate_series(1, 3) g
on conflict do nothing;
SQL
[ "$($SU -tAc "select count(*) from web_api.news_cards(null,'',null,false,50,0) where thread_key is null")" -ge 2 ] || { echo "FAIL: verify-script fixture needs >= 2 cards without a thread key"; exit 1; }
verify_out=$($SU -X -A -t -F '|' -f database/public-read/ops/news_v2_backfill_verify.sql 2>&1) || { echo "FAIL: news_v2_backfill_verify.sql did not run"; echo "$verify_out" | tail -5; exit 1; }
if echo "$verify_out" | grep -E '^(visible_reply_without_provenance|reply_by_unverified_identity|duplicate_cards_for_thread|suppressed_row_modified|published_at_changed)\|'; then
  echo "FAIL: backfill verification reported violations on healthy data (see above)"; exit 1
fi
echo "PASS: backfill verification script reports no violations (Official News cards without a thread key are not duplicates)"

echo "NEWS SQL CHECKS PASSED"
