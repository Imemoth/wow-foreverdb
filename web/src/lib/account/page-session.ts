import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { AccountContext } from "./runtime";
import { accountRuntime } from "./runtime";
import { jarFrom, resolveSession, type AccountUser, type StoredSession } from "./session";

/**
 * Identity for PRIVATE account PAGES (server components). Same resolver as the APIs: Auth confirms the user on every render.
 * Pages cannot set cookies, so a session that needs a refresh or is dead goes through the refresh handler (which can), and a
 * visitor without a session goes to sign-in and comes back to `path` afterwards (an allowlisted pathname).
 */
export type PageUser =
  | { ok: true; ac: AccountContext; user: AccountUser; session: StoredSession }
  | { ok: false; reason: "disabled" | "unavailable" };

export async function requirePageUser(path: string): Promise<PageUser> {
  const rt = accountRuntime();
  if (rt.state !== "ready") return { ok: false, reason: "disabled" }; // the layout already rendered the disabled / unavailable state
  const ac = rt.ctx;
  const store = await cookies();
  const r = await resolveSession(ac.cfg, jarFrom(() => store.getAll()), ac.https, { kind: "user", canWrite: false });
  const next = encodeURIComponent(path);
  if (r.state === "anonymous") redirect(`/account/login?next=${next}`);
  if (r.state === "needs_refresh" || r.state === "ended") redirect(`/account/api/session/refresh?next=${next}`);
  if (r.state === "unavailable") return { ok: false, reason: "unavailable" };
  return { ok: true, ac, user: r.user, session: r.session };
}

export const refreshPath = (path: string) => `/account/api/session/refresh?next=${encodeURIComponent(path)}`;
