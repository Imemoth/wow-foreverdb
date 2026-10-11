/**
 * Account System V1 — shared, isomorphic contracts (no secrets, no I/O).
 *
 * This is the closed vocabulary of the account boundary:
 *   - which Auth endpoints the backend-for-frontend may call,
 *   - which database RPCs it may call (name + validated input + validated output),
 *   - the installation-claim code format,
 *   - the redirect allowlist for confirmation / recovery / login callbacks.
 *
 * There is deliberately no generic "call any RPC" or "call any URL" helper. Anything not
 * listed here cannot be reached through the account boundary. Specification:
 * docs/account-v1/web-auth-boundary.md and docs/account-v1/ownership-claim-protocol.md.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------------------------
// Auth (GoTrue) endpoint allowlist
// ---------------------------------------------------------------------------------------------

export interface AuthEndpoint {
  method: "GET" | "POST" | "PUT";
  path: string;
  /** Required `grant_type` query value for the token endpoint. */
  grantTypes?: readonly string[];
}

export const AUTH_ENDPOINTS: readonly AuthEndpoint[] = [
  { method: "POST", path: "/auth/v1/signup" },
  { method: "POST", path: "/auth/v1/token", grantTypes: ["password", "refresh_token", "pkce"] },
  { method: "POST", path: "/auth/v1/verify" },
  { method: "POST", path: "/auth/v1/recover" },
  { method: "POST", path: "/auth/v1/resend" },
  { method: "POST", path: "/auth/v1/logout" },
  { method: "GET", path: "/auth/v1/user" },
  { method: "PUT", path: "/auth/v1/user" },
  { method: "GET", path: "/auth/v1/.well-known/jwks.json" },
];

/** True only for an exactly-listed method + path (+ grant type). Query strings are validated, not forwarded blindly. */
export function isAllowedAuthRequest(method: string, pathAndQuery: string): boolean {
  let url: URL;
  try {
    url = new URL(pathAndQuery, "https://auth.invalid");
  } catch {
    return false;
  }
  if (url.origin !== "https://auth.invalid") return false;
  const ep = AUTH_ENDPOINTS.find((e) => e.method === method.toUpperCase() && e.path === url.pathname);
  if (!ep) return false;
  if (ep.grantTypes) {
    const grant = url.searchParams.get("grant_type");
    return grant !== null && ep.grantTypes.includes(grant);
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Installation claim code
// ---------------------------------------------------------------------------------------------

/** 128 random bits = 32 hexadecimal characters, displayed as `FDB-XXXX-XXXX-...` (8 groups). */
export const CLAIM_CODE_HEX_LENGTH = 32;
export const CLAIM_CODE_TTL_SECONDS = 600;

/**
 * Canonical form (uppercase hex, no separators) of a user-typed code, or null if it cannot be one.
 * Accepts case differences, spaces, hyphens, and the optional `FDB` prefix (disambiguated by length:
 * a bare code has 32 hex characters, a prefixed one 35). O/I/L are NOT silently mapped: hex has none.
 */
export function normalizeClaimCode(input: unknown): string | null {
  if (typeof input !== "string" || input.length === 0 || input.length > 80) return null;
  const compact = input.toUpperCase().replace(/[\s-]/g, "");
  const body = compact.length === CLAIM_CODE_HEX_LENGTH + 3 && compact.startsWith("FDB") ? compact.slice(3) : compact;
  return /^[0-9A-F]{32}$/.test(body) ? body : null;
}

export function formatClaimCode(canonical: string): string {
  if (!/^[0-9A-F]{32}$/.test(canonical)) throw new Error("not a canonical claim code");
  return `FDB-${canonical.match(/.{4}/g)!.join("-")}`;
}

// ---------------------------------------------------------------------------------------------
// RPC contracts (name + input + output). The only database calls the account boundary may make.
// ---------------------------------------------------------------------------------------------

/** Installation IDs come from the Companion/addon; they are identifiers, never proof of ownership. */
export const installationIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "invalid installation id");

const isoTimestamp = z.string().min(10).max(40);
const pageLimit = z.number().int().min(1).max(200).default(100);
const pageOffset = z.number().int().min(0).max(100_000).default(0);

export const guildKeySchema = z.string().min(1).max(200);

export const ACCOUNT_RPCS = {
  /**
   * Caller: the installation's CURRENT owner, while still anonymous. Issues a single-use code.
   * Business failures are RESULTS (`ok:false`), never exceptions, so throttle counters persist; the failure
   * is deliberately one indistinguishable value (no existence or state oracle).
   */
  fdb_account_claim_start: {
    input: z.object({ p_installation_id: installationIdSchema }).strict(),
    output: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), code: z.string().regex(/^[0-9A-F]{32}$/), expires_at: isoTimestamp }).strict(),
      z.object({ ok: z.literal(false), error: z.literal("not_available") }).strict(),
    ]),
  },
  /** Caller: a REGISTERED, email-verified user. The code alone identifies the claim; one indistinguishable failure. */
  fdb_account_claim_redeem: {
    input: z.object({ p_code: z.string().regex(/^[0-9A-F]{32}$/) }).strict(),
    output: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), installation_id: installationIdSchema, linked_at: isoTimestamp }).strict(),
      z.object({ ok: z.literal(false), error: z.literal("invalid_claim") }).strict(),
    ]),
  },
  /** Caller: any authenticated session (the Companion). Only the previous owner learns `transferred`. */
  fdb_installation_link_status: {
    input: z.object({ p_installation_id: installationIdSchema }).strict(),
    output: z.object({ state: z.enum(["owned", "transferred", "unknown"]) }).strict(),
  },
  /** Caller: a REGISTERED user. Lists the caller's own linked installations only. */
  fdb_account_installations: {
    input: z.object({}).strict(),
    output: z
      .array(
        z
          .object({
            installation_id: installationIdSchema,
            linked_at: isoTimestamp,
            last_seen_at: isoTimestamp.nullable(),
            guild_count: z.number().int().min(0),
          })
          .strict(),
      )
      .max(100),
  },
  fdb_account_guildbook_guilds: {
    input: z.object({ p_installation_id: installationIdSchema }).strict(),
    output: z
      .array(
        z
          .object({
            guild_key: guildKeySchema,
            guild_name: z.string().max(200),
            realm_name: z.string().max(200),
            captured_at: z.number().int().min(0),
            member_count: z.number().int().min(0),
          })
          .strict(),
      )
      .max(100),
  },
  fdb_account_guildbook_members: {
    input: z
      .object({ p_installation_id: installationIdSchema, p_guild_key: guildKeySchema, p_limit: pageLimit, p_offset: pageOffset })
      .strict(),
    output: z
      .array(
        z
          .object({
            member_name: z.string().max(200),
            class_name: z.string().max(100),
            class_file: z.string().max(100),
            level: z.number().int().min(0),
            rank_name: z.string().max(100),
            rank_index: z.number().int(),
            online: z.boolean(),
            zone_name: z.string().max(200),
            last_online_hours: z.number().int().min(0),
          })
          .strict(),
      )
      .max(200),
  },
} as const;

export type AccountRpcName = keyof typeof ACCOUNT_RPCS;

export function isAccountRpc(name: string): name is AccountRpcName {
  return Object.prototype.hasOwnProperty.call(ACCOUNT_RPCS, name);
}

// ---------------------------------------------------------------------------------------------
// Redirect allowlist
// ---------------------------------------------------------------------------------------------

export const DEFAULT_ACCOUNT_REDIRECT = "/account";

/** Exact pathnames a callback or login may return to. Everything else falls back to the default. */
export const ACCOUNT_REDIRECT_ALLOWLIST: readonly string[] = [
  "/account",
  "/account/link",
  "/account/installations",
  "/account/guildbook",
  "/account/security",
];

/**
 * Validates a `next` parameter. Same-origin relative pathnames from the allowlist only; query and fragment are
 * dropped; absolute URLs, protocol-relative URLs, backslashes, control characters, and encoded variants of those
 * (any depth) fall back to the default. Returns a pathname, never a full URL.
 */
export function safeNext(next: unknown, allowlist: readonly string[] = ACCOUNT_REDIRECT_ALLOWLIST): string {
  if (typeof next !== "string" || next.length === 0 || next.length > 200) return DEFAULT_ACCOUNT_REDIRECT;
  let candidate = next;
  for (let i = 0; i < 4; i += 1) {
    if (/[\u0000-\u001f\u007f\\]/.test(candidate)) return DEFAULT_ACCOUNT_REDIRECT;
    if (!candidate.startsWith("/") || candidate.startsWith("//")) return DEFAULT_ACCOUNT_REDIRECT;
    let decoded: string;
    try {
      decoded = decodeURIComponent(candidate);
    } catch {
      return DEFAULT_ACCOUNT_REDIRECT;
    }
    if (decoded === candidate) break;
    candidate = decoded;
  }
  const pathname = (candidate.split(/[?#]/, 1)[0] ?? "").replace(/\/+$/, "") || "/";
  return allowlist.includes(pathname) ? pathname : DEFAULT_ACCOUNT_REDIRECT;
}

// ---------------------------------------------------------------------------------------------
// Session / identity classification
// ---------------------------------------------------------------------------------------------

/** What the account boundary decided about a verified set of JWT claims. */
export type IdentityKind = "anonymous" | "registered" | "invalid";

/**
 * Classify claims that were ALREADY verified (signature checked by getClaims / server-confirmed user).
 * Never call this on unverified cookie contents. Registered = authenticated role, non-anonymous, has a subject
 * and an email. (The database independently re-checks email confirmation; this is defence in depth.)
 */
export function classifyClaims(claims: unknown): IdentityKind {
  if (!claims || typeof claims !== "object") return "invalid";
  const c = claims as Record<string, unknown>;
  if (typeof c.sub !== "string" || !/^[0-9a-f-]{36}$/i.test(c.sub)) return "invalid";
  if (c.role !== "authenticated") return "invalid";
  if (c.is_anonymous === true) return "anonymous";
  if (c.is_anonymous === false && typeof c.email === "string" && c.email.length > 0) return "registered";
  return "invalid";
}
