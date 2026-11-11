import type { NextRequest } from "next/server";
import { auth } from "@/lib/account/auth-client";
import { originAllowed } from "@/lib/account/csrf";
import { failure, jsonResponse } from "@/lib/account/http";
import { accountRuntime } from "@/lib/account/runtime";
import { jarFrom, resolveSession, writeSession } from "@/lib/account/session";
import { adminEnabled } from "@/lib/admin/runtime";

export const dynamic = "force-dynamic";
export async function GET(req:NextRequest) {
  const rt=accountRuntime();
  if(rt.state!=="ready" || !adminEnabled(rt.ctx)) return failure(404,"not_found");
  if (!originAllowed(req.headers,rt.ctx.siteOrigin)) return failure(403,"forbidden");
  const jar=jarFrom(()=>req.cookies.getAll());
  const r=await resolveSession(rt.ctx.cfg,jar,rt.ctx.https,{kind:"user",canWrite:true});
  if(r.state!=="authenticated") return failure(r.state==="unavailable"?503:401,"unauthenticated");
  const user=await auth.getUser(rt.ctx.cfg,r.session.at);
  if(!user.ok) {
    const res=failure(503,"mfa_unavailable");
    if(r.rotated) await writeSession(rt.ctx.cfg.csrfSecret,res.headers,jar,rt.ctx.https,r.rotated);
    return res;
  }
  const factors=(user.data.factors??[]).filter(f=>f.factor_type==="totp").map(f=>({id:f.id,status:f.status}));
  const res=jsonResponse({ok:true,factors});
  if(r.rotated) await writeSession(rt.ctx.cfg.csrfSecret,res.headers,jar,rt.ctx.https,r.rotated);
  return res;
}
