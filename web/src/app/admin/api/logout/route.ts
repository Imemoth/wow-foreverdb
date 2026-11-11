import type { NextRequest } from "next/server";
import { checkCsrf, originAllowed } from "@/lib/account/csrf";
import { timingSafeEqualStr } from "@/lib/account/crypto";
import { failure, jsonResponse } from "@/lib/account/http";
import { jarFrom } from "@/lib/account/session";
import { callAdminRpc } from "@/lib/account/rpc-client";
import { adminRuntime } from "@/lib/admin/runtime";
import { adminCsrfCookie, clearAdminSession, readAdminSession } from "@/lib/admin/session";

export const dynamic = "force-dynamic";
export async function POST(req:NextRequest) {
  const rt=adminRuntime();
  if(rt.state!=="ready") return failure(404,"not_found");
  const jar=jarFrom(()=>req.cookies.getAll());
  const s=await readAdminSession(rt.ac,jar);
  if(!s) return failure(401,"admin_denied");
  const header=req.headers.get("x-fdb-csrf")??"";
  const cookie=jar.get(adminCsrfCookie)??"";
  if(!originAllowed(req.headers,rt.ac.siteOrigin)
    || !(req.headers.get("content-type")??"").toLowerCase().startsWith("application/json")
    || !header || !cookie || !timingSafeEqualStr(header,cookie)
    || !await checkCsrf(rt.ac.cfg.csrfSecret,header,`admin:${s.sid}`)) return failure(403,"csrf");
  // Revoke only this Admin session in the private ledger. The underlying
  // Website and Companion Auth sessions are deliberately not logged out here.
  const revoked=await callAdminRpc(rt.ac.cfg,"fdb_admin_session_revoke",s.at);
  const confirmed=revoked.ok && revoked.data;
  const res=jsonResponse({ok:confirmed,revoked:confirmed},confirmed?200:503);
  clearAdminSession(res.headers);
  return res;
}
