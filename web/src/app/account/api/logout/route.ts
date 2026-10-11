import { auth } from "@/lib/account/auth-client";
import { accountApi } from "@/lib/account/handler";
import { accountLog, jsonResponse } from "@/lib/account/http";
import { INPUTS } from "@/lib/account/inputs";
import { clearSession, resolveSession } from "@/lib/account/session";

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
    const out = await auth.logout(c.ac.cfg, r.session.at);
    revoked = out.ok;
    if (!out.ok) accountLog("logout_not_confirmed", { route: "logout", status: out.status, code: out.code });
  } else if (r.state === "ended" || r.state === "anonymous") {
    revoked = true; // nothing alive to revoke
  }
  const res = jsonResponse({ ok: true, revoked });
  clearSession(res.headers, c.ac.https);
  return res;
});
