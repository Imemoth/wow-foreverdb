import { auth } from "@/lib/account/auth-client";
import { accountApi, guardMailRoute, padMailRoute } from "@/lib/account/handler";
import { accountLog, failure, jsonResponse } from "@/lib/account/http";
import { INPUTS } from "@/lib/account/inputs";

export const dynamic = "force-dynamic";

export const POST = accountApi({ route: "forgot", mutating: true, body: INPUTS.forgot }, async (c, body) => {
  const startedAt = Date.now();
  const guard = await guardMailRoute(c, "recover", body.email, body.turnstileToken);
  if ("response" in guard) return guard.response;
  if (!guard.exhausted) {
    const r = await auth.recover(c.ac.cfg, { email: body.email }, c.ac.callbackUrl);
    if (!r.ok) {
      if (r.kind === "rate_limited" && r.code !== "over_email_send_rate_limit") return failure(429, "rate_limited", {}, { "Retry-After": "60" });
      // A 5xx may mean "the mail could not be sent for THIS address": that must not be distinguishable. Only an unreachable Auth
      // (no answer at all) is independent of the address and reported.
      if (r.kind === "unavailable" && r.status === 0) return failure(503, "temporarily_unavailable", {}, { "Retry-After": "30" });
      accountLog("recover_auth_refused", { route: "forgot", status: r.status, code: r.code });
    }
  }
  await padMailRoute(startedAt);
  return jsonResponse({ ok: true, status: "check_email" }, 202);
});
