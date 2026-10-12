import type { NextResponse } from "next/server";
import { normalizeClaimCode } from "@/lib/account/contracts";
import { accountApi } from "@/lib/account/handler";
import { accountLog, failure, jsonResponse } from "@/lib/account/http";
import { INPUTS } from "@/lib/account/inputs";
import { chargeAccount, chargeEmail } from "@/lib/account/limits";
import { authenticate, withSession } from "@/lib/account/private";
import { confirmPassword, recheckIdentity } from "@/lib/account/reauth";
import { callWebRpc } from "@/lib/account/rpc-client";

export const dynamic = "force-dynamic";

/**
 * Redeems an installation linking code for the signed-in account. Order matters and is pinned by tests:
 *
 *   1. approved wrapper: disabled/unavailable, signed CSRF + Origin + Fetch Metadata + JSON, strict bounded body;
 *   2. identity: server-confirmed registered user with a live web session (anonymous / recovery / expired / revoked: 401);
 *   3. code shape (local check only; nothing is sent anywhere for a malformed code);
 *   4. per-account password budget, then a FRESH password check against the same Auth project for the verified user's own
 *      e-mail, same immutable user id, temporary session revoked (reauth.ts). A CSRF token, a recent page load or a cookie is
 *      never accepted instead;
 *   5. the web identity is re-checked immediately before forwarding;
 *   6. per-account redemption budget, then the database RPC with the ORIGINAL web session's own access token.
 *
 * Database failures keep their meaning: invalid/expired/consumed/revoked/wrong-owner codes are ONE answer (422), the account
 * cap is a distinct, non-consuming answer (409), authentication failures are 401/403 (never "invalid code"), budgets are 429
 * with Retry-After, and a lost reply is an UNKNOWN outcome (502) that is never retried automatically. The code, the password,
 * both Auth sessions and the database error text are never logged or returned.
 */
export const POST = accountApi({ route: "link", mutating: true, body: INPUTS.link }, async (c, body) => {
  const a = await authenticate(c);
  if (!a.ok) return a.response;
  const { user, session } = a.auth;
  const done = (res: NextResponse) => withSession(c, a.auth, res);

  const code = normalizeClaimCode(body.code);
  if (!code) return done(failure(400, "invalid_code_format"));

  // Password guesses through this route are bounded twice: per verified ACCOUNT (any address) and by the SAME per-address sign-in
  // throttle the login route uses, so the two website paths share one pool of guesses instead of doubling it. Both fail closed.
  let reauthBudget;
  try {
    reauthBudget = await chargeAccount(c.ac.env, c.ac.cfg.csrfSecret, "reauth", user.id);
    if (reauthBudget.budget !== "exhausted" && (await chargeEmail(c.ac.env, c.ac.cfg.csrfSecret, "login", user.email)) === "exhausted") {
      reauthBudget = { budget: "exhausted" as const, retryAfterSec: 300 };
    }
  } catch {
    return done(failure(503, "temporarily_unavailable", {}, { "Retry-After": "30" }));
  }
  if (reauthBudget.budget === "exhausted") {
    return done(failure(429, "too_many_attempts", {}, { "Retry-After": String(reauthBudget.retryAfterSec) }));
  }

  const fresh = await confirmPassword(c.ac.cfg, user, body.password);
  if (!fresh.ok) {
    if (fresh.reason === "rate_limited") return done(failure(429, "rate_limited", {}, { "Retry-After": "60" }));
    if (fresh.reason === "unavailable") return done(failure(503, "temporarily_unavailable", {}, { "Retry-After": "30" }));
    accountLog("link_reauth_refused", { route: "link", kind: fresh.reason });
    // A wrong password (or, defensively, an identity mismatch) is the only thing the user is told: nothing about other accounts.
    return done(failure(401, "reauth_failed"));
  }

  // The web session must be the same live, confirmed, registered account right before the one-time call is made.
  const still = await recheckIdentity(c.ac.cfg, session);
  if (still === "unavailable") return done(failure(503, "temporarily_unavailable", {}, { "Retry-After": "30" }));
  if (still === "gone") return done(failure(401, "unauthenticated"));

  let linkBudget;
  try {
    linkBudget = await chargeAccount(c.ac.env, c.ac.cfg.csrfSecret, "link", user.id);
  } catch {
    return done(failure(503, "temporarily_unavailable", {}, { "Retry-After": "30" }));
  }
  if (linkBudget.budget === "exhausted") {
    return done(failure(429, "too_many_attempts", {}, { "Retry-After": String(linkBudget.retryAfterSec) }));
  }

  const out = await callWebRpc(c.ac.cfg, "fdb_account_claim_redeem", { p_code: code }, session.at);
  if (!out.ok) {
    accountLog("link_rpc_failed", { route: "link", kind: out.kind });
    switch (out.kind) {
      case "unauthenticated": return done(failure(401, "unauthenticated"));
      case "forbidden": return done(failure(403, "forbidden"));
      case "rate_limited": return done(failure(429, "rate_limited", {}, { "Retry-After": String(out.retryAfterSec) }));
      case "bad_request": return done(failure(400, "invalid_code_format"));
      case "unavailable": return done(failure(503, "temporarily_unavailable", {}, { "Retry-After": "30" }));
      case "unknown_outcome":
        return done(failure(502, "outcome_unknown", { reconcile: "/account/installations" }));
    }
  }
  if (!out.data.ok) {
    return out.data.error === "account_limit"
      ? done(failure(409, "account_limit"))
      : done(failure(422, "invalid_claim")); // invalid, expired, consumed, revoked, replaced and owner-mismatched: indistinguishable
  }
  accountLog("link_succeeded", { route: "link", status: 200 });
  return done(jsonResponse({ ok: true, installationId: out.data.installation_id, linkedAt: out.data.linked_at, reauthCleanup: fresh.cleanup }));
});
