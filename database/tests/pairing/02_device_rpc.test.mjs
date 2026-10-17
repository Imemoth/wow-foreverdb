import {before,after,beforeEach,it} from 'node:test';
import assert from 'node:assert/strict';
import {makePairingWorld,pairingInput,startArgs,proofArgs,startPairing,pairRow,due,protectedPairing,hash,randomUUID,isolatedCall,functions,nativePairingHelperSignatures} from './world.mjs';
import {claimsFor} from '../account/harness.mjs';
let w;
before(async()=>{w=await makePairingWorld();});
after(async()=>{await w?.close();});
beforeEach(async()=>{await w.fx.resetBudgets(); await w.admin.query('update private.device_pairing_config set enabled=true');});
const error = code => ({ok:false,error:code});

it('native RPCs are present with the exact p_* argument names and closed ACLs',async()=>{
  assert.deepEqual((await functions(w.admin)).filter(fn=>fn.schema==='private'&&/^fdb_.*pair/.test(fn.name)).map(fn=>fn.sig).sort(),nativePairingHelperSignatures);
  for(const sig of nativePairingHelperSignatures) {
    const r=(await w.admin.query("select has_function_privilege('anon',$1,'execute') anon,has_function_privilege('authenticated',$1,'execute') accepted,has_function_privilege('service_role',$1,'execute') service",[sig])).rows[0];
    assert.deepEqual(r,{anon:false,accepted:false,service:false});
  }
  for(const [fn,names] of [
    ['fdb_device_pair_start',['p_pairing_id','p_poll_secret_hash','p_device_id','p_device_credential_hash','p_installation_id','p_computer_name']],
    ['fdb_device_pair_poll',['p_pairing_id','p_poll_secret']],['fdb_device_pair_cancel',['p_pairing_id','p_poll_secret']]]) {
    const r=(await w.admin.query("select proargnames,prosecdef,proconfig,has_function_privilege('anon',oid,'execute') anon,has_function_privilege('service_role',oid,'execute') service,has_function_privilege('authenticated',oid,'execute') accepted from pg_proc where pronamespace='public'::regnamespace and proname=$1",[fn])).rows;
    assert.equal(r.length,1,`${fn} is missing`); assert.deepEqual(r[0].proargnames,names); assert.equal(r[0].prosecdef,true);
    assert.equal(r[0].anon,false); assert.equal(r[0].service,false); assert.equal(r[0].accepted,true);
    assert.ok(r[0].proconfig.includes('search_path=""')); assert.ok(r[0].proconfig.some(x=>x.startsWith('lock_timeout='))); assert.ok(r[0].proconfig.some(x=>x.startsWith('statement_timeout=')));
  }
});
it('start commits immutable bindings, only digests, exact five-minute expiry and idempotent retries',async()=>{
  const actor=await w.device(), p=await startPairing(w,actor); const r=await pairRow(w,p);
  assert.deepEqual(Object.keys(p.out).sort(),['ok','state','pairingId','expiresAt','intervalSeconds'].sort());
  assert.equal(p.out.state,'pending'); assert.equal(p.out.pairingId,p.id); assert.equal(p.out.intervalSeconds,5);
  assert.equal(r.expires_at-r.created_at,300000); assert.equal(r.next_poll_at-r.created_at,5000);
  assert.equal(r.initiator_uid,actor.uid); assert.equal(r.initiator_session_id,actor.sid); assert.equal(r.poll_secret_hash.toString('hex'),hash(p.secret));
  assert.equal(r.device_credential_hash.toString('hex'),hash(p.credential)); assert.equal(r.computer_label,p.label);
  const snapshot=await protectedPairing(w,p);
  assert.deepEqual(await actor.call('fdb_device_pair_start',startArgs(p)),p.out);
  assert.deepEqual((await pairRow(w,p)).version,r.version);
  for(const key of ['secret','credential','deviceId','installationId','label']) {
    await w.fx.resetBudgets();
    const q={...p,[key]:key==='deviceId'?randomUUID():key==='secret'?pairingInput().secret:key==='credential'?'different credential':key==='installationId'?'other-installation-1234':'Other PC'};
    assert.deepEqual(await actor.call('fdb_device_pair_start',startArgs(q)),error('pairing_conflict'));
  }
  // Budget state may change only for the actor's own legitimate identical start.
  assert.deepEqual((await protectedPairing(w,p)).pairing,snapshot.pairing);
});
it('start refuses malformed canonical UUID/hash/installation/label inputs before storage',async()=>{
  const d=await w.device(), p=pairingInput();
  for(const [index,value] of [[0,'12345678-1234-1234-9234-123456789abc'],[2,'12345678-1234-4234-1234-123456789abc'],[1,'A'.repeat(64)],[3,'a'.repeat(63)],[4,'short'],[4,'a'.repeat(129)],[4,'invalid space installation'],[5,' control\nname'],[5,'a'.repeat(61)],[5,' bad trim '],[5,'\u00a0PC'],[5,'PC\ufeff'],[5,'PC\u0085']]) {
    const args=startArgs(p);args[index]=value; assert.deepEqual(await d.call('fdb_device_pair_start',args),error('invalid_request'));
  }
  assert.equal((await w.admin.query('select count(*)::int n from private.device_pairings where id=$1',[p.id])).rows[0].n,0);
});
it('one live request per installation and initiator, foreign owner and live device fail closed',async()=>{
  const d=await w.device(),p=await startPairing(w,d);
  assert.deepEqual(await d.call('fdb_device_pair_start',startArgs(pairingInput())),error('pairing_pending'));
  const other=await w.device(); const before=await protectedPairing(w,p);
  assert.deepEqual(await other.call('fdb_device_pair_start',startArgs(pairingInput({installationId:p.installationId}))),error('pairing_pending'));
  assert.deepEqual(await protectedPairing(w,p),before);
  const inst=pairingInput();await w.fx.installation(inst.installationId,other.uid);
  assert.deepEqual(await (await w.device()).call('fdb_device_pair_start',startArgs(inst)),error('installation_conflict'));
  const a=await w.account(),e=await w.enrolled(a),bound=pairingInput({installationId:e.installationId});
  assert.deepEqual(await e.device.call('fdb_device_pair_start',startArgs(bound)),error('device_bound'));
});
it('pending poll obeys schedule and early polls increase by five capped at thirty',async()=>{
  const d=await w.device(),p=await startPairing(w,d);
  for(const interval of [10,15,20,25,30,30]) assert.deepEqual(await d.call('fdb_device_pair_poll',proofArgs(p)),{ok:false,error:'slow_down',intervalSeconds:interval});
  await due(w,p);const before=Date.now();
  const result=await d.call('fdb_device_pair_poll',proofArgs(p)); assert.equal(result.state,'pending');assert.equal(result.intervalSeconds,30);assert.ok(result.expiresAt);
  assert.ok((await pairRow(w,p)).next_poll_at.getTime()>=before+29000);
});
it('cancel, expiry and disabled gate are terminal and idempotent',async()=>{
  const d=await w.device(),p=await startPairing(w,d);
  await w.admin.query('update private.device_pairing_config set enabled=false');const before=await protectedPairing(w,p);
  for(const fn of ['poll','cancel']) assert.deepEqual(await d.call(`fdb_device_pair_${fn}`,proofArgs(p)),error('feature_disabled'));
  assert.deepEqual(await d.call('fdb_device_pair_start',startArgs(p)),error('feature_disabled')); assert.deepEqual(await protectedPairing(w,p),before);
  await w.admin.query('update private.device_pairing_config set enabled=true');
  assert.deepEqual(await d.call('fdb_device_pair_cancel',proofArgs(p)),{ok:true,state:'denied'});
  const denied=await protectedPairing(w,p);
  for(const fn of ['poll','cancel']) assert.deepEqual(await d.call(`fdb_device_pair_${fn}`,proofArgs(p)),{ok:true,state:'denied'});
  assert.deepEqual(await protectedPairing(w,p),denied);
  const q=await startPairing(w,d); await w.admin.query("update private.device_pairings set created_at=now()-interval '6 minutes',expires_at=now()-interval '1 minute' where id=$1",[q.id]);
  assert.deepEqual(await d.call('fdb_device_pair_poll',proofArgs(q)),{ok:true,state:'expired'});
  const expired=await protectedPairing(w,q);assert.deepEqual(await d.call('fdb_device_pair_cancel',proofArgs(q)),{ok:true,state:'expired'});assert.deepEqual(await protectedPairing(w,q),expired);
});
it('invalid locator/secret/UID/session/registered actor leave every protected byte and budget unchanged',async()=>{
  const d=await w.device(),other=await w.device(),registered=await w.account(),p=await startPairing(w,d);
  await w.fx.installation(p.installationId,d.uid);
  const sid=await w.fx.session(d.uid),same={claims:claimsFor({uid:d.uid,sid,anonymous:true})};
  for(const fn of ['poll','cancel']) for(const [actor,args] of [[d,[randomUUID(),p.secret]],[d,[p.id,pairingInput().secret]],[other,proofArgs(p)],[same,proofArgs(p)],[registered,proofArgs(p)]]) {
    const before=await protectedPairing(w,p);const out=await isolatedCall(w,actor,`fdb_device_pair_${fn}`,args);
    assert.deepEqual(out,error('pairing_not_available'));assert.deepEqual(await protectedPairing(w,p),before);
  }
  const before=await protectedPairing(w,p);
  assert.deepEqual(await registered.call('fdb_device_pair_start',startArgs(p)),error('session_not_accepted'));
  assert.deepEqual(await isolatedCall(w,same,'fdb_device_pair_start',startArgs(p)),error('pairing_conflict'));
  assert.deepEqual(await protectedPairing(w,p),before);
});
it('revoked, expired, missing-refresh and upgraded anonymous sessions cannot operate',async()=>{
  for(const damage of ['delete from auth.sessions where id=$1',"update auth.sessions set not_after=clock_timestamp()-interval '1 second' where id=$1",'update auth.refresh_tokens set revoked=true where session_id=$1','update auth.users set is_anonymous=false where id=$1']) {
    const d=await w.device(),p=await startPairing(w,d);await w.admin.query(damage,[damage.includes('auth.users')?d.uid:d.sid]);
    const before=await protectedPairing(w,p);
    for(const fn of ['poll','cancel']) assert.deepEqual(await d.call(`fdb_device_pair_${fn}`,proofArgs(p)),error('pairing_not_available'));
    assert.deepEqual(await d.call('fdb_device_pair_start',startArgs(p)),error('session_not_accepted'));assert.deepEqual(await protectedPairing(w,p),before);
  }
});

it('five-minute budget caps are start 5 UID/3 installation/120 global, poll 90 UID/3000 global, cancel 10 UID/5 pair/120 global',async()=>{
  // Seed the fixed-window counters at their boundary, invoke the actual RPC, inspect isolation.
  const window="to_timestamp(floor(extract(epoch from clock_timestamp())/300)*300)";
  for(const [kind,scope,limit] of [['start','uid',5],['start','installation',3],['start','global',120],['poll','uid',90],['poll','global',3000],['cancel','uid',10],['cancel','pair',5],['cancel','global',120]]) {
    await w.fx.resetBudgets();const d=await w.device(),p=await startPairing(w,d);await due(w,p); await w.fx.resetBudgets();
    const key=`pair_${kind}:${scope}${scope==='global'?'':':'+(scope==='uid'?d.uid:scope==='pair'?p.id:hash(p.installationId))}`;
    await w.admin.query(`insert into private.foreverdb_api_budgets(bucket,window_started,calls) values($1,${window},$2)`,[key,limit]);
    const before=await protectedPairing(w,p);
    assert.deepEqual(await d.call(`fdb_device_pair_${kind}`,kind==='start'?startArgs(p):proofArgs(p)),error('rate_limited'),`${kind} ${scope} ${limit}`);
    assert.deepEqual(await protectedPairing(w,p),before);
    await w.admin.query('update private.foreverdb_api_budgets set calls=$2-1 where bucket=$1',[key,limit]);
    const allowed=await d.call(`fdb_device_pair_${kind}`,kind==='start'?startArgs(p):proofArgs(p));assert.equal(allowed.ok,true,JSON.stringify({kind,scope,allowed}));
    assert.equal((await w.admin.query('select calls from private.foreverdb_api_budgets where bucket=$1',[key])).rows[0].calls,limit);
  }
});
it('foreign actors cannot charge another UID/installation/pair bucket at full budget',async()=>{
  const owner=await w.device(),attacker=await w.device(),p=await startPairing(w,owner);
  const before=await protectedPairing(w,p);
  for(let i=0;i<6;i++) await attacker.call('fdb_device_pair_start',startArgs(pairingInput({installationId:p.installationId})));
  for(const fn of ['poll','cancel']) for(let i=0;i<6;i++) await attacker.call(`fdb_device_pair_${fn}`,proofArgs(p));
  assert.deepEqual(await protectedPairing(w,p),before);
  assert.equal((await w.admin.query("select calls from private.foreverdb_api_budgets where bucket=$1",['pair_start:uid:'+owner.uid])).rows[0].calls,1);
});
it('the private poll-global counter has one hard-coded scope, fixed cap, rollover and no API-role grants',async()=>{
  const {rows}=await w.admin.query("select pronargs,prosecdef,has_function_privilege('anon',oid,'execute') anon,has_function_privilege('authenticated',oid,'execute') accepted,has_function_privilege('service_role',oid,'execute') service from pg_proc where oid='private.fdb_pair_poll_global_budget()'::regprocedure");
  assert.deepEqual(rows,[{pronargs:0,prosecdef:true,anon:false,accepted:false,service:false}]);
  await w.admin.query("insert into private.foreverdb_api_budgets(bucket,window_started,calls) values('pair_poll:global',to_timestamp(floor(extract(epoch from clock_timestamp())/300)*300),2999),('pair_poll:uid:unrelated',now(),17)");
  const unrelated=(await w.admin.query("select * from private.foreverdb_api_budgets where bucket='pair_poll:uid:unrelated'")).rows;
  await w.admin.query('select private.fdb_pair_poll_global_budget()');
  assert.equal((await w.admin.query("select calls from private.foreverdb_api_budgets where bucket='pair_poll:global'")).rows[0].calls,3000);
  await assert.rejects(w.admin.query('select private.fdb_pair_poll_global_budget()'),e=>e.code==='PT429');
  await w.admin.query("update private.foreverdb_api_budgets set window_started=now()-interval '10 minutes' where bucket='pair_poll:global'");
  await w.admin.query('select private.fdb_pair_poll_global_budget()');
  assert.equal((await w.admin.query("select calls from private.foreverdb_api_budgets where bucket='pair_poll:global'")).rows[0].calls,1);
  assert.deepEqual((await w.admin.query("select * from private.foreverdb_api_budgets where bucket='pair_poll:uid:unrelated'")).rows,unrelated);
});
it('an identical start after its pending deadline expires once and returns a fixed start conflict',async()=>{
  const p=await startPairing(w,await w.device());
  await w.admin.query("update private.device_pairings set created_at=now()-interval '6 minutes',expires_at=now()-interval '1 minute' where id=$1",[p.id]);
  assert.deepEqual(await p.actor.call('fdb_device_pair_start',startArgs(p)),error('pairing_conflict'));
  assert.equal((await pairRow(w,p)).status,'expired');
  assert.equal((await w.admin.query("select count(*)::int n from private.device_pairing_audit where pairing_audit_ref=$1 and event='pairing_expired'",[(await pairRow(w,p)).audit_ref])).rows[0].n,1);
  const before=await protectedPairing(w,p);
  assert.deepEqual(await p.actor.call('fdb_device_pair_start',startArgs(p)),error('pairing_conflict'));
  assert.deepEqual(await protectedPairing(w,p),before);
});
it('new start can recover an expired request only for the exact session and installation, with one expiry audit',async()=>{
  const actor=await w.device(),p=await startPairing(w,actor),fresh=pairingInput({installationId:p.installationId});
  const before=await protectedPairing(w,p);
  assert.deepEqual(await actor.call('fdb_device_pair_start',startArgs(fresh)),error('pairing_pending'));
  assert.deepEqual(await protectedPairing(w,p),before);
  await w.admin.query("update private.device_pairings set created_at=now()-interval '6 minutes',expires_at=now()-interval '1 minute' where id=$1",[p.id]);
  const expired=await protectedPairing(w,p),sid=await w.fx.session(actor.uid),sameUid={claims:claimsFor({uid:actor.uid,sid,anonymous:true})};
  for(const foreign of [await w.device(),sameUid]) {
    assert.deepEqual(await isolatedCall(w,foreign,'fdb_device_pair_start',startArgs(fresh)),error('pairing_pending'));
    assert.deepEqual(await protectedPairing(w,p),expired);
  }
  assert.deepEqual(await actor.call('fdb_device_pair_start',startArgs(pairingInput())),error('pairing_pending'));
  assert.deepEqual(await protectedPairing(w,p),expired);
  const out=await actor.call('fdb_device_pair_start',startArgs(fresh));assert.equal(out.ok,true);assert.equal(out.state,'pending');
  assert.equal((await pairRow(w,p)).status,'expired');
  assert.equal((await w.admin.query("select count(*)::int n from private.device_pairing_audit where pairing_audit_ref=$1 and event='pairing_expired'",[(await pairRow(w,p)).audit_ref])).rows[0].n,1);
  assert.deepEqual(await actor.call('fdb_device_pair_poll',proofArgs(p)),{ok:true,state:'expired'});
});
