// Consumes ONE e-mail link token on behalf of the public confirmation page (https://beta.azerdex.com/auth/confirm), so the website itself never needs the
// Auth project's address or key. Supabase Auth stays the identity authority: this function only calls Auth's own /verify (and, for recovery, /user and /logout)
// with the one-time `token_hash` Auth generated. It generates no tokens, keeps no session and returns none.
//
// verify_jwt = false is REQUIRED (the caller is a visitor's browser via the website). The credential is the one-time token itself, exactly as with Auth's own
// public /verify endpoint; it is consumed only by an explicit POST (the page that links here has no side effect, so mail scanners cannot use a token up).
// Supported: signup, email_change (confirm) and recovery (verify + set the new password, then end every session). Other link types answer 400.
import { Buffer } from "node:buffer";

const TYPES = ["signup", "email_change", "recovery"] as const;
type LinkType = (typeof TYPES)[number];
const TOKEN_HASH = /^[A-Za-z0-9_-]{8,128}$/;
const MAX_BODY = 4096;
const TIMEOUT_MS = 10_000;

type Env = { get(n: string): string | undefined };
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
type Log = (event: string, fields: Record<string, string | number>) => void;

const json = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export interface ConfirmInput {
  type: LinkType;
  tokenHash: string;
  password?: string;
}

/** Strict input check. A password is required for recovery and refused for every other type. 8..72 characters (Auth's bcrypt limit is 72 bytes). */
export function parseInput(raw: unknown): ConfirmInput | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.some((k) => !["type", "token_hash", "password"].includes(k))) return null;
  if (typeof o.type !== "string" || !(TYPES as readonly string[]).includes(o.type)) return null;
  if (typeof o.token_hash !== "string" || !TOKEN_HASH.test(o.token_hash)) return null;
  const type = o.type as LinkType;
  if (type === "recovery") {
    if (typeof o.password !== "string" || o.password.length < 8 || Buffer.byteLength(o.password, "utf8") > 72) return null;
    return { type, tokenHash: o.token_hash, password: o.password };
  }
  if (o.password !== undefined) return null;
  return { type, tokenHash: o.token_hash };
}

async function call(io: FetchLike, url: string, init: RequestInit): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const res = await io(url, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS) });
  let body: Record<string, unknown> | null = null;
  try {
    const j = await res.json();
    body = j && typeof j === "object" ? (j as Record<string, unknown>) : null;
  } catch { /* an empty body is fine */ }
  return { status: res.status, body };
}

export async function handle(req: Request, env: Env, io: FetchLike, log: Log): Promise<Response> {
  if (req.method !== "POST") return json(405, { ok: false, error: "method_not_allowed" });
  const base = (env.get("SUPABASE_URL") ?? "").trim().replace(/\/+$/, "");
  const apikey = (env.get("SUPABASE_ANON_KEY") ?? "").trim();
  if (!/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(base) || !apikey) {
    log("misconfigured", {});
    return json(503, { ok: false, error: "temporarily_unavailable" });
  }
  const text = await req.text();
  if (text.length > MAX_BODY) return json(413, { ok: false, error: "too_large" });
  let input: ConfirmInput | null = null;
  try {
    input = parseInput(JSON.parse(text));
  } catch { /* falls through to the generic refusal */ }
  if (!input) return json(400, { ok: false, error: "invalid_request" });

  const headers = { apikey, "content-type": "application/json" };
  try {
    const v = await call(io, `${base}/auth/v1/verify`, { method: "POST", headers, body: JSON.stringify({ type: input.type, token_hash: input.tokenHash }) });
    if (v.status === 429) return json(429, { ok: false, error: "rate_limited" });
    if (v.status >= 500) return json(503, { ok: false, error: "temporarily_unavailable" });
    const access = typeof v.body?.access_token === "string" ? (v.body.access_token as string) : "";
    if (v.status < 200 || v.status >= 300) {
      log("verify_refused", { type: input.type, status: v.status });
      return json(400, { ok: false, error: "invalid_or_expired" });
    }
    if (input.type !== "recovery") {
      log("confirmed", { type: input.type });
      return json(200, { ok: true, kind: "confirmed" }); // the session Auth returned is dropped on the floor
    }
    if (!access) return json(400, { ok: false, error: "invalid_or_expired" });
    const auth = { ...headers, authorization: `Bearer ${access}` };
    const u = await call(io, `${base}/auth/v1/user`, { method: "PUT", headers: auth, body: JSON.stringify({ password: input.password }) });
    if (u.status === 422 || u.status === 400) {
      const code = String(u.body?.error_code ?? "");
      log("password_refused", { status: u.status, code: code.slice(0, 40) });
      return json(400, { ok: false, error: code === "weak_password" || code === "same_password" ? code : "invalid_password" });
    }
    if (u.status === 429) return json(429, { ok: false, error: "rate_limited" });
    if (u.status < 200 || u.status >= 300) return json(503, { ok: false, error: "temporarily_unavailable" });
    // A password reset must end every session (including the one just created for this recovery). Reported, never assumed.
    const l = await call(io, `${base}/auth/v1/logout?scope=global`, { method: "POST", headers: auth, body: "{}" });
    const revoked = l.status >= 200 && l.status < 300;
    log("password_reset", { sessions_revoked: revoked ? 1 : 0 });
    return json(200, { ok: true, kind: "password_reset", sessions_revoked: revoked });
  } catch (e) {
    log("failed", { code: String((e as Error)?.name ?? "error").slice(0, 40) });
    return json(503, { ok: false, error: "temporarily_unavailable" });
  }
}

declare const Deno: { env: { get(n: string): string | undefined }; serve(h: (r: Request) => Promise<Response> | Response): void };

if (typeof Deno !== "undefined" && typeof Deno.serve === "function") {
  Deno.serve((req) =>
    handle(req, Deno.env, (u, i) => fetch(u, i), (event, fields) => console.log(JSON.stringify({ fn: "azerdex-auth-confirm", event, ...fields }))).catch(() => json(503, { ok: false, error: "temporarily_unavailable" })),
  );
}
