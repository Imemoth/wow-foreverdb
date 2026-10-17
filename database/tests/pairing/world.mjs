// Browser pairing fixtures use only the disposable Account/GoTrue integration stack.
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { makeWorld as enrollmentWorld } from "../enrollment/world.mjs";
import { repoRoot, connect, cloneDatabase, dropDatabase, psqlFile, HOST, PORT, JWT_SECRET } from "../account/harness.mjs";
export { connect, dropDatabase, psqlFile, randomUUID };
export const migration = path.join(repoRoot, "database/migrations/0016_browser_pairing.sql");
export const makeWorld = enrollmentWorld;
export const roles = ["public", "anon", "authenticated", "service_role"];
export const events = ["pairing_started", "pairing_approved", "pairing_denied", "pairing_expired", "pairing_connected", "pairing_revoked", "pairing_retry_deferred"];
// Exact Task 2 private additions; Task 4 lifecycle cleanup/restore must include both.
export const nativePairingHelperSignatures = [
  "private.fdb_device_pair_native(uuid,text,boolean)",
  "private.fdb_pair_poll_global_budget()",
];

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

// Task 2 worlds always build the current migration on an independent pristine predecessor.
// Enabling the gate is explicit and confined to the disposable clone.
export async function makePairingWorld() {
  const source = await prerequisiteTemplate();
  const database = `fdb_pairing_rpc_${randomBytes(6).toString("hex")}`;
  await cloneDatabase(source.database, database);
  const result = psqlFile(database, migration);
  assert.equal(result.status, 0, result.out);
  const w = await enrollmentWorld({database});
  await w.admin.query("update private.device_pairing_config set enabled=true");
  const close = w.close;
  w.database = database;
  w.close = async () => { await close(); await dropDatabase(database); await closeBefore16Template(); };
  return w;
}

import { createHash } from "node:crypto";
import { rpc } from "../account/harness.mjs";
export const hash = value => createHash("sha256").update(value).digest("hex");
export function pairingInput(overrides = {}) {
  const secret = `fdbp1_${randomBytes(32).toString("base64url")}`;
  const id = randomUUID(), deviceId = randomUUID();
  const credential = `fdbd1_${deviceId.replaceAll("-", "")}_${randomBytes(32).toString("base64url")}`;
  return {id, deviceId, secret, credential, installationId:randomBytes(16).toString("hex"), label:"Test PC", ...overrides};
}
export const startArgs = p => [p.id, hash(p.secret), p.deviceId, hash(p.credential), p.installationId, p.label];
export const proofArgs = p => [p.id, p.secret];
export async function startPairing(w, actor, p = pairingInput()) {
  const out = await actor.call("fdb_device_pair_start", startArgs(p));
  assert.equal(out.ok, true, JSON.stringify(out));
  return {...p, actor, out};
}
export async function due(w, p) {
  await w.admin.query("update private.device_pairings set next_poll_at=clock_timestamp()-interval '1 second' where id=$1", [p.id]);
}
export async function pairRow(w, p) {
  return (await w.admin.query("select *,xmin::text version from private.device_pairings where id=$1", [p.id])).rows[0];
}
export async function approveFixture(w, p, account) {
  const c = w.admin;
  await c.query("begin");
  try {
    await c.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [p.installationId]);
    await c.query("select private.fdb_lock_live_session($1,$2,true)", [p.actor.uid,p.actor.sid]);
    const row = (await c.query("select * from private.device_pairings where id=$1 for update", [p.id])).rows[0];
    assert.equal(row.status,"pending"); assert.equal(row.initiator_uid,p.actor.uid); assert.equal(row.initiator_session_id,p.actor.sid);
    assert.ok(row.expires_at > new Date());
    await c.query("select private.fdb_lock_live_session($1,$2,false)", [account.uid,account.sid]);
    assert.equal((await c.query("select private.fdb_account_usable($1) ok",[account.uid])).rows[0].ok,true);
    await c.query("update private.device_pairings set status='approved',approved_account_uid=$2,approved_session_id=$3,approved_at=clock_timestamp(),next_poll_at=clock_timestamp()-interval '1 second' where id=$1",[p.id,account.uid,account.sid]);
    await c.query("insert into private.device_pairing_audit(event,pairing_audit_ref,installation_id,account_uid) values('pairing_approved',$1,$2,$3)",[row.audit_ref,p.installationId,account.uid]);
    await c.query("commit");
  } catch(e) { await c.query("rollback"); throw e; }
  return {...p, account};
}
export async function approvedPairing(w, {actor, account, ...input} = {}) {
  const d=actor??await w.device(), a=account??await w.account();
  const p=await startPairing(w,d,pairingInput(input));
  return approveFixture(w,p,a);
}
export async function isolatedCall(w, actor, name, args) {
  const c=await connect(w.database);
  try { return await rpc(c,actor.claims,name,args); } finally { await c.end(); }
}
export async function protectedPairing(w,p) {
  const state={};
  for(const [key,sql,args] of [
    ["pairing","select to_jsonb(t)||jsonb_build_object('version',xmin::text) row from private.device_pairings t where id=$1",[p.id]],
    ["budgets","select to_jsonb(t) row from private.foreverdb_api_budgets t where bucket like 'pair_%:pair:'||$1 or bucket='pair_start:installation:'||$2 order by bucket",[p.id,hash(p.installationId)]],
    ["installation","select to_jsonb(t)||jsonb_build_object('version',xmin::text) row from public.installations t where id=$1",[p.installationId]],
    ["devices","select to_jsonb(t)||jsonb_build_object('version',xmin::text) row from private.devices t where installation_id=$1 order by id",[p.installationId]],
    ["audit","select to_jsonb(t) row from private.device_pairing_audit t where installation_id=$1 order by id",[p.installationId]],
    ["claims","select to_jsonb(t) row from private.account_installations t where installation_id=$1",[p.installationId]],
  ]) state[key]=(await w.admin.query(sql,args)).rows;
  return state;
}

// A real pinned GoTrue process on the pairing world's disposable DB, independent of other suites' lifecycle fixtures.
export async function startPairingAuth(w) {
  const port=await new Promise((resolve,reject)=>{
    const server=net.createServer();server.on('error',reject);server.listen(0,'127.0.0.1',()=>{
      const {port}=server.address();server.close(error=>error?reject(error):resolve(port));
    });
  });
  const run=fs.mkdtempSync(path.join(os.tmpdir(),'fdb-pairing-auth-')),url=`http://127.0.0.1:${port}`;
  const child=spawn(process.env.GOTRUE_BIN??path.join(repoRoot,'database/tests/account/.run/gotrue'),[],{
    env:{PATH:process.env.PATH,HOME:run,GOTRUE_DB_DRIVER:'postgres',
      DATABASE_URL:`postgres://supabase_auth_admin:local-test-password@${HOST}:${PORT}/${w.database}?search_path=auth`,
      GOTRUE_DB_AUTOMIGRATE:'false',GOTRUE_API_HOST:'127.0.0.1',GOTRUE_API_PORT:String(port),PORT:String(port),
      API_EXTERNAL_URL:url,GOTRUE_SITE_URL:'http://127.0.0.1:3000',GOTRUE_JWT_SECRET:JWT_SECRET,
      GOTRUE_JWT_EXP:'3600',GOTRUE_JWT_AUD:'authenticated',GOTRUE_JWT_DEFAULT_GROUP_NAME:'authenticated',
      GOTRUE_DISABLE_SIGNUP:'false',GOTRUE_EXTERNAL_EMAIL_ENABLED:'true',GOTRUE_MAILER_AUTOCONFIRM:'true',
      GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED:'true',GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED:'true',
      GOTRUE_RATE_LIMIT_ANONYMOUS_USERS:'1000',GOTRUE_RATE_LIMIT_EMAIL_SENT:'1000',GOTRUE_RATE_LIMIT_TOKEN_REFRESH:'1000',LOG_LEVEL:'error'},
    stdio:['ignore','ignore','pipe'],
  });
  let log='',spawnError;child.stderr.on('data',b=>{log=(log+b).slice(-4000);});child.on('error',e=>{spawnError=e;});
  const close=async()=>{
    if(child.pid&&child.exitCode===null&&!child.killed) await new Promise(resolve=>{child.once('exit',resolve);child.kill('SIGTERM');});
    fs.rmSync(run,{recursive:true,force:true});
  };
  try {
    let ready=false;
    for(let n=0;n<100;n++) {
      if(spawnError||child.exitCode!==null) throw new Error(`pairing GoTrue startup failed: ${spawnError??log}`);
      try {ready=(await fetch(url+'/health',{signal:AbortSignal.timeout(300)})).ok;} catch {}
      if(ready) break;await new Promise(resolve=>setTimeout(resolve,50));
    }
    assert.ok(ready,`pairing GoTrue health: ${log}`);
    return {close,async call(route,{body,token,method='POST'}={}) {
      const response=await fetch(url+route,{method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});
      const raw=await response.text();return {status:response.status,json:raw?JSON.parse(raw):null};
    }};
  } catch(e) {await close();throw e;}
}
