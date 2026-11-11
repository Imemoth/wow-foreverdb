import { z } from "@/lib/zod";
import { accountApi } from "@/lib/account/handler";
import { failure, jsonResponse } from "@/lib/account/http";
import { callAdminRpc } from "@/lib/account/rpc-client";
import { withAdminAccount } from "@/lib/admin/account";
import { writeAdminSession } from "@/lib/admin/session";

export const dynamic = "force-dynamic";
export const POST = accountApi({route:"admin_handoff_complete",mutating: true,
  body:z.object({token:z.string().regex(/^[A-Za-z0-9_-]{43}$/)}).strict()}, async (c,body) =>
  withAdminAccount(c,"admin_handoff",async session => {
    const result = await callAdminRpc(c.ac.cfg,"fdb_admin_handoff_redeem",session.at,body.token);
    if (!result.ok || !result.data) return failure(403,"admin_denied");
    const res = jsonResponse({ok:true,redirect:"/admin"});
    if (!await writeAdminSession(c.ac,res.headers,session)) return failure(403,"admin_denied");
    return res;
  }));
