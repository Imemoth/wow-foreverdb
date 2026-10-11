import { auth } from "@/lib/account/auth-client";
import { accountApi } from "@/lib/account/handler";
import { accountLog, failure, jsonResponse } from "@/lib/account/http";
import { INPUTS } from "@/lib/account/inputs";
import { clearSession, resolveSession } from "@/lib/account/session";

export const dynamic = "force-dynamic";

/** Sets the new password inside the short-lived RECOVERY session, then ends that session: the user signs in afresh. */
export const POST = accountApi({ route: "reset", mutating: true, body: INPUTS.reset }, async (c, body) => {
  const r = await resolveSession(c.ac.cfg, c.jar, c.ac.https, { kind: "recovery", canWrite: true });
  if (r.state === "unavailable") return failure(503, "temporarily_unavailable", {}, { "Retry-After": "30" });
  if (r.state !== "authenticated") {
    const res = failure(401, "recovery_required");
    if (r.state === "ended") clearSession(res.headers, c.ac.https);
    return res;
  }
  const upd = await auth.updatePassword(c.ac.cfg, r.session.at, body.password);
  if (!upd.ok) {
    if (upd.code === "same_password") return failure(422, "same_password");
    if (upd.code === "weak_password") return failure(422, "weak_password");
    if (upd.kind === "unavailable" || upd.kind === "rate_limited") return failure(503, "temporarily_unavailable", {}, { "Retry-After": "30" });
    accountLog("reset_refused", { route: "reset", status: upd.status, code: upd.code });
    const res = failure(401, "recovery_required");
    clearSession(res.headers, c.ac.https);
    return res;
  }
  await auth.logout(c.ac.cfg, r.session.at); // revokes only this recovery session (scope=local)
  const res = jsonResponse({ ok: true, redirect: "/account/login?reason=password_reset" });
  clearSession(res.headers, c.ac.https);
  return res;
});

