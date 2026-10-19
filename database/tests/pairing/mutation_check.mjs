// Browser Pairing V1 mutation gate. Each mutant weakens one required control and must make its focused functional proof fail.
import {spawnSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {repoRoot} from "../account/harness.mjs";

const here=path.join(repoRoot,"database/tests/pairing");
const sources={
  migration:path.join(repoRoot,"database/migrations/0016_browser_pairing.sql"),
  rollback:path.join(repoRoot,"database/rollback/0016_rollback.sql"),
  restore:path.join(repoRoot,"database/restore/0016_browser_pairing_restore.sql"),
};
const text=Object.fromEntries(Object.entries(sources).map(([k,v])=>[k,fs.readFileSync(v,"utf8")]));
const sub=(from,to)=>(s)=>{if(!s.includes(from))throw new Error(`mutation target not found: ${from.slice(0,100)}`);return s.replace(from,to);};
const subAll=(from,to)=>(s)=>{if(!s.includes(from))throw new Error(`mutation target not found: ${from.slice(0,100)}`);return s.replaceAll(from,to);};
const M="0016_browser_pairing.sql",R="0016_rollback.sql",S="0016_browser_pairing_restore.sql";
const mutations=[
  ["feature gate removed","migration",sub("if not exists(select 1 from private.device_pairing_config where singleton and enabled) then","if false then"),"02_device_rpc.test.mjs","cancel, expiry and disabled gate"],
  ["FORCE RLS removed","migration",sub("alter table private.device_pairings force row level security;","-- mutant: FORCE RLS removed"),"01_schema.test.mjs","FORCE RLS"],
  ["anon receives pairing EXECUTE","migration",sub("to authenticated;\n\n-- Static SQL","to authenticated,anon;\n\n-- Static SQL"),"02_device_rpc.test.mjs","exact p_.*closed ACLs"],
  ["initiator exact-session comparison removed","migration",sub(" or v_pair.initiator_session_id is distinct from v_sid\n       or v_pair.poll_secret_hash","\n       or v_pair.poll_secret_hash"),"02_device_rpc.test.mjs","invalid locator/secret/UID/session"],
  ["approving refresh-token liveness removed","migration",s=>sub("perform 1 from auth.refresh_tokens where session_id=v_pair.approved_session_id and not revoked order by id for share nowait;","perform 1;")(sub("and exists(select 1 from auth.refresh_tokens r where r.session_id=s.id and not r.revoked)) then v_reason := 'approval_session_revoked';","and true) then v_reason := 'approval_session_revoked';")(sub("and exists(select 1 from auth.refresh_tokens r where r.session_id=s.id and not r.revoked) for share;","and true for share;")(s))),"03_redemption_concurrency.test.mjs","owner conflict, device collision, approving-session revocation"],
  ["ownership conflict predicate removed","migration",sub("elsif v_exists and v_owner is distinct from v_uid and v_owner is distinct from v_pair.approved_account_uid then v_reason := 'ownership_conflict';","elsif false then v_reason := 'ownership_conflict';"),"03_redemption_concurrency.test.mjs","owner conflict, device collision"],
  ["reenrollment predecessor reason predicate removed","migration",subAll("or v_prev.status<>'revoked' or v_prev.revoked_reason not in ('owner_revoked','credential_reuse','replaced')","or v_prev.status<>'revoked'"),"05_reenrollment_revocation.test.mjs","rechecks every predecessor predicate"],
  ["installation advisory lock removed","migration",sub("    perform pg_advisory_xact_lock(hashtextextended(p_installation_id,0));\n    perform pg_advisory_xact_lock(hashtextextended('fdb-pairing:'","    perform pg_advisory_xact_lock(hashtextextended('fdb-pairing:'"),"07_mixed_concurrency.test.mjs","pairing-start/ticket-enrollment"],
  ["pairing expiry check removed","migration",sub("    if v_pair.expires_at<=clock_timestamp() then\n        if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;","    if false then\n        if v_session_deadline<=clock_timestamp() then raise sqlstate 'PT401'; end if;"),"02_device_rpc.test.mjs","cancel, expiry and disabled gate"],
  ["poll secret proof removed","migration",sub("       or v_pair.poll_secret_hash is distinct from extensions.digest(p_poll_secret,'sha256') then","       then"),"02_device_rpc.test.mjs","invalid locator/secret/UID/session"],
  ["approval state predicate removed","migration",sub("    if v_pair.status<>'pending' then return jsonb_build_object('ok',false,'error','already_decided'); end if;","    if false then return jsonb_build_object('ok',false,'error','already_decided'); end if;"),"04_account_rpc.test.mjs","approval and denial enforce"],
  ["one-device-per-pairing unique index removed","migration",sub("create unique index devices_one_per_pairing on private.devices(pairing_id) where pairing_id is not null;","-- mutant: unique pairing provenance removed"),"01_schema.test.mjs","device provenance permits exactly one"],
  ["revocation trigger removed","migration",sub("create trigger devices_propagate_pairing_revocation after update of status on private.devices\nfor each row when (old.status is distinct from new.status and new.status='revoked')\nexecute function private.device_pairing_revocation_trigger();","-- mutant: revocation trigger removed"),"06_audit.test.mjs","revocation trigger is a closed"],
  ["audit reason bound removed","migration",sub("constraint device_pairing_audit_reason check (","constraint device_pairing_audit_reason check (true or"),"01_schema.test.mjs","audit has exactly"],
  ["rollback function-hash precondition removed","rollback",sub("if v_actual is distinct from v_hash then raise exception '0016 rollback pre-flight: function hash mismatch for %',v_sig; end if;","if false then raise exception '0016 rollback pre-flight: function hash mismatch for %',v_sig; end if;"),"08_rollback_restore.test.mjs","definition or schema hash drift"],
  ["restore retained-trigger precondition removed","restore",sub("if not ((v_schema=0 and not v_trigger and not v_column) or (v_schema=4 and v_trigger and v_column)) then","if not ((v_schema=0 and not v_trigger and not v_column) or (v_schema=4 and v_column)) then"),"08_rollback_restore.test.mjs","restore refuses a mixed retained schema"],
];

const only=process.argv.slice(2).join(" ");
let survived=0,total=0;
for(const [name,kind,mutate,test,pattern] of mutations){
  if(only&&!name.includes(only))continue;
  total++;
  const changed=mutate(text[kind]);
  if(changed===text[kind])throw new Error(`mutation did not change source: ${name}`);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"fdb-pairing-mutant-"));
  const target=path.join(dir,kind==="migration"?M:kind==="rollback"?R:S);
  fs.writeFileSync(target,changed,{mode:0o600,flag:"wx"});
  const env={...process.env};
  if(kind==="migration")env.FDB_PAIRING_MIGRATION=target;
  if(kind==="rollback")env.FDB_PAIRING_ROLLBACK=target;
  if(kind==="restore")env.FDB_PAIRING_RESTORE=target;
  const run=spawnSync(process.execPath,["--test","--test-concurrency=1",`--test-name-pattern=${pattern}`,path.join(here,test)],{cwd:repoRoot,env,encoding:"utf8",timeout:180000});
  fs.rmSync(dir,{recursive:true,force:true});
  if(run.status===0){survived++;console.log(`SURVIVED: ${name}`);}else console.log(`KILLED: ${name}`);
}
console.log(`\n${total-survived}/${total} mutants killed, ${survived} survived`);
process.exit(survived?1:0);
