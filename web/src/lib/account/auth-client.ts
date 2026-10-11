import "server-only";
import { z } from "zod";
import { AUTH_BODIES, isAllowedAuthRequest } from "./contracts";
import type { AccountAuthConfig } from "./config";

/**
 * THE single Supabase Auth (GoTrue) wrapper of the website. Every request to Auth is built here and nowhere else
 * (a static test forbids Auth paths in any other file):
 *
 *   - the method + path + query is checked against `isAllowedAuthRequest` (closed endpoint list, pinned query, the
 *     one server-computed callback URL), after the body was parsed with the strict `AUTH_BODIES` schema;
 *   - one function per operation: no generic "forward this request" entry point exists;
 *   - only the publishable key (`apikey`) and, for the user's own calls, that user's access token are sent: there is
 *     no service-role or secret key anywhere in the website;
 *   - no redirects are followed, responses are size-bounded and schema-validated, Auth error TEXT is never returned
 *     (only the machine `error_code`), and nothing is logged.
 */

export type AuthFailure = {
  ok: false;
  status: number;
  /** GoTrue's machine error code (e.g. `invalid_credentials`), null if absent/unparseable. Never a message. */
  code: string | null;
  kind: "rejected" | "rate_limited" | "unavailable";
};
export type AuthSuccess<T> = { ok: true; status: number; data: T };
export type AuthResult<T> = AuthSuccess<T> | AuthFailure;

const sessionUser = z
  .object({
    id: z.string().regex(/^[0-9a-f-]{36}$/i),
    email: z.string().max(320).optional().nullable(),
    email_confirmed_at: z.string().nullable().optional(),
    confirmed_at: z.string().nullable().optional(),
    created_at: z.string().optional(),
    last_sign_in_at: z.string().nullable().optional(),
    is_anonymous: z.boolean().optional(),
  })
  .passthrough();
export type AuthUser = z.infer<typeof sessionUser>;

const sessionSchema = z
  .object({
    access_token: z.string().min(20).max(8192),
    refresh_token: z.string().min(10).max(2048),
    expires_in: z.number().int().positive(),
    expires_at: z.number().int().positive().optional(),
    token_type: z.string(),
    user: sessionUser,
  })
  .passthrough();
export type AuthSession = z.infer<typeof sessionSchema>;

const MAX_RESPONSE_BYTES = 64 * 1024;
const TIMEOUT_MS = 8000;

interface CallSpec<T> {
  method: "GET" | "POST" | "PUT";
  /** Fixed path (+ pinned query). Never built from caller input. */
  pathAndQuery: string;
  body?: unknown;
  bearer?: string;
  parse: z.ZodType<T>;
  /** Success statuses that carry no body (e.g. logout answers 204). */
  emptyOk?: boolean;
}

async function call<T>(cfg: AccountAuthConfig, spec: CallSpec<T>, callbackUrl?: string): Promise<AuthResult<T>> {
  if (!isAllowedAuthRequest(spec.method, spec.pathAndQuery, { callbackUrl })) {
    // A programming error, not a runtime condition: refuse loudly rather than send anything.
    throw new Error("auth_request_not_allowed");
  }
  const headers: Record<string, string> = { apikey: cfg.publishableKey, Accept: "application/json" };
  if (spec.bearer) headers.Authorization = `Bearer ${spec.bearer}`;
  if (spec.body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(cfg.authOrigin + spec.pathAndQuery, {
      method: spec.method,
      headers,
      body: spec.body === undefined ? undefined : JSON.stringify(spec.body),
      redirect: "manual",
      cache: "no-store",
      credentials: "omit",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { ok: false, status: 0, code: null, kind: "unavailable" };
  }
  const text = await readBounded(res);
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  if (res.status >= 200 && res.status < 300) {
    if (spec.emptyOk && !text) return { ok: true, status: res.status, data: undefined as T };
    const parsed = spec.parse.safeParse(json);
    if (parsed.success) return { ok: true, status: res.status, data: parsed.data };
    return { ok: false, status: res.status, code: "bad_auth_response", kind: "unavailable" };
  }
  const code = json && typeof json === "object" && typeof (json as Record<string, unknown>).error_code === "string"
    ? ((json as Record<string, string>).error_code as string).slice(0, 64)
    : null;
  const kind = res.status === 429 ? "rate_limited" : res.status >= 500 || res.status === 0 || (res.status >= 300 && res.status < 400) ? "unavailable" : "rejected";
  return { ok: false, status: res.status, code, kind };
}

async function readBounded(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return "";
      }
      chunks.push(value);
    }
  } catch {
    return "";
  }
  const all = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

const anyJson = z.unknown();
const noBody = z.unknown();

/** The only callback the website ever hands to Auth: computed from the validated SITE_URL, never from a request. */
export function callbackUrlFor(siteOrigin: string): string {
  return new URL("/account/auth/confirm", siteOrigin).toString();
}

export const auth = {
  signUp(cfg: AccountAuthConfig, input: { email: string; password: string }, callbackUrl: string) {
    const body = AUTH_BODIES.signup.parse(input);
    return call(cfg, { method: "POST", pathAndQuery: `/auth/v1/signup?redirect_to=${encodeURIComponent(callbackUrl)}`, body, parse: anyJson }, callbackUrl);
  },
  passwordGrant(cfg: AccountAuthConfig, input: { email: string; password: string }) {
    const body = AUTH_BODIES.password_grant.parse(input);
    return call(cfg, { method: "POST", pathAndQuery: "/auth/v1/token?grant_type=password", body, parse: sessionSchema });
  },
  refresh(cfg: AccountAuthConfig, refreshToken: string) {
    const body = AUTH_BODIES.refresh_grant.parse({ refresh_token: refreshToken });
    return call(cfg, { method: "POST", pathAndQuery: "/auth/v1/token?grant_type=refresh_token", body, parse: sessionSchema });
  },
  verify(cfg: AccountAuthConfig, input: { type: "signup" | "email" | "recovery"; token_hash: string }) {
    const body = AUTH_BODIES.verify.parse(input);
    return call(cfg, { method: "POST", pathAndQuery: "/auth/v1/verify", body, parse: sessionSchema });
  },
  recover(cfg: AccountAuthConfig, input: { email: string }, callbackUrl: string) {
    const body = AUTH_BODIES.recover.parse(input);
    return call(cfg, { method: "POST", pathAndQuery: `/auth/v1/recover?redirect_to=${encodeURIComponent(callbackUrl)}`, body, parse: anyJson }, callbackUrl);
  },
  resend(cfg: AccountAuthConfig, input: { email: string }, callbackUrl: string) {
    const body = AUTH_BODIES.resend.parse({ type: "signup", email: input.email });
    return call(cfg, { method: "POST", pathAndQuery: `/auth/v1/resend?redirect_to=${encodeURIComponent(callbackUrl)}`, body, parse: anyJson }, callbackUrl);
  },
  /** Ends THIS session only. `scope=local` is pinned in the allowlist: a global logout would also sign the Companion out. */
  logout(cfg: AccountAuthConfig, accessToken: string) {
    return call(cfg, { method: "POST", pathAndQuery: "/auth/v1/logout?scope=local", bearer: accessToken, parse: noBody, emptyOk: true });
  },
  /** The server-confirmed identity: Auth validates the JWT AND that its session still exists. */
  getUser(cfg: AccountAuthConfig, accessToken: string) {
    return call(cfg, { method: "GET", pathAndQuery: "/auth/v1/user", bearer: accessToken, parse: sessionUser });
  },
  /** Password only (no email change in V1); used inside a recovery session. */
  updatePassword(cfg: AccountAuthConfig, accessToken: string, password: string) {
    const body = AUTH_BODIES.update_password.parse({ password });
    return call(cfg, { method: "PUT", pathAndQuery: "/auth/v1/user", body, bearer: accessToken, parse: sessionUser });
  },
};
