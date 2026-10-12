import { auth } from "@/lib/account/auth-client";
import { accountApi } from "@/lib/account/handler";
import { accountLog, failure, jsonResponse } from "@/lib/account/http";
import { INPUTS } from "@/lib/account/inputs";
import { clearSession, resolveSession } from "@/lib/account/session";

export const dynamic = "force-dynamic";

/**
 * Sets the new password inside the short-lived RECOVERY session, then ends EVERY session of the account (owner decision, PR E): a
 * previously issued web session (e.g. an attacker's), another browser and the registered Companion are all revoked, so the person
 * who just proved control of the address is the only one left. The anonymous Companion identity is a different Auth user and is untouched.
 *
 * A reset is reported as complete ONLY when the revocation is `confirmed`. If the password changed but the revocation failed or is
 * uncertain (timeout, 5xx, 429), the answer is 202 `revocation_incomplete`, the recovery session is KEPT (15 minutes) and the person
 * retries through `POST /account/api/reset-password/revoke` without choosing another password. An identical password is accepted as
 * "already set" so the same flow also works from a fresh recovery link after the first session expired.
 */
export const POST = accountApi({ route: "reset", mutating: true, body: INPUTS.reset }, async (c, body) => {
  const r = await resolveSession(c.ac.cfg, c.jar, c.ac.https, { kind: "recovery", canWrite: true });
  if (r.state === "unavailable") return failure(503, "temporarily_unavailable", {}, { "Retry-After": "30" });
  if (r.state !== "authenticated") {
    const res = failure(401, "recovery_required");
    if (r.state === "ended") clearSession(res.headers, c.ac.https);
    return res;
  }
  const upd = await auth.updatePassword(c.ac.cfg, r.session.at, body.password);
  let passwordChanged = true;
  if (!upd.ok) {
    if (upd.code === "weak_password") return failure(422, "weak_password");
    if (upd.code === "same_password") passwordChanged = false; // already this password (e.g. a retry): still finish the revocation
    else {
      if (upd.kind === "unavailable" || upd.kind === "rate_limited") return failure(503, "temporarily_unavailable", {}, { "Retry-After": "30" });
      accountLog("reset_refused", { route: "reset", status: upd.status, code: upd.code });
      const res = failure(401, "recovery_required");
      clearSession(res.headers, c.ac.https);
      return res;
    }
  }
  const revoked = await auth.logoutAllAfterRecovery(c.ac.cfg, r.session.at);
  if (revoked === "confirmed") {
    const res = jsonResponse({ ok: true, passwordChanged, sessionsRevoked: true, redirect: "/account/login?reason=password_reset" });
    clearSession(res.headers, c.ac.https);
    return res;
  }
  // Never "complete": the recovery cookie stays so the person can finish without a second password update.
  accountLog("reset_revocation_incomplete", { route: "reset", kind: revoked });
  return jsonResponse({ ok: false, error: "revocation_incomplete", passwordChanged, sessionsRevoked: false, retryable: true }, 202);
});
