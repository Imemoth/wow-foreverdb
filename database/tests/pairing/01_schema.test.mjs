import { after, before, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { repoRoot } from "../account/harness.mjs";
import { makeWorld, before16, protectedState, functions, closeBefore16Template, assertPreserved, assertNoPublicPairingFunctions, migration, psqlFile, pending, rollback, roles, events, randomUUID } from "./world.mjs";
let w;
before(async () => { w = await makeWorld(); });
after(async () => { await w?.close(); await closeBefore16Template(); });
const cols = async (table) => (await w.admin.query(`select attname name, format_type(atttypid,atttypmod) type, attnotnull required
 from pg_attribute where attrelid=$1::regclass and attnum>0 and not attisdropped order by attnum`, [table])).rows;
const column = (name, type, required=true) => ({name,type,required});

it("0016 exists at its reserved name", () => {
  assert.ok(fs.existsSync(migration), "0016_browser_pairing.sql is absent");
});
it("stack.sh implements apply16", () => {
  assert.match(fs.readFileSync(path.join(repoRoot,"database/tests/account/stack.sh"),"utf8"), /apply16\)/, "stack.sh apply16 is absent");
});
it("the pairing table exists (not exposed through a public RPC in Task 1)", async () => {
  assert.equal((await w.admin.query("select to_regclass('private.device_pairings')::text t")).rows[0].t, "private.device_pairings");
});
it("pairings have the exact typed and nullable state-machine fields", async () => {
  assert.deepEqual(await cols("private.device_pairings"), [
    column("id","uuid"), column("audit_ref","uuid"), column("installation_id","text"), column("initiator_uid","uuid"), column("initiator_session_id","uuid"),
    column("poll_secret_hash","bytea"), column("proposed_device_id","uuid"), column("device_credential_hash","bytea"), column("computer_label","text",false), column("status","text"),
    ...["created_at","expires_at","next_poll_at"].map(x=>column(x,"timestamp with time zone")), column("poll_interval_sec","integer"),
    column("approved_account_uid","uuid",false), column("approved_session_id","uuid",false), column("approved_at","timestamp with time zone",false), column("previous_owner_uid","uuid",false),
    column("connected_device_id","uuid",false), column("connected_at","timestamp with time zone",false), column("denied_at","timestamp with time zone",false), column("denied_reason","text",false), column("revoked_at","timestamp with time zone",false),
  ]);
});
it("config is a closed singleton with an OFF default", async () => {
  assert.deepEqual(await cols("private.device_pairing_config"), [column("singleton","boolean"),column("enabled","boolean"),column("updated_at","timestamp with time zone")]);
  assert.deepEqual((await w.admin.query("select singleton,enabled from private.device_pairing_config")).rows,[{singleton:true,enabled:false}]);
  await rollback(w.admin, async()=> {
    await w.admin.query("delete from private.device_pairing_config");
    assert.equal((await w.admin.query("insert into private.device_pairing_config default values returning enabled")).rows[0].enabled,false);
    await assert.rejects(w.admin.query("insert into private.device_pairing_config default values"),e=>e.code==="23505");
  });
  await rollback(w.admin,()=>assert.rejects(w.admin.query("insert into private.device_pairing_config(singleton) values(false)"),e=>e.code==="23514"));
});
it("all three new tables FORCE RLS with zero policies or API table/sequence grants", async () => {
  for (const table of ["device_pairing_config","device_pairings","device_pairing_audit"]) {
    const t=`private.${table}`;
    assert.deepEqual((await w.admin.query("select relrowsecurity,relforcerowsecurity from pg_class where oid=$1::regclass",[t])).rows,[{relrowsecurity:true,relforcerowsecurity:true}]);
    assert.equal((await w.admin.query("select count(*)::int n from pg_policies where schemaname='private' and tablename=$1",[table])).rows[0].n,0);
    for(const role of roles) assert.equal((await w.admin.query("select has_table_privilege($1,$2,'select,insert,update,delete,truncate,references,trigger') p",[role,t])).rows[0].p,false,`${role} on ${t}`);
  }
  for(const role of roles) assert.equal((await w.admin.query("select has_sequence_privilege($1,'private.device_pairing_audit_id_seq','usage,select,update') p",[role])).rows[0].p,false);
});
it("pairing bounds reject invalid hashes, lifetime, polling, labels, statuses and partial state", async () => {
  const statusCheck = (await w.admin.query("select pg_get_constraintdef(oid) d from pg_constraint where conrelid='private.device_pairings'::regclass and conname='device_pairings_status_check'")).rows[0].d;
  assert.deepEqual([...statusCheck.matchAll(/'([^']+)'/g)].map(m => m[1]).sort(), ["pending","approved","connected","expired","denied","revoked"].sort());
  const invalid = [
    {poll_secret_hash:Buffer.alloc(31)}, {device_credential_hash:Buffer.alloc(33)}, {computer_label:"x".repeat(61)},
    {expires_at:new Date(Date.now()+301000)}, {created_at:new Date(Date.now()+400000)},
    {poll_interval_sec:4}, {poll_interval_sec:31}, {status:"unknown"},
    {approved_account_uid:randomUUID()}, {status:"approved"}, {status:"connected"}, {status:"denied"}, {status:"revoked"},
    {previous_owner_uid:randomUUID()}, {connected_device_id:randomUUID()}, {connected_at:new Date()}, {denied_at:new Date()}, {denied_reason:"arbitrary"}, {revoked_at:new Date()},
  ];
  for(const value of invalid) await rollback(w.admin,()=>assert.rejects(pending(w.admin,value),e=>e.code==="23514",JSON.stringify(value)));
  for(const status of ["pending","expired"]) await rollback(w.admin,()=>pending(w.admin,{status}));
  await rollback(w.admin,()=>pending(w.admin,{status:"approved",approved_account_uid:randomUUID(),approved_session_id:randomUUID(),approved_at:new Date()}));
  await rollback(w.admin,()=>pending(w.admin,{status:"denied",denied_at:new Date(),denied_reason:"companion_canceled"}));
});
it("audit_ref is server-generated, unique and distinct from the public locator", async () => {
  await rollback(w.admin, async()=> {
    const row=await pending(w.admin);
    assert.ok(row.audit_ref); assert.notEqual(row.audit_ref,row.id);
    await assert.rejects(pending(w.admin,{audit_ref:row.audit_ref}),e=>e.code==="23505");
  });
});
it("unique active-installation/initiator, poll, proposed and connected device indexes exist", async()=> {
  const indexes=(await w.admin.query("select indexdef from pg_indexes where schemaname='private' and tablename='device_pairings'")).rows.map(x=>x.indexdef);
  for(const key of ["id","audit_ref","poll_secret_hash","proposed_device_id","connected_device_id"]) assert.ok(indexes.some(x=>x.includes("UNIQUE INDEX")&&x.includes(`(${key})`)),key);
  for(const key of ["installation_id","initiator_uid"]) assert.ok(indexes.some(x=>x.includes("UNIQUE INDEX")&&x.includes(`(${key}) WHERE`)&&x.includes("pending")&&x.includes("approved")),key);
  for(const key of ["installation_id","initiator_uid","poll_secret_hash","proposed_device_id"]) await rollback(w.admin,async()=> {
    const p=await pending(w.admin); await assert.rejects(pending(w.admin,{[key]:p[key]}),e=>e.code==="23505");
  });
  await rollback(w.admin,async()=> { const p=await pending(w.admin,{status:"expired"}); await pending(w.admin,{installation_id:p.installation_id,initiator_uid:p.initiator_uid}); });
});
it("audit has exactly its nonsecret columns, seven events and two partial uniqueness rules", async()=> {
  assert.deepEqual(await cols("private.device_pairing_audit"), [column("id","bigint"),column("at","timestamp with time zone"),column("event","text"),column("pairing_audit_ref","uuid"),column("installation_id","text"),column("account_uid","uuid",false),column("device_id","uuid",false),column("reason","text",false)]);
  const eventCheck = (await w.admin.query("select pg_get_constraintdef(oid) d from pg_constraint where conrelid='private.device_pairing_audit'::regclass and conname='device_pairing_audit_event_check'")).rows[0].d;
  assert.deepEqual([...eventCheck.matchAll(/'([^']+)'/g)].map(m => m[1]).sort(), [...events].sort());
  const indexes=(await w.admin.query("select indexdef from pg_indexes where schemaname='private' and tablename='device_pairing_audit'")).rows.map(x=>x.indexdef);
  assert.ok(indexes.some(x=>x.includes("UNIQUE INDEX")&&x.includes("(pairing_audit_ref, event) WHERE (event <>")&&x.includes("pairing_retry_deferred")));
  assert.ok(indexes.some(x=>x.includes("UNIQUE INDEX")&&x.includes("(pairing_audit_ref, event, reason) WHERE (event =")&&x.includes("pairing_retry_deferred")));
  for(const event of events) await rollback(w.admin,async()=> {
    const p=await pending(w.admin); const reason=event==="pairing_retry_deferred"?"account_limit":event==="pairing_denied"?"companion_canceled":event==="pairing_revoked"?"owner_revoked":null;
    await w.admin.query("insert into private.device_pairing_audit(event,pairing_audit_ref,installation_id,reason) values($1,$2,$3,$4)",[event,p.audit_ref,p.installation_id,reason]);
    await assert.rejects(w.admin.query("insert into private.device_pairing_audit(event,pairing_audit_ref,installation_id,reason) values($1,$2,$3,$4)",[event,p.audit_ref,p.installation_id,reason]),e=>e.code==="23505");
  });
  for(const [event,reason] of [["unknown",null],["pairing_retry_deferred",null],["pairing_retry_deferred","arbitrary"],["pairing_denied","raw machine name"],["pairing_revoked","arbitrary"]]) await rollback(w.admin,async()=> {
    const p=await pending(w.admin);
    await assert.rejects(w.admin.query("insert into private.device_pairing_audit(event,pairing_audit_ref,installation_id,reason) values($1,$2,$3,$4)",[event,p.audit_ref,p.installation_id,reason]),e=>e.code==="23514");
  });
  await rollback(w.admin,async()=> {
    const p=await pending(w.admin);
    for(const reason of ["account_limit","device_limit"]) await w.admin.query("insert into private.device_pairing_audit(event,pairing_audit_ref,installation_id,reason) values('pairing_retry_deferred',$1,$2,$3)",[p.audit_ref,p.installation_id,reason]);
    await assert.rejects(w.admin.query("insert into private.device_pairing_audit(event,pairing_audit_ref,installation_id) values('pairing_started',$1,$2)",[p.id,p.installation_id]),e=>e.code==="23503");
  });
});
it("device provenance permits exactly one ticket or pairing and at most one device per pairing", async()=> {
  const c=await cols("private.devices"); assert.equal(c.find(x=>x.name==="ticket_id").required,false); assert.deepEqual(c.find(x=>x.name==="pairing_id"),column("pairing_id","uuid",false));
  const acct=await w.account(); const enrolled=await w.enrolled(acct);
  await rollback(w.admin,async()=> {
    const p=await pending(w.admin);
    await w.admin.query("update private.devices set ticket_id=null,pairing_id=$1 where id=$2",[p.id,enrolled.deviceId]);
    const d=await w.device_row(enrolled.deviceId); assert.equal(d.pairing_id,p.id);
    await assert.rejects(w.admin.query("update private.devices set pairing_id=null where id=$1",[d.id]),e=>e.code==="23514");
  });
  await rollback(w.admin,async()=> {
    const p=await pending(w.admin);
    await assert.rejects(w.admin.query("update private.devices set pairing_id=$1 where id=$2",[p.id,enrolled.deviceId]),e=>e.code==="23514");
  });
  const defs=(await w.admin.query("select pg_get_constraintdef(oid) d from pg_constraint where conrelid='private.devices'::regclass")).rows.map(x=>x.d);
  assert.ok(defs.some(x=>x.includes("FOREIGN KEY (pairing_id) REFERENCES private.device_pairings(id)")));
  assert.ok((await w.admin.query("select indexdef from pg_indexes where schemaname='private' and tablename='devices'")).rows.some(x=>x.indexdef.includes("UNIQUE INDEX")&&x.indexdef.includes("(pairing_id) WHERE (pairing_id IS NOT NULL)")));
});
it("0016 preserves protected schemas, all old function definition/ACL hashes and populated historical rows", async()=> {
  // Seed and fingerprint a pristine predecessor clone BEFORE its first and only 0016 application.
  await before16(async({admin,database})=> {
    const seed=await makeWorld({database});
    try {
      const account=await seed.account(); const e=await seed.enrolled(account);
      const {snapshot}=await import("../enrollment/world.mjs");
      assert.equal((await seed.ingest(e.device,e.secret,snapshot(e.installationId))).ok,true);
      const anonymous=await seed.device(); const legacyId=randomUUID().replaceAll("-", "");
      await seed.fx.resetBudgets();
      assert.equal((await anonymous.call("ingest_foreverdb_snapshot_auth",[snapshot(legacyId)])).ok,true);
      const claim=await anonymous.call("fdb_account_claim_start",[legacyId]);
      assert.equal((await account.call("fdb_account_claim_redeem",[claim.code])).ok,true);
    } finally { await seed.close(); }
    const before=await protectedState(admin);
    for(const table of ["private.devices","public.installation_item_stats","private.account_installations","private.account_audit"])
      assert.ok(before[`${table}:rows`][0].n>0,`${table} has genuine historical rows`);
    const r=psqlFile(database,migration); assert.equal(r.status,0,r.out);
    assertPreserved(before,await protectedState(admin));
    assert.equal((await admin.query("select enabled from private.device_pairing_config")).rows[0].enabled,false);
  });
});

it("apply16 succeeds without any 0015 object and with azerdex_welcome_outbox recorded, without recording itself", async()=> {
  await w.close(); w=null;
  try {
  for(const outbox of [false,true]) await before16(async({admin,database})=> {
    if(outbox) await admin.query("insert into supabase_migrations.schema_migrations(version,name,statements) values('0015','azerdex_welcome_outbox',array['fixture'])");
    const ledger=(await admin.query("select * from supabase_migrations.schema_migrations order by version")).rows;
    const r=spawnSync("bash",[path.join(repoRoot,"database/tests/account/stack.sh"),"apply16"],{env:{...process.env,FDB_IT_DB:database},encoding:"utf8"});
    assert.equal(r.status,0,`${r.stdout}${r.stderr}`);
    assert.deepEqual((await admin.query("select * from supabase_migrations.schema_migrations order by version")).rows,ledger);
    assert.equal((await admin.query("select enabled from private.device_pairing_config")).rows[0].enabled,false);
  });
  } finally { w=await makeWorld(); }
});
it("preflight rejects missing 0012/0014, conflicting names, missing Auth/crypto/privileges, and recorded lifecycle entries atomically", async()=> {
  await w.close(); w=null;
  try {
  for(const damage of [
    "drop table private.account_installations cascade", "drop function private.fdb_anonymous_caller() cascade", "drop table private.devices cascade",
    "alter table private.devices drop column ticket_id cascade", "alter table auth.sessions drop column not_after cascade",
    "alter function extensions.digest(text,text) rename to task1_removed_digest", "revoke update on auth.sessions from fdb_migrator",
    "create table private.device_pairings(id integer)",
    ...["browser_pairing","rollback_browser_pairing","browser_pairing_restore"].map(name=>`insert into supabase_migrations.schema_migrations(version,name) values('0016','${name}')`),
  ]) await before16(async({admin,database})=> {
    // Only a superuser can damage Auth or extension-owned fixtures.
    const {connectSuper}=await import("../account/harness.mjs"); const su=await connectSuper(database);
    try { await su.query(damage); } finally { await su.end(); }
    const r=psqlFile(database,migration); assert.notEqual(r.status,0,damage); assert.match(r.out,/0016 pre-flight/,r.out);
    assert.equal((await admin.query("select to_regclass('private.device_pairing_config')::text t")).rows[0].t,null,"failed migration left no config");
  });
  } finally { w=await makeWorld(); }
});
it("Task 1 creates exactly zero public pairing RPCs", async () => {
  const { rows } = await w.admin.query(`select n.nspname schema, p.proname name
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname like 'fdb_%pair%'`);
  assert.deepEqual(rows, []);
  assertNoPublicPairingFunctions(await functions(w.admin));
});
it("the qualified registry detects a visible public RPC fixture rather than passing vacuously", async () => {
  await rollback(w.admin, async () => {
    await w.admin.query("create function public.fdb_device_pair_forbidden() returns boolean language sql as 'select false'");
    const raw = (await w.admin.query("select 'public.fdb_device_pair_forbidden()'::regprocedure::text sig")).rows[0].sig;
    assert.equal(raw, "fdb_device_pair_forbidden()", "fixture reproduces regprocedure's omitted visible namespace");
    const rows = await functions(w.admin);
    const rpc = rows.find(fn => fn.schema === "public" && fn.name === "fdb_device_pair_forbidden");
    assert.ok(rpc, "namespace metadata must identify the injected public pairing RPC");
    assert.equal(rpc.sig, "public.fdb_device_pair_forbidden()");
    const { assertNoPublicPairingFunctions, canonicalSignature } = await import("./world.mjs");
    assert.equal(canonicalSignature(rpc), rpc.sig);
    assert.throws(() => assertNoPublicPairingFunctions(rows), /public pairing RPCs/);
  });
});
it("the pre-0016 baseline is independent of a predecessor ACL changed in the post-0016 source", async () => {
  await w.admin.query("revoke execute on function public.fdb_account_devices() from authenticated");
  await w.close(); w=null;
  try {
    await before16(async ({admin}) => {
      assert.equal((await admin.query("select has_function_privilege('authenticated','public.fdb_account_devices()','execute') p")).rows[0].p, true,
        "a pristine 0014 predecessor must not inherit a post-0016 replacement");
      assert.equal((await admin.query("select to_regclass('private.device_pairings')::text t")).rows[0].t, null);
    });
  } finally {
    w=await makeWorld();
    await w.admin.query("grant execute on function public.fdb_account_devices() to authenticated");
  }
});
it("the external preservation proof rejects an ACL mutation before the migration's own snapshot", async () => {
  await w.close(); w=null;
  try {
    await before16(async ({admin,database}) => {
      const before = await protectedState(admin);
      const os = await import("node:os");
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fdb-pairing-mutant-"));
      try {
        const mutant = path.join(dir, "0016_acl_mutant.sql");
        fs.writeFileSync(mutant, "revoke execute on function public.fdb_account_devices() from authenticated;\n" + fs.readFileSync(migration, "utf8"));
        const r = psqlFile(database, mutant);
        assert.equal(r.status, 0, r.out);
        const { assertPreserved } = await import("./world.mjs");
        assert.equal(typeof assertPreserved, "function");
        const after = await protectedState(admin);
        assert.throws(() => assertPreserved(before, after), /public.fdb_account_devices/);
      } finally { fs.rmSync(dir, {recursive:true,force:true}); }
    });
  } finally { w=await makeWorld(); }
});
it("preflight rejects live-device indexes with altered ownership, uniqueness, columns, predicate or validity", async () => {
  await w.close(); w=null;
  try {
    for (const [name,col] of [["devices_one_live_per_installation","installation_id"],["devices_one_live_per_identity","auth_uid"]]) {
      const alterations = [
        `drop index private.${name}; create index ${name} on private.devices (${col}) where status <> 'revoked'`,
        `drop index private.${name}; create unique index ${name} on private.devices (id) where status <> 'revoked'`,
        `drop index private.${name}; create unique index ${name} on private.devices (${col}) where status = 'active'`,
        `drop index private.${name}; create unique index ${name} on private.enrollment_tickets(id)`,
        `update pg_index set indisvalid=false where indexrelid='private.${name}'::regclass`,
      ];
      for (const damage of alterations) await before16(async ({admin,database}) => {
        const {connectSuper}=await import("../account/harness.mjs");
        const su=await connectSuper(database);
        try { await su.query(damage); } finally { await su.end(); }
        const r=psqlFile(database,migration);
        assert.notEqual(r.status,0,damage);
        assert.match(r.out,/0016 pre-flight.*live-device index/,r.out);
        assert.equal((await admin.query("select to_regclass('private.device_pairing_config')::text t")).rows[0].t,null);
      });
    }
  } finally { w=await makeWorld(); }
});
it("complete connected/revoked states and all approval-nullability combinations obey the schema", async () => {
  const account=await w.account(); const linked=await w.enrolled(account);
  const approval={approved_account_uid:account.uid,approved_session_id:account.sid,approved_at:new Date()};
  for (const status of ["pending","approved","connected","expired","denied","revoked"]) {
    for(let mask=0;mask<8;mask++) {
      const deviceId=["connected","revoked"].includes(status)?linked.deviceId:randomUUID();
      const state={status,proposed_device_id:deviceId};
      if(status==="connected"||status==="revoked") Object.assign(state,{connected_device_id:deviceId,connected_at:new Date(),previous_owner_uid:randomUUID()});
      if(status==="denied") Object.assign(state,{denied_at:new Date(),denied_reason:"browser_denied"});
      if(status==="revoked") state.revoked_at=new Date();
      Object.keys(approval).forEach((key,i)=> {if(mask&(1<<i)) state[key]=approval[key];});
      const valid=(mask===0 && ["pending","expired","denied"].includes(status)) || (mask===7 && status!=="pending");
      await rollback(w.admin,async()=> {
        if(valid) {
          const pairing=await pending(w.admin,state);
          assert.equal(pairing.status,status);
          if(status==="connected"||status==="revoked") {
            await w.admin.query("update private.devices set ticket_id=null,pairing_id=$1,status=$2,revoked_at=$3 where id=$4",
              [pairing.id,status==="revoked"?"revoked":"active",state.revoked_at??null,linked.deviceId]);
            assert.equal((await w.device_row(linked.deviceId)).pairing_id,pairing.id);
          }
        }
        else await assert.rejects(pending(w.admin,state),e=>e.code==="23514");
      });
    }
  }
});
it("pairing and audit FKs block real parent deletion without cascading history", async () => {
  await rollback(w.admin,async()=> {
    const p=await pending(w.admin);
    await w.admin.query("insert into private.device_pairing_audit(event,pairing_audit_ref,installation_id) values('pairing_started',$1,$2)",[p.audit_ref,p.installation_id]);
    await w.admin.query("savepoint delete_parent");
    await assert.rejects(w.admin.query("delete from private.device_pairings where id=$1",[p.id]),e=>e.code==="23503");
    await w.admin.query("rollback to savepoint delete_parent");
    assert.equal((await w.admin.query("select count(*)::int n from private.device_pairing_audit where pairing_audit_ref=$1",[p.audit_ref])).rows[0].n,1);
    assert.equal((await w.admin.query("select count(*)::int n from private.device_pairings where id=$1",[p.id])).rows[0].n,1);
  });
  const account=await w.account(); const enrolled=await w.enrolled(account);
  await rollback(w.admin,async()=> {
    const p=await pending(w.admin);
    await w.admin.query("update private.devices set ticket_id=null,pairing_id=$1 where id=$2",[p.id,enrolled.deviceId]);
    await w.admin.query("savepoint delete_parent");
    await assert.rejects(w.admin.query("delete from private.device_pairings where id=$1",[p.id]),e=>e.code==="23503");
    await w.admin.query("rollback to savepoint delete_parent");
    assert.equal((await w.device_row(enrolled.deviceId)).pairing_id,p.id);
    assert.equal((await w.admin.query("select count(*)::int n from private.device_pairings where id=$1",[p.id])).rows[0].n,1);
  });
});
