import { accountApi } from "@/lib/account/handler";
import { accountLog, failure, jsonResponse } from "@/lib/account/http";
import { INPUTS } from "@/lib/account/inputs";
import { authenticate, guarded, mutationFailure, withSession } from "@/lib/account/private";
import { callWebRpc } from "@/lib/account/rpc-client";

export const dynamic = "force-dynamic";

/**
 * Revokes one still-unused activation file of the signed-in account (`fdb_account_enrollment_ticket_revoke`). Only a pending ticket
 * of the caller can be revoked: unknown, foreign, used and already revoked tickets are ONE answer (409 `not_available`). The id is a
 * ticket ID (a public identifier), never the ticket secret, which the website does not keep. Lost reply: 502 outcome_unknown.
 */
export const POST = accountApi({ route: "enrollment_revoke", mutating: true, body: INPUTS.enrollmentRevoke }, async (c, body) => {
  const a = await authenticate(c);
  if (!a.ok) return a.response;
  return guarded(c, a.auth, async () => {
    const out = await callWebRpc(c.ac.cfg, "fdb_account_enrollment_ticket_revoke", { p_ticket_id: body.ticketId }, a.auth.session.at);
    if (!out.ok) {
      accountLog("ticket_revoke_failed", { route: "enrollment_revoke", kind: out.kind });
      return withSession(c, a.auth, mutationFailure(out, "/account/devices"));
    }
    if (!out.data.ok) return withSession(c, a.auth, failure(409, "not_available"));
    accountLog("ticket_revoked", { route: "enrollment_revoke", status: 200 });
    return withSession(c, a.auth, jsonResponse({ ok: true }));
  });
});
