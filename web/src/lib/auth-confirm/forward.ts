/**
 * Public e-mail confirmation (sign-up, e-mail change, password recovery) that works while the Account area is switched off.
 *
 * Deliberately NOT part of the Account zone: it holds no session, no cookie, no Auth address and no key. The visitor's explicit POST is forwarded to an
 * opaque server-side endpoint (the Supabase Edge Function `azerdex-auth-confirm`, configured by AZERDEX_CONFIRM_ENDPOINT at runtime) which talks to Auth.
 * The GET page has no side effect, so link scanners cannot consume a token; Auth remains the identity authority.
 */

export const CONFIRM_TYPES = ["signup", "email_change", "recovery"] as const;
export type ConfirmType = (typeof CONFIRM_TYPES)[number];
export const TOKEN_HASH = /^[A-Za-z0-9_-]{8,128}$/;

export interface ConfirmRequest {
  type: ConfirmType;
  tokenHash: string;
  password?: string;
}

export const isConfirmType = (v: unknown): v is ConfirmType => typeof v === "string" && (CONFIRM_TYPES as readonly string[]).includes(v);

/** The forwarding target must be exactly an https Supabase Edge Function URL of the confirm function (no credentials, port, query or other path). */
export function parseEndpoint(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== "https:" || u.username || u.password || u.port || u.search || u.hash) return null;
    if (!/^[a-z0-9]{20}\.supabase\.co$/.test(u.hostname)) return null;
    if (u.pathname !== "/functions/v1/azerdex-auth-confirm") return null;
    return u.toString();
  } catch {
    return null;
  }
}

export type ForwardError = "invalid_or_expired" | "weak_password" | "same_password" | "invalid_password" | "password_mismatch" | "invalid_request" | "rate_limited" | "temporarily_unavailable";
export type Forwarded = { ok: true; kind: string } | { ok: false; error: ForwardError };

const KNOWN_ERRORS = new Set<string>(["invalid_or_expired", "weak_password", "same_password", "invalid_password", "rate_limited", "temporarily_unavailable", "invalid_request"]);

/** Parses the form body; a recovery request also needs two identical passwords. */
export function parseForm(fd: FormData): { req: ConfirmRequest } | { error: { ok: false; error: ForwardError } } {
  const type = fd.get("type");
  const tokenHash = fd.get("token_hash");
  if (!isConfirmType(type) || typeof tokenHash !== "string" || !TOKEN_HASH.test(tokenHash)) return { error: { ok: false, error: "invalid_request" } };
  if (type !== "recovery") return { req: { type, tokenHash } };
  const password = fd.get("password");
  const again = fd.get("password_confirm");
  if (typeof password !== "string" || typeof again !== "string") return { error: { ok: false, error: "invalid_request" } };
  if (password !== again) return { error: { ok: false, error: "password_mismatch" } };
  return { req: { type, tokenHash, password } };
}

export async function forwardConfirm(endpoint: string, r: ConfirmRequest, io: (url: string, init: RequestInit) => Promise<Response>): Promise<Forwarded> {
  try {
    const res = await io(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: r.type, token_hash: r.tokenHash, ...(r.password === undefined ? {} : { password: r.password }) }),
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await res.json().catch(() => null)) as { ok?: unknown; kind?: unknown; error?: unknown } | null;
    if (res.ok && j?.ok === true && (j.kind === "confirmed" || j.kind === "password_reset")) return { ok: true, kind: j.kind };
    const e: ForwardError = typeof j?.error === "string" && KNOWN_ERRORS.has(j.error) ? (j.error as ForwardError) : "temporarily_unavailable";
    return { ok: false, error: e };
  } catch {
    return { ok: false, error: "temporarily_unavailable" };
  }
}

/**
 * The submit handler's CSRF check. A real Origin must match Host. The confirmation page sends `Referrer-Policy: no-referrer`, and browsers then send
 * `Origin: null` on its same-origin form POST, so an absent or "null" Origin falls back to Fetch-Metadata, which browsers send regardless of the referrer policy.
 */
export function isSameOriginForm(h: { get(n: string): string | null }): boolean {
  const origin = h.get("origin");
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (origin && origin !== "null") {
    try {
      return host !== null && new URL(origin).host === host;
    } catch {
      return false;
    }
  }
  const site = h.get("sec-fetch-site");
  return site === "same-origin" || site === "none";
}
