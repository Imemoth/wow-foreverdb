import {before,after,beforeEach,it} from 'node:test';
import assert from 'node:assert/strict';
import {makePairingWorld,approvedPairing,approveFixture,startPairing,pairingInput,proofArgs,startArgs,protectedPairing,pairRow,due,hash,isolatedCall,connect,startPairingAuth} from './world.mjs';
import {waitUntilBlocked,claimsFor,verifyJwt,rpc} from '../account/harness.mjs';
let w;
before(async()=>{w=await makePairingWorld();});after(async()=>{await w?.close();});beforeEach(async()=>w.fx.resetBudgets());
it('start retries after approval or terminal transition stay inside the fixed Task 5 start error contract',async()=>{
  const p=await approvedPairing(w);
  assert.deepEqual(await p.actor.call('fdb_device_pair_start',startArgs(p)),{ok:false,error:'pairing_conflict'});
  await connected(p);
  assert.deepEqual(await p.actor.call('fdb_device_pair_start',startArgs(p)),{ok:false,error:'pairing_conflict'});
});
async function connected(p) {
  const result=await p.actor.call('fdb_device_pair_poll',proofArgs(p));assert.deepEqual(result,{ok:true,state:'connected',deviceId:p.deviceId});
  const row=await pairRow(w,p),dev=await w.device_row(p.deviceId);
  assert.equal(row.status,'connected');assert.equal(row.connected_device_id,p.deviceId);assert.ok(row.connected_at);
  assert.equal(await w.fx.owner(p.installationId),p.account.uid);assert.equal(dev.account_uid,p.account.uid);assert.equal(dev.auth_uid,p.actor.uid);assert.equal(dev.pairing_id,p.id);assert.equal(dev.ticket_id,null);assert.equal(dev.credential_hash.toString('hex'),hash(p.credential));
  assert.equal((await w.admin.query("select count(*)::int n from private.device_pairing_audit where pairing_audit_ref=$1 and event='pairing_connected'",[row.audit_ref])).rows[0].n,1);
  return row;
}
it('approved redemption creates a schema-zero placeholder and lost-response replay is zero-write',async()=>{
  const p=await approvedPairing(w);await connected(p);
  assert.equal((await w.admin.query('select schema_version from public.installations where id=$1',[p.installationId])).rows[0].schema_version,0);
  assert.equal((await pairRow(w,p)).previous_owner_uid,null);
  const before=await protectedPairing(w,p);
  for(const fn of ['poll','poll','cancel']) assert.deepEqual(await p.actor.call(`fdb_device_pair_${fn}`,proofArgs(p)),{ok:true,state:'connected',deviceId:p.deviceId});
  assert.deepEqual(await protectedPairing(w,p),before);
});
it('anonymous-owner transfer records previous_owner_uid atomically and preserves history/claim-only authority',async()=>{
  const actor=await w.device(),account=await w.account(),input=pairingInput();await w.fx.installation(input.installationId,actor.uid);await w.fx.guild(input.installationId,'guild',[{guid:'member',name:'Member'}]);
  const before=await w.history(input.installationId);const p=await approvedPairing(w,{...input,actor,account});
  assert.equal((await connected(p)).previous_owner_uid,actor.uid);assert.deepEqual(await w.history(p.installationId),before);
  assert.equal((await w.admin.query('select count(*)::int n from private.account_installations where installation_id=$1',[p.installationId])).rows[0].n,0);
});
it('owner conflict, device collision, approving-session revocation and unavailable accounts deny without ownership/device writes',async()=>{
  for(const kind of ['owner','collision','session','refresh','ban','unconfirmed']) {
    await w.fx.resetBudgets();const p=await approvedPairing(w);const original=await w.fx.owner(p.installationId);
    if(kind==='owner') await w.fx.installation(p.installationId,(await w.account()).uid);
    if(kind==='collision') {const e=await w.enrolled(await w.account());await w.admin.query('update private.devices set id=$1 where id=$2',[p.deviceId,e.deviceId]);}
    if(kind==='session') await w.admin.query('delete from auth.sessions where id=$1',[p.account.sid]);
    if(kind==='refresh') await w.admin.query('update auth.refresh_tokens set revoked=true where session_id=$1',[p.account.sid]);
    if(kind==='ban') await w.admin.query("update auth.users set banned_until=clock_timestamp()+interval '1 day' where id=$1",[p.account.uid]);
    if(kind==='unconfirmed') await w.admin.query('update auth.users set email_confirmed_at=null where id=$1',[p.account.uid]);
    const before=await protectedPairing(w,p);
    assert.deepEqual(await p.actor.call('fdb_device_pair_poll',proofArgs(p)),{ok:true,state:'denied'});
    const after=await protectedPairing(w,p);assert.deepEqual(after.installation,before.installation);assert.deepEqual(after.devices,before.devices);
    assert.equal((await pairRow(w,p)).denied_reason,{owner:'ownership_conflict',collision:'device_id_conflict',session:'approval_session_revoked',refresh:'approval_session_revoked',ban:'account_unavailable',unconfirmed:'account_unavailable'}[kind]);
  }
});
it('account and device limits remain approved, defer audit once, and succeed when capacity is released',async()=>{
  for(const kind of ['account','device']) {
    await w.fx.resetBudgets();const p=await approvedPairing(w);
    if(kind==='account') await w.admin.query("insert into public.installations(id,owner_user_id,schema_version,addon_version) select 'limit-install-'||$1::text||'-'||n,$1::uuid,0,'fixture' from generate_series(1,50) n",[p.account.uid]);
    else for(let n=0;n<10;n++) await w.enrolled(p.account);
    for(let retry=0;retry<2;retry++) {await due(w,p);assert.deepEqual(await p.actor.call('fdb_device_pair_poll',proofArgs(p)),{ok:false,error:kind+'_limit'});}
    assert.equal((await pairRow(w,p)).status,'approved');assert.equal(await w.fx.owner(p.installationId),null);
    assert.equal((await w.admin.query("select count(*)::int n from private.device_pairing_audit where installation_id=$1 and event='pairing_retry_deferred'",[p.installationId])).rows[0].n,1);
    if(kind==='account') await w.admin.query("delete from public.installations where id in (select id from public.installations where owner_user_id=$1 limit 1)",[p.account.uid]);
    else await w.admin.query("update private.devices set status='revoked',revoked_at=clock_timestamp(),revoked_reason='owner_revoked' where id in(select id from private.devices where account_uid=$1 and status<>'revoked' limit 1)",[p.account.uid]);
    await due(w,p);await connected(p);
  }
});
it('public start and redemption enforce every controlled reenrollment predecessor predicate',async()=>{
  for(const kind of ['owner_revoked','credential_reuse','replaced','missing','wrong-identity','wrong-account','wrong-installation','reason','latest','active']) {
    await w.fx.resetBudgets();const account=await w.account(),e=await w.enrolled(account);
    const allowed=['owner_revoked','credential_reuse','replaced'].includes(kind);
    if(kind!=='active') await w.admin.query("update private.devices set status='revoked',revoked_at=clock_timestamp(),revoked_reason=$2 where id=$1",[e.deviceId,allowed?kind:'owner_revoked']);
    if(kind==='missing') await w.admin.query('delete from private.devices where id=$1',[e.deviceId]);
    if(kind==='wrong-identity') await w.admin.query('update private.devices set auth_uid=$2 where id=$1',[e.deviceId,(await w.device()).uid]);
    if(kind==='wrong-account') await w.admin.query('update private.devices set account_uid=$2 where id=$1',[e.deviceId,(await w.account()).uid]);
    if(kind==='wrong-installation') {const other=pairingInput();await w.fx.installation(other.installationId,account.uid);await w.admin.query('update private.devices set installation_id=$2 where id=$1',[e.deviceId,other.installationId]);}
    if(kind==='reason') await w.admin.query("update private.devices set revoked_reason='account_unavailable' where id=$1",[e.deviceId]);
    if(kind==='latest') {const another=await w.enrolled(account);await w.admin.query("update private.devices set installation_id=$2,status='revoked',revoked_at=clock_timestamp(),revoked_reason='owner_revoked',created_at=clock_timestamp()+interval '1 second' where id=$1",[another.deviceId,e.installationId]);}
    const input=pairingInput({installationId:e.installationId}),before=await protectedPairing(w,input);
    const out=await e.device.call('fdb_device_pair_start',startArgs(input));
    if(allowed) {
      assert.equal(out.ok,true,kind);const p=await approveFixture(w,{...input,actor:e.device},account);
      const row=await connected(p);assert.equal(row.previous_owner_uid,null);assert.equal((await w.device_row(e.deviceId)).status,'revoked');
    } else {
      assert.deepEqual(out,{ok:false,error:kind==='active'?'device_bound':'installation_conflict'},kind);
      assert.deepEqual(await protectedPairing(w,input),before,kind);
    }
  }
});
it('injected constraint failure rolls back owner, provenance, device, pairing and audit together',async()=>{
  const actor=await w.device(),input=pairingInput();await w.fx.installation(input.installationId,actor.uid);const p=await approvedPairing(w,{...input,actor});
  const before=await protectedPairing(w,p);
  await w.admin.query(`alter table private.device_pairing_audit add constraint task2_injected_failure check(event<>'pairing_connected') not valid`);
  try {assert.deepEqual(await p.actor.call('fdb_device_pair_poll',proofArgs(p)),{ok:false,error:'temporarily_unavailable'});assert.deepEqual(await protectedPairing(w,p),before);}
  finally {await w.admin.query('alter table private.device_pairing_audit drop constraint task2_injected_failure');}
  await connected(p);
});
it('100 paired races serialize double-poll and poll/cancel with no partial or duplicate effects', {timeout:120000}, async()=>{
  for(let n=0;n<100;n++) {
    await w.fx.resetBudgets();const p=await approvedPairing(w);const cancel=n%2===1;
    const results=await Promise.all([isolatedCall(w,p.actor,'fdb_device_pair_poll',proofArgs(p)),isolatedCall(w,p.actor,cancel?'fdb_device_pair_cancel':'fdb_device_pair_poll',proofArgs(p))]);
    const row=await pairRow(w,p);assert.ok(['connected','denied'].includes(row.status),JSON.stringify(results));
    if(!cancel) assert.equal(row.status,'connected');
    const devices=(await w.admin.query('select * from private.devices where pairing_id=$1',[p.id])).rows;
    const audits=(await w.admin.query("select * from private.device_pairing_audit where pairing_audit_ref=$1 and event='pairing_connected'",[row.audit_ref])).rows;
    assert.equal(devices.length,row.status==='connected'?1:0);assert.equal(audits.length,devices.length);
    assert.equal(await w.fx.owner(p.installationId),row.status==='connected'?p.account.uid:null);
    const before=await protectedPairing(w,p);await p.actor.call('fdb_device_pair_poll',proofArgs(p));assert.deepEqual(await protectedPairing(w,p),before);
  }
});
it('caller and exact approving session are revalidated after installation-lock wait',async()=>{
  for(const action of ['start','cancel','poll','approver']) {
    await w.fx.resetBudgets();const p=action==='approver'||action==='poll'?await approvedPairing(w):await startPairing(w,await w.device());
    const holder=await connect(w.database),caller=await connect(w.database);
    await holder.query('begin');await holder.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[p.installationId]);
    const {rpc}=await import('../account/harness.mjs');const fn=action==='approver'?'poll':action;
    const result=rpc(caller,p.actor.claims,`fdb_device_pair_${fn}`,fn==='start'?startArgs(p):proofArgs(p));
    try {
      await waitUntilBlocked(w.admin,caller);
      await w.admin.query('delete from auth.sessions where id=$1',[action==='approver'?p.account.sid:p.actor.sid]);
      const before=await protectedPairing(w,p);await holder.query('commit');
      assert.deepEqual(await result,action==='approver'?{ok:true,state:'denied'}:{ok:false,error:action==='start'?'session_not_accepted':'pairing_not_available'});
      if(action!=='approver') assert.deepEqual(await protectedPairing(w,p),before);
      assert.equal((await w.admin.query('select count(*)::int n from private.devices where pairing_id=$1',[p.id])).rows[0].n,0);
    } finally {await holder.query('rollback');await holder.end();await caller.end();}
  }
});
it('same-UID wrong-session poll races valid redemption without changing the outcome',async()=>{
  const p=await approvedPairing(w),sid=await w.fx.session(p.actor.uid),other={claims:claimsFor({uid:p.actor.uid,sid,anonymous:true})};
  const results=await Promise.all([isolatedCall(w,other,'fdb_device_pair_poll',proofArgs(p)),isolatedCall(w,p.actor,'fdb_device_pair_poll',proofArgs(p))]);
  assert.deepEqual(results[0],{ok:false,error:'pairing_not_available'});assert.deepEqual(results[1],{ok:true,state:'connected',deviceId:p.deviceId});
});
it('redemption waiting on the approving account lock rechecks the deadline before any owner or device write',async()=>{
  const p=await approvedPairing(w),holder=await connect(w.database),caller=await connect(w.database);
  const {rpc}=await import('../account/harness.mjs');
  await w.admin.query("update private.device_pairings set expires_at=clock_timestamp()+interval '1 second' where id=$1",[p.id]);
  await holder.query('begin');await holder.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['fdb-account:'+p.account.uid]);
  const pending=rpc(caller,p.actor.claims,'fdb_device_pair_poll',proofArgs(p));
  try {
    await waitUntilBlocked(w.admin,caller);
    await new Promise(resolve=>setTimeout(resolve,1100));
    await holder.query('commit');
    assert.deepEqual(await pending,{ok:true,state:'expired'});
    assert.equal(await w.fx.owner(p.installationId),null);
    assert.equal((await w.admin.query('select count(*)::int n from private.devices where pairing_id=$1',[p.id])).rows[0].n,0);
  } finally {await holder.query('rollback');await holder.end();await caller.end();}
});
it('session deadlines crossed during an account-lock wait cannot redeem',async()=>{
  const {rpc}=await import('../account/harness.mjs');
  for(const whose of ['initiator','approver']) {
    await w.fx.resetBudgets();const p=await approvedPairing(w),holder=await connect(w.database),caller=await connect(w.database);
    await w.admin.query("update auth.sessions set not_after=clock_timestamp()+interval '1 second' where id=$1",[whose==='initiator'?p.actor.sid:p.account.sid]);
    await holder.query('begin');await holder.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['fdb-account:'+p.account.uid]);
    const before=await protectedPairing(w,p),pending=rpc(caller,p.actor.claims,'fdb_device_pair_poll',proofArgs(p));
    try {
      await waitUntilBlocked(w.admin,caller);await new Promise(resolve=>setTimeout(resolve,1100));await holder.query('commit');
      assert.deepEqual(await pending,whose==='initiator'?{ok:false,error:'pairing_not_available'}:{ok:true,state:'denied'});
      if(whose==='initiator') assert.deepEqual(await protectedPairing(w,p),before);
      assert.equal(await w.fx.owner(p.installationId),null);
    } finally {await holder.query('rollback');await holder.end();await caller.end();}
  }
});
it('start takes its proven installation budget before locking installation/device rows',async()=>{
  const actor=await w.device(),p=pairingInput(),holder=await connect(w.database),caller=await connect(w.database);
  const {rpc}=await import('../account/harness.mjs');
  await w.fx.installation(p.installationId,actor.uid);
  const bucket='pair_start:installation:'+hash(p.installationId);
  await w.admin.query("insert into private.foreverdb_api_budgets(bucket,window_started,calls) values($1,to_timestamp(floor(extract(epoch from clock_timestamp())/300)*300),1)",[bucket]);
  await holder.query('begin');await holder.query('select 1 from public.installations where id=$1 for update',[p.installationId]);
  const pending=rpc(caller,actor.claims,'fdb_device_pair_start',startArgs(p));
  try {
    await waitUntilBlocked(w.admin,caller);
    await assert.rejects(w.admin.query('select 1 from private.foreverdb_api_budgets where bucket=$1 for update nowait',[bucket]),e=>e.code==='55P03');
  } finally {await holder.query('rollback');await pending;await holder.end();await caller.end();}
});
// A test-only table trigger pauses AFTER the last authority checks, immediately before the first owner write.
// The RPC runs unchanged, through the public surface; no production function is replaced or instrumented.
async function pauseBeforeOwnerWrite(p, check) {
  const holder=await connect(w.database),caller=await connect(w.database),contender=await connect(w.database);
  const {rpc}=await import('../account/harness.mjs');
  await w.admin.query(`create function private.task2_pause_owner_write() returns trigger language plpgsql as $$
    begin perform pg_advisory_xact_lock(702001); return new; end $$`);
  await w.admin.query(`create trigger task2_pause_owner_write before insert or update of owner_user_id on public.installations
    for each row execute function private.task2_pause_owner_write()`);
  await holder.query('begin');await holder.query('select pg_advisory_xact_lock(702001)');
  const pending=rpc(caller,p.actor.claims,'fdb_device_pair_poll',proofArgs(p));
  try {
    await waitUntilBlocked(w.admin,caller);
    await check(contender,holder,pending);
  } finally {
    await holder.query('rollback');await pending;
    await w.admin.query('drop trigger task2_pause_owner_write on public.installations');
    await w.admin.query('drop function private.task2_pause_owner_write()');
    await Promise.all([holder.end(),caller.end(),contender.end()]);
  }
}
const authorityChange = (kind,p) => kind==='upgrade'
  ? ['update auth.users set is_anonymous=false where id=$1',[p.actor.uid]]
  : ['update auth.refresh_tokens set revoked=true where session_id=$1',[kind==='initiator-family'?p.actor.sid:p.account.sid]];

for(const kind of ['initiator-family','approver-family','upgrade']) {
it('redemption pins '+kind+' authority after the final check through commit',async()=>{
    await w.fx.resetBudgets();const p=await approvedPairing(w);
    await pauseBeforeOwnerWrite(p,async(contender,holder,pending)=>{
      await contender.query("set lock_timeout='150ms'");
      const [sql,args]=authorityChange(kind,p);
      await assert.rejects(contender.query(sql,args),e=>e.code==='55P03',kind+' cannot commit before redemption');
      assert.equal(await w.fx.owner(p.installationId),null);
      assert.equal((await pairRow(w,p)).status,'approved');
      await holder.query('commit');
      assert.deepEqual(await pending,{ok:true,state:'connected',deviceId:p.deviceId});
      await contender.query(sql,args); // inverse actor now proceeds only AFTER redemption committed.
      assert.equal(await w.fx.owner(p.installationId),p.account.uid);
      assert.equal((await w.admin.query('select count(*)::int n from private.devices where pairing_id=$1',[p.id])).rows[0].n,1);
    });
});
it(kind+' authority changes that lock first defer redemption without writes, then win after commit',async()=>{
  const {rpc}=await import('../account/harness.mjs');
    await w.fx.resetBudgets();const p=await approvedPairing(w),changer=await connect(w.database),caller=await connect(w.database);
    await changer.query('begin');const [sql,args]=authorityChange(kind,p);await changer.query(sql,args);
    const before=await protectedPairing(w,p);
    try {
      assert.deepEqual(await rpc(caller,p.actor.claims,'fdb_device_pair_poll',proofArgs(p)),{ok:false,error:'temporarily_unavailable'},kind);
      assert.deepEqual(await protectedPairing(w,p),before,kind);
      await changer.query('commit');
      assert.deepEqual(await rpc(caller,p.actor.claims,'fdb_device_pair_poll',proofArgs(p)),kind==='approver-family'?{ok:true,state:'denied'}:{ok:false,error:'pairing_not_available'});
      assert.equal(await w.fx.owner(p.installationId),null);
      assert.equal((await w.admin.query('select count(*)::int n from private.devices where pairing_id=$1',[p.id])).rows[0].n,0);
    } finally {await changer.query('rollback');await changer.end();await caller.end();}
});
}
it('simultaneous identical starts and changed-verifier starts create one immutable row and one start audit',async()=>{
  const {rpc}=await import('../account/harness.mjs');
  for(let n=0;n<20;n++) {
    await w.fx.resetBudgets();const actor=await w.device(),p=pairingInput(),other=n%4===1?{...p,secret:pairingInput().secret}:n%4===3?{...p,credential:pairingInput().credential}:p;
    const holder=await connect(w.database),one=await connect(w.database),two=await connect(w.database);
    await holder.query('begin');await holder.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[p.installationId]);
    const first=rpc(one,actor.claims,'fdb_device_pair_start',startArgs(p)),second=rpc(two,actor.claims,'fdb_device_pair_start',startArgs(other));
    try {
      await waitUntilBlocked(w.admin,one);await waitUntilBlocked(w.admin,two);await holder.query('commit');
      const results=await Promise.all([first,second]),rows=(await w.admin.query('select * from private.device_pairings where id=$1',[p.id])).rows;
      assert.equal(rows.length,1);assert.equal(rows[0].status,'pending');
      if(n%2) {
        assert.equal(results.filter(r=>r.ok).length,1);
        assert.deepEqual(results.find(r=>!r.ok),{ok:false,error:'pairing_conflict'});
        const winner=results[0].ok?p:other;assert.equal(rows[0].poll_secret_hash.toString('hex'),hash(winner.secret));
        assert.equal(rows[0].device_credential_hash.toString('hex'),hash(winner.credential));
      } else {assert.deepEqual(results[0],results[1]);assert.equal(results[0].ok,true);}
      assert.equal((await w.admin.query("select count(*)::int n from private.device_pairing_audit where pairing_audit_ref=$1 and event='pairing_started'",[rows[0].audit_ref])).rows[0].n,1);
    } finally {await holder.query('rollback');await Promise.all([first,second]);await Promise.all([holder.end(),one.end(),two.end()]);}
  }
});
it('pinned real GoTrue refresh, logout and anonymous upgrade serialize with redemption without deadlocks', {timeout:30000}, async()=>{
  const auth=await startPairingAuth(w);
  // pg_stat_activity hides another role's wait fields from fdb_migrator; observe GoTrue as its own disposable Auth role.
  const authObserver=await connect(w.database,{user:'supabase_auth_admin',password:'local-test-password'});
  const realActor=async(body)=>{
    const result=await auth.call('/signup',{body});assert.equal(result.status,200,JSON.stringify(result.json));
    const claims=verifyJwt(result.json.access_token);
    return {uid:claims.sub,sid:claims.session_id,claims,token:result.json.access_token,refresh:result.json.refresh_token,
      call:(name,args)=>rpc(w.client,claims,name,args)};
  };
  try {
    for(const kind of ['initiator-refresh','approver-refresh','initiator-logout','approver-logout','upgrade']) {
      await w.fx.resetBudgets();
      const actor=await realActor({}),account=await realActor({email:`pair-${pairingInput().id}@example.invalid`,password:'Pairing-test-passphrase-1'});
      const p=await approvedPairing(w,{actor,account}),target=kind.startsWith('approver')?account:actor;
      await pauseBeforeOwnerWrite(p,async(_contender,holder,pending)=>{
        let settled=false;
        const action=kind.endsWith('refresh')?auth.call('/token?grant_type=refresh_token',{body:{refresh_token:target.refresh}})
          :kind.endsWith('logout')?auth.call('/logout?scope=local',{token:target.token})
          :auth.call('/user',{method:'PUT',token:actor.token,body:{email:`upgrade-${p.id}@example.invalid`,password:'Pairing-test-passphrase-1'}});
        const observed=action.then(r=>{settled=true;return r;});
        try {
          if(!kind.endsWith('refresh')) {
            let blocked=false;
            for(let i=0;i<100&&!blocked;i++) {
              blocked=(await authObserver.query("select exists(select 1 from pg_stat_activity where datname=$1 and usename='supabase_auth_admin' and wait_event_type='Lock') blocked",[w.database])).rows[0].blocked;
              if(!blocked) {assert.equal(settled,false,kind+' completed before redemption');await new Promise(resolve=>setTimeout(resolve,10));}
            }
            assert.equal(blocked,true,kind+' must reach the authority row lock');
          } else {
            // GoTrue uses FOR UPDATE SKIP LOCKED and bounded retry for refresh, so it does not report a DB lock wait.
            await new Promise(resolve=>setTimeout(resolve,120));assert.equal(settled,false,kind+' cannot rotate a pinned family');
          }
          await holder.query('commit');assert.deepEqual(await pending,{ok:true,state:'connected',deviceId:p.deviceId});
          const result=await observed;assert.equal(result.status,kind.endsWith('logout')?204:200,kind+': '+JSON.stringify(result.json));
          if(kind.endsWith('refresh')) {
            assert.equal(verifyJwt(result.json.access_token).session_id,target.sid);
            assert.equal((await w.admin.query('select count(*)::int n from auth.refresh_tokens where session_id=$1 and not revoked',[target.sid])).rows[0].n,1);
          }
          if(kind==='upgrade') assert.equal((await w.admin.query('select is_anonymous from auth.users where id=$1',[actor.uid])).rows[0].is_anonymous,false);
          assert.equal(await w.fx.owner(p.installationId),account.uid);
        } finally {await holder.query('rollback');await observed;}
      });
    }
  } finally {await authObserver.end();await auth.close();}
});

// Natural not_after expiry is independent of explicit Auth writes and remains possible while authority rows are pinned.
for(const scenario of [
  {name:'start identity lock',action:'start',lock:'identity'},
  {name:'start recovery identity lock',action:'start',lock:'identity',existing:'expired',recover:true},
  {name:'start pairing row',action:'start',lock:'pair',existing:'pending'},
  {name:'start expired recovery row',action:'start',lock:'pair',existing:'expired',recover:true},
  {name:'start installation row',action:'start',lock:'installation'},
  {name:'start predecessor row',action:'start',lock:'device'},
  {name:'start installation budget',action:'start',lock:'budget',existing:'pending'},
  {name:'pending poll pairing row',action:'poll',lock:'pair',existing:'pending',due:true},
  {name:'early poll pairing row',action:'poll',lock:'pair',existing:'pending'},
  {name:'expiry poll pairing row',action:'poll',lock:'pair',existing:'expired'},
  {name:'pending cancel pairing row',action:'cancel',lock:'pair',existing:'pending'},
  {name:'approved cancel pairing row',action:'cancel',lock:'pair',existing:'approved'},
  {name:'cancel pair budget',action:'cancel',lock:'budget',existing:'pending'},
]) it(scenario.name+' refuses a session deadline crossed at the later lock without protected mutation',async()=>{
  let actor=await w.device(),p=pairingInput(),prior,predecessor;
  if(scenario.lock==='device') {
    const e=await w.enrolled(await w.account());actor=e.device;p=pairingInput({installationId:e.installationId});predecessor=e.deviceId;
    await w.admin.query("update private.devices set status='revoked',revoked_at=clock_timestamp(),revoked_reason='owner_revoked' where id=$1",[predecessor]);
  } else if(scenario.existing==='approved') {
    p=await approvedPairing(w,{actor});
  } else if(scenario.existing) {
    p=await startPairing(w,actor);
    if(scenario.existing==='expired') await w.admin.query("update private.device_pairings set created_at=now()-interval '6 minutes',expires_at=now()-interval '1 minute' where id=$1",[p.id]);
    if(scenario.recover) {prior=p;p=pairingInput({installationId:p.installationId});}
  }
  if(scenario.due) await due(w,p);
  if(scenario.lock==='installation') await w.fx.installation(p.installationId,actor.uid);
  const budget=scenario.action==='start'?'pair_start:installation:'+hash(p.installationId):'pair_cancel:pair:'+p.id;
  if(scenario.lock==='budget') await w.admin.query("insert into private.foreverdb_api_budgets(bucket,window_started,calls) values($1,to_timestamp(floor(extract(epoch from clock_timestamp())/300)*300),1) on conflict(bucket) do nothing",[budget]);
  await w.admin.query("update auth.sessions set not_after=clock_timestamp()+interval '1 second' where id=$1",[actor.sid]);
  const before=await protectedPairing(w,p),priorBefore=prior?await protectedPairing(w,prior):null;
  const holder=await connect(w.database),caller=await connect(w.database);
  await holder.query('begin');
  if(scenario.lock==='identity') await holder.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['fdb-device-identity:'+actor.uid]);
  if(scenario.lock==='pair') await holder.query('select 1 from private.device_pairings where id=$1 for update',[prior?.id??p.id]);
  if(scenario.lock==='installation') await holder.query('select 1 from public.installations where id=$1 for update',[p.installationId]);
  if(scenario.lock==='device') await holder.query('select 1 from private.devices where id=$1 for update',[predecessor]);
  if(scenario.lock==='budget') await holder.query('select 1 from private.foreverdb_api_budgets where bucket=$1 for update',[budget]);
  const pending=rpc(caller,actor.claims,'fdb_device_pair_'+scenario.action,scenario.action==='start'?startArgs(p):proofArgs(p));
  try {
    await waitUntilBlocked(w.admin,caller);
    assert.ok((await w.admin.query('select pg_blocking_pids($1) blockers',[caller.processID])).rows[0].blockers.includes(holder.processID));
    let expired=false;const deadline=Date.now()+3000;
    while(!expired&&Date.now()<deadline) {
      expired=(await w.admin.query('select not_after<=clock_timestamp() expired from auth.sessions where id=$1',[actor.sid])).rows[0].expired;
      if(!expired) await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.equal(expired,true,'release only after the database observes natural session expiry');
    await holder.query('commit');
    assert.deepEqual(await pending,{ok:false,error:scenario.action==='start'?'session_not_accepted':'pairing_not_available'});
    assert.deepEqual(await protectedPairing(w,p),before);
    if(prior) assert.deepEqual(await protectedPairing(w,prior),priorBefore,'rollback any expired-request cleanup performed before the later wait');
  } finally {await holder.query('rollback');await pending;await holder.end();await caller.end();}
});

async function waitForNaturalDeadline(sid) {
  let expired=false;const deadline=Date.now()+3000;
  while(!expired&&Date.now()<deadline) {
    expired=(await w.admin.query('select not_after<=clock_timestamp() expired from auth.sessions where id=$1',[sid])).rows[0].expired;
    if(!expired) await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.equal(expired,true,'the exact session deadline must pass on the DB clock before releasing the wait');
}
async function redemptionDeadlinePair(lock) {
  if(lock==='device') {
    const account=await w.account(),e=await w.enrolled(account);
    await w.admin.query("update private.devices set status='revoked',revoked_at=clock_timestamp(),revoked_reason='owner_revoked' where id=$1",[e.deviceId]);
    const p=await startPairing(w,e.device,pairingInput({installationId:e.installationId}));
    return {...await approveFixture(w,p,account),predecessor:e.deviceId};
  }
  const actor=await w.device(),account=await w.account(),input=pairingInput();
  await w.fx.installation(input.installationId,actor.uid);
  return approveFixture(w,await startPairing(w,actor,input),account);
}
async function assertRedemptionDeadlineResult(p,whose,before,result) {
  const after=await protectedPairing(w,p);
  if(whose==='initiator') {
    assert.deepEqual(result,{ok:false,error:'pairing_not_available'});
    assert.deepEqual(after,before,'expired caller rolls the complete attempt back');
    return;
  }
  assert.deepEqual(result,{ok:true,state:'denied'});
  const row=after.pairing[0].row,old=before.pairing[0].row;
  assert.equal(row.status,'denied');assert.equal(row.denied_reason,'approval_session_revoked');assert.ok(row.denied_at);
  for(const key of ['installation','devices','claims','budgets']) assert.deepEqual(after[key],before[key],key+' is unchanged');
  const unchanged=({...value})=>{for(const key of ['version','status','denied_at','denied_reason']) delete value[key];return value;};
  assert.deepEqual(unchanged(row),unchanged(old),'no ownership provenance/connected fields/schedule change survives');
  assert.deepEqual(after.audit.slice(0,-1),before.audit);
  assert.equal(after.audit.at(-1).row.event,'pairing_denied');assert.equal(after.audit.at(-1).row.reason,'approval_session_revoked');
  assert.equal((await w.admin.query("select count(*)::int n from private.device_pairing_audit where installation_id=$1 and event='pairing_connected'",[p.installationId])).rows[0].n,0);
  assert.deepEqual(await p.actor.call('fdb_device_pair_poll',proofArgs(p)),{ok:true,state:'denied'});
  assert.deepEqual(await protectedPairing(w,p),after,'terminal denial replay is protected-write free');
}
for(const whose of ['initiator','approver']) for(const lock of ['approver-session','account','identity','installation','device']) {
  it('approved redemption '+whose+' deadline across '+lock+' wait preserves the fixed refusal and ownership',async()=>{
    const p=await redemptionDeadlinePair(lock),sid=whose==='initiator'?p.actor.sid:p.account.sid;
    await w.admin.query("update auth.sessions set not_after=clock_timestamp()+interval '1 second' where id=$1",[sid]);
    const before=await protectedPairing(w,p),holder=await connect(w.database),caller=await connect(w.database);
    await holder.query('begin');
    if(lock==='approver-session') await holder.query('select 1 from auth.sessions where id=$1 for update',[p.account.sid]);
    if(lock==='account') await holder.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['fdb-account:'+p.account.uid]);
    if(lock==='identity') await holder.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['fdb-device-identity:'+p.actor.uid]);
    if(lock==='installation') await holder.query('select 1 from public.installations where id=$1 for update',[p.installationId]);
    if(lock==='device') await holder.query('select 1 from private.devices where id=$1 for update',[p.predecessor]);
    const pending=rpc(caller,p.actor.claims,'fdb_device_pair_poll',proofArgs(p));
    try {
      await waitUntilBlocked(w.admin,caller);
      assert.ok((await w.admin.query('select pg_blocking_pids($1) blockers',[caller.processID])).rows[0].blockers.includes(holder.processID));
      await waitForNaturalDeadline(sid);await holder.query('commit');
      await assertRedemptionDeadlineResult(p,whose,before,await pending);
    } finally {await holder.query('rollback');await pending;await holder.end();await caller.end();}
  });
}

// Test-only statement checkpoints also expose deadline passage inside writes AFTER the ordinary row-lock classes.
async function pauseRedemptionWrite(p,target,check) {
  const table=target==='device'?'private.devices':'private.device_pairing_audit';
  const holder=await connect(w.database),caller=await connect(w.database);
  await w.admin.query(`create function private.task2_pause_redemption_write() returns trigger language plpgsql as $$
    begin
      if TG_TABLE_NAME='device_pairing_audit' then
        if new.event<>TG_ARGV[0] then return new; end if;
      end if;
      perform pg_advisory_xact_lock(702003);return new;
    end $$`);
  const event=target==='deferred-audit'?'pairing_retry_deferred':'pairing_connected';
  await w.admin.query(`create trigger task2_pause_redemption_write before insert on ${table} for each row execute function private.task2_pause_redemption_write('${event}')`);
  await holder.query('begin');await holder.query('select pg_advisory_xact_lock(702003)');
  const pending=rpc(caller,p.actor.claims,'fdb_device_pair_poll',proofArgs(p));
  try {await waitUntilBlocked(w.admin,caller);await check(holder,pending);}
  finally {
    await holder.query('rollback');await pending;
    await w.admin.query(`drop trigger task2_pause_redemption_write on ${table}`);await w.admin.query('drop function private.task2_pause_redemption_write()');
    await holder.end();await caller.end();
  }
}
for(const whose of ['initiator','approver']) for(const target of ['owner','device','success-audit','deferred-audit']) {
  it('approved redemption '+whose+' deadline during '+target+' write rolls back owner/device effects before refusal',async()=>{
    const p=await redemptionDeadlinePair('identity'),sid=whose==='initiator'?p.actor.sid:p.account.sid;
    if(target==='deferred-audit') await w.admin.query("insert into public.installations(id,owner_user_id,schema_version,addon_version) select 'limit-install-'||$1::text||'-'||n,$1::uuid,0,'fixture' from generate_series(1,50) n",[p.account.uid]);
    await w.admin.query("update auth.sessions set not_after=clock_timestamp()+interval '1 second' where id=$1",[sid]);
    const before=await protectedPairing(w,p);
    const check=async(holder,pending)=>{
      await waitForNaturalDeadline(sid);await holder.query('commit');
      await assertRedemptionDeadlineResult(p,whose,before,await pending);
    };
    if(target==='owner') await pauseBeforeOwnerWrite(p,async(_contender,holder,pending)=>check(holder,pending));
    else await pauseRedemptionWrite(p,target,check);
  });
}
