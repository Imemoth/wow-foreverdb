import { auth } from "@/lib/account/auth-client";
import { safeNext } from "@/lib/account/contracts";
import { accountApi } from "@/lib/account/handler";
import { accountLog, failure, jsonResponse } from "@/lib/account/http";
import { INPUTS } from "@/lib/account/inputs";
import { chargeEmail } from "@/lib/account/limits";
import { acceptableUser, fromAuthSession, writeSession } from "@/lib/account/session";

export const dynamic = "force-dynamic";

export const POST = accountApi({ route: "login", mutating: true, body: INPUTS.login }, async (c, body) => {
  try {
    if ((await chargeEmail(c.ac.env, c.ac.cfg.csrfSecret, "login", body.email)) === "exhausted") {
      return failure(429, "too_many_attempts", {}, { "Retry-After": "300" });
    }
  } catch {
    return failure(503, "temporarily_unavailable", {}, { "Retry-After": "30" });
  }
  const r = await auth.passwordGrant(c.ac.cfg, { email: body.email, password: body.password });
  if (!r.ok) {
    if (r.kind === "rate_limited") return failure(429, "rate_limited", {}, { "Retry-After": "60" });
    if (r.kind === "unavailable") return failure(503, "temporarily_unavailable", {}, { "Retry-After": "30" });
    // Wrong password, unknown address AND unconfirmed address ("email_not_confirmed") are one answer: Auth's own
    // distinct codes would otherwise tell an attacker which addresses are registered.
    accountLog("login_refused", { route: "login", status: r.status, code: r.code });
    return failure(401, "invalid_credentials");
  }
  const now = Math.floor(Date.now() / 1000);
  const session = fromAuthSession(r.data, { kind: "user", now });
  if (!acceptableUser(r.data.user, session)) return failure(401, "invalid_credentials"); // anonymous / unverified: never a web session
  const res = jsonResponse({ ok: true, redirect: safeNext(body.next) });
  await writeSession(c.ac.cfg.csrfSecret, res.headers, c.jar, c.ac.https, session);
  return res;
});
