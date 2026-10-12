import { auth } from "@/lib/account/auth-client";
import { accountApi } from "@/lib/account/handler";
import { accountLog, failure, jsonResponse } from "@/lib/account/http";
import { INPUTS } from "@/lib/account/inputs";
import { clearResetPending, clearSession, resetPendingFor, resolveSession, writeResetPending, writeSession } from "@/lib/account/session";

export const dynamic = "force-dynamic";

/**
 * Sets the new password inside the short-lived RECOVERY session, then ends EVERY session of the account (owner decision, PR E): a
 * previously issued web session (e.g. an attacker's), another browser and the registered Companion are all revoked, so the person
 * who just proved control of the address is the only one left. The anonymous Companion identity is a different Auth user and is untouched.
 *
 * A reset is reported as complete ONLY when the revocation is `confirmed`. If the password changed but the revocation failed or is
 * uncertain (timeout, 5xx, 429), the answer is 202 `revocation_incomplete`, the recovery session is KEPT (15 minutes) and a sealed marker
 * cookie records "this browser changed the password of this account"; the person retries through `POST /account/api/reset-password/revoke`
 * without choosing another password. If the recovery session is gone, a fresh link in the SAME browser accepts the identical password as
 * "already set" ONLY because of that marker. Without the marker an identical password is refused (422) and nothing is revoked: a
 * reset must never leave a possibly compromised password in place and call itself secure.
 */
export const POST = accountApi({ route: "reset", mutating: true, body: INPUTS.reset }, async (c, body) => {
  const r = await resolveSession(c.ac.cfg, c.jar, c.ac.https, { kind: "recovery", canWrite: true });
  if (r.state === "unavailable") return failure(503, "temporarily_unavailable", {}, { "Retry-After": "30" });
  if (r.state !== "authenticated") {
    const res = failure(401, "recovery_required");
    if (r.state === "ended") clearSession(res.headers, c.ac.https);
    return res;
  }
  // A refresh during this request spent the refresh token in the cookie: every answer that keeps the session persists the rotated one.
  const keep = async <T extends Response>(res: T): Promise<T> => {
    if (r.rotated) await writeSession(c.ac.cfg.csrfSecret, res.headers, c.jar, c.ac.https, r.rotated);
    return res;
  };
  const upd = await auth.updatePassword(c.ac.cfg, r.session.at, body.password);
  let passwordChanged = true;
  if (!upd.ok) {
    if (upd.code === "weak_password") return keep(failure(422, "weak_password"));
    if (upd.code === "same_password") {
      if (!(await resetPendingFor(c.ac.cfg.csrfSecret, c.jar, c.ac.https, r.user.id))) return keep(failure(422, "same_password"));
      passwordChanged = false; // an earlier reset in this browser already set it: finish the revocation
    } else {
      if (upd.kind === "unavailable" || upd.kind === "rate_limited") return keep(failure(503, "temporarily_unavailable", {}, { "Retry-After": "30" }));
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
    clearResetPending(res.headers, c.ac.https);
    return res;
  }
  // Never "complete": the recovery cookie stays so the person can finish without a second password update.
  accountLog("reset_revocation_incomplete", { route: "reset", kind: revoked });
  const res = jsonResponse({ ok: false, error: "revocation_incomplete", passwordChanged, sessionsRevoked: false, retryable: revoked !== "failed" }, 202);
  await writeResetPending(c.ac.cfg.csrfSecret, res.headers, c.ac.https, r.user.id);
  return keep(res);
});
