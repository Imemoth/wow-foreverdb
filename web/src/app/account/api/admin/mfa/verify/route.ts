import { z } from "@/lib/zod";
import { auth } from "@/lib/account/auth-client";
import { accountApi } from "@/lib/account/handler";
import { failure, jsonResponse } from "@/lib/account/http";
import { chargeAccount } from "@/lib/account/limits";
import { unverifiedJwtPayload } from "@/lib/account/crypto";
import { acceptableUser, fromAuthSession, resolveSession, writeSession } from "@/lib/account/session";
import { adminEnabled } from "@/lib/admin/runtime";

export const dynamic = "force-dynamic";
export const POST = accountApi({route:"admin_mfa_verify",mutating: true,
  body:z.object({factorId:z.string().uuid(),challengeId:z.string().uuid(),code:z.string().regex(/^[0-9]{6}$/)}).strict()}, async (c,body) => {
  if (!adminEnabled(c.ac)) return failure(404,"not_found");
  const current = await resolveSession(c.ac.cfg,c.jar,c.ac.https,{kind:"user",canWrite:true});
  if (current.state !== "authenticated") return failure(current.state === "unavailable" ? 503 : 401,"unauthenticated");
  const deny = async (status:number,reason:string) => {
    const res=failure(status,reason);
    // resolveSession may already have rotated the Account refresh token.
    // A refused TOTP attempt must not strand the browser with the old pair.
    if (current.rotated) await writeSession(c.ac.cfg.csrfSecret,res.headers,c.jar,c.ac.https,current.rotated);
    return res;
  };
  try {
    if ((await chargeAccount(c.ac.env,c.ac.cfg.csrfSecret,"admin_verify",current.user.id)).budget === "exhausted")
      return deny(429,"too_many_attempts");
  } catch { return deny(503,"temporarily_unavailable"); }
  const user = await auth.getUser(c.ac.cfg,current.session.at);
  if (!user.ok || !user.data.factors?.some(f => f.id === body.factorId && f.factor_type === "totp")) return deny(403,"factor_unavailable");
  const result = await auth.verifyTotp(c.ac.cfg,current.session.at,body.factorId,body.challengeId,body.code);
  if (!result.ok) return deny(result.kind === "rejected" ? 403 : 503,"mfa_verification_failed");
  const next = fromAuthSession(result.data,{kind:"user",sc:current.session.sc,now:Math.floor(Date.now()/1000)});
  const claims = unverifiedJwtPayload(next.at);
  if (next.uid !== current.session.uid || next.sid !== current.session.sid || !acceptableUser(result.data.user,next)
    || claims?.aal !== "aal2" || claims.sub !== next.uid || claims.session_id !== next.sid
    || typeof claims.exp !== "number" || claims.exp <= Math.floor(Date.now()/1000)) return deny(403,"mfa_session_mismatch");
  // GoTrue has just returned this token pair after the one-time TOTP challenge.
  // Persist it as one sealed Account cookie; a second /user request here could
  // strand the browser with its now-rotated old refresh token during an outage.
  const res = jsonResponse({ok:true});
  await writeSession(c.ac.cfg.csrfSecret,res.headers,c.jar,c.ac.https,next);
  return res;
});
