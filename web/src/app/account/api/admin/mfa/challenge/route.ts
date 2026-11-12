import { z } from "@/lib/zod";
import { auth } from "@/lib/account/auth-client";
import { accountApi } from "@/lib/account/handler";
import { failure, jsonResponse } from "@/lib/account/http";
import { withAdminAccount } from "@/lib/admin/account";

export const dynamic = "force-dynamic";
export const POST = accountApi({route:"admin_mfa_challenge",mutating: true,body:z.object({factorId:z.string().uuid()}).strict()}, async (c,body) =>
  withAdminAccount(c,"admin_challenge",async session => {
    const user = await auth.getUser(c.ac.cfg,session.at);
    if (!user.ok || !user.data.factors?.some(f => f.id === body.factorId && f.factor_type === "totp")) return failure(403,"factor_unavailable");
    const result = await auth.challengeTotp(c.ac.cfg,session.at,body.factorId);
    if (!result.ok) return failure(result.kind === "rate_limited" ? 429 : 503,"mfa_unavailable");
    return jsonResponse({ok:true,challengeId:result.data.id});
  }));
