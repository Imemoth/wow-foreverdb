#!/usr/bin/env bash
# Tests the G5b write set (US Dev Notes replies #7, #8, #9) on an ISOLATED, production-shaped database: migrations 0001/0002/0008-0012 as a
# NON-superuser admin, the live state before G5b (topic 2360696 holds the opener #1 and reply #10 and is tracked; five legacy rejected rows; a Gamepad
# row; suppressed rows; decoy runs), the REAL collector payloads of the two windows, the capture / verify / rollback scripts and their negative cases.
# EPHEMERAL SERVER ONLY. Env: PGHOST PGPORT PGUSER (superuser of a FRESH throwaway cluster; PostgreSQL 17 recommended).
set -euo pipefail
cd "$(dirname "$0")/.."
: "${PGHOST:?}" "${PGPORT:?}" "${PGUSER:?}"
case "${PGHOST}" in localhost|127.0.0.1|/tmp|/var/run/postgresql|/var/tmp/*) ;; *) echo "Refusing non-local PGHOST=${PGHOST}"; exit 2;; esac
OPS=database/public-read/ops; PA=database/public-read/tests/g5b/window_a_payload.json; PB=database/public-read/tests/g5b/window_b_payload.json
W=$(mktemp -d /var/tmp/g5btest.XXXXXX); trap 'rm -rf "$W"' EXIT
DB=az_g5b; PW=it-only-admin
SU() { psql -X -q -At -v ON_ERROR_STOP=1 -d "${DBN:-$DB}" "$@"; }
AD() { env PGPASSWORD=$PW psql -X -q -At -v ON_ERROR_STOP=1 -U sbadmin -d "${DBN:-$DB}" "$@"; }
fail() { echo "FAIL: $*"; exit 1; }
pass() { echo "PASS: $*"; }
echo "server: $(psql -X -At -d postgres -c 'select version()' | cut -c1-48)"
for r in anon authenticated service_role; do psql -X -q -d postgres -c "create role $r nologin" 2>/dev/null || true; done
psql -X -q -d postgres -c "create role sbadmin login createrole createdb bypassrls inherit" 2>/dev/null || true
psql -X -q -v ON_ERROR_STOP=1 -d postgres -c "alter role sbadmin password '$PW'"
psql -X -q -v ON_ERROR_STOP=1 -d postgres -c "drop database if exists $DB" -c "create database $DB owner sbadmin" >/dev/null 2>&1
q="psql -X -q -v ON_ERROR_STOP=1 -d $DB"
$q -f database/public-read/tests/hosted-stubs/supabase_stubs.sql >/dev/null
$q -c "alter schema extensions owner to sbadmin" -c "grant usage on schema vault, cron, net to sbadmin" -c "grant select on vault.decrypted_secrets to sbadmin" -c "grant select, insert, update on vault.secrets to sbadmin" \
   -c "grant execute on all functions in schema vault, cron, net to sbadmin" -c "grant select, insert, update, delete on all tables in schema cron to sbadmin" \
   -c "grant select, insert, update, delete on all tables in schema net to sbadmin" -c "grant usage on all sequences in schema cron, net to sbadmin" >/dev/null
for m in 0001_public_read_model 0002_news_model 0008_news_ingest_role 0009_news_ingest_search_path 0010_news_bluepost_suppression 0011_news_collector_v2 0012_news_revision_due_tolerance; do
  env PGPASSWORD=$PW psql -X -q -v ON_ERROR_STOP=1 -U sbadmin -d $DB -f "database/public-read/migrations/$m.sql" >/dev/null 2>&1 || fail "migration $m"
done
SU -c "grant foreverdb_pub_owner to sbadmin" >/dev/null 2>&1 || true
pass "isolated database built (migrations 0001, 0002, 0008-0012)"

cat >"$W/h.mjs" <<'EOF'
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const [, , cmd, ...a] = process.argv;
const q = (s) => `'${s.replace(/'/g, "''")}'`;
const load = (f) => JSON.parse(readFileSync(f, "utf8"));
if (cmd === "apply") { // apply <payload> <out.sql> <mode override|-> <only ids comma|-> <edit id|->
  const p = load(a[0]); p.run.dryRun = false;
  if (a[2] !== "-") p.run.mode = a[2];
  if (a[3] !== "-") { const keep = new Set(a[3].split(",")); p.entries = p.entries.filter((e) => keep.has(e.sourceEntryId)); }
  if (a[4] !== "-") { const e = p.entries.find((x) => x.sourceEntryId === a[4]); e.excerpt += " (later legitimate edit)"; e.contentHash = "e".repeat(64); }
  writeFileSync(a[1], `select (pub_admin.news_apply_sync(${q(JSON.stringify(p))}::jsonb) - 'report')::text;\n`);
} else if (cmd === "seed") { // seed <payload B> <out.sql>: the live pre-G5b state = opener #1 + reply #10 of topic 2360696, normal-mode run
  const p = load(a[0]); p.run.dryRun = false; p.run.mode = "normal";
  const opener = p.entries.find((e) => e.sourceEntryId === "post:30185131");
  const r10 = { ...opener, sourceEntryId: "post:30756539", sourcePostNumber: 10, canonicalUrl: opener.canonicalUrl.replace(/\/1$/, "/10"), publishedAt: "2026-11-04T19:35:16.582Z", modifiedAt: "2026-11-04T19:35:16.582Z",
    excerpt: "Latest development notes update with enough text to be a real staff reply in the Forever beta thread.", contentHash: createHash("sha256").update("r10").digest("hex") };
  delete r10.officialUpdatedAt; delete r10.sourceVersion;
  p.entries = [opener, r10]; p.run.topicChecks = [];
  writeFileSync(a[1], `select (pub_admin.news_apply_sync(${q(JSON.stringify(p))}::jsonb) - 'report')::text;\n`);
} else if (cmd === "reply11") { // a later unrelated reply
  const p = load(a[0]); p.run.dryRun = false; p.run.mode = "normal"; p.run.topicChecks = [];
  const e = { ...p.entries.find((x) => x.sourceEntryId === "post:30185131"), sourceEntryId: "post:30999999", sourcePostNumber: 11, publishedAt: "2026-11-05T01:00:00.000Z", modifiedAt: null,
    excerpt: "A later, unrelated verified reply that a rollback of G5b must never delete or touch at all.", contentHash: createHash("sha256").update("r11").digest("hex"), canonicalUrl: "https://us.forums.blizzard.com/en/wow/t/x/2360696/11" };
  delete e.officialUpdatedAt; delete e.sourceVersion; p.entries = [e];
  writeFileSync(a[1], `select (pub_admin.news_apply_sync(${q(JSON.stringify(p))}::jsonb) - 'report')::text;\n`);
} else if (cmd === "failed") { // failed <payload> <out>: the collector reports a fetch failure for the window (a run record with status failed, no entries)
  const p = load(a[0]); p.run.dryRun = false; p.run.mode = "backfill"; p.run.status = "failed"; p.run.fetchOk = false; p.run.fetchedCount = 0; p.run.acceptedCount = 0; p.run.rejectedCount = 0; p.entries = [];
  writeFileSync(a[1], `select (pub_admin.news_apply_sync(${q(JSON.stringify(p))}::jsonb) - 'report')::text;\n`);
} else if (cmd === "invalid") { // invalid <payload> <out>: the apply function raises -> the whole transaction (run record included) is rolled back
  const p = load(a[0]); p.run.dryRun = false; p.run.mode = "backfill"; p.entries.find((e) => e.sourceEntryId === "post:30732723").canonicalUrl = "not-a-url";
  writeFileSync(a[1], `select (pub_admin.news_apply_sync(${q(JSON.stringify(p))}::jsonb) - 'report')::text;\n`);
} else if (cmd === "render") { // render <in> <out> KEY=file...
  let s = readFileSync(a[0], "utf8");
  for (const kv of a.slice(2)) { const i = kv.indexOf("="); s = s.split(`<<${kv.slice(0, i)}>>`).join(readFileSync(kv.slice(i + 1), "utf8").trim()); }
  writeFileSync(a[1], s);
}
EOF
NODE="node $W/h.mjs"
cap_row() { SU -F '|' -f "$OPS/news_v2_g5b_capture.sql" | head -1; }
post_values() { local sql; sql=$(sed -e 's/;[[:space:]]*$//' "$OPS/news_v2_g5b_capture.sql"); SU -c "select post_state_values from ($sql) q"; }
dbfp() { SU -c "select md5(coalesce((select string_agg(e::text, ';' order by e.id) from pub.news_entries e), '') || coalesce((select string_agg(v::text, ';' order by v.id) from pub.news_post_versions v), '') || coalesce((select string_agg(r::text, ';' order by r.id) from pub.news_sync_runs r), '') || coalesce((select string_agg(t::text, ';' order by t.topic_id) from pub.news_tracked_topics t), ''))"; }
# ---- production-shaped pre-G5b state
$NODE seed "$PB" "$W/seed.sql"; SU -f "$W/seed.sql" >/dev/null
SU >/dev/null <<'SQL'
insert into pub.news_sources (source_key, source_type, region, endpoint_url) values ('blizzard-bluepost-eu', 'bluepost', 'eu', 'https://eu.forums.blizzard.com/en/wow/groups/blizzard-tracker/posts.json') on conflict do nothing;
-- five legacy rejected rows (no provenance), a published Gamepad-like row, five suppressed rows, decoy runs
insert into pub.news_entries (source_key, source_entry_id, source_topic_id, source_post_number, thread_key, slug, canonical_url, title, author, region, published_at, category, relevance, status, content_hash, excerpt)
select 'blizzard-bluepost-us', 'post:' || id, 'topic:' || (2392000 + g), 1, 'us:topic:' || (2392000 + g), 'legacy-' || id, 'https://us.forums.blizzard.com/en/wow/t/x/' || (2392000 + g) || '/1', 'Legacy rejected post number ' || g, 'Blizzard Entertainment', 'us',
       '2026-10-27T19:00:00Z'::timestamptz + g * interval '10 minutes', 'bluepost', 'irrelevant', 'rejected', encode(sha256(convert_to('leg' || g, 'UTF8')), 'hex'), 'Unrelated Midnight announcement excerpt number ' || g
from (values (1, 30623027), (2, 30638690), (3, 30639364), (4, 30640021), (5, 30644593)) v(g, id);
insert into pub.news_entries (source_key, source_entry_id, source_topic_id, source_post_number, thread_key, slug, canonical_url, title, author, region, published_at, category, relevance, status, content_hash, excerpt, author_user_id, author_group, thread_origin, observed_via, source_version)
values ('blizzard-bluepost-us', 'post:30743268', 'topic:2400119', 1, 'us:topic:2400119', 'gamepad-us', 'https://us.forums.blizzard.com/en/wow/t/x/2400119/1', 'Explore WoW: Forever with a Gamepad', 'Blizzard Entertainment', 'us', '2026-11-03T20:00:09.24Z', 'bluepost', 'relevant', 'published',
        encode(sha256(convert_to('gamepad', 'UTF8')), 'hex'), 'Prefer a gamepad? Get to know another way to play World of Warcraft: Forever.', 520262, 'api_users', 'official', 'topic', 9);
insert into pub.news_entries (source_key, source_entry_id, source_topic_id, source_post_number, thread_key, slug, canonical_url, title, author, region, published_at, category, relevance, status, content_hash, excerpt, suppressed_at, suppression_reason)
select 'blizzard-bluepost-eu', 'post:' || (6391797 + g), 'topic:631316', 2 + g, 'eu:topic:631316', 'sup-' || g, 'https://eu.forums.blizzard.com/en/wow/t/x/631316/' || (2 + g), 'WoW Forever Beta Development Notes', 'Kaivax', 'eu',
       ('2026-10-0' || (1 + g) || 'T00:00:00Z')::timestamptz, 'bluepost', 'relevant', 'published', encode(sha256(convert_to('sup' || g, 'UTF8')), 'hex'), 'legacy suppressed reply', '2026-10-22 12:00:00+00', 'bluepost_reply_dedup_v1:test'
from generate_series(1, 5) g;
insert into pub.news_sync_runs (source_key, started_at, status, mode, error) values
  ('blizzard-bluepost-eu', now() - interval '2 hours', 'succeeded', 'backfill', 'g5b-test-decoy'), ('blizzard-bluepost-us', now() - interval '3 hours', 'succeeded', 'backfill', 'g5b-test-decoy'),
  ('blizzard-bluepost-us', now() - interval '1 hour', 'succeeded', 'normal', 'g5b-test-decoy');
SQL
[ "$(SU -c "select count(*) from pub.news_entries where source_topic_id='topic:2360696'")" = 2 ] || fail "seed: topic 2360696 must hold #1 and #10"
# Capture helpers. Fields (| separated, one line): 1 targets_present 2 us_rows 3 untouched_fp 4 untouched_rows 5 tracked_ids 6 suppressed_count 7 suppressed_md5
# 8 entries_total 9 versions_total 10 backfill_runs 11 post_state_values 12 max_entry_id 13 max_run_id 14 g5b_run_ids 15 g5b_runs_detail
cap() { SU -F '|' -f "$OPS/news_v2_g5b_capture.sql" | head -1; }
field() { echo "$1" | cut -d'|' -f"$2"; }
TARGETS="'post:30624529','post:30634848','post:30732723'"
n_targets() { SU -c "select count(*) from pub.news_entries where source_key='blizzard-bluepost-us' and source_entry_id in ($TARGETS)"; }
has_target() { SU -c "select count(*) from pub.news_entries where source_entry_id='$1'"; }
tracked_ids() { SU -c "select official_post_ids::text from pub.news_tracked_topics where topic_id='topic:2360696'"; }
# render the rollback with the tokens taken from a FRESH capture ($1 = out file, $2 = policy, $3 = capture line, $4 = PRE max entry id, $5 = PRE max run id, $6 = override run ids or '-')
render_rb() { local runs; runs=$(field "$3" 14); [ "${6:--}" = "-" ] || runs=$6
  echo "$runs" >"$W/k_runs"; echo "$4" >"$W/k_me"; echo "$5" >"$W/k_mr"; echo "'$2'" >"$W/k_pol"; field "$3" 11 >"$W/k_pv"
  $NODE render "$OPS/news_v2_g5b_rollback.sql" "$1" "RUN_IDS=$W/k_runs" "PRE_MAX_ENTRY_ID=$W/k_me" "PRE_MAX_RUN_ID=$W/k_mr" "MODIFIED_POLICY=$W/k_pol" "POST_STATE_VALUES=$W/k_pv"; }
# a scenario database cloned from the pre-G5b state; DBN switches SU/AD to it
fresh() { DBN=""; psql -X -q -d postgres -c "drop database if exists $1" -c "create database $1 template ${DB}_pre owner sbadmin" >/dev/null; DBN=$1; }
apply_file() { SU -f "$1"; }

# ---- the happy path on the main database: apply window A (#7, #8) then window B (#9) exactly as the collector would send them
IFS='|' read -r T0 US0 UFP0 UR0 TR0 SC0 SM0 E0 V0 B0 PV0 ME0 MR0 RUN0 _x <<<"$(cap)"
[ "$T0" = 0 ] && [ "$US0" = 2 ] || fail "pre capture shape: $T0/$US0"
pass "production-shaped pre-G5b state: topic 2360696 = opener #1 + reply #10 (tracked), 5 legacy rows, Gamepad row, 5 suppressed rows, 3 decoy runs (tracked ids $TR0; PRE max entry id $ME0, max run id $MR0, no G5b runs yet: '${RUN0}')"
psql -X -q -d postgres -c "drop database if exists ${DB}_pre" -c "create database ${DB}_pre template $DB owner sbadmin" >/dev/null
$NODE apply "$PA" "$W/a.sql" backfill - -; $NODE apply "$PB" "$W/b.sql" backfill - -
$NODE failed "$PB" "$W/b_failed.sql"; $NODE invalid "$PB" "$W/b_invalid.sql"
$NODE apply "$PB" "$W/n_rev9.sql" normal post:30732723 post:30732723; $NODE apply "$PA" "$W/n_rev8.sql" normal post:30634848 post:30634848
RA=$(apply_file "$W/a.sql"); RB=$(apply_file "$W/b.sql"); echo "window A: $RA"; echo "window B: $RB"
node -e 'const [a,b]=process.argv.slice(1).map(JSON.parse); if(a.inserted!==2||a.updated!==0||a.skipped!==1||b.inserted!==1||b.updated!==0||b.skipped!==1) process.exit(1)' "$RA" "$RB" || fail "apply results differ from the production dry-runs (A: 2 inserted/0 updated/1 skipped; B: 1/0/1)"
IFS='|' read -r T1 US1 UFP1 UR1 TR1 SC1 SM1 E1 V1 B1 PV1 ME1 MR1 RUN1 DET1 <<<"$(cap)"
[ "$T1" = 3 ] && [ "$US1" = 5 ] && [ "$UFP1" = "$UFP0" ] && [ "$UR1" = "$UR0" ] || fail "post shape: targets=$T1 thread rows=$US1 untouched_fp equal=$([ "$UFP1" = "$UFP0" ] && echo y || echo n)"
[ "$E1" = $((E0 + 3)) ] && [ "$V1" = $((V0 + 3)) ] && [ "$B1" = $((B0 + 2)) ] && [ "$SM1" = "$SM0" ] || fail "counters: entries $E0->$E1 versions $V0->$V1 backfill runs $B0->$B1"
[ "$(echo "$RUN1" | tr -d ' ' | tr ',' '\n' | grep -c .)" = 2 ] || fail "capture must discover exactly the two G5b window runs (got '$RUN1')"
pass "post-G5b: entries +3, versions +3, 2 backfill runs (discovered by window: $DET1), untouched rows (legacy, Gamepad, #1, #10) fingerprint-identical, suppressed fingerprint unchanged; tracked ids: $TR1"
VOUT=$(AD -F '|' -f "$OPS/news_v2_g5b_verify.sql"); echo "$VOUT" | sed 's/^/    /'
[ "$(echo "$VOUT" | grep -c '|PASS$')" = 8 ] && ! echo "$VOUT" | grep -q '|FAIL$' || fail "verify script did not PASS all 8 checks"
pass "ops/news_v2_g5b_verify.sql: all 8 checks PASS"
RA2=$(apply_file "$W/a.sql"); RB2=$(apply_file "$W/b.sql")
node -e 'for (const r of process.argv.slice(1).map(JSON.parse)) if (r.inserted!==0||r.updated!==0) process.exit(1)' "$RA2" "$RB2" || fail "re-applying the windows must be a no-op (0 inserted, 0 updated)"
pass "idempotent: re-applying both windows inserts 0 and updates 0 (a retried window is always safe: it only adds a run record)"

# ======================= recovery scenarios: every one on a clone of the PRE state, rollback fed by a FRESH capture =======================
dbfp() { SU -c "select md5(coalesce((select string_agg(e::text, ';' order by e.id) from pub.news_entries e), '') || coalesce((select string_agg(v::text, ';' order by v.id) from pub.news_post_versions v), '') || coalesce((select string_agg(r::text, ';' order by r.id) from pub.news_sync_runs r), '') || coalesce((select string_agg(t::text, ';' order by t.topic_id) from pub.news_tracked_topics t), ''))"; }
untouched_fp() { SU -c "select md5(coalesce((select string_agg(e::text, ';' order by e.id) from pub.news_entries e where e.source_entry_id not in ($TARGETS)), '') || coalesce((select string_agg(v::text, ';' order by v.id) from pub.news_post_versions v where v.news_entry_id not in (select id from pub.news_entries where source_entry_id in ($TARGETS))), ''))"; }
run_rb() { local name=$1 pol=$2 line; line=$(cap); render_rb "$W/rb_$name.sql" "$pol" "$line" "$ME0" "$MR0" "${3:--}"; AD -f "$W/rb_$name.sql" >"$W/rb_$name.out" 2>&1; }
expect_refused() { local name=$1 pol=$2 msg=$3 ov=${4:--} before after; before=$(dbfp)
  if run_rb "$name" "$pol" "$ov"; then fail "[$name] rollback must have been refused"; fi
  grep -q "$msg" "$W/rb_$name.out" || fail "[$name] wrong refusal (expected '$msg'): $(grep -m1 -E 'ERROR' "$W/rb_$name.out")"
  after=$(dbfp); [ "$before" = "$after" ] || fail "[$name] a refused rollback still changed data"; pass "[$name] refused with '$msg'; database unchanged"; }

# S1 complete apply + a later unrelated reply #11, then rollback; a second rollback has nothing to do
fresh s1; apply_file "$W/a.sql" >/dev/null; apply_file "$W/b.sql" >/dev/null
$NODE reply11 "$PB" "$W/r11.sql"; SU -f "$W/r11.sql" >/dev/null
U1=$(untouched_fp); run_rb s1 keep || { cat "$W/rb_s1.out"; fail "S1 rollback failed"; }
[ "$(n_targets)" = 0 ] && [ "$(has_target post:30999999)" = 1 ] && [ "$(SU -c "select count(*) from pub.news_sync_runs where mode='backfill'")" = 2 ] || fail "S1: targets gone, reply #11 kept, two decoy backfill runs kept"
[ "$(untouched_fp)" = "$U1" ] || fail "S1: untouched rows (#1, #10, #11, legacy, Gamepad) changed"
tracked_ids | grep -Eq '30999999|30756539' && ! tracked_ids | grep -Eq '30624529|30634848|30732723' || fail "S1: tracked ids must lose exactly the three targets: $(tracked_ids)"
[ "$(SU -c "select count(*) from pub.news_tracked_topics where topic_id='topic:2360696'")" = 1 ] || fail "S1: tracked row must stay"
pass "S1 complete apply: rollback removed 3 entries + versions + the two window runs; tracked row kept (3 ids removed); #1, #10, #11, legacy rows, decoy runs untouched"
expect_refused s1b keep "nothing to roll back"

# S2 window A succeeds, window B fails (function error -> nothing written; fetch failure -> a failed run record) - roll back the partial state
fresh s2; apply_file "$W/a.sql" >/dev/null; FP_A=$(dbfp)
if apply_file "$W/b_invalid.sql" >/dev/null 2>&1; then fail "S2: the invalid window-B payload must raise"; fi
[ "$(dbfp)" = "$FP_A" ] || fail "S2: a raising apply must leave NOTHING behind (the run record is rolled back too)"
apply_file "$W/b_failed.sql" >/dev/null
[ "$(n_targets)" = 2 ] && [ "$(has_target post:30732723)" = 0 ] || fail "S2: partial state must be #7,#8 present and #9 absent"
L2=$(cap); [ "$(echo "$(field "$L2" 14)" | tr ',' '\n' | grep -c .)" = 2 ] || fail "S2: capture must list the succeeded A run and the failed B run: $(field "$L2" 15)"
U2=$(untouched_fp); run_rb s2 keep || { cat "$W/rb_s2.out"; fail "S2 rollback failed"; }
[ "$(n_targets)" = 0 ] && [ "$(SU -c "select count(*) from pub.news_sync_runs where mode='backfill'")" = 2 ] && [ "$(untouched_fp)" = "$U2" ] || fail "S2: partial rollback must remove #7/#8 and both G5b run records only"
pass "S2 A ok / B failed: a raising apply leaves nothing; the partial state (#7, #8 + A run + failed B run) rolls back cleanly, #9 absent is not an error"
# S2b ... or roll FORWARD: retry B after the failure; the verify script accepts the extra (failed) run record
fresh s2b; apply_file "$W/a.sql" >/dev/null; apply_file "$W/b_failed.sql" >/dev/null; RB_RETRY=$(apply_file "$W/b.sql")
node -e 'const b=JSON.parse(process.argv[1]); if (b.inserted!==1||b.updated!==0) process.exit(1)' "$RB_RETRY" || fail "S2b: the retried window B must insert exactly #9"
VOUT=$(AD -F '|' -f "$OPS/news_v2_g5b_verify.sql"); [ "$(echo "$VOUT" | grep -c '|PASS$')" = 8 ] && ! echo "$VOUT" | grep -q '|FAIL$' || { echo "$VOUT"; fail "S2b: verify must PASS after a retried window B"; }
run_rb s2b keep || { cat "$W/rb_s2b.out"; fail "S2b rollback failed"; }
[ "$(n_targets)" = 0 ] && [ "$(SU -c "select count(*) from pub.news_sync_runs where mode='backfill'")" = 2 ] || fail "S2b: the full rollback after a retry must remove 3 run records (A, failed B, B retry) and 3 entries"
pass "S2b B retried after a failure: roll-forward verifies (8 PASS) and the 3-run set (A, failed B, B retry) rolls back completely"

# S3 window B TIMES OUT with an unknown outcome: both possible truths are handled by the same script
fresh s3a; apply_file "$W/a.sql" >/dev/null; apply_file "$W/b.sql" >/dev/null; RB3=$(apply_file "$W/b.sql")
node -e 'const b=JSON.parse(process.argv[1]); if (b.inserted!==0||b.updated!==0) process.exit(1)' "$RB3" || fail "S3a: the retry of an already committed window must insert 0"
run_rb s3a keep || { cat "$W/rb_s3a.out"; fail "S3a rollback failed"; }
[ "$(n_targets)" = 0 ] && [ "$(SU -c "select count(*) from pub.news_sync_runs where mode='backfill'")" = 2 ] || fail "S3a: timed-out B had committed and was retried: 3 G5b runs (A, B, B retry) and 3 entries must all go"
pass "S3a B timed out but had COMMITTED; the retry inserted 0: rollback removes the A, B and B-retry run records and all three entries"
fresh s3b; apply_file "$W/a.sql" >/dev/null
run_rb s3b keep || { cat "$W/rb_s3b.out"; fail "S3b rollback failed"; }
[ "$(n_targets)" = 0 ] && [ "$(SU -c "select count(*) from pub.news_sync_runs where mode='backfill'")" = 2 ] || fail "S3b: only A exists"
pass "S3b B timed out and NEVER committed: rollback of the A-only state"
# S3c the timed-out B commits AFTER the capture / run-id list was taken: the stale inputs are refused (nothing changes), a fresh capture works
fresh s3c; apply_file "$W/a.sql" >/dev/null; LATE=$(cap); apply_file "$W/b.sql" >/dev/null
render_rb "$W/rb_s3c.sql" keep "$LATE" "$ME0" "$MR0"; before=$(dbfp)
if AD -f "$W/rb_s3c.sql" >"$W/rb_s3c.out" 2>&1; then fail "S3c: stale capture must be refused"; fi
grep -q "not exactly the G5b window runs" "$W/rb_s3c.out" || fail "S3c: wrong refusal: $(grep -m1 ERROR "$W/rb_s3c.out")"; [ "$(dbfp)" = "$before" ] || fail "S3c: refused rollback changed data"
run_rb s3c keep && [ "$(n_targets)" = 0 ] || fail "S3c: a fresh capture must work"
pass "S3c B committed late (after the capture): stale run list refused with the database unchanged; a fresh capture rolls back"

# S4 a normal REVISION cycle updates a target: the legitimate change is KEPT (policy keep) or the rollback aborts (policy abort)
fresh s4; apply_file "$W/a.sql" >/dev/null; apply_file "$W/b.sql" >/dev/null; LINE4=$(cap); apply_file "$W/n_rev8.sql" >/dev/null
[ "$(SU -c "select count(*) from pub.news_post_versions v join pub.news_entries e on e.id=v.news_entry_id where e.source_entry_id='post:30634848'")" = 2 ] || fail "S4: the revision must have added a second version of #8"
U4=$(untouched_fp); S4FP=$(SU -c "select md5(e::text) from pub.news_entries e where source_entry_id='post:30634848'")
expect_refused s4abort abort "changed since the post-apply capture"
run_rb s4 keep || { cat "$W/rb_s4.out"; fail "S4 rollback failed"; }
grep -q "KEPT" "$W/rb_s4.out" || fail "S4: the report must say the modified row is KEPT"
[ "$(has_target post:30634848)" = 1 ] && [ "$(has_target post:30624529)" = 0 ] && [ "$(has_target post:30732723)" = 0 ] || fail "S4: #8 (revised) kept, #7 and #9 deleted"
[ "$(SU -c "select md5(e::text) from pub.news_entries e where source_entry_id='post:30634848'")" = "$S4FP" ] || fail "S4: the kept row changed"
[ "$(SU -c "select count(*) from pub.news_post_versions v join pub.news_entries e on e.id=v.news_entry_id where e.source_entry_id='post:30634848'")" = 2 ] || fail "S4: both versions of the kept row must stay"
tracked_ids | grep -q 30634848 && ! tracked_ids | grep -Eq '30624529|30732723' || fail "S4: tracked ids: kept #8 stays tracked, #7/#9 removed: $(tracked_ids)"
[ "$(SU -c "select count(*) from pub.news_sync_runs where mode='backfill'")" = 4 ] || fail "S4: the G5b run records stay as the audit trail while a target is kept"
pass "S4 revision updated #8 before the rollback: policy abort refuses unchanged; policy keep deletes only the unchanged #7/#9, keeps #8 (2 versions) and its tracked id, keeps the run records"
# S4b the revision ran BEFORE the capture (the capture already contains the edited row): still recognised as modified (second version), still kept
fresh s4b; apply_file "$W/a.sql" >/dev/null; apply_file "$W/b.sql" >/dev/null; apply_file "$W/n_rev8.sql" >/dev/null
run_rb s4b keep || { cat "$W/rb_s4b.out"; fail "S4b rollback failed"; }
[ "$(has_target post:30634848)" = 1 ] && [ "$(has_target post:30624529)" = 0 ] || fail "S4b: a revision before the capture must still protect #8"
pass "S4b revision BEFORE the capture: the edited row is still recognised (a second version exists) and kept"
# S4c a tampered / unrelated capture value can only make the script KEEP more (it never deletes what it cannot prove unchanged)
fresh s4c; apply_file "$W/a.sql" >/dev/null; apply_file "$W/b.sql" >/dev/null; L4C=$(cap)
BAD=$(field "$L4C" 11 | sed '0,/'\''[0-9a-f]\{32\}'\''/s//'\''00000000000000000000000000000000'\''/'); L4C2=$(echo "$L4C" | awk -F'|' -v OFS='|' -v v="$BAD" '{$11=v; print}')
render_rb "$W/rb_s4c.sql" keep "$L4C2" "$ME0" "$MR0"; AD -f "$W/rb_s4c.sql" >/dev/null || fail "S4c failed"
[ "$(n_targets)" = 1 ] || fail "S4c: a fingerprint that does not match must KEEP that target (2 deleted, 1 kept), got $(n_targets) left"
pass "S4c tampered capture fingerprint: the unprovable target is KEPT, never deleted"

# S5 a target that existed BEFORE G5b (entry id <= PRE high-water mark) is never ours; S6 a foreign backfill run after the PRE capture
fresh s5; $NODE apply "$PA" "$W/pre7.sql" normal post:30624529 -; apply_file "$W/pre7.sql" >/dev/null
L5=$(cap); ME5=$(field "$L5" 12); MR5=$(field "$L5" 13); apply_file "$W/a.sql" >/dev/null; apply_file "$W/b.sql" >/dev/null
line=$(cap); render_rb "$W/rb_s5.sql" keep "$line" "$ME5" "$MR5"; before=$(dbfp)
if AD -f "$W/rb_s5.sql" >"$W/rb_s5.out" 2>&1; then fail "S5: a target that existed before G5b must block the rollback"; fi
grep -q "existed before G5b" "$W/rb_s5.out" || fail "S5: wrong refusal: $(grep -m1 ERROR "$W/rb_s5.out")"; [ "$(dbfp)" = "$before" ] || fail "S5: refused rollback changed data"
pass "S5 target existed before G5b (id <= PRE_MAX_ENTRY_ID): refused, database unchanged"
fresh s6; apply_file "$W/a.sql" >/dev/null; apply_file "$W/b.sql" >/dev/null
SU -c "insert into pub.news_sync_runs (source_key, status, mode, diagnostics) values ('blizzard-bluepost-us', 'succeeded', 'backfill', '{\"since\":\"2026-09-01T00:00:00Z\",\"until\":\"2026-09-02T00:00:00Z\"}')" >/dev/null
expect_refused s6 keep "another backfill run of blizzard-bluepost-us was recorded after the PRE capture"
fresh s6b; apply_file "$W/a.sql" >/dev/null; apply_file "$W/b.sql" >/dev/null; expect_refused s6b keep "not exactly the G5b window runs" "1"
fresh s6c; apply_file "$W/a.sql" >/dev/null; SU -c "insert into pub.news_sync_runs (source_key, status, mode, diagnostics) values ('blizzard-bluepost-us', 'running', 'backfill', '{\"since\":\"2026-11-03T03:00:00Z\",\"until\":\"2026-11-03T04:00:00Z\"}')" >/dev/null
expect_refused s6c keep "still running"
fresh s6d; apply_file "$W/a.sql" >/dev/null; expect_refused s6d bogus "MODIFIED_POLICY must be keep or abort"
fresh s6e; apply_file "$W/a.sql" >/dev/null; before=$(dbfp); if AD -f "$OPS/news_v2_g5b_rollback.sql" >/dev/null 2>&1; then fail "unreplaced tokens must fail closed"; fi; [ "$(dbfp)" = "$before" ] || fail "unreplaced tokens changed data"
pass "[unreplaced tokens] refused (syntax error), database unchanged"

# ---- PostgreSQL LOCKING with concurrent sessions
timeit() { local t0=$(date +%s.%N); "$@"; local rc=$?; echo "$(echo "$(date +%s.%N) - $t0" | bc)" >"$W/elapsed"; return $rc; }
# C1 a revision write is IN FLIGHT when the rollback starts: the rollback waits for it, then sees it and keeps the revised row
fresh c1; apply_file "$W/a.sql" >/dev/null; apply_file "$W/b.sql" >/dev/null
line=$(cap)   # capture BEFORE the in-flight revision commits
render_rb "$W/rb_c1.sql" keep "$line" "$ME0" "$MR0"
( SU -c "begin; $(cat "$W/n_rev8.sql") select pg_sleep(6); commit;" >/dev/null ) & BG=$!
sleep 1.5; T0=$(date +%s.%N); AD -f "$W/rb_c1.sql" >"$W/rb_c1.out" 2>&1 || { cat "$W/rb_c1.out"; wait $BG; fail "C1: rollback failed"; }; EL=$(echo "$(date +%s.%N) - $T0" | bc); wait $BG
awk -v e="$EL" 'BEGIN{exit !(e>=3.5)}' || fail "C1: the rollback must WAIT for the in-flight revision (waited ${EL}s)"
[ "$(has_target post:30634848)" = 1 ] && [ "$(has_target post:30624529)" = 0 ] && [ "$(has_target post:30732723)" = 0 ] || fail "C1: the revision that committed during the wait must be KEPT, the other two deleted"
grep -q "KEPT" "$W/rb_c1.out" || fail "C1: report must say KEPT"
pass "C1 collector write in flight: rollback waited ${EL}s on the table lock, then saw the committed revision and KEPT #8 (no lost update, no half-visible state)"
# C2 the ROLLBACK holds the lock when a collector apply arrives: the apply waits for the rollback to commit, then runs on the rolled-back state
fresh c2; apply_file "$W/a.sql" >/dev/null; apply_file "$W/b.sql" >/dev/null; line=$(cap); render_rb "$W/rb_c2.sql" keep "$line" "$ME0" "$MR0"
sed 's/^-- @after-lock$/select pg_sleep(6);/' "$W/rb_c2.sql" >"$W/rb_c2_sleep.sql"
( AD -f "$W/rb_c2_sleep.sql" >"$W/rb_c2.out" 2>&1 ) & BG=$!
sleep 2; T0=$(date +%s.%N); apply_file "$W/n_rev9.sql" >"$W/c2_apply.out"; EL=$(echo "$(date +%s.%N) - $T0" | bc); wait $BG
awk -v e="$EL" 'BEGIN{exit !(e>=2.5)}' || fail "C2: the collector write must WAIT for the rollback (waited ${EL}s)"
grep -q "deleted" "$W/rb_c2.out" || fail "C2: rollback report: $(cat "$W/rb_c2.out")"
[ "$(has_target post:30624529)" = 0 ] && [ "$(has_target post:30634848)" = 0 ] && [ "$(has_target post:30732723)" = 1 ] || fail "C2: #7/#8 gone; the late collector write ran AFTER the rollback and (re-)inserted #9 once"
[ "$(SU -c "select count(*) from pub.news_post_versions v join pub.news_entries e on e.id=v.news_entry_id where e.source_entry_id='post:30732723'")" = 1 ] || fail "C2: #9 must have exactly one version"
pass "C2 rollback holds the lock: a concurrent collector apply waited ${EL}s and ran on the rolled-back state (serialised, consistent)"
# C3 lock timeout: a long collector transaction blocks the lock -> the rollback FAILS CLOSED, nothing changed, a retry in a quiet moment works
fresh c3; apply_file "$W/a.sql" >/dev/null; apply_file "$W/b.sql" >/dev/null; line=$(cap); render_rb "$W/rb_c3.sql" keep "$line" "$ME0" "$MR0"
( SU -c "begin; insert into pub.news_sync_runs (source_key, status, mode) values ('blizzard-bluepost-us', 'succeeded', 'normal'); select pg_sleep(9); commit;" >/dev/null ) & BG=$!
sleep 1; before_t=$(n_targets)
if AD -f "$W/rb_c3.sql" >"$W/rb_c3.out" 2>&1; then wait $BG; fail "C3: rollback must time out on the lock"; fi
grep -qi "lock timeout" "$W/rb_c3.out" || { wait $BG; fail "C3: expected a lock timeout: $(grep -m1 ERROR "$W/rb_c3.out")"; }
wait $BG; [ "$(n_targets)" = "$before_t" ] || fail "C3: a timed-out rollback changed data"
line=$(cap); render_rb "$W/rb_c3b.sql" keep "$line" "$ME0" "$MR0"; AD -f "$W/rb_c3b.sql" >/dev/null || fail "C3: retry after the collector transaction ended must work"
[ "$(n_targets)" = 0 ] || fail "C3: retry must roll back"
pass "C3 collector transaction holds the lock > 5 s: the rollback failed closed ('lock timeout', nothing changed); the retry after it ended succeeded"
# C4 two rollbacks at once serialise (the second finds nothing to do)
fresh c4; apply_file "$W/a.sql" >/dev/null; apply_file "$W/b.sql" >/dev/null; line=$(cap); render_rb "$W/rb_c4.sql" keep "$line" "$ME0" "$MR0"
sed 's/^-- @after-lock$/select pg_sleep(4);/' "$W/rb_c4.sql" >"$W/rb_c4_sleep.sql"
( AD -f "$W/rb_c4_sleep.sql" >"$W/rb_c4a.out" 2>&1 ) & BG=$!; sleep 1
if AD -f "$W/rb_c4.sql" >"$W/rb_c4b.out" 2>&1; then wait $BG; fail "C4: the second rollback must find nothing to do"; fi
wait $BG; grep -Eq "nothing to roll back|not exactly the G5b window runs" "$W/rb_c4b.out" || fail "C4: second rollback: $(grep -m1 ERROR "$W/rb_c4b.out")"; [ "$(n_targets)" = 0 ] || fail "C4: first rollback must have completed"
pass "C4 two simultaneous rollbacks serialise: the first completes, the second (stale run list) is refused"
echo "ALL G5b TESTS PASSED ($(psql -X -At -d postgres -c 'show server_version'))"
