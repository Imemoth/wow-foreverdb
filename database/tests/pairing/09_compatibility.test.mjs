import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { before16, closeBefore16Template, migration, psqlFile, makeWorld, randomUUID } from "./world.mjs";

after(closeBefore16Template);

describe("0016 predecessor and PR #58 compatibility", { concurrency: 1 }, () => {
  it("applies after 0012/0014 with no 0015 ledger row", async () => before16(async ({database, admin}) => {
    const before = (await admin.query("select name from supabase_migrations.schema_migrations order by version")).rows;
    const result = psqlFile(database, migration);
    assert.equal(result.status, 0, result.out);
    assert.deepEqual((await admin.query("select name from supabase_migrations.schema_migrations order by version")).rows, before,
      "0016 never records itself or rewrites predecessor history");
  }));

  it("applies independently when the PR #58 ledger name is already present", async () => before16(async ({database, admin}) => {
    await admin.query("insert into supabase_migrations.schema_migrations(version,name,statements) values('0015','azerdex_welcome_outbox',array['fixture'])");
    const result = psqlFile(database, migration);
    assert.equal(result.status, 0, result.out);
    assert.equal((await admin.query("select count(*)::int n from supabase_migrations.schema_migrations where name='azerdex_welcome_outbox'")).rows[0].n, 1);
    assert.equal((await admin.query("select count(*)::int n from supabase_migrations.schema_migrations where name like '%browser_pairing%'")).rows[0].n, 0);
  }));

  it("keeps claim and enrollment function definitions and ACLs byte-identical", async () => before16(async ({database, admin}) => {
    const before = (await admin.query(`select oid::regprocedure::text sig,md5(pg_get_functiondef(oid)) def,coalesce(proacl::text,'') acl
      from pg_proc where pronamespace in ('public'::regnamespace,'private'::regnamespace) order by 1`)).rows;
    const result = psqlFile(database, migration);
    assert.equal(result.status, 0, result.out);
    const afterRows = (await admin.query(`select oid::regprocedure::text sig,md5(pg_get_functiondef(oid)) def,coalesce(proacl::text,'') acl
      from pg_proc where pronamespace in ('public'::regnamespace,'private'::regnamespace) order by 1`)).rows;
    const index = new Map(afterRows.map(row => [row.sig,row]));
    for (const row of before) assert.deepEqual(index.get(row.sig), row, row.sig);
  }));

  it("keeps claim transfers and ticket enrollment working before and after 0016", async () => before16(async ({database}) => {
    const w=await makeWorld({database});
    try {
      const account=await w.account();
      const claimOnce=async suffix=>{
        const actor=await w.device(), installation=`claim-${suffix}-${randomUUID()}`;
        await w.fx.installation(installation,actor.uid);
        const started=await actor.call("fdb_account_claim_start",[installation]);
        assert.equal(started.ok,true,JSON.stringify(started));
        const redeemed=await account.call("fdb_account_claim_redeem",[started.code]);
        assert.equal(redeemed.ok,true,JSON.stringify(redeemed));
        assert.equal(await w.fx.owner(installation),account.uid);
      };
      const enrollOnce=async suffix=>{
        const actor=await w.device(), ticket=await w.ticket(account), installation=`ticket-${suffix}-${randomUUID()}`;
        const out=await w.enroll(actor,ticket.ticket,installation);
        assert.equal(out.ok,true,JSON.stringify(out));
        assert.equal(await w.fx.owner(installation),account.uid);
      };
      await claimOnce("before"); await enrollOnce("before");
      const applied=psqlFile(database,migration); assert.equal(applied.status,0,applied.out);
      await claimOnce("after"); await enrollOnce("after");
    } finally { await w.close(); }
  }));
});
