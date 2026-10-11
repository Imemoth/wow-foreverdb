import { auth } from "@/lib/account/auth-client";
import { accountApi, revokeReplacedSession } from "@/lib/account/handler";
import { accountLog, failure, jsonResponse } from "@/lib/account/http";
import { INPUTS } from "@/lib/account/inputs";
import { acceptableUser, fromAuthSession, resolveSession, writeSession } from "@/lib/account/session";

export const dynamic = "force-dynamic";

/**
 * The ONLY place a one-time e-mail token is consumed, and only by this explicit POST (the GET page /account/auth/confirm
 * has no side effect, so a mail scanner that prefetches the link cannot use the token up).
 */
export const POST = accountApi({ route: "confirm", mutating: true, body: INPUTS.confirm }, async (c, body) => {
  // A one-time link is not bound to the browser that asked for it (it may be opened on another device), so it must never silently
  // REPLACE a live session: a phished link would otherwise sign the victim into the attacker's account. Sign out first.
  if (c.stored) {
    const current = await resolveSession(c.ac.cfg, c.jar, c.ac.https, { kind: c.stored.k, canWrite: false });
    if (current.state === "authenticated" || current.state === "needs_refresh") return failure(409, "already_signed_in");
  }
  const r = await auth.verify(c.ac.cfg, { type: body.type, token_hash: body.token_hash });
  if (!r.ok) {
    if (r.kind === "rate_limited") return failure(429, "rate_limited", {}, { "Retry-After": "60" });
    if (r.kind === "unavailable") return failure(503, "temporarily_unavailable", {}, { "Retry-After": "30" });
    accountLog("confirm_refused", { route: "confirm", status: r.status, code: r.code });
    return failure(400, "invalid_or_expired");
  }
  const kind = body.type === "recovery" ? "recovery" : "user";
  const session = fromAuthSession(r.data, { kind, now: Math.floor(Date.now() / 1000) });
  if (!acceptableUser(r.data.user, session)) return failure(400, "invalid_or_expired");
  const res = jsonResponse({ ok: true, kind, redirect: kind === "recovery" ? "/account/reset-password" : "/account?welcome=1" });
  await revokeReplacedSession(c);
  await writeSession(c.ac.cfg.csrfSecret, res.headers, c.jar, c.ac.https, session);
  return res;
});
