import { auth } from "@/lib/account/auth-client";
import { accountApi } from "@/lib/account/handler";
import { accountLog, failure, jsonResponse } from "@/lib/account/http";
import { INPUTS } from "@/lib/account/inputs";
import { acceptableUser, fromAuthSession, writeSession } from "@/lib/account/session";

export const dynamic = "force-dynamic";

/**
 * The ONLY place a one-time e-mail token is consumed, and only by this explicit POST (the GET page /account/auth/confirm
 * has no side effect, so a mail scanner that prefetches the link cannot use the token up).
 */
export const POST = accountApi({ route: "confirm", mutating: true, body: INPUTS.confirm }, async (c, body) => {
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
  await writeSession(c.ac.cfg.csrfSecret, res.headers, c.jar, c.ac.https, session);
  return res;
});
