import type { NextRequest } from "next/server";
import { CSRF_TTL_SEC, currentOrNewCsrf } from "@/lib/account/csrf";
import { failure, jsonResponse } from "@/lib/account/http";
import { jarFrom, setCookie } from "@/lib/account/session";
import { adminRuntime } from "@/lib/admin/runtime";
import { adminCsrfCookie, resolveAdminSession } from "@/lib/admin/session";

export const dynamic = "force-dynamic";
export async function GET(req:NextRequest) {
  const rt=adminRuntime();
  if(rt.state!=="ready") return failure(404,"not_found");
  if(req.headers.get("sec-fetch-site") && req.headers.get("sec-fetch-site")!=="same-origin") return failure(403,"forbidden");
  const jar=jarFrom(()=>req.cookies.getAll());
  const r=await resolveAdminSession(rt.ac,jar);
  if(!r.ok) return failure(401,"admin_denied");
  const token=await currentOrNewCsrf(rt.ac.cfg.csrfSecret,jar.get(adminCsrfCookie),`admin:${r.sid}`);
  const res=jsonResponse({ok:true,token});
  setCookie(res.headers,adminCsrfCookie,token,{httpOnly:true,secure:true,sameSite:"Strict",path:"/admin",maxAge:CSRF_TTL_SEC});
  return res;
}
