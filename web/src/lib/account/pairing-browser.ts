import "server-only";
import type { NextResponse } from "next/server";
import type { z } from "zod";
import { INPUTS } from "./inputs";
import type { RouteContext } from "./handler";
import { accountLog, failure, jsonResponse } from "./http";
import { clearPairingCookie, pairingCookieName, readPairingCookie, verifyPairingPageBinding } from "./pairing-cookie";
import { browserPairingWebAvailable } from "./pairing-gate";
import { authenticate, guarded, mutationFailure, withSession } from "./private";
import { callAccountPairingRpc } from "./rpc-client";

type Decision = "approve" | "deny";
type DecisionBody = z.infer<typeof INPUTS.pairingDecision>;

/** Shared closed implementation for the two decision routes; the route fixes the RPC name. */
export async function decidePairing(c: RouteContext, body: DecisionBody, decision: Decision): Promise<NextResponse> {
  if (!browserPairingWebAvailable(c.ac)) return failure(404, "not_found");
  const a = await authenticate(c);
  if (!a.ok) return a.response;
  return guarded(c, a.auth, async () => {
    const done = async (res: NextResponse, clear = false) => {
      const out = await withSession(c, a.auth, res);
      if (clear) clearPairingCookie(out.headers, c.ac.https);
      return out;
    };
    const raw = c.jar.get(pairingCookieName(c.ac.https));
    const locator = raw ? await readPairingCookie(c.ac.cfg.csrfSecret, raw) : null;
    if (!locator) return done(failure(409, "pairing_not_available"), true);
    // A stale tab must not delete the newer tab's valid selector. The mismatch is inert and the currently signed cookie survives.
    if (locator.id !== body.pairingId) return done(failure(409, "pairing_not_available"));
    if (!(await verifyPairingPageBinding(c.ac.cfg.csrfSecret, locator, a.auth.user.id, a.auth.session.sid, c.req.headers.get("x-fdb-pairing-page")))) {
      return done(failure(409, "account_changed"));
    }

    const rpc = decision === "approve" ? "fdb_account_device_pair_approve" : "fdb_account_device_pair_deny";
    const result = await callAccountPairingRpc(c.ac.cfg, rpc, { p_pairing_id: locator.id }, a.auth.session.at);
    if (!result.ok) {
      accountLog("pairing_decision_failed", { route: `pairing_${decision}`, kind: result.kind });
      return done(mutationFailure(result, "/account/device-pair"));
    }
    if (!result.data.ok) {
      const terminal = ["expired", "already_decided", "cannot_connect_to_this_account"].includes(result.data.error);
      const status = result.data.error === "rate_limited" ? 429
        : result.data.error === "unauthenticated" ? 401
        : result.data.error === "forbidden" ? 403
        : result.data.error === "feature_disabled" || result.data.error === "temporarily_unavailable" ? 503
        : 409;
      return done(failure(status, result.data.error, {}, status === 429 ? { "Retry-After": "60" } : {}), terminal);
    }
    accountLog("pairing_decided", { route: `pairing_${decision}`, status: 200, kind: result.data.state });
    return done(jsonResponse({ ok: true, state: result.data.state }), true);
  });
}
