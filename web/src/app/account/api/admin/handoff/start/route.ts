import { z } from "@/lib/zod";
import { randomToken } from "@/lib/account/crypto";
import { accountApi } from "@/lib/account/handler";
import { failure, jsonResponse } from "@/lib/account/http";
import { callAdminRpc } from "@/lib/account/rpc-client";
import { withAdminAccount } from "@/lib/admin/account";

export const dynamic = "force-dynamic";
export const POST = accountApi({route:"admin_handoff_start",mutating: true,body:z.object({}).strict()}, async c =>
  withAdminAccount(c,"admin_handoff",async session => {
    const token = randomToken(32);
    const result = await callAdminRpc(c.ac.cfg,"fdb_admin_handoff_start",session.at,token);
    if (!result.ok || !result.data) return failure(403,"admin_denied");
    return jsonResponse({ok:true,token});
  }));
