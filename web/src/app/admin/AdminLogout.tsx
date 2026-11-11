"use client";
import { useState } from "react";

export function AdminLogout() {
  const [busy,setBusy]=useState(false);
  return <button type="button" disabled={busy} onClick={async()=>{
    setBusy(true);
    try {
      const csrf=await fetch("/admin/api/csrf",{credentials:"same-origin",cache:"no-store"});
      const body=await csrf.json() as {token?:string};
      if(!csrf.ok || !body.token) return;
      const r=await fetch("/admin/api/logout",{method:"POST",credentials:"same-origin",cache:"no-store",
        headers:{"Content-Type":"application/json","x-fdb-csrf":body.token},body:"{}"});
      if(r.ok) window.location.assign("/account");
      else window.alert("Admin session revocation could not be confirmed. Sign out of your Account to revoke its Auth session.");
    } finally {setBusy(false);}
  }}>Leave Admin</button>;
}
