import "server-only";
import { z } from "zod";
import { auth, type AuthFailure, type AuthSession, type AuthUser } from "./auth-client";
import type { AccountAuthConfig } from "./config";
import { seal, unseal, unverifiedJwtPayload } from "./crypto";

/**
 * Server-managed web session (ADR-015).
 *
 * The browser holds ONE opaque cookie (`__Secure-fdb_acct` on https, `fdb_acct` on local http): the Auth session
 * (access + rotating refresh token) sealed with AES-256-GCM under a key derived from ACCOUNT_CSRF_SECRET, HttpOnly,
 * Secure, SameSite=Lax, Path=/account (so public pages and APIs never receive it), chunked only if it ever outgrows
 * one cookie. Browser JavaScript cannot read it, and even the cookie's owner sees only ciphertext.
 *
 * Nothing inside the cookie is trusted for authorization. Who the caller is comes from `resolveSession`, which asks
 * Auth (GET /user: signature + the session row still exists) with the stored access token, so a logout, a revocation
 * or a deleted user takes effect on the very next request. `getSession()`/cookie contents never authorize anything.
 */

export const SESSION_COOKIE_MAX_AGE_SEC = 14 * 24 * 3600; // sliding: renewed on every refresh
export const SESSION_ABSOLUTE_MAX_SEC = 30 * 24 * 3600; // hard cap: after this the user signs in again
export const RECOVERY_SESSION_MAX_SEC = 15 * 60;
const MAX_CHUNKS = 6;
const CHUNK_SIZE = 3300;
const REFRESH_SKEW_SEC = 15;
const REFRESH_LOOP_GUARD_SEC = 5;

export interface CookieJar {
  get(name: string): string | undefined;
}
export function jarFrom(all: () => { name: string; value: string }[]): CookieJar {
  return { get: (name) => all().find((c) => c.name === name)?.value };
}

export function cookieNames(https: boolean) {
  return { session: https ? "__Secure-fdb_acct" : "fdb_acct", csrf: https ? "__Secure-fdb_csrf" : "fdb_csrf" } as const;
}
const chunkName = (base: string, i: number) => (i === 0 ? base : `${base}.${i}`);
const aadFor = (base: string) => `fdb-acct-session-v1|${base}`;

const stored = z
  .object({
    v: z.literal(1),
    k: z.enum(["user", "recovery"]),
    /** The Auth user this session belongs to. A refresh that answers for a different user ends the session. */
    uid: z.string().regex(/^[0-9a-f-]{36}$/i),
    at: z.string().min(20),
    rt: z.string().min(10),
    ex: z.number().int(),
    sid: z.string().min(1).max(64),
    sc: z.number().int(),
    rf: z.number().int(),
  })
  .strict();
export type StoredSession = z.infer<typeof stored>;

export interface AccountUser {
  id: string;
  email: string;
  createdAt: string | null;
  lastSignInAt: string | null;
}

export function fromAuthSession(s: AuthSession, meta: { kind: "user" | "recovery"; sc?: number; now: number }): StoredSession {
  const claims = unverifiedJwtPayload(s.access_token);
  const exp = typeof claims?.exp === "number" ? claims.exp : s.expires_at ?? meta.now + s.expires_in;
  const sid = typeof claims?.session_id === "string" ? claims.session_id : "none";
  return { v: 1, k: meta.kind, uid: s.user.id, at: s.access_token, rt: s.refresh_token, ex: exp, sid, sc: meta.sc ?? meta.now, rf: meta.now };
}

export async function readSession(secret: string, jar: CookieJar, https: boolean): Promise<{ session: StoredSession | null; present: boolean }> {
  const base = cookieNames(https).session;
  const first = jar.get(base);
  if (first === undefined) return { session: null, present: false };
  let value = first;
  for (let i = 1; i < MAX_CHUNKS; i += 1) {
    const next = jar.get(chunkName(base, i));
    if (next === undefined) break;
    value += next;
  }
  const plain = await unseal(secret, value, aadFor(base));
  if (!plain) return { session: null, present: true };
  try {
    const parsed = stored.safeParse(JSON.parse(plain));
    return parsed.success ? { session: parsed.data, present: true } : { session: null, present: true };
  } catch {
    return { session: null, present: true };
  }
}

/** Anything with `append(name, value)`: a `Headers` object, i.e. `response.headers`. */
export interface CookieSink {
  append(name: string, value: string): void;
}

export interface CookieAttrs {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Lax" | "Strict";
  path: string;
  maxAge: number;
}

/**
 * Serialises one Set-Cookie header. Built by hand and appended to `response.headers` because the framework's cookie
 * helper is keyed by cookie NAME: two deletions of the same name on different paths (/account and /) would collapse into one.
 */
export function serializeCookie(name: string, value: string, a: CookieAttrs): string {
  const parts = [`${name}=${value}`, `Path=${a.path}`, `Max-Age=${Math.max(0, Math.floor(a.maxAge))}`];
  if (a.maxAge <= 0) parts.push("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  if (a.httpOnly) parts.push("HttpOnly");
  if (a.secure) parts.push("Secure");
  parts.push(`SameSite=${a.sameSite}`);
  return parts.join("; ");
}

export function setCookie(sink: CookieSink, name: string, value: string, a: CookieAttrs) {
  sink.append("Set-Cookie", serializeCookie(name, value, a));
}

export async function writeSession(secret: string, sink: CookieSink, jar: CookieJar, https: boolean, s: StoredSession): Promise<void> {
  const base = cookieNames(https).session;
  const sealed = await seal(secret, JSON.stringify(s), aadFor(base));
  const parts = sealed.match(new RegExp(`.{1,${CHUNK_SIZE}}`, "g")) ?? [sealed];
  if (parts.length > MAX_CHUNKS) throw new Error("session_cookie_too_large");
  const maxAge = s.k === "recovery" ? RECOVERY_SESSION_MAX_SEC : SESSION_COOKIE_MAX_AGE_SEC;
  parts.forEach((value, i) => setCookie(sink, chunkName(base, i), value, { httpOnly: true, secure: https, sameSite: "Lax", path: "/account", maxAge }));
  // Stale continuation chunks from an earlier, larger value must not linger (they would corrupt the next read).
  for (let i = parts.length; i < MAX_CHUNKS; i += 1) {
    if (jar.get(chunkName(base, i)) !== undefined) expire(sink, chunkName(base, i), https, "/account");
  }
}

function expire(sink: CookieSink, name: string, https: boolean, path: string) {
  setCookie(sink, name, "", { httpOnly: true, secure: https, sameSite: "Lax", path, maxAge: 0 });
}

/**
 * Deletes the session cookie and EVERY chunk, on the cookie's own path and on `/` (a cookie of the same name on
 * another path is a different cookie and would otherwise survive; nothing in the app sets one, so this is defence
 * against planted or legacy cookies). Deleting more than exists is harmless.
 */
export function clearSession(sink: CookieSink, https: boolean) {
  const base = cookieNames(https).session;
  for (const path of ["/account", "/"]) for (let i = 0; i < MAX_CHUNKS; i += 1) expire(sink, chunkName(base, i), https, path);
}

// -------------------------------------------------------------------------------------------------------------
// Password-reset marker: "this browser changed the password of <uid> but the session revocation was not confirmed"
// -------------------------------------------------------------------------------------------------------------

export const RESET_PENDING_MAX_AGE_SEC = 3600;
const resetPendingName = (https: boolean) => (https ? "__Secure-fdb_reset" : "fdb_reset");
const resetAad = (name: string) => `fdb-acct-reset-pending-v1|${name}`;

/** Sealed, HttpOnly, Path=/account: lets the SAME browser finish an incomplete reset (revoke endpoint, "same password" retry) and nothing else. */
export async function writeResetPending(secret: string, sink: CookieSink, https: boolean, uid: string, now = Math.floor(Date.now() / 1000)): Promise<void> {
  const name = resetPendingName(https);
  const sealed = await seal(secret, JSON.stringify({ uid: uid.toLowerCase(), exp: now + RESET_PENDING_MAX_AGE_SEC }), resetAad(name));
  setCookie(sink, name, sealed, { httpOnly: true, secure: https, sameSite: "Lax", path: "/account", maxAge: RESET_PENDING_MAX_AGE_SEC });
}
export async function resetPendingFor(secret: string, jar: CookieJar, https: boolean, uid: string, now = Math.floor(Date.now() / 1000)): Promise<boolean> {
  const name = resetPendingName(https);
  const v = jar.get(name);
  if (!v) return false;
  const plain = await unseal(secret, v, resetAad(name));
  if (!plain) return false;
  try {
    const p = JSON.parse(plain) as { uid?: unknown; exp?: unknown };
    return typeof p.uid === "string" && typeof p.exp === "number" && p.exp > now && p.uid === uid.toLowerCase();
  } catch {
    return false;
  }
}
export function clearResetPending(sink: CookieSink, https: boolean) {
  expire(sink, resetPendingName(https), https, "/account");
}

// -------------------------------------------------------------------------------------------------------------
// Resolution: stored session -> server-confirmed user (refreshing when needed)
// -------------------------------------------------------------------------------------------------------------

export type Resolved =
  /** No session cookie at all. */
  | { state: "anonymous" }
  /** Server-confirmed, verified, non-anonymous user. `rotated` is a fresh session the caller MUST persist (if it can). */
  | { state: "authenticated"; user: AccountUser; session: StoredSession; rotated: StoredSession | null }
  /** Pages cannot set cookies: send the browser through the refresh handler, which can. */
  | { state: "needs_refresh" }
  /** The session is dead or invalid (revoked, expired, tampered, wrong user). The caller clears the cookie. */
  | { state: "ended"; stale: StoredSession | null }
  /** Auth could not be reached. Nothing is cleared; the user is not logged out by an outage. */
  | { state: "unavailable" };

export interface ResolveOptions {
  kind: "user" | "recovery";
  /** True in route handlers (they can Set-Cookie); false in server components. */
  canWrite: boolean;
  now?: number;
}

export function acceptableUser(u: AuthUser, s: StoredSession): AccountUser | null {
  if (u.id.toLowerCase() !== s.uid.toLowerCase()) return null; // never a different account
  if (u.is_anonymous === true) return null; // anonymous (Companion-style) identities have no web account
  if (!u.email) return null;
  if (!(u.email_confirmed_at ?? u.confirmed_at)) return null; // unverified e-mail: no session, no access
  return { id: u.id, email: u.email, createdAt: u.created_at ?? null, lastSignInAt: u.last_sign_in_at ?? null };
}

export async function resolveSession(cfg: AccountAuthConfig, jar: CookieJar, https: boolean, opts: ResolveOptions): Promise<Resolved> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const { session: found, present } = await readSession(cfg.csrfSecret, jar, https);
  if (!present) return { state: "anonymous" };
  if (!found) return { state: "ended", stale: null };
  if (found.k !== opts.kind) return { state: "anonymous" };
  const maxAge = found.k === "recovery" ? RECOVERY_SESSION_MAX_SEC : SESSION_ABSOLUTE_MAX_SEC;
  if (now - found.sc > maxAge) return { state: "ended", stale: found };

  let s = found;
  let rotated: StoredSession | null = null;
  const refresh = async (): Promise<"ok" | "dead" | "transient"> => {
    const r = await auth.refresh(cfg, s.rt);
    if (!r.ok) return failureClass(r) === "dead" ? "dead" : "transient";
    if (r.data.user.id.toLowerCase() !== s.uid.toLowerCase()) return "dead"; // a refresh must never switch accounts
    s = fromAuthSession(r.data, { kind: s.k, sc: s.sc, now });
    rotated = s;
    return "ok";
  };
  const recentlyRefreshed = () => now - s.rf < REFRESH_LOOP_GUARD_SEC;

  if (s.ex - now <= REFRESH_SKEW_SEC) {
    if (!opts.canWrite && !recentlyRefreshed()) return { state: "needs_refresh" };
    if (opts.canWrite) {
      const r = await refresh();
      if (r === "dead") return { state: "ended", stale: found };
      if (r === "transient") return { state: "unavailable" };
    }
  }

  let u = await auth.getUser(cfg, s.at);
  if (!u.ok && failureClass(u) === "dead") {
    // The access token was refused (expired early, clock skew) or its session is gone. One refresh attempt decides which.
    if (opts.canWrite && rotated === null) {
      const r = await refresh();
      if (r === "dead") return { state: "ended", stale: found };
      if (r === "transient") return { state: "unavailable" };
      u = await auth.getUser(cfg, s.at);
    } else if (!opts.canWrite && !recentlyRefreshed()) {
      return { state: "needs_refresh" };
    }
  }
  if (!u.ok) return failureClass(u) === "dead" ? { state: "ended", stale: found } : { state: "unavailable" };
  const user = acceptableUser(u.data, s);
  if (!user) return { state: "ended", stale: found };
  return { state: "authenticated", user, session: s, rotated };
}

/**
 * `dead`: Auth answered with a refusal that says THIS credential or session is gone. Anything else (5xx, 429, an unknown or
 * code-less 4xx such as a rotated API key or a misconfiguration) is transient: it must never sign every user out at once.
 */
const DEAD_CODES = new Set([
  "refresh_token_not_found", "refresh_token_already_used", "session_not_found", "session_expired", "bad_jwt", "invalid_jwt", "no_authorization",
  "user_not_found", "user_banned",
]);
function failureClass(f: AuthFailure): "dead" | "transient" {
  return f.kind === "rejected" && f.code !== null && DEAD_CODES.has(f.code) ? "dead" : "transient";
}

/** True while a RECOVERY session cookie is within its lifetime (a presence check for pages; Auth is asked on the POST). */
export function recoverySessionActive(s: StoredSession | null, now = Math.floor(Date.now() / 1000)): boolean {
  return s?.k === "recovery" && now - s.sc <= RECOVERY_SESSION_MAX_SEC;
}
