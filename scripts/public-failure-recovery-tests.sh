#!/usr/bin/env bash
# Failure, recovery, idempotency and concurrency tests for the publication pipeline on an EPHEMERAL, hosted-like database
# (run scripts/public-hosted-compat.sh first: it creates the database and activates one publication).
# Everything here uses the real shared core through the Node CLI. NEVER point at a real project.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${PGHOST:?}" "${PGPORT:?}" "${PGUSER:?}"
case "${PGHOST}" in localhost|127.0.0.1|/tmp|/var/run/postgresql) ;; *) echo "Refusing non-local PGHOST=${PGHOST}"; exit 2;; esac
DB=${HOSTED_DB:-az_hosted_pub}
ADMIN_PW=${ADMIN_PW:-it-only-admin}
OWNER="env PGPASSWORD=$ADMIN_PW psql -X -At -v ON_ERROR_STOP=1 -h $PGHOST -p $PGPORT -U sbadmin -d $DB"
H=${PGHOST}; [ "${H#/}" != "$H" ] && H=localhost
export PUBLIC_PUBLISHER_DATABASE_URL="postgresql://foreverdb_publisher:it-only@${H}:${PGPORT}/${DB}"
pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; exit 1; }
q() { $OWNER -c "set role foreverdb_pub_owner" -c "$1" | grep -v '^SET$'; }
CLI="npx --prefix publisher tsx publisher/src/cli.ts"
FIX=database/tests/fixtures/synthetic_private_export.json
TMP=$(mktemp -d)

# Test setup: start from a released lease (an earlier aborted run of this script may have left one held until its TTL).
q "update pub.publisher_lease set expires_at='-infinity'" >/dev/null
active0=$(q "select active_publication_id from pub.state")
count0=$(q "select count(*) from pub.publications")
sha0=$(q "select content_sha256 from pub.publications where id=$active0")

# --- idempotency: identical content is a no-op BEFORE any row is written ---------------------------------------------
out=$($CLI publish --from-export $FIX)
echo "$out" | grep -q '"outcome":"duplicate"' || fail "duplicate not detected: $out"
echo "$out" | grep -q '"precheckDuplicate":true' || fail "duplicate not recognised by the pre-write check: $out"
[ "$(q "select count(*) from pub.publications")" = "$count0" ] || fail "duplicate run changed the publication set"
pass "unchanged re-run: duplicate recognised before writing; publication set untouched"

# --- failed publication (shrink guard fires in finalize, AFTER all rows were staged) -> previous version intact ---------
node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
  const keep=new Set(d.items.slice(0,Math.floor(d.items.length/4)).map(i=>i.item_id));
  d.items=d.items.filter(i=>keep.has(i.item_id)); require("fs").writeFileSync(process.argv[2],JSON.stringify(d))' $FIX "$TMP/shrunk.json"
if out=$($CLI publish --from-export "$TMP/shrunk.json"); then fail "shrunken export was published: $out"; fi
echo "$out" | grep -q '"outcome":"failed"' || fail "unexpected failure shape: $out"
[ "$(q "select active_publication_id from pub.state")" = "$active0" ] || fail "active publication changed after a failed publication"
[ "$(q "select count(*) from pub.publications where status='staging'")" = "0" ] || fail "staging leftovers after a failed publication"
[ "$(q "select count(*) from pub.items where publication_id not in (select id from pub.publications)")" = "0" ] || fail "orphan rows"
[ "$(q "select content_sha256 from pub.publications where id=$active0")" = "$sha0" ] || fail "active content changed"
[ "$(q "select count(*) from pub.publish_runs where outcome='failed'")" -ge 1 ] || fail "failed run not logged"
pass "failed publication (post-staging validation) leaves the previous active version intact, no leftovers, failure logged"

# --- contract violation fails closed without echoing values -------------------------------------------------------------
node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); d.buckets[0].installation_id="LEAKCANARY"; require("fs").writeFileSync(process.argv[2],JSON.stringify(d))' $FIX "$TMP/leak.json"
if out=$($CLI publish --from-export "$TMP/leak.json"); then fail "tampered export was published"; fi
echo "$out" | grep -q export_contract_violation || fail "unexpected: $out"
echo "$out" | grep -q LEAKCANARY && fail "private canary echoed into logs"
[ "$(q "select count(*) from pub.publish_runs where error_class='export_contract_violation'")" -ge 1 ] || fail "contract failure not logged"
[ "$(q "select count(*)::int from pub.publish_runs where error_detail::text like '%LEAKCANARY%' or metrics::text like '%LEAKCANARY%'")" = "0" ] || fail "canary persisted in the run log"
pass "non-allowlisted column fails closed, nothing echoed or persisted"

# --- crash mid-write: SIGKILL during staging inserts -> readers unaffected; lease abandoned, then recoverable ---------------
( $CLI publish --rehearse --synthetic 60 >/dev/null 2>&1 & echo $! > "$TMP/pid"; wait ) &
sleep 1.2
pkill -9 -f "cli.ts publish --rehearse --synthetic 60" || true
sleep 1
[ "$(q "select active_publication_id from pub.state")" = "$active0" ] || fail "active publication changed after a killed run"
[ "$(q "select count(*) from pub.publications where status='staging'")" = "0" ] || fail "killed run left a staging publication"
lease=$(q "select (expires_at > now())::text from pub.publisher_lease")
[ "$lease" = "true" ] || echo "note: killed run finished before the kill (lease already released)"
out=$($CLI publish --from-export $FIX) || true
if echo "$out" | grep -q '"outcome":"skipped_busy"'; then
  pass "killed run: lease still held, next run safely skipped (no overlap)"
  q "update pub.publisher_lease set expires_at='-infinity'" >/dev/null   # simulate TTL expiry
  out=$($CLI publish --from-export $FIX)
fi
echo "$out" | grep -q '"outcome":"duplicate"' || fail "recovery run after a killed run: $out"
pass "after lease expiry the pipeline recovers and verifies the active publication"

# --- concurrency: two overlapping runs, exactly one proceeds ------------------------------------------------------------
( $CLI publish --rehearse --synthetic 12 > "$TMP/r1.json" 2>&1 ) &
( $CLI publish --rehearse --synthetic 12 > "$TMP/r2.json" 2>&1 ) &
wait
ok=$(cat "$TMP"/r1.json "$TMP"/r2.json | grep '"event":"publication_finished"' | grep -c '"outcome":"rehearsal_ok"' || true)
busy=$(cat "$TMP"/r1.json "$TMP"/r2.json | grep '"event":"publication_finished"' | grep -c '"outcome":"skipped_busy"' || true)
[ "$ok" = "1" ] && [ "$busy" = "1" ] || fail "overlap: rehearsal_ok=$ok skipped_busy=$busy"
[ "$(q "select active_publication_id from pub.state")" = "$active0" ] || fail "overlap changed the active publication"
pass "two overlapping runs: one executed, one skipped_busy; active publication unchanged"

# --- synthetic data can never be published ----------------------------------------------------------------------------
if out=$($CLI publish --synthetic 1); then fail "synthetic publish accepted"; fi
echo "$out" | grep -q synthetic_publish_refused || fail "unexpected: $out"
[ "$(q "select count(*) from pub.sources where name like 'Synthetic %'")" = "0" ] || fail "synthetic rows present in published tables"
pass "synthetic export refused for publication; no synthetic row exists in any published table"
echo "FAILURE/RECOVERY TESTS PASSED"
