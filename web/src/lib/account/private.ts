import "server-only";
import type { NextResponse } from "next/server";
import { failure } from "./http";
import type { RpcFailure } from "./rpc-client";
import type { RouteContext } from "./handler";
import { clearSession, resolveSession, writeSession, type AccountUser, type StoredSession } from "./session";

/**
 * Identity resolution shared by every PRIVATE account handler (link, installations, Guildbook). Each request resolves its own
 * identity from scratch through the approved session resolver, which asks Auth (`GET /user`) with the stored access token:
 * a cookie alone, a CSRF token alone, or an earlier request never authorises anything. Only an ordinary, server-confirmed,
 * registered, e-mail-confirmed user passes: anonymous, expired, revoked, deleted, unconfirmed and recovery-only sessions do not.
 */
export interface PrivateAuth {
  user: AccountUser;
  /** The current web session (already rotated when a refresh was needed). Its access token is the ONLY identity used downstream. */
  session: StoredSession;
  rotated: StoredSession | null;
}

export async function authenticate(c: RouteContext, opts: { read?: boolean } = {}): Promise<{ ok: true; auth: PrivateAuth } | { ok: false; response: NextResponse }> {
  if (opts.read) {
    // Reads are GET/POST-without-side-effects; a browser still tells us when another site triggered the request.
    const site = c.req.headers.get("sec-fetch-site");
    if (site !== null && site !== "same-origin" && site !== "none") return { ok: false, response: failure(403, "forbidden") };
  }
  const r = await resolveSession(c.ac.cfg, c.jar, c.ac.https, { kind: "user", canWrite: true });
  if (r.state === "unavailable" || r.state === "needs_refresh") return { ok: false, response: failure(503, "temporarily_unavailable", {}, { "Retry-After": "30" }) };
  if (r.state === "anonymous" || r.state === "ended") {
    const res = failure(401, "unauthenticated");
    if (r.state === "ended") clearSession(res.headers, c.ac.https);
    return { ok: false, response: res };
  }
  return { ok: true, auth: { user: r.user, session: r.session, rotated: r.rotated } };
}

/** Persists a rotated session on the response (the refresh token it replaced is spent) and returns the response. */
export async function withSession(c: RouteContext, a: PrivateAuth, res: NextResponse): Promise<NextResponse> {
  if (a.rotated) await writeSession(c.ac.cfg.csrfSecret, res.headers, c.jar, c.ac.https, a.rotated);
  return res;
}

/** Maps a failed READ RPC to the HTTP answer. A lost reply of a read is simply "unavailable". */
export function readFailure(f: RpcFailure): NextResponse {
  switch (f.kind) {
    case "unauthenticated": return failure(401, "unauthenticated");
    case "forbidden": return failure(403, "forbidden");
    case "rate_limited": return failure(429, "rate_limited", {}, { "Retry-After": String(f.retryAfterSec) });
    case "bad_request": return failure(400, "invalid_input");
    default: return failure(503, "temporarily_unavailable", {}, { "Retry-After": "30" });
  }
}

/**
 * Runs the rest of a private handler; an exception after `authenticate` must not lose a refresh that already rotated the token
 * (the browser would keep the spent one and be signed out): the rotated session is persisted on the generic error answer too.
 */
export async function guarded(c: RouteContext, a: PrivateAuth, fn: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await fn();
  } catch {
    return withSession(c, a, failure(500, "internal_error"));
  }
}
