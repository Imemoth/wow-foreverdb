import { auth } from "@/lib/account/auth-client";
import { accountApi, guardMailRoute } from "@/lib/account/handler";
import { accountLog, failure, jsonResponse } from "@/lib/account/http";
import { INPUTS } from "@/lib/account/inputs";

export const dynamic = "force-dynamic";

export const POST = accountApi({ route: "forgot", mutating: true, body: INPUTS.forgot }, async (c, body) => {
  const guard = await guardMailRoute(c, "recover", body.email, body.turnstileToken);
  if ("response" in guard) return guard.response;
  if (!guard.exhausted) {
    const r = await auth.recover(c.ac.cfg, { email: body.email }, c.ac.callbackUrl);
    if (!r.ok) {
      if (r.kind === "rate_limited" && r.code !== "over_email_send_rate_limit") return failure(429, "rate_limited", {}, { "Retry-After": "60" });
      if (r.kind === "unavailable") return failure(503, "temporarily_unavailable", {}, { "Retry-After": "30" });
      accountLog("recover_auth_refused", { route: "forgot", status: r.status, code: r.code });
    }
  }
  return jsonResponse({ ok: true, status: "check_email" }, 202);
});
