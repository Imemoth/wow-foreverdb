import "server-only";
import { hmacB64, randomToken, timingSafeEqualStr } from "./crypto";
import type { CookieJar, StoredSession } from "./session";

/**
 * Signed CSRF protocol (docs/account-v1/architecture.md section 5).
 *
 * A state-changing request is accepted only if ALL of these hold:
 *   1. `Origin` equals the site origin exactly, and `Sec-Fetch-Site` (when the browser sends it) is `same-origin`;
 *      a request carrying neither header is refused;
 *   2. the body is JSON (a cross-site <form> cannot send that without a CORS preflight, which is never granted);
 *   3. the token in the `x-fdb-csrf` header equals the token in the HttpOnly `SameSite=Strict` CSRF cookie;
 *   4. that token carries a valid HMAC (key derived from ACCOUNT_CSRF_SECRET) over nonce, expiry and a BINDING: the
 *      web session id once signed in, `anon` before (this covers login and registration, i.e. login CSRF).
 * The HMAC matters because a path-scoped cookie cannot use the `__Host-` prefix: a sibling subdomain could plant a plain
 * double-submit value, but it cannot forge a MAC.
 */
export const CSRF_HEADER = "x-fdb-csrf";
export const CSRF_TTL_SEC = 3600;
const REUSE_MIN_REMAINING_SEC = 600;

export function csrfBinding(session: StoredSession | null): string {
  return session ? `s:${session.sid}` : "anon";
}

export async function mintCsrf(secret: string, binding: string, now = Math.floor(Date.now() / 1000)): Promise<string> {
  const nonce = randomToken(16);
  const exp = now + CSRF_TTL_SEC;
  return `v1.${nonce}.${exp}.${await hmacB64(secret, "csrf-mac", `v1|${binding}|${nonce}|${exp}`)}`;
}

/** Validates the token itself; returns its expiry when valid, or null. */
export async function checkCsrf(secret: string, token: string | undefined, binding: string, now = Math.floor(Date.now() / 1000)): Promise<{ exp: number } | null> {
  if (!token || token.length > 256) return null;
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  const [, nonce, expStr, mac] = parts as [string, string, string, string];
  if (!/^[A-Za-z0-9_-]{16,32}$/.test(nonce) || !/^\d{1,12}$/.test(expStr)) return null;
  const exp = Number(expStr);
  if (exp < now) return null;
  const expected = await hmacB64(secret, "csrf-mac", `v1|${binding}|${nonce}|${exp}`);
  return timingSafeEqualStr(mac, expected) ? { exp } : null;
}

/** A still-valid cookie token is reused so several open tabs keep agreeing on one token. */
export async function currentOrNewCsrf(secret: string, existing: string | undefined, binding: string, now = Math.floor(Date.now() / 1000)): Promise<string> {
  const ok = await checkCsrf(secret, existing, binding, now);
  if (existing && ok && ok.exp - now > REUSE_MIN_REMAINING_SEC) return existing;
  return mintCsrf(secret, binding, now);
}

export function originAllowed(headers: Headers, siteOrigin: string): boolean {
  const origin = headers.get("origin");
  const site = headers.get("sec-fetch-site");
  if (origin !== null && origin !== siteOrigin) return false;
  if (site !== null && site !== "same-origin") return false;
  return origin !== null || site !== null;
}

export type CsrfVerdict = "ok" | "origin" | "content_type" | "token";

/**
 * Native HTML <form method="post"> variant (used ONLY where the response must be a file download that may not pass through page
 * JavaScript: the activation file). A form cannot send the JSON content type or the custom header, so the proof is different but
 * not weaker: (1) the exact site Origin (or Sec-Fetch-Site: same-origin) as above, (2) the form content type, (3) a token in the
 * body whose HMAC covers nonce, expiry and the WEB SESSION ID (see `csrfBinding`): it is minted server-side into the page of a
 * signed-in user, so another site can neither read nor forge it, and it is useless with any other session. The session cookie is
 * SameSite=Lax, so a cross-site form post would not even carry it.
 */
export const FORM_CSRF_FIELD = "csrf";
export function verifyFormRequest(headers: Headers, siteOrigin: string): "ok" | "origin" | "content_type" {
  if (!originAllowed(headers, siteOrigin)) return "origin";
  const type = (headers.get("content-type") ?? "").toLowerCase();
  return type === "application/x-www-form-urlencoded" || type.startsWith("application/x-www-form-urlencoded;") ? "ok" : "content_type";
}
export async function verifyFormToken(secret: string, token: unknown, session: StoredSession | null, now?: number): Promise<boolean> {
  return typeof token === "string" && (await checkCsrf(secret, token, csrfBinding(session), now)) !== null;
}

export async function verifyCsrf(opts: {
  headers: Headers;
  jar: CookieJar;
  cookieName: string;
  siteOrigin: string;
  secret: string;
  session: StoredSession | null;
  now?: number;
}): Promise<CsrfVerdict> {
  if (!originAllowed(opts.headers, opts.siteOrigin)) return "origin";
  if (!(opts.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return "content_type";
  const header = opts.headers.get(CSRF_HEADER) ?? undefined;
  const cookie = opts.jar.get(opts.cookieName);
  if (!header || !cookie || !timingSafeEqualStr(header, cookie)) return "token";
  return (await checkCsrf(opts.secret, header, csrfBinding(opts.session), opts.now)) ? "ok" : "token";
}
