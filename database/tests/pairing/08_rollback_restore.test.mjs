import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { before16, closeBefore16Template, connect, dropDatabase, migration, psqlFile, randomUUID, makeWorld, startPairing, pairingInput, due } from "./world.mjs";
import { cloneDatabase, repoRoot } from "../account/harness.mjs";

const file = (...parts) => path.join(repoRoot, ...parts);
const LEDGER = file("database/ops/0016_record_migration_ledger.sql");
const ENABLE = process.env.FDB_PAIRING_ENABLE ?? file("database/ops/0016_enable_browser_pairing.sql");
const DISABLE = file("database/ops/0016_disable_browser_pairing.sql");
const KILL = file("database/rollback/0016_kill_switch.sql");
const KILL_RESTORE = file("database/rollback/0016_kill_switch_restore.sql");
const ROLLBACK = process.env.FDB_PAIRING_ROLLBACK ?? file("database/rollback/0016_rollback.sql");
const RESTORE = process.env.FDB_PAIRING_RESTORE ?? file("database/restore/0016_browser_pairing_restore.sql");
const ROLLBACK_14 = file("database/rollback/0014_rollback.sql");
const ROLLBACK_12 = file("database/rollback/0012_rollback.sql");

const PUBLIC = [
  "public.fdb_device_pair_start(uuid,text,uuid,text,text,text)",
  "public.fdb_device_pair_poll(uuid,text)",
  "public.fdb_device_pair_cancel(uuid,text)",
  "public.fdb_account_device_pair_preview(uuid)",
  "public.fdb_account_device_pair_approve(uuid)",
  "public.fdb_account_device_pair_deny(uuid)",
];

const apply16 = database => {
  const result = psqlFile(database, migration);
  assert.equal(result.status, 0, result.out);
};
const run = (database, sql, vars) => psqlFile(database, sql, vars);
const record = (database, name) => run(database, LEDGER, { name });
const present = async (admin, sig) => (await admin.query("select to_regprocedure($1)::text value", [sig])).rows[0].value;
const enabled = async admin => (await admin.query("select enabled from private.device_pairing_config where singleton")).rows[0].enabled;
const executable = async (admin, sig, role = "authenticated") => (await admin.query("select has_function_privilege($1,$2,'execute') value", [role, sig])).rows[0].value;

async function with16(fn) {
  return before16(async ({database, admin}) => {
    apply16(database);
    await admin.query(`insert into supabase_migrations.schema_migrations(version,name,statements) values
      ('20261012000000','account_ownership_claims',array['fixture']),
      ('20261014000000','zero_touch_enrollment',array['fixture']) on conflict do nothing`);
    return fn({database, admin});
  });
}

after(closeBefore16Template);

describe("0016 operational lifecycle", { concurrency: 1 }, () => {
  it("records a single append-only browser_pairing -> rollback -> restore ledger cycle", async () => with16(async ({database, admin}) => {
    const before = (await admin.query("select version,name,statements from supabase_migrations.schema_migrations order by version")).rows;
    assert.notEqual(record(database, "rollback_browser_pairing").status, 0);
    assert.notEqual(record(database, "browser_pairing_restore").status, 0);
    assert.equal(record(database, "browser_pairing").status, 0);
    assert.notEqual(record(database, "browser_pairing").status, 0);
    assert.equal(run(database, ROLLBACK).status, 0);
    { const r = record(database, "rollback_browser_pairing"); assert.equal(r.status, 0, r.out); }
    assert.equal(run(database, RESTORE).status, 0);
    assert.equal(record(database, "browser_pairing_restore").status, 0);
    assert.notEqual(record(database, "rollback_browser_pairing").status, 0);
    const afterRows = (await admin.query("select version,name,statements from supabase_migrations.schema_migrations order by version")).rows;
    assert.deepEqual(afterRows.slice(0, before.length), before);
    assert.deepEqual(afterRows.slice(before.length).map(row => row.name), ["browser_pairing", "rollback_browser_pairing", "browser_pairing_restore"]);
  }));

  it("enable, disable, kill, and kill-switch restore preserve the OFF default and exact ACL", async () => with16(async ({database, admin}) => {
    assert.equal(record(database, "browser_pairing").status, 0);
    assert.equal(await enabled(admin), false);
    assert.equal(run(database, ENABLE).status, 0);
    assert.equal(await enabled(admin), true);
    assert.equal(run(database, DISABLE).status, 0);
    assert.equal(await enabled(admin), false);
    assert.equal(run(database, ENABLE).status, 0);
    assert.equal(run(database, KILL).status, 0);
    assert.equal(await enabled(admin), false);
    for (const sig of PUBLIC) assert.equal(await executable(admin, sig), false, sig);
    assert.equal(run(database, KILL_RESTORE).status, 0);
    assert.equal(await enabled(admin), false, "restoring EXECUTE never enables pairing");
    for (const sig of PUBLIC) {
      assert.equal(await executable(admin, sig), true, sig);
      for (const role of ["public", "anon", "service_role"]) assert.equal(await executable(admin, sig, role), false, `${sig} ${role}`);
    }
  }));

  it("empty rollback removes the complete 0016 schema and restore reconstructs it with the gate off", async () => with16(async ({database, admin}) => {
    assert.equal(record(database, "browser_pairing").status, 0);
    const ownersBefore = (await admin.query("select md5(coalesce(string_agg(id||':'||coalesce(owner_user_id::text,''),'|' order by id),'')) h from public.installations")).rows[0].h;
    assert.equal(run(database, ROLLBACK).status, 0);
    for (const sig of PUBLIC) assert.equal(await present(admin, sig), null, sig);
    for (const table of ["private.device_pairing_config", "private.device_pairings", "private.device_pairing_audit"]) {
      assert.equal((await admin.query("select to_regclass($1)::text value", [table])).rows[0].value, null, table);
    }
    assert.equal((await admin.query("select exists(select 1 from pg_attribute where attrelid='private.devices'::regclass and attname='pairing_id' and not attisdropped) value")).rows[0].value, false);
    { const r = record(database, "rollback_browser_pairing"); assert.equal(r.status, 0, r.out); }
    assert.equal(run(database, RESTORE).status, 0);
    assert.equal(await enabled(admin), false);
    for (const sig of PUBLIC) assert.equal(await executable(admin, sig), true, sig);
    assert.equal((await admin.query("select md5(coalesce(string_agg(id||':'||coalesce(owner_user_id::text,''),'|' order by id),'')) h from public.installations")).rows[0].h, ownersBefore);
  }));

  it("empty rollback preserves a legacy 0014 ticket device byte-for-byte", async () => before16(async ({database, admin}) => {
    const w = await makeWorld({database});
    try {
      const account = await w.account(), device = await w.device();
      const ticket = await w.ticket(account, "Legacy ticket PC");
      const enrolled = await w.enroll(device, ticket.ticket, "legacy-ticket-installation", "Legacy ticket PC");
      assert.equal(enrolled.ok, true);
      const before = (await admin.query(`select
        (select jsonb_agg(to_jsonb(t) order by id) from private.devices t) devices,
        (select jsonb_agg(to_jsonb(t) order by id) from private.enrollment_tickets t) tickets,
        (select jsonb_agg(to_jsonb(t) order by id) from private.device_audit t) audit`)).rows[0];
      apply16(database);
      await admin.query(`insert into supabase_migrations.schema_migrations(version,name,statements) values
        ('20261012000000','account_ownership_claims',array['fixture']),
        ('20261014000000','zero_touch_enrollment',array['fixture']) on conflict do nothing`);
      assert.equal(record(database, "browser_pairing").status, 0);
      const rolledBack = run(database, ROLLBACK);
      assert.equal(rolledBack.status, 0, rolledBack.out);
      assert.equal((await admin.query("select exists(select 1 from pg_attribute where attrelid='private.devices'::regclass and attname='pairing_id' and not attisdropped) value")).rows[0].value, false);
      assert.deepEqual((await admin.query(`select
        (select jsonb_agg(to_jsonb(t) order by id) from private.devices t) devices,
        (select jsonb_agg(to_jsonb(t) order by id) from private.enrollment_tickets t) tickets,
        (select jsonb_agg(to_jsonb(t) order by id) from private.device_audit t) audit`)).rows[0], before);
      assert.equal(record(database, "rollback_browser_pairing").status, 0);
      const restored = run(database, RESTORE);
      assert.equal(restored.status, 0, restored.out);
      assert.equal(await enabled(admin), false);
      assert.deepEqual((await admin.query(`select
        (select jsonb_agg(to_jsonb(t)-'pairing_id' order by id) from private.devices t) devices,
        (select jsonb_agg(to_jsonb(t) order by id) from private.enrollment_tickets t) tickets,
        (select jsonb_agg(to_jsonb(t) order by id) from private.device_audit t) audit`)).rows[0], before);
      assert.equal((await admin.query("select count(*)::int n from private.devices where pairing_id is not null")).rows[0].n, 0);
    } finally { await w.close(); }
  }));

  it("nonempty rollback retains the closed schema and trigger, then restore recreates only the API surface", async () => with16(async ({database, admin}) => {
    assert.equal(record(database, "browser_pairing").status, 0);
    const id = randomUUID(), auditRef = randomUUID(), initiator = randomUUID();
    await admin.query(`insert into private.device_pairings(id,audit_ref,installation_id,initiator_uid,initiator_session_id,poll_secret_hash,
      proposed_device_id,device_credential_hash,status,created_at,expires_at,next_poll_at)
      values($1,$2,$3,$4,$5,decode(repeat('11',32),'hex'),$6,decode(repeat('22',32),'hex'),'pending',now(),now()+interval '5 minutes',now()+interval '5 seconds')`,
      [id,auditRef,"retained-pairing-install",initiator,randomUUID(),randomUUID()]);
    await admin.query("insert into private.device_pairing_audit(event,pairing_audit_ref,installation_id) values('pairing_started',$1,$2)", [auditRef,"retained-pairing-install"]);
    const rowsBefore = (await admin.query("select to_jsonb(t) row from private.device_pairings t order by id")).rows;
    assert.equal(run(database, ROLLBACK).status, 0);
    assert.equal((await admin.query("select to_regclass('private.device_pairings')::text value")).rows[0].value, "private.device_pairings");
    assert.equal((await admin.query("select count(*)::int n from pg_trigger where tgrelid='private.devices'::regclass and tgname='devices_propagate_pairing_revocation' and not tgisinternal")).rows[0].n, 1);
    assert.deepEqual((await admin.query("select to_jsonb(t) row from private.device_pairings t order by id")).rows, rowsBefore);
    for (const sig of PUBLIC) assert.equal(await present(admin, sig), null, sig);
    assert.equal(record(database, "rollback_browser_pairing").status, 0);
    assert.equal(run(database, RESTORE).status, 0);
    assert.equal(await enabled(admin), false);
    assert.deepEqual((await admin.query("select to_jsonb(t) row from private.device_pairings t order by id")).rows, rowsBefore);
  }));

  it("refuses mixed schemas and predecessor rollback while any 0016 dependency remains", async () => with16(async ({database, admin}) => {
    assert.equal(record(database, "browser_pairing").status, 0);
    assert.notEqual(run(database, ROLLBACK_14).status, 0, "0014 must be rolled back only after 0016");
    assert.notEqual(run(database, ROLLBACK_12).status, 0, "0012 must be rolled back only after 0016");
    await admin.query("drop trigger devices_propagate_pairing_revocation on private.devices");
    const failed = run(database, ROLLBACK);
    assert.notEqual(failed.status, 0);
    assert.match(failed.out, /mixed|incomplete|trigger|pre-flight/i);
    for (const sig of PUBLIC) assert.ok(await present(admin, sig), "atomic failure keeps API present");
  }));

  it("keeps the revocation trigger live while APIs are rolled back, then restores rows unchanged and OFF", async () => with16(async ({database, admin}) => {
    assert.equal(record(database, "browser_pairing").status, 0);
    const w = await makeWorld({database});
    try {
      await admin.query("update private.device_pairing_config set enabled=true");
      const actor = await w.device(), account = await w.account();
      const p = await startPairing(w, actor, pairingInput());
      assert.deepEqual(await account.call("fdb_account_device_pair_approve", [p.id]), {ok:true,state:"approved"});
      await due(w, p);
      assert.equal((await actor.call("fdb_device_pair_poll", [p.id,p.secret])).state, "connected");
      assert.equal(run(database, ROLLBACK).status, 0);
      for (const sig of PUBLIC) assert.equal(await present(admin, sig), null, sig);
      assert.deepEqual(await account.call("fdb_account_device_revoke", [p.deviceId]), {ok:true});
      const beforeRestore = (await admin.query("select to_jsonb(t) row from private.device_pairings t where id=$1", [p.id])).rows;
      assert.equal(beforeRestore[0].row.status, "revoked");
      assert.equal((await admin.query("select count(*)::int n from private.device_pairing_audit where pairing_audit_ref=$1 and event='pairing_revoked'", [beforeRestore[0].row.audit_ref])).rows[0].n, 1);
      { const r=record(database,"rollback_browser_pairing"); assert.equal(r.status,0,r.out); }
      { const r=run(database,RESTORE); assert.equal(r.status,0,r.out); }
      assert.deepEqual((await admin.query("select to_jsonb(t) row from private.device_pairings t where id=$1", [p.id])).rows, beforeRestore);
      assert.equal(await enabled(admin), false);
    } finally { await w.close(); }
  }));

  it("preflights enable and restore atomically and permits the clean reverse-order rollback path", async () => with16(async ({database, admin}) => {
    assert.notEqual(run(database, ENABLE).status, 0, "enable requires its ledger entry");
    assert.equal(await enabled(admin), false);
    assert.equal(record(database, "browser_pairing").status, 0);
    await admin.query("revoke execute on function public.fdb_device_pair_poll(uuid,text) from authenticated");
    const refused = run(database, ENABLE);
    assert.notEqual(refused.status, 0);
    assert.equal(await enabled(admin), false, "failed enable is atomic");
    await admin.query("grant execute on function public.fdb_device_pair_poll(uuid,text) to authenticated");
    assert.equal(run(database, ROLLBACK).status, 0);
    { const r=record(database,"rollback_browser_pairing"); assert.equal(r.status,0,r.out); }
    assert.equal(run(database, ROLLBACK_14).status, 0, "0014 succeeds only after empty 0016 rollback");
    { const r=run(database,ROLLBACK_12); assert.equal(r.status,0,`0012 succeeds last: ${r.out}`); }
  }));

  it("restore refuses a mixed retained schema without changing rows or recreating APIs", async () => with16(async ({database, admin}) => {
    assert.equal(record(database,"browser_pairing").status,0);
    const id=randomUUID(), auditRef=randomUUID();
    await admin.query(`insert into private.device_pairings(id,audit_ref,installation_id,initiator_uid,initiator_session_id,poll_secret_hash,
      proposed_device_id,device_credential_hash,status,created_at,expires_at,next_poll_at)
      values($1,$2,'mixed-restore-install',$3,$4,decode(repeat('11',32),'hex'),$5,decode(repeat('22',32),'hex'),'pending',now(),now()+interval '5 minutes',now()+interval '5 seconds')`,
      [id,auditRef,randomUUID(),randomUUID(),randomUUID()]);
    assert.equal(run(database,ROLLBACK).status,0);
    { const r=record(database,"rollback_browser_pairing"); assert.equal(r.status,0,r.out); }
    await admin.query("drop trigger devices_propagate_pairing_revocation on private.devices");
    const before=(await admin.query("select to_jsonb(t) row from private.device_pairings t")).rows;
    const refused=run(database,RESTORE); assert.notEqual(refused.status,0); assert.match(refused.out,/mixed|incomplete|trigger/i);
    assert.deepEqual((await admin.query("select to_jsonb(t) row from private.device_pairings t")).rows,before);
    for(const sig of PUBLIC) assert.equal(await present(admin,sig),null,sig);
  }));

  it("enable, kill-switch and rollback refuse definition or schema hash drift atomically", async () => with16(async ({database, admin}) => {
    assert.equal(record(database,"browser_pairing").status,0);
    await admin.query(`create or replace function public.fdb_device_pair_poll(p_pairing_id uuid,p_poll_secret text) returns jsonb language sql security definer set search_path='' as 'select jsonb_build_object(''ok'',false)'`);
    for(const script of [ENABLE,KILL,ROLLBACK]) {
      const before=await enabled(admin), r=run(database,script);
      assert.notEqual(r.status,0,script); assert.match(r.out,/hash mismatch/i); assert.equal(await enabled(admin),before,"failed preflight is atomic");
    }
  }));
});
