import {after,before,beforeEach,it} from 'node:test';
import assert from 'node:assert/strict';
import {makePairingWorld,startPairing,pairingInput,due,pairRow} from './world.mjs';
let w;
before(async()=>{w=await makePairingWorld();});after(async()=>{await w?.close();});beforeEach(async()=>{await w.fx.resetBudgets();});

async function connect(actor,account,input={}){const p=await startPairing(w,actor,pairingInput(input));assert.deepEqual(await account.call('fdb_account_device_pair_approve',[p.id]),{ok:true,state:'approved'});await due(w,p);return {p,out:await actor.call('fdb_device_pair_poll',[p.id,p.secret])};}

it('connects a missing installation and an anonymous-owned installation under Account V1 owner authority',async()=>{
  for(const existing of [false,true]){const d=await w.device(),a=await w.account(),input={};if(existing){input.installationId=pairingInput().installationId;await w.fx.installation(input.installationId,d.uid);}
    const {p,out}=await connect(d,a,input);assert.deepEqual(out,{ok:true,state:'connected',deviceId:p.deviceId});assert.equal(await w.fx.owner(p.installationId),a.uid);
    const dev=await w.device_row(p.deviceId);assert.equal(dev.account_uid,a.uid);assert.equal(dev.auth_uid,d.uid);assert.equal(dev.pairing_id,p.id);assert.equal(dev.ticket_id,null);
  }
});

it('controlled re-enrollment accepts each allowed latest predecessor reason and inserts a fresh device',async()=>{
  for(const reason of ['owner_revoked','credential_reuse','replaced']){const a=await w.account(),d=await w.device(),e=await w.enrolled(a,{device:d});
    await w.admin.query("update private.devices set status='revoked',revoked_at=clock_timestamp(),revoked_reason=$2 where id=$1",[e.deviceId,reason]);
    const {p,out}=await connect(d,a,{installationId:e.installationId});assert.equal(out.state,'connected');assert.notEqual(p.deviceId,e.deviceId);
    const old=await w.device_row(e.deviceId),fresh=await w.device_row(p.deviceId);assert.equal(old.status,'revoked');assert.equal(old.revoked_reason,reason);assert.equal(fresh.status,'active');
  }
});

it('rechecks every predecessor predicate at redemption and refuses each one-field mutant without owner/device change',async()=>{
  for(const mutation of ['active','wrong-installation','wrong-account','wrong-initiator','disallowed','stale']){const a=await w.account(),d=await w.device(),e=await w.enrolled(a,{device:d});await a.call('fdb_account_device_revoke',[e.deviceId]);
    const p=await startPairing(w,d,pairingInput({installationId:e.installationId}));assert.deepEqual(await a.call('fdb_account_device_pair_approve',[p.id]),{ok:true,state:'approved'});
    if(mutation==='active') await w.admin.query("update private.devices set status='active',revoked_at=null,revoked_reason=null where id=$1",[e.deviceId]);
    if(mutation==='wrong-installation') {const other=pairingInput().installationId;await w.fx.installation(other,a.uid);await w.admin.query("update private.devices set installation_id=$2 where id=$1",[e.deviceId,other]);}
    if(mutation==='wrong-account') await w.admin.query('update private.devices set account_uid=$2 where id=$1',[e.deviceId,(await w.account()).uid]);
    if(mutation==='wrong-initiator') await w.admin.query('update private.devices set auth_uid=$2 where id=$1',[e.deviceId,(await w.device()).uid]);
    if(mutation==='disallowed') await w.admin.query("update private.devices set revoked_reason='ticket_revoked' where id=$1",[e.deviceId]);
    if(mutation==='stale'){const newer=await w.device(),t=await w.ticket(a);const replacement=await w.enroll(newer,t.ticket,e.installationId);await a.call('fdb_account_device_revoke',[replacement.device_id]);}
    await due(w,p);const owner=await w.fx.owner(e.installationId),count=(await w.row("select count(*)::int n from private.devices where installation_id=$1",[e.installationId]))[0].n;
    const out=await d.call('fdb_device_pair_poll',[p.id,p.secret]);assert.deepEqual(out,{ok:true,state:'denied'},mutation);assert.equal(await w.fx.owner(e.installationId),owner);assert.equal((await w.row("select count(*)::int n from private.devices where installation_id=$1",[e.installationId]))[0].n,count);assert.equal((await pairRow(w,p)).denied_reason,'reenrollment_conflict');
  }
});
