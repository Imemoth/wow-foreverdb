import { auth } from "@/lib/account/auth-client";
import { accountApi } from "@/lib/account/handler";
import { accountLog, jsonResponse } from "@/lib/account/http";
import { INPUTS } from "@/lib/account/inputs";
import { clearSession, resolveSession } from "@/lib/account/session";
import { callAdminRpc } from "@/lib/account/rpc-client";
import { adminEnabled } from "@/lib/admin/runtime";
import { clearAdminSession } from "@/lib/admin/session";

export const dynamic = "force-dynamic";

/**
 * Ends THIS browser's session only: Auth `logout?scope=local` (pinned in the allowlist) revokes this one session row,
 * so a Companion signed in with the same account keeps working. The cookie is cleared (every chunk, every path)
 * whatever Auth answered; `revoked` tells the UI whether the server-side revocation was confirmed.
 */
export const POST = accountApi({ route: "logout", mutating: true, body: INPUTS.logout }, async (c) => {
  let revoked = false;
  const kind = c.stored?.k ?? "user";
  const r = await resolveSession(c.ac.cfg, c.jar, c.ac.https, { kind, canWrite: true });
  if (r.state === "authenticated") {
    if (adminEnabled(c.ac)) {
      // Deny this browser's Admin session before GoTrue revokes the Account
      // bearer; a failed Auth logout must not silently preserve Admin access.
      const denied = await callAdminRpc(c.ac.cfg,"fdb_admin_session_revoke",r.session.at);
      if (!denied.ok || !denied.data) accountLog("admin_revoke_not_confirmed",{route:"logout"});
    }
    const out = await auth.logout(c.ac.cfg, r.session.at);
    revoked = out.ok;
    if (!out.ok) accountLog("logout_not_confirmed", { route: "logout", status: out.status, code: out.code });
  } else if (r.state === "ended" || r.state === "anonymous") {
    revoked = true; // nothing alive to revoke
  }
  const res = jsonResponse({ ok: true, revoked });
  clearSession(res.headers, c.ac.https);
  if (adminEnabled(c.ac)) clearAdminSession(res.headers);
  return res;
});
