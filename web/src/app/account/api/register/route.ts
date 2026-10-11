import { auth } from "@/lib/account/auth-client";
import { accountApi, guardMailRoute } from "@/lib/account/handler";
import { accountLog, failure, jsonResponse } from "@/lib/account/http";
import { INPUTS } from "@/lib/account/inputs";

export const dynamic = "force-dynamic";

/** Codes that describe the REQUEST (not the account), so reporting them reveals nothing about who is registered. */
const INPUT_CODES = new Set(["weak_password", "email_address_invalid", "validation_failed"]);

export const POST = accountApi({ route: "register", mutating: true, body: INPUTS.register }, async (c, body) => {
  const guard = await guardMailRoute(c, "register", body.email, body.turnstileToken);
  if ("response" in guard) return guard.response;
  if (!guard.exhausted) {
    const r = await auth.signUp(c.ac.cfg, { email: body.email, password: body.password }, c.ac.callbackUrl);
    if (!r.ok) {
      if (r.code === "weak_password") return failure(422, "weak_password");
      if (r.code && INPUT_CODES.has(r.code)) return failure(400, "invalid_input");
      // GoTrue answers "already registered / mail sent a moment ago" differently from a fresh sign-up. All of that, and
      // anything else that is a verdict about the ADDRESS, must look exactly like success.
      if (r.kind === "rate_limited" && r.code !== "over_email_send_rate_limit") return failure(429, "rate_limited", {}, { "Retry-After": "60" });
      if (r.kind === "unavailable") return failure(503, "temporarily_unavailable", {}, { "Retry-After": "30" });
      accountLog("register_auth_refused", { route: "register", status: r.status, code: r.code });
    }
  }
  // One answer for a new address, an existing one, an unconfirmed one and a throttled one.
  return jsonResponse({ ok: true, status: "check_email" }, 202);
});
