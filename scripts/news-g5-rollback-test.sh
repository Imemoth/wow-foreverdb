#!/usr/bin/env bash
# Tests database/public-read/ops/news_v2_g5_rollback.sql (+ ops/news_v2_g5_capture.sql) on an ISOLATED, production-shaped database:
# migrations 0001/0002/0008-0011 applied as a NON-superuser admin (like the hosted `postgres` role), the pre-G5 state of the US
# write set restored from the verified backup, the real collector payload of the agreed window applied (G5), then rolled back.
# EPHEMERAL SERVER ONLY. Env: PGHOST PGPORT PGUSER (superuser of a FRESH throwaway cluster; PostgreSQL 17 recommended).
set -euo pipefail
cd "$(dirname "$0")/.."
: "${PGHOST:?}" "${PGPORT:?}" "${PGUSER:?}"
case "${PGHOST}" in localhost|127.0.0.1|/tmp|/var/run/postgresql|/var/tmp/*) ;; *) echo "Refusing non-local PGHOST=${PGHOST}"; exit 2;; esac
ROLLBACK=database/public-read/ops/news_v2_g5_rollback.sql
CAPTURE=database/public-read/ops/news_v2_g5_capture.sql
PAYLOAD=database/public-read/tests/g5/us_window_payload.json
W=$(mktemp -d /var/tmp/g5test.XXXXXX); trap 'rm -rf "$W"' EXIT
DB=az_g5; PW=it-only-admin
SU() { psql -X -q -At -v ON_ERROR_STOP=1 -d "${DBN:-$DB}" "$@"; }
AD() { env PGPASSWORD=$PW psql -X -q -At -v ON_ERROR_STOP=1 -U sbadmin -d "${DBN:-$DB}" "$@"; }
fail() { echo "FAIL: $*"; exit 1; }
pass() { echo "PASS: $*"; }

echo "server: $(psql -X -At -d postgres -c 'select version()' | cut -c1-48)"
for r in anon authenticated service_role; do psql -X -q -d postgres -c "create role $r nologin" 2>/dev/null || true; done
psql -X -q -d postgres -c "create role sbadmin login createrole createdb bypassrls inherit" 2>/dev/null || true
psql -X -q -v ON_ERROR_STOP=1 -d postgres -c "alter role sbadmin password '$PW'"
build_db() { # $1 = database name
  psql -X -q -v ON_ERROR_STOP=1 -d postgres -c "drop database if exists $1" -c "create database $1 owner sbadmin" >/dev/null
  local q="psql -X -q -v ON_ERROR_STOP=1 -d $1"
  $q -f database/public-read/tests/hosted-stubs/supabase_stubs.sql >/dev/null
  $q -c "alter schema extensions owner to sbadmin" -c "grant usage on schema vault, cron, net to sbadmin" \
     -c "grant select on vault.decrypted_secrets to sbadmin" -c "grant select, insert, update on vault.secrets to sbadmin" \
     -c "grant execute on all functions in schema vault, cron, net to sbadmin" \
     -c "grant select, insert, update, delete on all tables in schema cron to sbadmin" \
     -c "grant select, insert, update, delete on all tables in schema net to sbadmin" \
     -c "grant usage on all sequences in schema cron, net to sbadmin" >/dev/null
  for m in 0001_public_read_model 0002_news_model 0008_news_ingest_role 0009_news_ingest_search_path 0010_news_bluepost_suppression 0011_news_collector_v2; do
    env PGPASSWORD=$PW psql -X -q -v ON_ERROR_STOP=1 -U sbadmin -d "$1" -f "database/public-read/migrations/$m.sql" >/dev/null 2>&1 || fail "migration $m"
  done
}
build_db $DB
# Production postgres may SET ROLE to the schema owner (verified on the hosted project); mirror that for the hosted-like admin.
SU -c "grant foreverdb_pub_owner to sbadmin" >/dev/null
pass "isolated database built with migrations 0001, 0002, 0008-0011"

# ---- helpers (node): payload subsets, rendering of the rollback script, SQL literal for news_apply_sync
cat >"$W/h.mjs" <<'EOF'
import { readFileSync, writeFileSync } from "node:fs";
const [, , cmd, ...a] = process.argv;
const q = (s) => `'${s.replace(/'/g, "''")}'`;
if (cmd === "apply") { // apply <payload.json> <out.sql> <only|-> <override.json|->
  const p = JSON.parse(readFileSync(a[0], "utf8")); p.run.dryRun = false;
  if (a[2] && a[2] !== "-") { const keep = new Set(a[2].split(",")); p.entries = p.entries.filter((e) => keep.has(e.sourceEntryId)); }
  if (a[3] && a[3] !== "-") { const o = JSON.parse(readFileSync(a[3], "utf8")); p.entries = o.entries ?? p.entries; if (o.verifiedStaff) p.run.verifiedStaff = o.verifiedStaff; if (o.noTopicChecks) delete p.run.topicChecks; }
  writeFileSync(a[1], `select (pub_admin.news_apply_sync(${q(JSON.stringify(p))}::jsonb) - 'report')::text;\n`);
} else if (cmd === "render") { // render <in.sql> <out.sql> KEY=VALUE...
  let s = readFileSync(a[0], "utf8");
  for (const kv of a.slice(2)) { const i = kv.indexOf("="); const k = kv.slice(0, i); const v = readFileSync(kv.slice(i + 1), "utf8").trim(); s = s.split(`<<${k}>>`).join(v); }
  writeFileSync(a[1], s);
} else if (cmd === "variant") { // variant <payload.json> <out.json> <sourceEntryId> <mutation>
  const p = JSON.parse(readFileSync(a[0], "utf8")); const e = p.entries.find((x) => x.sourceEntryId === a[2]);
  if (a[3] === "edit") { e.excerpt = e.excerpt + " (later legitimate edit)"; e.contentHash = "e".repeat(64); e.status = e.status; }
  if (a[3] === "reply10") { Object.assign(e, { sourceEntryId: "post:30999999", sourcePostNumber: 10, contentHash: "d".repeat(64), publishedAt: "2026-11-04T20:00:00.000Z", modifiedAt: null }); delete e.officialUpdatedAt; delete e.sourceVersion; }
  writeFileSync(a[1], JSON.stringify({ entries: [e] }));
}
EOF
NODE="node $W/h.mjs"
capture_cols() { # runs the capture SQL, prints "k=v|k=v..." summary on one line
  SU -F '|' -f "$CAPTURE" | head -1
}
post_values() { # prints the post_state_values column only
  local sql; sql=$(sed -e 's/;[[:space:]]*$//' "$CAPTURE")
  SU -c "select post_state_values from ($sql) q"
}
dbfp() { # fingerprint of everything the rollback may touch or must not touch
  SU -c "select md5(
    coalesce((select string_agg(e::text, ';' order by e.id) from pub.news_entries e), '') ||
    coalesce((select string_agg(v::text, ';' order by v.id) from pub.news_post_versions v), '') ||
    coalesce((select string_agg(r::text, ';' order by r.id) from pub.news_sync_runs r), '') ||
    coalesce((select string_agg(t::text, ';' order by t.source_key, t.topic_id) from pub.news_tracked_topics t), '') ||
    coalesce((select string_agg(s::text, ';' order by s.source_key) from pub.news_sources s), ''))"
}
render() { # render <out> <run_id> <suppressed_md5> <suppressed_count> <values-file>
  echo "$2" >"$W/k_run"; echo "$3" >"$W/k_md5"; echo "$4" >"$W/k_cnt"
  $NODE render "$ROLLBACK" "$1" "G5_RUN_ID=$W/k_run" "SUPPRESSED_MD5=$W/k_md5" "SUPPRESSED_COUNT=$W/k_cnt" "POST_STATE_VALUES=$5"
}

# ---- production-shaped pre-G5 state
UNCH="post:30741364,post:30675695,post:30673599,post:30671248,post:30658235,post:30650104,post:30638185,post:30622338"
$NODE apply "$PAYLOAD" "$W/seed.sql" "$UNCH" -
sed -i 's/"mode":"backfill"/"mode":"normal"/' "$W/seed.sql"   # production has no backfill run yet; the seed must not add one
SU -f "$W/seed.sql" >/dev/null                       # 8 verified US openers that G5 must report as unchanged (+ their tracked topics)
grep -E '^insert into pub.news_(entries|post_versions) overriding system value select' "$ROLLBACK" >"$W/backup.sql"
[ "$(wc -l <"$W/backup.sql")" = 22 ] || fail "the rollback script must embed 22 backup statements"
SU --single-transaction -f "$W/backup.sql" >/dev/null   # the six pre-G5 rows + 16 versions, restored from the backup
SU >/dev/null <<'SQL'
insert into pub.news_sources (source_key, source_type, region, endpoint_url) values ('blizzard-bluepost-eu', 'bluepost', 'eu', 'https://eu.forums.blizzard.com/en/wow/groups/blizzard-tracker/posts.json') on conflict do nothing;
insert into pub.news_entries (source_key, source_entry_id, source_topic_id, source_post_number, slug, canonical_url, title, region, published_at, category, relevance, status, content_hash,
                              suppressed_at, suppression_reason)
select 'blizzard-bluepost-eu', 'post:' || (6391797 + g), 'topic:631316', 2 + g, 'legacy-suppressed-' || g, 'https://eu.forums.blizzard.com/en/wow/t/x/631316/' || (2 + g),
       'WoW Forever Beta Development Notes', 'eu', ('2026-10-0' || (1 + g) || 'T00:00:00Z')::timestamptz, 'bluepost', 'relevant', 'published', encode(sha256(convert_to('sup' || g, 'UTF8')), 'hex'),
       '2026-10-22 12:00:00+00', 'bluepost_reply_dedup_v1:test'
  from generate_series(1, 5) g;
-- decoy sync runs that the rollback must never delete (another source's backfill, an older US backfill, a cron run)
insert into pub.news_sync_runs (source_key, started_at, status, mode, error) values
  ('blizzard-bluepost-eu', now() - interval '2 hours', 'succeeded', 'backfill', 'g5-test-decoy'),
  ('blizzard-bluepost-us', now() - interval '3 hours', 'succeeded', 'backfill', 'g5-test-decoy'),
  ('blizzard-bluepost-us', now() - interval '1 hour', 'succeeded', 'normal', 'g5-test-decoy');
SQL
EU_DECOY=$(SU -c "select id from pub.news_sync_runs where error='g5-test-decoy' and source_key='blizzard-bluepost-eu' and mode='backfill'")
NORMAL_RUN=$(SU -c "select id from pub.news_sync_runs where error='g5-test-decoy' and mode='normal'")
DECOYS=$(SU -c "select count(*) from pub.news_sync_runs where mode='backfill'")   # 2 decoy backfill runs exist before G5
auxfp() { SU -F ' ' -c "select 'sources=' || left(md5(coalesce((select string_agg(s::text, ';' order by source_key) from pub.news_sources s), '')), 8),
  'tracked=' || left(md5(coalesce((select string_agg(t::text, ';' order by source_key, topic_id) from pub.news_tracked_topics t), '')), 8),
  'staff=' || left(md5(coalesce((select string_agg(v::text, ';' order by source_key, user_id) from pub.news_verified_staff v), '')), 8)"; }
auxfp >"$W/aux_before.txt"
PRE_ROW=$(capture_cols); echo "pre-G5 capture: $PRE_ROW"
IFS='|' read -r PRE_TARGETS PRE_VERS PRE_T2360696 SUP_COUNT SUP_MD5 PRE_ENTRIES _rest <<<"$PRE_ROW"
[ "$PRE_TARGETS" = 6 ] && [ "$PRE_VERS" = 16 ] && [ "$PRE_T2360696" = 0 ] || fail "pre-G5 shape (6 entries / 16 versions / 0 rows for topic 2360696) not reproduced"
SU -c "select kind || '|' || id || '|' || h from (select 'entry' kind, e.id, md5(e::text) h from pub.news_entries e where e.id in (32989,40722,40866,40894,41424,88762) union all select 'version', v.id, md5(v::text) from pub.news_post_versions v where v.news_entry_id in (32989,40722,40866,40894,41424,88762)) q order by kind desc, id" >"$W/pre_fp.txt"
[ "$(md5sum <"$W/pre_fp.txt" | cut -c1-32)" != "" ] && [ "$(wc -l <"$W/pre_fp.txt")" = 22 ] || fail "pre-image fingerprints"
NONTARGET_BEFORE=$(SU -c "select md5(string_agg(e::text, ';' order by e.id)) from pub.news_entries e where e.source_entry_id not in ('post:30185131','post:30624529','post:30634848','post:30732723','post:30743268','post:30623027','post:30638690','post:30639364','post:30640021','post:30644593') or e.source_key <> 'blizzard-bluepost-us'")
pass "production-shaped pre-G5 state: 6 entries + 16 versions restored from the backup, 8 unchanged openers, 5 suppressed rows, 3 decoy runs"

# ---- T1: the real G5 apply (expected: 4 inserts / 6 updates / 8 unchanged, exactly as the production dry-run predicted)
$NODE apply "$PAYLOAD" "$W/g5.sql" - -
RESULT=$(SU -f "$W/g5.sql"); echo "G5 apply result: $RESULT"
RUN_ID=$(node -e 'console.log(JSON.parse(process.argv[1]).runId)' "$RESULT")
node -e 'const r=JSON.parse(process.argv[1]); if(r.inserted!==4||r.updated!==6||r.skipped!==8||r.skippedUnverified!==0) process.exit(1)' "$RESULT" || fail "apply result differs from the predicted 4 inserted / 6 updated / 8 skipped"
pass "G5 apply on the production-shaped database: inserted 4, updated 6, skipped 8 (matches the production dry-run)"
POST_ROW=$(capture_cols); echo "post-G5 capture: $POST_ROW"
post_values >"$W/post_values.txt"
[ "$(wc -l <"$W/post_values.txt")" -ge 30 ] || fail "post-state values too short"
SU -c "select (select count(*) from pub.news_entries where source_topic_id='topic:2360696'), (select count(*) from web_api.news_cards(null,'',null,false,50,0) where thread_key='us:topic:2360696'), (select count(*) from pub.news_card_entries where id in (32989,40722,40866,40894,41424))" | grep -qx '4|1|0' || fail "post-G5 shape: 4 rows, one card, legacy rows invisible"
pass "post-G5: topic 2360696 has 4 rows and ONE card; the five legacy rows stay invisible"
VERIFY=database/public-read/ops/news_v2_g5_verify.sql
VOUT=$(AD -F '|' -f "$VERIFY") || fail "post-apply verification script did not run"
echo "$VOUT" | sed 's/^/    /'
[ "$(echo "$VOUT" | grep -c '|PASS$')" = 11 ] && ! echo "$VOUT" | grep -q '|FAIL$' || fail "post-apply verification script reported FAIL/missing checks"
pass "ops/news_v2_g5_verify.sql: all 11 post-apply checks PASS on the production-shaped database"
psql -X -q -d postgres -c "drop database if exists ${DB}_post" -c "create database ${DB}_post template $DB owner sbadmin" >/dev/null  # template for negative cases

# ---- T2: corrected rollback, as the hosted-like admin
render "$W/rb_ok.sql" "$RUN_ID" "'$SUP_MD5'" "$SUP_COUNT" "$W/post_values.txt"
AD -f "$W/rb_ok.sql" >/dev/null || fail "rollback with correct parameters failed"
SU -c "select kind || '|' || id || '|' || h from (select 'entry' kind, e.id, md5(e::text) h from pub.news_entries e where e.id in (32989,40722,40866,40894,41424,88762) union all select 'version', v.id, md5(v::text) from pub.news_post_versions v where v.news_entry_id in (32989,40722,40866,40894,41424,88762)) q order by kind desc, id" >"$W/after_fp.txt"
diff "$W/pre_fp.txt" "$W/after_fp.txt" >/dev/null || fail "rollback did not restore the 22 pre-G5 fingerprints"
pass "rollback restored all 22 pre-G5 fingerprints (6 entries + 16 versions)"
[ "$(SU -c "select count(*) from pub.news_entries where source_entry_id in ('post:30185131','post:30624529','post:30634848','post:30732723')")" = 0 ] || fail "inserted rows still present"
[ "$(SU -c "select count(*) from pub.news_sync_runs where id=$RUN_ID")" = 0 ] || fail "the G5 run record was not deleted"
[ "$(SU -c "select count(*) from pub.news_sync_runs where mode='backfill'")" = "$DECOYS" ] || fail "rollback deleted a backfill run record other than the G5 run"
[ "$(SU -c "select count(*) from pub.news_sync_runs where id in ($EU_DECOY,$NORMAL_RUN)")" = 2 ] || fail "decoy runs must survive"
pass "only the G5 run record ($RUN_ID) was deleted; $DECOYS decoy backfill/normal run records are intact"
[ "$(SU -c "select md5(string_agg(e::text, ';' order by e.id)) from pub.news_entries e where e.source_entry_id not in ('post:30185131','post:30624529','post:30634848','post:30732723','post:30743268','post:30623027','post:30638690','post:30639364','post:30640021','post:30644593') or e.source_key <> 'blizzard-bluepost-us'")" = "$NONTARGET_BEFORE" ] || fail "an entry outside the write set changed"
[ "$(SU -c "select count(*) from pub.news_entries where suppressed_at is not null")" = "$SUP_COUNT" ] || fail "suppressed rows changed"
pass "entries outside the write set and the suppressed rows are untouched"
auxfp >"$W/aux_after.txt"
echo "auxiliary fingerprints before G5:      $(cat "$W/aux_before.txt")"; echo "auxiliary fingerprints after rollback: $(cat "$W/aux_after.txt")"
[ "$(cut -d' ' -f1 "$W/aux_before.txt")" != "$(cut -d' ' -f1 "$W/aux_after.txt")" ] || fail "expected source freshness NOT to be restored"
[ "$(cut -d' ' -f2 "$W/aux_before.txt")" != "$(cut -d' ' -f2 "$W/aux_after.txt")" ] || fail "expected tracked-topic scheduling NOT to be restored"
[ "$(cut -d' ' -f3 "$W/aux_before.txt")" != "$(cut -d' ' -f3 "$W/aux_after.txt")" ] || fail "expected verified-staff last_seen_at NOT to be restored"
pass "source freshness, tracked-topic scheduling and verified-staff last_seen_at are, as documented, NOT restored"
AFTER_OK=$(dbfp)
AD -f "$W/rb_ok.sql" >"$W/second.out" 2>&1 && fail "a second rollback run must be refused" || true
grep -q "is not a backfill run" "$W/second.out" || fail "second rollback run was refused for the wrong reason: $(tail -2 "$W/second.out")"
[ "$(dbfp)" = "$AFTER_OK" ] || fail "refused second rollback changed data"
pass "a second rollback is refused (run record gone) and changes nothing"

# ---- negative cases: each starts from a clone of the post-G5 state; the rollback must abort and change NOTHING
neg() { # neg <name> <expected message fragment> <mutation sql file|-> <rendered rollback file>
  local name=$1 msg=$2 mut=$3 rb=$4
  DBN="${DB}_neg"; psql -X -q -d postgres -c "drop database if exists $DBN" -c "create database $DBN template ${DB}_post owner sbadmin" >/dev/null
  [ "$mut" = "-" ] || SU -f "$mut" >/dev/null
  local before after; before=$(dbfp)
  if AD -f "$rb" >"$W/neg.out" 2>&1; then fail "[$name] rollback must have been refused"; fi
  grep -q "$msg" "$W/neg.out" || fail "[$name] refused for the wrong reason (expected '$msg'): $(grep -m1 -E 'ERROR|error' "$W/neg.out")"
  after=$(dbfp); [ "$before" = "$after" ] || fail "[$name] refused rollback still changed data"
  pass "[$name] refused with '$msg'; database unchanged"
  DBN=
}
$NODE variant "$PAYLOAD" "$W/v_edit.json" post:30743268 edit
$NODE apply "$PAYLOAD" "$W/n1.sql" post:30743268 "$W/v_edit.json"
neg "later legitimate edit of an updated entry" "changed since the post-G5 capture" "$W/n1.sql" "$W/rb_ok.sql"
$NODE variant "$PAYLOAD" "$W/v_legacy.json" post:30639364 edit
$NODE apply "$PAYLOAD" "$W/n2.sql" post:30639364 "$W/v_legacy.json"
neg "later change to a legacy row (new version)" "changed since the post-G5 capture" "$W/n2.sql" "$W/rb_ok.sql"
$NODE variant "$PAYLOAD" "$W/v_r10.json" post:30732723 reply10
$NODE apply "$PAYLOAD" "$W/n3.sql" post:30732723 "$W/v_r10.json"
neg "a later reply #10 in thread 2360696" "later post exists" "$W/n3.sql" "$W/rb_ok.sql"
render "$W/rb_eu.sql" "$EU_DECOY" "'$SUP_MD5'" "$SUP_COUNT" "$W/post_values.txt"
neg "run id of another source's backfill" "is not a backfill run of blizzard-bluepost-us" - "$W/rb_eu.sql"
render "$W/rb_norm.sql" "$NORMAL_RUN" "'$SUP_MD5'" "$SUP_COUNT" "$W/post_values.txt"
neg "run id of a normal cron run" "is not a backfill run of blizzard-bluepost-us" - "$W/rb_norm.sql"
sed 's/^\(.\{0\}\)\(.*\)$/\2/' "$W/post_values.txt" | sed '0,/'\''[0-9a-f]\{32\}'\''/s//'\''00000000000000000000000000000000'\''/' >"$W/post_values_bad.txt"
render "$W/rb_bad.sql" "$RUN_ID" "'$SUP_MD5'" "$SUP_COUNT" "$W/post_values_bad.txt"
neg "tampered post-G5 fingerprint" "changed since the post-G5 capture" - "$W/rb_bad.sql"
render "$W/rb_sup.sql" "$RUN_ID" "'00000000000000000000000000000000'" "$SUP_COUNT" "$W/post_values.txt"
neg "wrong suppressed fingerprint (postcondition aborts the whole transaction)" "suppressed-row fingerprint changed" - "$W/rb_sup.sql"
neg "unreplaced tokens (fail closed)" "syntax error" - "$ROLLBACK"
echo "ALL G5 ROLLBACK TESTS PASSED ($(psql -X -At -d postgres -c 'show server_version'))"
