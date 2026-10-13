import { accountApi } from "@/lib/account/handler";
import { accountLog, failure, jsonResponse } from "@/lib/account/http";
import { INPUTS } from "@/lib/account/inputs";
import { authenticate, guarded, mutationFailure, withSession } from "@/lib/account/private";
import { callWebRpc } from "@/lib/account/rpc-client";

export const dynamic = "force-dynamic";

/**
 * Revokes one of the signed-in account's devices (`fdb_account_device_revoke`, idempotent). The id is only a FILTER: the database
 * revokes it when it belongs to the caller's own verified session and otherwise answers `not_available` (409, nothing about other
 * accounts). A lost reply is an UNKNOWN outcome (502): the list page shows the real state.
 */
export const POST = accountApi({ route: "devices_revoke", mutating: true, body: INPUTS.deviceRevoke }, async (c, body) => {
  const a = await authenticate(c);
  if (!a.ok) return a.response;
  return guarded(c, a.auth, async () => {
    const out = await callWebRpc(c.ac.cfg, "fdb_account_device_revoke", { p_device_id: body.deviceId }, a.auth.session.at);
    if (!out.ok) {
      accountLog("device_revoke_failed", { route: "devices_revoke", kind: out.kind });
      return withSession(c, a.auth, mutationFailure(out, "/account/devices"));
    }
    if (!out.data.ok) return withSession(c, a.auth, failure(409, "not_available"));
    accountLog("device_revoked", { route: "devices_revoke", status: 200 });
    return withSession(c, a.auth, jsonResponse({ ok: true }));
  });
});
