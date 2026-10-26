import { auth } from "@/lib/account/auth-client";
import { accountApi } from "@/lib/account/handler";
import { accountLog, failure, jsonResponse } from "@/lib/account/http";
import { INPUTS } from "@/lib/account/inputs";
import { clearResetPending, clearSession, resetPendingFor, resolveSession, writeSession } from "@/lib/account/session";

export const dynamic = "force-dynamic";

/**
 * Finishes a password reset whose session revocation was not confirmed (see ../route.ts): same recovery session, NO new password.
 * It works only for the browser that changed the password (sealed marker cookie for THIS account) and only with a live recovery
 * session, so it cannot be used to end sessions without a prior password change. It is reported as done only when Auth's answer is
 * confirmed. If the recovery session is already gone (the unanswered first attempt may have revoked it, or it expired), the person
 * requests a new link in the same browser and enters the same password.
 */
export const POST = accountApi({ route: "reset-revoke", mutating: true, body: INPUTS.logout }, async (c) => {
  const r = await resolveSession(c.ac.cfg, c.jar, c.ac.https, { kind: "recovery", canWrite: true });
  if (r.state === "unavailable") return failure(503, "temporarily_unavailable", {}, { "Retry-After": "30" });
  if (r.state !== "authenticated") {
    const res = failure(401, "recovery_required");
    if (r.state === "ended") clearSession(res.headers, c.ac.https);
    return res;
  }
  const keep = async <T extends Response>(res: T): Promise<T> => {
    if (r.rotated) await writeSession(c.ac.cfg.csrfSecret, res.headers, c.jar, c.ac.https, r.rotated);
    return res;
  };
  if (!(await resetPendingFor(c.ac.cfg.csrfSecret, c.jar, c.ac.https, r.user.id))) return keep(failure(409, "no_pending_reset"));
  const revoked = await auth.logoutAllAfterRecovery(c.ac.cfg, r.session.at);
  if (revoked === "confirmed") {
    const res = jsonResponse({ ok: true, sessionsRevoked: true, redirect: "/account/login?reason=password_reset" });
    clearSession(res.headers, c.ac.https);
    clearResetPending(res.headers, c.ac.https);
    return res;
  }
  accountLog("reset_revocation_incomplete", { route: "reset-revoke", kind: revoked });
  return keep(jsonResponse({ ok: false, error: "revocation_incomplete", sessionsRevoked: false, retryable: revoked !== "failed" }, 202));
});
