"use client";
import { useEffect, useState } from "react";
import { getJson, postJson } from "@/lib/account/client";

type Factor = { id:string; status:string };
export function AdminEntry() {
  const [factors,setFactors]=useState<Factor[]>([]);
  const [factorId,setFactorId]=useState("");
  const [challengeId,setChallengeId]=useState("");
  const [secret,setSecret]=useState("");
  const [code,setCode]=useState("");
  const [notice,setNotice]=useState("");
  const [busy,setBusy]=useState(false);
  useEffect(()=>{void getJson("/account/api/admin/mfa/factors").then(r=>{
    if(r.status===200 && Array.isArray(r.data.factors)) setFactors(r.data.factors as Factor[]);
  });},[]);
  const enroll=async()=>{
    setBusy(true); setNotice("");
    try {
      const r=await postJson("/account/api/admin/mfa/enroll",{});
      if(r.status!==200 || typeof r.data.factorId!=="string" || typeof r.data.secret!=="string") {setNotice("TOTP enrollment unavailable.");return;}
      setFactorId(r.data.factorId);setSecret(r.data.secret);
      setNotice("Add this secret to an authenticator, then request a challenge.");
    } finally {setBusy(false);}
  };
  const challenge=async()=>{
    setBusy(true); setNotice("");
    try {
      const id=factorId||factors.find(f=>f.status==="verified")?.id;
      if(!id) {setNotice("Enroll a TOTP factor first.");return;}
      const r=await postJson("/account/api/admin/mfa/challenge",{factorId:id});
      if(r.status!==200 || typeof r.data.challengeId!=="string") {setNotice("Challenge unavailable.");return;}
      setFactorId(id);setChallengeId(r.data.challengeId);setNotice("Enter the current six-digit code.");
    } finally {setBusy(false);}
  };
  const verify=async()=>{
    setBusy(true);setNotice("");
    try {
      const v=await postJson("/account/api/admin/mfa/verify",{factorId,challengeId,code});
      setCode("");
      if(v.status!==200) {setNotice("TOTP verification failed.");return;}
      setSecret("");
      const start=await postJson("/account/api/admin/handoff/start",{});
      if(start.status!==200 || typeof start.data.token!=="string") {setNotice("Admin entry is not authorized by the active policy.");return;}
      const done=await postJson("/account/api/admin/handoff/complete",{token:start.data.token},{retryCsrf:false});
      if(done.status===200) window.location.assign("/admin");
      else setNotice("Admin handoff expired or was denied. Retry from your account.");
    } finally {setBusy(false);}
  };
  return <section className="panel space-y-3 p-6" aria-label="Admin authentication">
    <h2 className="panel-title text-xl">Admin authentication</h2>
    <p>Local development only. A verified factor and active staff policy are required for entry.</p>
    {factors.every(f=>f.status!=="verified") && <button type="button" disabled={busy} onClick={()=>void enroll()}>Enroll TOTP</button>}
    {secret && <p>Authenticator setup secret: <code>{secret}</code></p>}
    <button type="button" disabled={busy} onClick={()=>void challenge()}>Request TOTP challenge</button>
    {challengeId && <div><label htmlFor="admin-totp">Six-digit code</label>
      <input id="admin-totp" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
        value={code} onChange={e=>setCode(e.target.value.replace(/\D/g,"").slice(0,6))}/>
      <button type="button" disabled={busy||code.length!==6} onClick={()=>void verify()}>Verify and enter Admin</button></div>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
