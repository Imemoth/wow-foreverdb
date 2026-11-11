import { z } from "@/lib/zod";
import { auth } from "@/lib/account/auth-client";
import { accountApi } from "@/lib/account/handler";
import { failure, jsonResponse } from "@/lib/account/http";
import { withAdminAccount } from "@/lib/admin/account";

export const dynamic = "force-dynamic";
export const POST = accountApi({route:"admin_mfa_enroll",mutating: true,body:z.object({}).strict()}, async c =>
  withAdminAccount(c,"admin_enroll",async session => {
    const user = await auth.getUser(c.ac.cfg,session.at);
    if (!user.ok) return failure(401,"unauthenticated");
    if (user.data.factors?.some(f => f.factor_type === "totp" && f.status === "verified")) return failure(409,"factor_exists");
    const result = await auth.enrollTotp(c.ac.cfg,session.at);
    if (!result.ok) return failure(result.kind === "rate_limited" ? 429 : 503,"mfa_unavailable");
    return jsonResponse({ok:true,factorId:result.data.id,qrCode:result.data.totp.qr_code,secret:result.data.totp.secret});
  }));
