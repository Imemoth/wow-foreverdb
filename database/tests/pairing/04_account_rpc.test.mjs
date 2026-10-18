import {after,before,beforeEach,it} from 'node:test';
import assert from 'node:assert/strict';
import {makePairingWorld,startPairing,pairingInput,due,pairRow,isolatedCall,protectedPairing,randomUUID,functions} from './world.mjs';
import {claimsFor,connect,rpc,waitUntilBlocked} from '../account/harness.mjs';
let w;
before(async()=>{w=await makePairingWorld();});
after(async()=>{await w?.close();});
beforeEach(async()=>{await w.fx.resetBudgets();await w.admin.query('update private.device_pairing_config set enabled=true');});
const err=error=>({ok:false,error});

it('has exactly three registered-browser RPCs with fixed signatures, attributes and ACLs',async()=>{
  const expected=['public.fdb_account_device_pair_approve(uuid)','public.fdb_account_device_pair_deny(uuid)','public.fdb_account_device_pair_preview(uuid)'];
  const rows=(await functions(w.admin)).filter(x=>x.schema==='public'&&x.name.startsWith('fdb_account_device_pair_'));
  assert.deepEqual(rows.map(x=>x.sig).sort(),expected);
  for(const sig of expected){
    const r=(await w.admin.query("select p.proargnames,p.prosecdef,p.proconfig,has_function_privilege('anon',p.oid,'execute') anon,has_function_privilege('authenticated',p.oid,'execute') accepted,has_function_privilege('service_role',p.oid,'execute') service from pg_proc p where p.oid=$1::regprocedure",[sig])).rows[0];
    assert.deepEqual(r.proargnames,['p_pairing_id']);assert.equal(r.prosecdef,true);assert.equal(r.anon,false);assert.equal(r.accepted,true);assert.equal(r.service,false);
    assert.ok(r.proconfig.includes('search_path=""'));assert.ok(r.proconfig.some(x=>x.startsWith('lock_timeout=')));assert.ok(r.proconfig.some(x=>x.startsWith('statement_timeout=')));
  }
});

it('preview is registered-only, exact-session live, sanitized and reveals no actor, owner, full installation or device identity',async()=>{
  const p=await startPairing(w,await w.device(),pairingInput({label:'Gaming PC'})),a=await w.account();
  const out=await a.call('fdb_account_device_pair_preview',[p.id]);
  assert.deepEqual(Object.keys(out).sort(),['canApprove','computerName','expiresAt','installationSuffix','requestedAt','state'].sort());
  assert.equal(out.state,'pending');assert.equal(out.computerName,'Gaming PC');assert.equal(out.installationSuffix,'…'+p.installationId.slice(-6));assert.equal(out.canApprove,true);
  assert.ok(!JSON.stringify(out).includes(p.installationId));assert.ok(!JSON.stringify(out).includes(p.actor.uid));assert.ok(!JSON.stringify(out).includes(p.deviceId));
  assert.deepEqual(await p.actor.call('fdb_account_device_pair_preview',[p.id]),err('forbidden'));
  const missing={claims:claimsFor({uid:a.uid,sid:randomUUID(),anonymous:false})};
  assert.deepEqual(await isolatedCall(w,missing,'fdb_account_device_pair_preview',[p.id]),err('unauthenticated'));
  await w.admin.query('update auth.refresh_tokens set revoked=true where session_id=$1',[a.sid]);
  assert.deepEqual(await a.call('fdb_account_device_pair_preview',[p.id]),err('unauthenticated'));
});

it('approval stores only the current registered UID and exact JWT session and changes no owner or device before poll',async()=>{
  const d=await w.device(),p=await startPairing(w,d),a=await w.account();await w.fx.installation(p.installationId,d.uid);
  const before=await protectedPairing(w,p),out=await a.call('fdb_account_device_pair_approve',[p.id]);
  assert.deepEqual(out,{ok:true,state:'approved'});const row=await pairRow(w,p);
  assert.equal(row.approved_account_uid,a.uid);assert.equal(row.approved_session_id,a.sid);assert.ok(row.approved_at);
  assert.deepEqual((await protectedPairing(w,p)).installation,before.installation);assert.deepEqual((await protectedPairing(w,p)).devices,before.devices);
  const sameUidOtherSession={uid:a.uid,sid:await w.fx.session(a.uid),claims:null};sameUidOtherSession.claims=claimsFor({uid:a.uid,sid:sameUidOtherSession.sid,anonymous:false});
  assert.deepEqual(await isolatedCall(w,sameUidOtherSession,'fdb_account_device_pair_deny',[p.id]),{ok:true,state:'denied'});
});

it('approval and denial enforce compatibility, terminal replay, expiry and same-account denial',async()=>{
  const owner=await w.account(),other=await w.account(),d=await w.device(),e=await w.enrolled(owner,{device:d});
  await owner.call('fdb_account_device_revoke',[e.deviceId]);
  const p=await startPairing(w,d,pairingInput({installationId:e.installationId}));
  assert.deepEqual(await other.call('fdb_account_device_pair_preview',[p.id]),err('cannot_connect_to_this_account'));
  assert.deepEqual(await other.call('fdb_account_device_pair_approve',[p.id]),err('cannot_connect_to_this_account'));
  assert.deepEqual(await owner.call('fdb_account_device_pair_approve',[p.id]),{ok:true,state:'approved'});
  assert.deepEqual(await other.call('fdb_account_device_pair_deny',[p.id]),err('already_decided'));
  assert.deepEqual(await owner.call('fdb_account_device_pair_deny',[p.id]),{ok:true,state:'denied'});
  assert.deepEqual(await owner.call('fdb_account_device_pair_approve',[p.id]),err('already_decided'));
  const q=await startPairing(w,d);await w.admin.query("update private.device_pairings set created_at=now()-interval '6 minutes',expires_at=now()-interval '1 minute' where id=$1",[q.id]);
  assert.deepEqual(await owner.call('fdb_account_device_pair_approve',[q.id]),err('expired'));assert.equal((await pairRow(w,q)).status,'expired');
});

it('preview returns only the fixed terminal state for connected, expired, denied and revoked rows',async()=>{
  const account=await w.account();
  const connected=await startPairing(w,await w.device());await account.call('fdb_account_device_pair_approve',[connected.id]);await due(w,connected);await connected.actor.call('fdb_device_pair_poll',[connected.id,connected.secret]);
  assert.deepEqual(await account.call('fdb_account_device_pair_preview',[connected.id]),{state:'connected'});
  await account.call('fdb_account_device_revoke',[connected.deviceId]);
  assert.deepEqual(await account.call('fdb_account_device_pair_preview',[connected.id]),{state:'revoked'});
  const denied=await startPairing(w,await w.device());await account.call('fdb_account_device_pair_deny',[denied.id]);
  assert.deepEqual(await account.call('fdb_account_device_pair_preview',[denied.id]),{state:'denied'});
  const expired=await startPairing(w,await w.device());await w.admin.query("update private.device_pairings set created_at=now()-interval '6 minutes',expires_at=now()-interval '1 minute' where id=$1",[expired.id]);
  assert.deepEqual(await account.call('fdb_account_device_pair_preview',[expired.id]),{state:'expired'});
});

it('two-account approval, approve-deny and approve-expiry races have exactly one state winner',async()=>{
  for(const kind of ['two-account','approve-deny']){
    await w.fx.resetBudgets();const p=await startPairing(w,await w.device()),a=await w.account(),b=await w.account();
    const calls=kind==='two-account'?[isolatedCall(w,a,'fdb_account_device_pair_approve',[p.id]),isolatedCall(w,b,'fdb_account_device_pair_approve',[p.id])]:[isolatedCall(w,a,'fdb_account_device_pair_approve',[p.id]),isolatedCall(w,b,'fdb_account_device_pair_deny',[p.id])];
    await Promise.all(calls);const row=await pairRow(w,p);assert.ok(['approved','denied','expired'].includes(row.status),kind);
    const events=(await w.admin.query("select event,count(*)::int n from private.device_pairing_audit where pairing_audit_ref=$1 and event in ('pairing_approved','pairing_denied','pairing_expired') group by event",[row.audit_ref])).rows;
    assert.equal(events.reduce((n,x)=>n+x.n,0),1,kind);
  }
  await w.fx.resetBudgets();const p=await startPairing(w,await w.device()),a=await w.account();
  await w.admin.query("update private.device_pairings set created_at=now()-interval '299 seconds',expires_at=clock_timestamp()+interval '100 milliseconds' where id=$1",[p.id]);
  await w.admin.query('begin');await w.admin.query('select 1 from private.device_pairings where id=$1 for update',[p.id]);
  const approving=isolatedCall(w,a,'fdb_account_device_pair_approve',[p.id]);await new Promise(r=>setTimeout(r,150));await w.admin.query('commit');
  assert.deepEqual(await approving,err('expired'));const expired=await pairRow(w,p);assert.equal(expired.status,'expired');
  assert.equal((await w.admin.query("select count(*)::int n from private.device_pairing_audit where pairing_audit_ref=$1 and event in ('pairing_approved','pairing_expired')",[expired.audit_ref])).rows[0].n,1);
});

it('fixed preview and shared approve-deny budgets isolate UID and pair keys',async()=>{
  const window="to_timestamp(floor(extract(epoch from clock_timestamp())/300)*300)";
  for(const [fn,scope,limit,key] of [
    ['preview','uid',30,a=>`pair_preview:uid:${a.uid}`],['preview','pair',60,(_,p)=>`pair_preview:pair:${p.id}`],['preview','global',600,()=>`pair_preview:global`],
    ['approve','uid',10,a=>`pair_decide:uid:${a.uid}`],['approve','pair',5,(_,p)=>`pair_decide:pair:${p.id}`],['deny','global',120,()=>`pair_decide:global`]]){
    await w.fx.resetBudgets();const p=await startPairing(w,await w.device()),a=await w.account();await w.fx.resetBudgets();const bucket=key(a,p);
    await w.admin.query(`insert into private.foreverdb_api_budgets(bucket,window_started,calls) values($1,${window},$2)`,[bucket,limit]);
    const before=await protectedPairing(w,p);assert.deepEqual(await a.call(`fdb_account_device_pair_${fn}`,[p.id]),err('rate_limited'),`${fn}:${scope}`);assert.deepEqual(await protectedPairing(w,p),before);
  }
  await w.fx.resetBudgets();const p=await startPairing(w,await w.device()),a=await w.account(),other=await w.account();await w.fx.resetBudgets();
  const bucket=`pair_decide:pair:${p.id}`;await w.admin.query(`insert into private.foreverdb_api_budgets(bucket,window_started,calls) values($1,${window},5)`,[bucket]);
  assert.deepEqual(await a.call('fdb_account_device_pair_approve',[p.id]),err('rate_limited'));assert.deepEqual(await other.call('fdb_account_device_pair_deny',[p.id]),err('rate_limited'));
  assert.equal((await w.admin.query("select count(*)::int n from private.foreverdb_api_budgets where bucket=$1",[`pair_decide:uid:${other.uid}`])).rows[0].n,0);
});

it('approve and deny revalidate the exact registered session after an installation-lock wait',async()=>{
  for(const operation of ['approve','deny']){
    await w.fx.resetBudgets();const p=await startPairing(w,await w.device()),a=await w.account();
    const hold=await connect(w.database),caller=await connect(w.database);
    await hold.query('begin');await hold.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[p.installationId]);
    try{
      const attempt=rpc(caller,a.claims,`fdb_account_device_pair_${operation}`,[p.id]);
      await waitUntilBlocked(w.admin,caller);
      await w.admin.query('delete from auth.sessions where id=$1',[a.sid]);
      await hold.query('commit');
      assert.deepEqual(await attempt,err('unauthenticated'),operation);
      assert.equal((await pairRow(w,p)).status,'pending');
      assert.deepEqual((await w.admin.query('select event from private.device_pairing_audit where installation_id=$1 order by id',[p.installationId])).rows,[{event:'pairing_started'}]);
    }finally{
      await hold.query('rollback').catch(()=>{});await Promise.all([hold.end(),caller.end()]);
    }
  }
});
