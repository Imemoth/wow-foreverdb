#!/usr/bin/env bash
# End-to-end test of the PUBLIC publication pipeline on an EPHEMERAL PostgreSQL.
# NEVER point this at production: it creates/drops databases and test roles.
#
# Env: PGHOST PGPORT PGUSER (superuser of the throwaway server). Requires psql + node.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${PGHOST:?}" "${PGPORT:?}" "${PGUSER:?}"
case "${PGHOST}" in localhost|127.0.0.1|/tmp|/var/run/postgresql) ;; *) echo "Refusing non-local PGHOST=${PGHOST}"; exit 2;; esac

PRIV=fdb_it_private
PUB=fdb_it_public
PSQL="psql -X -q -v ON_ERROR_STOP=1"
pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; exit 1; }

$PSQL -d postgres -c "drop database if exists $PRIV" -c "drop database if exists $PUB" >/dev/null
$PSQL -d postgres -c "create database $PRIV" -c "create database $PUB" >/dev/null

# Roles are cluster-wide: tolerate reruns.
psql -X -q -d $PRIV -f database/tests/api_security_local_bootstrap.sql >/dev/null 2>&1 || true
for m in database/migrations/0001_initial_schema.sql database/migrations/0002_sync_safety.sql \
         database/migrations/0003_companion_auth.sql database/migrations/0004_remove_legacy_ingest.sql \
         database/migrations/0005_guildbook_v1.sql database/migrations/0006_companion_search_zone.sql \
         database/sql/search_location_api.sql database/sql/map_asset_diagnostics.sql \
         database/migrations/0008_zone_catalog_browse.sql database/migrations/0008a_close_unused_private_rpcs.sql \
         database/migrations/0008b_prepare_authenticated_global_search.sql \
         database/migrations/0009_api_security_rate_limits.sql \
         database/private-export/0010_public_projection_export.sql; do
  $PSQL -d $PRIV -f "$m" >/dev/null
done
pass "private replica schema + 0010 export applied"
$PSQL -d $PRIV -f database/tests/fixtures/synthetic_private_seed.sql >/dev/null
$PSQL -d $PRIV -f database/tests/public_projection_export_smoke.sql 2>&1 | grep -E "PASS|FAIL" || fail "export smoke"

$PSQL -d $PUB -f database/public-read/migrations/0001_public_read_model.sql >/dev/null
pass "public read model applied"

# Test-only logins (never reused anywhere real).
$PSQL -d postgres -c "alter role foreverdb_projection_reader login password 'it-only'" \
  -c "alter role foreverdb_publisher login password 'it-only'" \
  -c "alter role foreverdb_web_reader login password 'it-only'" >/dev/null

H=${PGHOST}; [ "${H#/}" != "$H" ] && H=localhost
export PRIVATE_EXPORT_DATABASE_URL="postgresql://foreverdb_projection_reader:it-only@${H}:${PGPORT}/${PRIV}"
export PUBLIC_PUBLISHER_DATABASE_URL="postgresql://foreverdb_publisher:it-only@${H}:${PGPORT}/${PUB}"
TMP=$(mktemp -d)
cd publisher
npx tsx src/cli.ts export --out "$TMP/export.json" >/dev/null
out=$(npx tsx src/cli.ts publish); echo "$out" | grep -q '"outcome":"activated"' || fail "first publish: $out"
pass "first publication activated"
out=$(npx tsx src/cli.ts publish); echo "$out" | grep -q '"outcome":"duplicate"' || fail "idempotent republish: $out"
pass "identical republish is an idempotent no-op"

# Fail closed: non-allowlisted column in the export.
node -e 'const f=process.argv[1];const d=require(f);d.buckets[0].installation_id="leak";require("fs").writeFileSync(f+".bad.json",JSON.stringify(d))' "$TMP/export.json"
if npx tsx src/cli.ts publish --from-export "$TMP/export.json.bad.json" > "$TMP/bad.log"; then fail "tampered export was published"; fi
grep -q export_contract_violation "$TMP/bad.log" || fail "unexpected failure mode: $(cat "$TMP/bad.log")"
! grep -q leak "$TMP/bad.log" || fail "failure log echoed a private value"
pass "non-allowlisted column fails closed without echoing values"

# Fail closed: mass hostile names.
node -e 'const f=process.argv[1];const d=require(f);d.items.forEach(i=>i.name="<b>x</b>");require("fs").writeFileSync(f+".hostile.json",JSON.stringify(d))' "$TMP/export.json"
if npx tsx src/cli.ts publish --from-export "$TMP/export.json.hostile.json" > "$TMP/hostile.log"; then fail "hostile export was published"; fi
grep -q rejection_ratio_exceeded "$TMP/hostile.log" || fail "unexpected: $(cat "$TMP/hostile.log")"
pass "hostile-name flood fails closed"

# New content activates; operator rollback restores the previous publication.
node -e 'const f=process.argv[1];const d=require(f);d.buckets.forEach(b=>b.observations=Number(b.observations)+1);require("fs").writeFileSync(f+".v2.json",JSON.stringify(d))' "$TMP/export.json"
out=$(npx tsx src/cli.ts publish --from-export "$TMP/export.json.v2.json"); echo "$out" | grep -q '"outcome":"activated"' || fail "v2: $out"
cd ..
first=$($PSQL -d $PUB -Atc "select min(id) from pub.publications")
active=$($PSQL -d $PUB -Atc "select active_publication_id from pub.state")
[ "$first" != "$active" ] || fail "v2 did not activate"
$PSQL -d $PUB -c "select pub_admin.activate_publication($first)" >/dev/null
[ "$($PSQL -d $PUB -Atc "select active_publication_id from pub.state")" = "$first" ] || fail "rollback"
pass "new publication activated; operator rollback restored publication $first"

$PSQL -d $PUB -f database/public-read/tests/public_read_model_security.sql 2>&1 | grep -E "PASS|FAIL" || fail "public read model security"

# P2: deterministic zone-semantics regression fixture in its OWN throwaway public database
# (a source observed in two zones, known global item drop count, no zone-specific item count).
PUB2=fdb_it_zone
$PSQL -d postgres -c "drop database if exists $PUB2" -c "create database $PUB2" >/dev/null
$PSQL -d $PUB2 -f database/public-read/migrations/0001_public_read_model.sql >/dev/null
out=$(cd publisher && PUBLIC_PUBLISHER_DATABASE_URL="postgresql://foreverdb_publisher:it-only@${H}:${PGPORT}/${PUB2}" \
      npx tsx src/cli.ts publish --from-export ../database/tests/fixtures/zone_semantics_export.json)
echo "$out" | grep -q '"outcome":"activated"' || fail "zone-semantics publish: $out"
zs=$($PSQL -d $PUB2 -f database/public-read/tests/public_read_zone_semantics.sql 2>&1) || { echo "$zs"; fail "zone semantics SQL"; }
echo "$zs" | grep -E "PASS|FAIL"
echo "$zs" | grep -q FAIL && fail "zone semantics SQL reported FAIL"
[ "$(echo "$zs" | grep -c PASS)" = 2 ] || fail "zone semantics SQL: expected 2 PASS lines"
pass "zone-semantics regression database published and verified (PUB2=$PUB2)"
echo "ALL PIPELINE CHECKS PASSED"
echo "PUBLIC_READ_DATABASE_URL=postgresql://foreverdb_web_reader:it-only@${H}:${PGPORT}/${PUB}"
echo "PARITY_DATABASE_URL=postgresql://foreverdb_web_reader:it-only@${H}:${PGPORT}/${PUB2}"
