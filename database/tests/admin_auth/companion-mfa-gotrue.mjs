// Real pinned GoTrue only. Tokens, factor secrets, codes, uid and sid are never printed.
import { createHmac, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const base=process.env.FDB_LOCAL_GOTRUE_URL;
assert.match(base??'',/^http:\/\/127\.0\.0\.1:[0-9]+$/);
const rest=process.env.FDB_LOCAL_REST_URL;
assert.match(rest??'',/^http:\/\/127\.0\.0\.1:[0-9]+$/);
const pgContainer=process.env.FDB_LOCAL_PG_CONTAINER;
const pgDatabase=process.env.FDB_LOCAL_PG_DATABASE;
assert.match(pgContainer??'',/^fdb_mfa_pg_[0-9]+$/);
assert.equal(pgDatabase,'fdb_mfa_it');
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const claimsOf=token=>JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString('utf8'));
function freshTotp(token) {
  const claims=claimsOf(token);
  assert.match(claims.sub,uuid);assert.match(claims.session_id,uuid);
  const query=`set role admin_executor; select admin_private.fresh_totp_session('${claims.sub}','${claims.session_id}');`;
  const result=execFileSync('docker',['exec','-i',pgContainer,'psql','-X','-At','-U','postgres','-d',pgDatabase],{input:query,encoding:'utf8'});
  return result.trim().split('\n').at(-1)==='t';
}
async function call(path,body,token,method='POST') {
  const res=await fetch(`${base}${path}`,{method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},
    body:body===undefined?undefined:JSON.stringify(body),redirect:'manual'});
  const data=await res.json().catch(()=>null);
  return {status:res.status,data};
}
const ok=(r,label)=>{assert.equal(r.status,200,`${label}: ${r.status}`);return r.data;};
function totp(secret) {
  const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits=0,acc=0,bytes=[];
  for(const c of secret.toUpperCase().replace(/=+$/,'')) {
    const n=alphabet.indexOf(c);assert(n>=0);acc=(acc<<5)|n;bits+=5;
    if(bits>=8){bits-=8;bytes.push((acc>>bits)&255);}
  }
  const counter=Buffer.alloc(8);counter.writeBigUInt64BE(BigInt(Math.floor(Date.now()/30000)));
  const h=createHmac('sha1',Buffer.from(bytes)).update(counter).digest();
  const offset=h[h.length-1]&15;
  return String((h.readUInt32BE(offset)&0x7fffffff)%1000000).padStart(6,'0');
}
const email=`admin-mfa-${randomUUID()}@example.invalid`;
const password='LocalTestPassword-12345!';
const first=ok(await call('/signup',{email,password}),'signup');
assert(first.access_token&&first.refresh_token&&first.user?.id);
const uid=first.user.id;
async function rpc(name,token,body={}) {
  const r=await fetch(`${rest}/rpc/${name}`,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body)});
  return {status:r.status,data:await r.json().catch(()=>null)};
}
const jwtParts=first.access_token.split('.');
assert.equal(jwtParts.length,3);
const forged=`${jwtParts[0]}.${jwtParts[1]}.${jwtParts[2][0]==='A'?'B':'A'}${jwtParts[2].slice(1)}`;
assert.equal((await rpc('fdb_admin_entry_ready',first.access_token)).data,false,'active deny-all');
assert.equal((await rpc('fdb_admin_handoff_start',first.access_token,{p_token:'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ'})).data,false,'no handoff under deny-all');
assert.equal((await rpc('fdb_admin_entry_ready',forged)).status,401,'forged JWT refused before SQL');
assert.notEqual((await rpc('fdb_admin_entry_ready',null)).status,200,'anonymous caller denied');
const hidden=await fetch(`${rest}/handoff_tokens`,{headers:{'accept-profile':'admin_private',authorization:`Bearer ${first.access_token}`}});
assert.notEqual(hidden.status,200,'private schema not exposed');
let web=first;
assert.equal(freshTotp(web.access_token),false,'AAL1 has no fresh TOTP proof');
let companion=ok(await call('/token?grant_type=password',{email,password}),'companion sign-in');
assert.equal(companion.user.id,uid);
const anonymous=ok(await call('/signup',{}),'anonymous sign-in');
assert.notEqual(anonymous.user.id,uid);
ok(await call('/user',undefined,companion.access_token,'GET'),'companion before MFA');
const enrolled=ok(await call('/factors',{factor_type:'totp',friendly_name:'AzerDex Admin',issuer:'AzerDex'},web.access_token),'TOTP enroll');
assert(enrolled.id&&enrolled.totp?.secret);
const afterEnrollUser=await call('/user',undefined,companion.access_token,'GET');
const afterEnrollRefresh=await call('/token?grant_type=refresh_token',{refresh_token:companion.refresh_token});
assert.equal(afterEnrollUser.status,200,'Companion continuity immediately after enrollment');
companion=ok(afterEnrollRefresh,'Companion refresh immediately after enrollment');
assert.equal(companion.user.id,uid);

async function stepUp(label) {
  const challenge=ok(await call(`/factors/${enrolled.id}/challenge`,{},web.access_token),`${label} challenge`);
  web=ok(await call(`/factors/${enrolled.id}/verify`,{challenge_id:challenge.id,code:totp(enrolled.totp.secret)},web.access_token),`${label} verify`);
  assert.equal(web.user.id,uid);
  assert.equal(freshTotp(web.access_token),true,`${label}: authoritative GoTrue AMR/factor proof missing`);
  const user=await call('/user',undefined,companion.access_token,'GET');
  const refresh=await call('/token?grant_type=refresh_token',{refresh_token:companion.refresh_token});
  const result={user:user.status,refresh:refresh.status};
  if(refresh.status===200) companion=refresh.data;
  return result;
}
const firstImpact=await stepUp('first');
const firstReauth=ok(await call('/token?grant_type=password',{email,password}),'companion reauthentication');
assert.equal(firstReauth.user.id,uid);
companion=firstReauth;
const repeatedImpact=await stepUp('repeated');
const repeatedReauth=ok(await call('/token?grant_type=password',{email,password}),'companion repeated reauthentication');
assert.equal(repeatedReauth.user.id,uid);
const anonAfter=await call('/user',undefined,anonymous.access_token,'GET');
assert.equal(anonAfter.status,200,'anonymous identity isolation');
console.log(JSON.stringify({firstImpact,repeatedImpact,registeredReauth:'same_uid',anonymousSession:'valid',
  afterEnrollment:{user:afterEnrollUser.status,refresh:afterEnrollRefresh.status},
  postgrest:'forged and anonymous denied; private schema hidden; active policy deny-all',
  note:'Pinned GoTrue/PostgREST evidence only; installation/Guildbook and hosted staging require separate regression evidence.'}));
