import "server-only";
import { auth, type AuthFailure } from "./auth-client";
import type { AccountAuthConfig } from "./config";
import { acceptableUser, type AccountUser, type StoredSession } from "./session";
import { accountLog } from "./http";

/**
 * Fresh-password re-confirmation and the identity re-check used before an installation claim is redeemed
 * (docs/account-v1/web-auth.md section 8, finding R-M1: a confirmation link alone must never authorise a transfer).
 *
 * Design: the password is verified by asking the SAME Auth project for a password grant for the VERIFIED account's e-mail
 * address (taken from the server-confirmed identity, never from the request). A password grant creates one more Auth session;
 * that TEMPORARY session is treated as radioactive waste:
 *
 *   - it is never written to a cookie, never returned to the browser, never used as the redemption identity;
 *   - it is validated once (`GET /user`) and must belong to the SAME immutable Auth user id, be confirmed and be non-anonymous;
 *   - it is then ended with `logout?scope=local` (pinned: this session only, never the user's other sessions), retried once;
 *   - if that revocation cannot be confirmed the result says so (`cleanup: "unconfirmed"`): it is logged by name and reported,
 *     never claimed as done. Its tokens are dropped when this function returns, so nobody holds them.
 *
 * The caller redeems with the ORIGINAL web session's own access token only.
 */
export type ReauthResult =
  | { ok: true; cleanup: "revoked" | "unconfirmed" }
  | { ok: false; reason: "wrong_password" | "rate_limited" | "unavailable" | "identity_mismatch" };

async function revokeTemporary(cfg: AccountAuthConfig, accessToken: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const out = await auth.logout(cfg, accessToken);
    if (out.ok) return true;
    // The session is already gone (e.g. concurrently revoked): that is a confirmed end, not a failure.
    if (out.kind === "rejected" && (out.code === "session_not_found" || out.code === "session_expired")) return true;
  }
  return false;
}

function failureReason(f: AuthFailure): "wrong_password" | "rate_limited" | "unavailable" {
  if (f.kind === "rate_limited") return "rate_limited";
  if (f.kind === "unavailable") return "unavailable";
  // Wrong password, unknown address and unconfirmed address are one answer (Auth's distinct codes would be an oracle).
  return "wrong_password";
}

export async function confirmPassword(cfg: AccountAuthConfig, current: AccountUser, password: string): Promise<ReauthResult> {
  const grant = await auth.passwordGrant(cfg, { email: current.email, password });
  if (!grant.ok) {
    // A 2xx whose body we could not parse may have CREATED a session nobody holds: say so by name (nothing to revoke without a token).
    if (grant.status >= 200 && grant.status < 300) accountLog("reauth_grant_unparseable", { route: "link", status: grant.status });
    return { ok: false, reason: failureReason(grant) };
  }

  const temp = grant.data;
  let verdict: "match" | "mismatch" | "unavailable" = "mismatch";
  // The grant's own answer already names a user; it must be the same immutable id. The independent `GET /user` below then
  // validates the temporary session server-side (signature + session row) and re-checks confirmation and anonymity.
  if (temp.user.id.toLowerCase() === current.id.toLowerCase()) {
    const check = await auth.getUser(cfg, temp.access_token);
    if (!check.ok) verdict = check.kind === "unavailable" ? "unavailable" : "mismatch";
    else {
      const probe: StoredSession = { v: 1, k: "user", uid: current.id, at: "", rt: "", ex: 0, sid: "", sc: 0, rf: 0 };
      const accepted = acceptableUser(check.data, probe);
      verdict = accepted && accepted.id.toLowerCase() === current.id.toLowerCase() ? "match" : "mismatch";
    }
  }

  const revoked = await revokeTemporary(cfg, temp.access_token);
  if (!revoked) accountLog("reauth_temp_session_not_revoked", { route: "link", kind: "unconfirmed" });

  if (verdict !== "match") return { ok: false, reason: verdict === "unavailable" ? "unavailable" : "identity_mismatch" };
  return { ok: true, cleanup: revoked ? "revoked" : "unconfirmed" };
}

/**
 * Re-asks Auth who the ORIGINAL web session is, immediately before the redemption is forwarded: the user must still be the
 * same confirmed, registered account and the session must still be alive (a logout, revocation or deletion that happened
 * while the password was being checked ends the request here).
 */
export async function recheckIdentity(
  cfg: AccountAuthConfig,
  session: StoredSession,
): Promise<"same" | "gone" | "unavailable"> {
  const u = await auth.getUser(cfg, session.at);
  if (!u.ok) return u.kind === "rejected" ? "gone" : "unavailable";
  return acceptableUser(u.data, session) ? "same" : "gone";
}
