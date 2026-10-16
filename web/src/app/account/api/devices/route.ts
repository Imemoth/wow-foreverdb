import { accountApi } from "@/lib/account/handler";
import { jsonResponse } from "@/lib/account/http";
import { authenticate, guarded, readFailure, withSession } from "@/lib/account/private";
import { callWebRpc } from "@/lib/account/rpc-client";

export const dynamic = "force-dynamic";

/**
 * The devices registered to the signed-in account (database function `fdb_account_devices`, at most 50). Nothing is read from the
 * request. A device credential is never part of the answer (the database does not return one).
 */
export const GET = accountApi({ route: "devices", mutating: false }, async (c) => {
  const a = await authenticate(c, { read: true });
  if (!a.ok) return a.response;
  return guarded(c, a.auth, async () => {
    const out = await callWebRpc(c.ac.cfg, "fdb_account_devices", {}, a.auth.session.at);
    if (!out.ok) return withSession(c, a.auth, readFailure(out));
    return withSession(
      c,
      a.auth,
      jsonResponse({
        ok: true,
        devices: out.data.map((d) => ({
          deviceId: d.device_id,
          installationId: d.installation_id,
          label: d.label,
          status: d.status,
          createdAt: d.created_at,
          lastSeenAt: d.last_seen_at,
          revokedAt: d.revoked_at,
          revokedReason: d.revoked_reason,
        })),
      }),
    );
  });
});
