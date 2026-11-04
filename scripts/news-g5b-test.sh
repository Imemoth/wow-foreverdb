#!/usr/bin/env bash
# Tests the G5b write set (US Dev Notes replies #7, #8, #9) on an ISOLATED, production-shaped database: migrations 0001/0002/0008-0011 as a
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
for m in 0001_public_read_model 0002_news_model 0008_news_ingest_role 0009_news_ingest_search_path 0010_news_bluepost_suppression 0011_news_collector_v2; do
  env PGPASSWORD=$PW psql -X -q -v ON_ERROR_STOP=1 -U sbadmin -d $DB -f "database/public-read/migrations/$m.sql" >/dev/null 2>&1 || fail "migration $m"
done
SU -c "grant foreverdb_pub_owner to sbadmin" >/dev/null 2>&1 || true
pass "isolated database built (migrations 0001, 0002, 0008-0011)"

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
render() { echo "$2" >"$W/k_runs"; echo "$3" >"$W/k_md5"; echo "$4" >"$W/k_cnt"; $NODE render "$OPS/news_v2_g5b_rollback.sql" "$1" "RUN_IDS=$W/k_runs" "SUPPRESSED_MD5=$W/k_md5" "SUPPRESSED_COUNT=$W/k_cnt" "POST_STATE_VALUES=$5"; }

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
IFS='|' read -r T0 US0 UFP0 UR0 TR0 SC0 SM0 E0 V0 B0 _x <<<"$(cap_row)"
[ "$T0" = 0 ] && [ "$US0" = 2 ] || fail "pre capture shape: $T0/$US0"
pass "production-shaped pre-G5b state: topic 2360696 = opener #1 + reply #10 (tracked), 5 legacy rows, Gamepad row, 5 suppressed rows, 3 decoy runs (tracked ids $TR0)"

# ---- apply: window A (#7, #8) then window B (#9) exactly as the collector would send them
$NODE apply "$PA" "$W/a.sql" backfill - -; $NODE apply "$PB" "$W/b.sql" backfill - -
RA=$(SU -f "$W/a.sql"); RB=$(SU -f "$W/b.sql"); echo "window A: $RA"; echo "window B: $RB"
node -e 'const [a,b]=process.argv.slice(1).map(JSON.parse); if(a.inserted!==2||a.updated!==0||a.skipped!==1||b.inserted!==1||b.updated!==0||b.skipped!==1) process.exit(1)' "$RA" "$RB" || fail "apply results differ from the production dry-runs (A: 2 inserted/0 updated/1 skipped; B: 1/0/1)"
RID_A=$(node -e 'console.log(JSON.parse(process.argv[1]).runId)' "$RA"); RID_B=$(node -e 'console.log(JSON.parse(process.argv[1]).runId)' "$RB")
pass "G5b apply on the production-shaped database: window A inserted 2, window B inserted 1, nothing updated (matches the production dry-runs)"
IFS='|' read -r T1 US1 UFP1 UR1 TR1 SC1 SM1 E1 V1 B1 _x <<<"$(cap_row)"
[ "$T1" = 3 ] && [ "$US1" = 5 ] && [ "$UFP1" = "$UFP0" ] && [ "$UR1" = "$UR0" ] || fail "post shape: targets=$T1 thread rows=$US1 untouched_fp equal=$([ "$UFP1" = "$UFP0" ] && echo y || echo n)"
[ "$E1" = $((E0 + 3)) ] && [ "$V1" = $((V0 + 3)) ] && [ "$B1" = $((B0 + 2)) ] && [ "$SM1" = "$SM0" ] || fail "counters: entries $E0->$E1 versions $V0->$V1 backfill runs $B0->$B1"
pass "post-G5b: entries +3, versions +3, 2 backfill runs, untouched rows (legacy, Gamepad, #1, #10) fingerprint-identical, suppressed fingerprint unchanged; tracked ids: $TR1"
post_values >"$W/post_values.txt"
VOUT=$(AD -F '|' -f "$OPS/news_v2_g5b_verify.sql"); echo "$VOUT" | sed 's/^/    /'
[ "$(echo "$VOUT" | grep -c '|PASS$')" = 8 ] && ! echo "$VOUT" | grep -q '|FAIL$' || fail "verify script did not PASS all 8 checks"
pass "ops/news_v2_g5b_verify.sql: all 8 checks PASS"
psql -X -q -d postgres -c "drop database if exists ${DB}_post" -c "create database ${DB}_post template $DB owner sbadmin" >/dev/null
# idempotency: a second apply of both windows changes nothing
FP_BEFORE=$(dbfp)
RA2=$(SU -f "$W/a.sql"); RB2=$(SU -f "$W/b.sql")
node -e 'for (const r of process.argv.slice(1).map(JSON.parse)) if (r.inserted!==0||r.updated!==0) process.exit(1)' "$RA2" "$RB2" || fail "re-applying the windows must be a no-op (0 inserted, 0 updated)"
SU -c "delete from pub.news_sync_runs where id in ($(node -e 'const r=process.argv.slice(1).map(JSON.parse);console.log(r.map(x=>x.runId).join(","))' "$RA2" "$RB2"))" >/dev/null
pass "idempotent: re-applying both windows inserts 0 and updates 0"

# ---- rollback (also proves a later UNRELATED reply #11 survives)
$NODE reply11 "$PB" "$W/r11.sql"; SU -f "$W/r11.sql" >/dev/null
IFS='|' read -r _t _a UFP_PRE _rest <<<"$(cap_row)"   # untouched fingerprint incl. the later reply #11, taken right before the rollback
render "$W/rb_ok.sql" "$RID_A, $RID_B" "'$SM0'" "$SC0" "$W/post_values.txt"
AD -f "$W/rb_ok.sql" >/dev/null || fail "rollback with correct parameters failed"
[ "$(SU -c "select count(*) from pub.news_entries where source_entry_id in ('post:30624529','post:30634848','post:30732723')")" = 0 ] || fail "targets still present"
[ "$(SU -c "select count(*) from pub.news_entries where source_entry_id = 'post:30999999'")" = 1 ] || fail "a later unrelated reply must survive the rollback"
[ "$(SU -c "select count(*) from pub.news_sync_runs where id in ($RID_A, $RID_B)")" = 0 ] || fail "the G5b run records must be gone"
[ "$(SU -c "select count(*) from pub.news_sync_runs where mode='backfill'")" = 2 ] || fail "the two decoy backfill runs must survive"
[ "$(SU -c "select count(*) from pub.news_tracked_topics where topic_id='topic:2360696'")" = 1 ] || fail "the tracked topic row must NOT be deleted"
SU -c "select official_post_ids::text from pub.news_tracked_topics where topic_id='topic:2360696'" | grep -Eq '30999999|30756539' || fail "tracked ids of untouched posts lost"
! SU -c "select official_post_ids::text from pub.news_tracked_topics where topic_id='topic:2360696'" | grep -Eq '30624529|30634848|30732723' || fail "target ids still tracked"
IFS='|' read -r T2 _a UFP2 _rest <<<"$(cap_row)"; [ "$T2" = 0 ] && [ "$UFP2" = "$UFP_PRE" ] || fail "untouched rows changed by the rollback"
pass "rollback: 3 entries + versions + 2 run records removed; tracked row kept (3 ids removed); #1, #10, legacy, Gamepad untouched; decoy runs and a later reply #11 intact"
[ "$(AD -f "$W/rb_ok.sql" 2>&1 | grep -c 'precondition failed')" -ge 1 ] || fail "a second rollback must be refused"
pass "a second rollback is refused"

# ---- negative cases (each from a clone of the post-apply state): the rollback must abort and change NOTHING
neg() { local name=$1 msg=$2 mut=$3 rb=$4
  DBN="${DB}_neg"; psql -X -q -d postgres -c "drop database if exists $DBN" -c "create database $DBN template ${DB}_post owner sbadmin" >/dev/null
  [ "$mut" = "-" ] || SU -f "$mut" >/dev/null
  local before after; before=$(dbfp)
  if AD -f "$rb" >"$W/neg.out" 2>&1; then fail "[$name] rollback must have been refused"; fi
  grep -q "$msg" "$W/neg.out" || fail "[$name] wrong refusal (expected '$msg'): $(grep -m1 -E 'ERROR' "$W/neg.out")"
  after=$(dbfp); [ "$before" = "$after" ] || fail "[$name] refused rollback still changed data"
  pass "[$name] refused with '$msg'; database unchanged"; DBN=; }
$NODE apply "$PB" "$W/n1.sql" normal post:30732723 post:30732723; sed -i 's/"mode":"backfill"/"mode":"normal"/' "$W/n1.sql"
neg "later edit of a target entry" "changed since the post-apply capture" "$W/n1.sql" "$W/rb_ok.sql"
render "$W/rb_one.sql" "$RID_A" "'$SM0'" "$SC0" "$W/post_values.txt"; neg "only one run id" "exactly two run ids" - "$W/rb_one.sql"
EU_DECOY=$(SU -c "select id from pub.news_sync_runs where error='g5b-test-decoy' and source_key='blizzard-bluepost-eu'" 2>/dev/null || true)
DBN="${DB}_post"; DECOY_US=$(SU -c "select id from pub.news_sync_runs where error='g5b-test-decoy' and source_key='blizzard-bluepost-us' and mode='backfill'"); DECOY_EU=$(SU -c "select id from pub.news_sync_runs where error='g5b-test-decoy' and source_key='blizzard-bluepost-eu'"); DBN=
render "$W/rb_dec.sql" "$RID_A, $DECOY_EU" "'$SM0'" "$SC0" "$W/post_values.txt"; neg "another source's run id" "not two succeeded backfill runs" - "$W/rb_dec.sql"
sed '0,/'\''[0-9a-f]\{32\}'\''/s//'\''00000000000000000000000000000000'\''/' "$W/post_values.txt" >"$W/pv_bad.txt"
render "$W/rb_bad.sql" "$RID_A, $RID_B" "'$SM0'" "$SC0" "$W/pv_bad.txt"; neg "tampered fingerprint" "changed since the post-apply capture" - "$W/rb_bad.sql"
render "$W/rb_sup.sql" "$RID_A, $RID_B" "'00000000000000000000000000000000'" "$SC0" "$W/post_values.txt"; neg "wrong suppressed fingerprint (postcondition aborts everything)" "suppressed-row fingerprint changed" - "$W/rb_sup.sql"
neg "unreplaced tokens (fail closed)" "syntax error" - "$OPS/news_v2_g5b_rollback.sql"
echo "ALL G5b TESTS PASSED ($(psql -X -At -d postgres -c 'show server_version'))"
