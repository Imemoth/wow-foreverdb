import type { NextRequest } from "next/server";
import { failure, jsonResponse } from "@/lib/account/http";
import { jarFrom } from "@/lib/account/session";
import { adminRuntime } from "@/lib/admin/runtime";
import { resolveAdminSession } from "@/lib/admin/session";

export const dynamic = "force-dynamic";
export async function GET(req:NextRequest) {
  const rt=adminRuntime();
  if(rt.state!=="ready") return failure(rt.state==="disabled"?404:503,"admin_unavailable");
  const r=await resolveAdminSession(rt.ac,jarFrom(()=>req.cookies.getAll()));
  return r.ok ? jsonResponse({ok:true}) : failure(401,"admin_denied");
}
