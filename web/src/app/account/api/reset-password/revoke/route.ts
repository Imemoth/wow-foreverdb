import { auth } from "@/lib/account/auth-client";
import { accountApi } from "@/lib/account/handler";
import { accountLog, failure, jsonResponse } from "@/lib/account/http";
import { INPUTS } from "@/lib/account/inputs";
import { clearSession, resolveSession } from "@/lib/account/session";

export const dynamic = "force-dynamic";

/**
 * Finishes a password reset whose session revocation was not confirmed (see ../route.ts): same recovery session, NO new password.
 * Only a live recovery session (proof of control of the address within the last 15 minutes) can call it, it only ever ends sessions,
 * and it is reported as done only when Auth's answer is confirmed. If the recovery session is already gone (it may have been
 * revoked by the first, unanswered attempt, or it expired), the person is told to request a new link and enter the same password.
 */
export const POST = accountApi({ route: "reset-revoke", mutating: true, body: INPUTS.logout }, async (c) => {
  const r = await resolveSession(c.ac.cfg, c.jar, c.ac.https, { kind: "recovery", canWrite: true });
  if (r.state === "unavailable") return failure(503, "temporarily_unavailable", {}, { "Retry-After": "30" });
  if (r.state !== "authenticated") {
    const res = failure(401, "recovery_required");
    if (r.state === "ended") clearSession(res.headers, c.ac.https);
    return res;
  }
  const revoked = await auth.logoutAllAfterRecovery(c.ac.cfg, r.session.at);
  if (revoked === "confirmed") {
    const res = jsonResponse({ ok: true, sessionsRevoked: true, redirect: "/account/login?reason=password_reset" });
    clearSession(res.headers, c.ac.https);
    return res;
  }
  accountLog("reset_revocation_incomplete", { route: "reset-revoke", kind: revoked });
  return jsonResponse({ ok: false, error: "revocation_incomplete", sessionsRevoked: false, retryable: revoked !== "failed" }, 202);
});
