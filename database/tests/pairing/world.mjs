// Browser pairing fixtures use only the disposable Account/GoTrue integration stack.
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { makeWorld as enrollmentWorld } from "../enrollment/world.mjs";
import { repoRoot, connect, cloneDatabase, dropDatabase, psqlFile } from "../account/harness.mjs";
export { connect, dropDatabase, psqlFile, randomUUID };
export const migration = path.join(repoRoot, "database/migrations/0016_browser_pairing.sql");
export const makeWorld = enrollmentWorld;
export const roles = ["public", "anon", "authenticated", "service_role"];
export const events = ["pairing_started", "pairing_approved", "pairing_denied", "pairing_expired", "pairing_connected", "pairing_revoked", "pairing_retry_deferred"];

// Build an independent prerequisite database from repository migrations exactly once per suite.
// Never derive the baseline from a database that has already executed 0016.
let template;
async function prerequisiteTemplate() {
  if (template) return template;
  const database = `fdb_pairing_before16_${randomBytes(6).toString("hex")}`;
  const run = fs.mkdtempSync(path.join(os.tmpdir(), "fdb-pairing-before16-"));
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
  const stack = path.join(repoRoot, "database/tests/account/stack.sh");
  const r = spawnSync("bash", ["-c", `set -e
    trap 'if [ -f "$FDB_IT_RUN_DIR/gotrue.pid" ]; then kill "$(cat "$FDB_IT_RUN_DIR/gotrue.pid")" 2>/dev/null || true; fi' EXIT
    "$1" up
    "$1" apply
    "$1" apply14`, "pairing-prerequisites", stack], {
    cwd: repoRoot,
    env: {...process.env, FDB_IT_DB:database, FDB_IT_RUN_DIR:run, GOTRUE_PORT:String(port)},
    encoding: "utf8", timeout: 180000,
  });
  if (r.status !== 0) {
    await dropDatabase(database);
    fs.rmSync(run, {recursive:true,force:true});
    assert.fail(`pristine 0014 bootstrap failed: ${r.error ?? ""}\n${r.stdout}${r.stderr}`);
  }
  template = {database, run};
  return template;
}

export async function closeBefore16Template() {
  if (!template) return;
  const old = template;
  template = undefined;
  await dropDatabase(old.database);
  fs.rmSync(old.run, {recursive:true,force:true});
}

export async function before16(fn) {
  const source = await prerequisiteTemplate();
  const database = `fdb_pairing_schema_${randomBytes(6).toString("hex")}`;
  await cloneDatabase(source.database, database);
  const admin = await connect(database);
  try {
    assert.equal((await admin.query("select to_regclass('private.device_pairings')::text t")).rows[0].t, null,
      "prerequisite template has never applied 0016");
    return await fn({ database, admin });
  } finally {
    await admin.end();
    await dropDatabase(database);
  }
}

const quoteIdentifier = value => /^[a-z_][a-z0-9_]*$/.test(value) ? value : `"${value.replaceAll('"', '""')}"`;
export function canonicalSignature({schema, name, argument_types}) {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(name)}(${argument_types.join(",")})`;
}

export async function functions(admin) {
  const rows = (await admin.query(`select n.nspname schema, p.proname name,
    array(select case when t.typnamespace='pg_catalog'::regnamespace then format_type(t.oid,null)
           else format('%I.%I',tn.nspname,t.typname) end
          from unnest(p.proargtypes) with ordinality a(type_oid,position)
          join pg_type t on t.oid=a.type_oid join pg_namespace tn on tn.oid=t.typnamespace order by a.position) argument_types,
    md5(pg_get_functiondef(p.oid)) definition, pg_get_userbyid(p.proowner) owner,
    coalesce(p.proacl::text, '') acl, md5(coalesce(p.proacl::text,'')) acl_hash
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','private') order by n.nspname,p.proname,p.proargtypes::text`)).rows;
  return rows.map(row => ({...row, sig:canonicalSignature(row)}));
}

export function assertNoPublicPairingFunctions(rows) {
  assert.deepEqual(rows.filter(fn => fn.schema === "public" && /^fdb_.*pair/.test(fn.name)), [],
    "Task 1 must create zero public pairing RPCs");
}

export function assertPreserved(before, after) {
  const {functions:oldFunctions, ...oldState} = before;
  const {functions:nowFunctions, ...nowState} = after;
  assert.deepEqual(nowState, oldState, "predecessor schemas and historical rows unchanged");
  const bySignature = new Map(nowFunctions.map(fn => [fn.sig, fn]));
  for (const fn of oldFunctions) assert.deepEqual(bySignature.get(fn.sig), fn, `${fn.sig} predecessor definition/ACL changed`);
}

export async function protectedState(admin) {
  const tables = ["private.account_installations", "private.account_audit"];
  const state = { functions: await functions(admin) };
  for (const table of tables) {
    state[table] = (await admin.query(`select c.relrowsecurity, c.relforcerowsecurity, c.relacl::text,
      (select jsonb_agg(jsonb_build_array(a.attname, format_type(a.atttypid,a.atttypmod), a.attnotnull, pg_get_expr(d.adbin,d.adrelid)) order by a.attnum)
       from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped) columns,
      (select jsonb_agg(pg_get_constraintdef(oid) order by conname) from pg_constraint where conrelid=c.oid) constraints,
      (select jsonb_agg(indexdef order by indexname) from pg_indexes where schemaname=split_part($1,'.',1) and tablename=split_part($1,'.',2)) indexes
      from pg_class c where c.oid=$1::regclass`, [table])).rows;
  }
  for (const table of ["public.installations", "private.account_installations", "private.account_audit", "private.installation_claims", "private.enrollment_tickets", "private.devices", "private.device_audit",
    "public.installation_item_stats", "public.installation_source_stats", "public.installation_location_stats", "public.installation_guilds", "public.installation_guild_members", "public.installation_guild_professions", "public.items", "public.sources"]) {
    // Adding nullable provenance must leave every historical device field unchanged.
    state[`${table}:rows`] = (await admin.query(`select count(*)::int n,
      md5(coalesce(string_agg((to_jsonb(t) - 'pairing_id')::text, '|' order by (to_jsonb(t) - 'pairing_id')::text), '')) hash from ${table} t`)).rows;
  }
  return state;
}

export async function pending(admin, overrides = {}) {
  const values = {
    id: randomUUID(), installation_id: randomBytes(16).toString("hex"), initiator_uid: randomUUID(), initiator_session_id: randomUUID(),
    poll_secret_hash: randomBytes(32), proposed_device_id: randomUUID(), device_credential_hash: randomBytes(32),
    status: "pending", created_at: new Date(), expires_at: new Date(Date.now() + 299000), next_poll_at: new Date(Date.now() + 5000), ...overrides,
  };
  const keys = Object.keys(values);
  return (await admin.query(`insert into private.device_pairings (${keys.join(",")}) values (${keys.map((_,i)=>`$${i+1}`).join(",")}) returning *`, Object.values(values))).rows[0];
}

export async function rollback(admin, fn) {
  await admin.query("begin");
  try { return await fn(); } finally { await admin.query("rollback"); }
}
