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
 * docs/account-v1/architecture.md (sections 4 and 5) and docs/account-v1/ownership-claim-protocol.md.
 */
import { z } from "@/lib/zod";

// ---------------------------------------------------------------------------------------------
// Auth (GoTrue) endpoint allowlist
// ---------------------------------------------------------------------------------------------

export interface AuthEndpoint {
  method: "GET" | "POST" | "PUT";
  path: string;
  /** Required `grant_type` query value for the token endpoint. */
  grantTypes?: readonly string[];
  /** Query parameters that must be present with exactly this value (e.g. logout is always `scope=local`). */
  fixedQuery?: Readonly<Record<string, string>>;
  /** `redirect_to` is accepted only when it equals the single, server-computed callback URL. */
  allowRedirectTo?: boolean;
  /**
   * Reachable ONLY when the caller passes `{ recovery: true }` (one server-only wrapper function does, see auth-client.ts): never
   * selectable by request data. The global logout that ends every session of a user after a successful password reset.
   */
  recoveryOnly?: boolean;
}

export const AUTH_ENDPOINTS: readonly AuthEndpoint[] = [
  { method: "POST", path: "/auth/v1/signup", allowRedirectTo: true },
  { method: "POST", path: "/auth/v1/token", grantTypes: ["password", "refresh_token", "pkce"] },
  { method: "POST", path: "/auth/v1/verify" },
  { method: "POST", path: "/auth/v1/recover", allowRedirectTo: true },
  { method: "POST", path: "/auth/v1/resend", allowRedirectTo: true },
  // Web logout ends THIS session only. GoTrue's default is global scope, which would also sign the Companion
  // out (sessions must stay independent), so the scope is pinned and never taken from a caller.
  { method: "POST", path: "/auth/v1/logout", fixedQuery: { scope: "local" } },
  // PR E (owner decision): after a successful password reset EVERY session of the user is revoked (a pre-registering attacker's session,
  // other browsers, the registered Companion). Fixed query, recovery-only: `isAllowedAuthRequest` refuses it unless `recovery: true`.
  { method: "POST", path: "/auth/v1/logout", fixedQuery: { scope: "global" }, recoveryOnly: true },
  { method: "GET", path: "/auth/v1/user" },
  { method: "PUT", path: "/auth/v1/user" },
  { method: "GET", path: "/auth/v1/.well-known/jwks.json" },
];

/**
 * True only for an exactly-listed method + path whose query string contains nothing but the parameters that endpoint
 * permits (pinned values, the grant type, a `redirect_to` equal to `opts.callbackUrl`). Duplicate or unknown
 * parameters are refused, so the backend can never be steered into e.g. a global logout or an arbitrary redirect.
 */
export function isAllowedAuthRequest(method: string, pathAndQuery: string, opts: { callbackUrl?: string; recovery?: boolean } = {}): boolean {
  let url: URL;
  try {
    url = new URL(pathAndQuery, "https://auth.invalid");
  } catch {
    return false;
  }
  if (url.origin !== "https://auth.invalid") return false;
  const candidates = AUTH_ENDPOINTS.filter((e) => e.method === method.toUpperCase() && e.path === url.pathname && (!e.recoveryOnly || opts.recovery === true));
  return candidates.some((ep) => matchesEndpoint(ep, url, opts));
}

function matchesEndpoint(ep: AuthEndpoint, url: URL, opts: { callbackUrl?: string }): boolean {
  const keys = [...url.searchParams.keys()];
  if (new Set(keys).size !== keys.length) return false;
  for (const key of keys) {
    const value = url.searchParams.get(key) ?? "";
    const ok =
      (key === "grant_type" && ep.grantTypes !== undefined && ep.grantTypes.includes(value)) ||
      (ep.fixedQuery !== undefined && ep.fixedQuery[key] === value) ||
      (key === "redirect_to" && ep.allowRedirectTo === true && opts.callbackUrl !== undefined && value === opts.callbackUrl);
    if (!ok) return false;
  }
  if (ep.grantTypes && !url.searchParams.has("grant_type")) return false;
  if (ep.fixedQuery) for (const k of Object.keys(ep.fixedQuery)) if (!url.searchParams.has(k)) return false;
  return true;
}

/** Request bodies the backend may send. Strict: no `data`/user_metadata, no extra fields, no email change in V1. */
const authEmail = z.string().trim().toLowerCase().email().max(254);
const authPassword = z
  .string()
  .max(72) // UTF-16 code units: never stricter than the byte limit below, and cheap to reject early
  // 12 characters means code POINTS (a surrogate pair is one character), while the 72 limit counts UTF-8 BYTES.
  .refine((v) => Array.from(v).length >= 12, "password too short (12 characters minimum)")
  .refine((v) => new TextEncoder().encode(v).length <= 72, "password too long (bcrypt limit is 72 bytes)");
/** Sign-in never enforces the sign-up policy (a policy change must not lock existing users out); it only bounds the input. */
const loginPassword = z
  .string()
  .min(1)
  .max(72)
  .refine((v) => new TextEncoder().encode(v).length <= 72, "password too long (bcrypt limit is 72 bytes)");
export const AUTH_BODIES = {
  signup: z.object({ email: authEmail, password: authPassword }).strict(),
  password_grant: z.object({ email: authEmail, password: loginPassword }).strict(),
  refresh_grant: z.object({ refresh_token: z.string().min(10).max(2048) }).strict(),
  verify: z.object({ type: z.enum(["signup", "email", "recovery"]), token_hash: z.string().min(10).max(512) }).strict(),
  recover: z.object({ email: authEmail }).strict(),
  resend: z.object({ type: z.literal("signup"), email: authEmail }).strict(),
  update_password: z.object({ password: authPassword }).strict(),
} as const;

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
      // `account_limit` is only ever returned to a registered caller who holds an otherwise VALID code (nothing is consumed).
      z.object({ ok: z.literal(false), error: z.enum(["invalid_claim", "account_limit"]) }).strict(),
    ]),
  },
  /** Caller: any authenticated session (the Companion). Only the previous owner learns `transferred`. */
  fdb_installation_link_status: {
    input: z.object({ p_installation_id: installationIdSchema }).strict(),
    output: z.object({ state: z.enum(["owned", "transferred", "unknown"]) }).strict(),
  },
  /** Caller: a REGISTERED user with a live session. Attributes only a newly captured local Guildbook snapshot. */
  fdb_account_guildbook_ingest: {
    input: z
      .object({
        p_installation_id: installationIdSchema,
        p_capture_id: z.string().min(1).max(200),
        p_captured_at: z.number().int().min(0),
        p_source_character: z.string().min(1).max(200),
        p_guilds: z.array(z.record(z.string(), z.unknown())).max(100),
      })
      .strict(),
    output: z.discriminatedUnion("ok", [
      z
        .object({ ok: z.literal(true), status: z.literal("applied"), installation_id: installationIdSchema, capture_id: z.string(), captured_at: z.number().int().min(0) })
        .strict(),
      z.object({ ok: z.literal(false), error: z.enum(["installation_unknown", "capture_replayed", "capture_stale"]) }).strict(),
    ]),
  },
  /** Caller: a REGISTERED user. Lists the installations the caller OWNS (ownership is installations.owner_user_id). */
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
      .max(50),
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
  /** Account-scoped Guildbook reads use a distinct RPC family so the legacy installation-owned reads remain unchanged. */
  fdb_account_guildbook_guilds_scoped: {
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
  fdb_account_guildbook_members_scoped: {
    input: z
      .object({ p_installation_id: installationIdSchema, p_guild_key: guildKeySchema, p_limit: pageLimit, p_offset: pageOffset })
      .strict(),
    output: z
      .array(
        z
          .object({
            member_guid: z.string().max(200),
            member_name: z.string().max(200),
            class_name: z.string().max(100),
            class_file: z.string().max(100),
            level: z.number().int().min(0),
            rank_name: z.string().max(100),
            rank_index: z.number().int(),
            online: z.boolean(),
            zone_name: z.string().max(200),
            last_online_hours: z.number().int().min(0),
            professions: z.array(
              z
                .object({
                  skill_line_id: z.number().int(),
                  name: z.string().max(200),
                  skill: z.number().int().min(0),
                  max_skill: z.number().int().min(0),
                  source: z.string().max(100),
                  is_secondary: z.boolean(),
                })
                .strict(),
            ),
          })
          .strict(),
      )
      .max(200),
  },
} as const;

export type AccountRpcName = keyof typeof ACCOUNT_RPCS;

/**
 * The identity guard EVERY account function must run as its first statement (ownership-claim-protocol.md section 4).
 * Each guard includes a LIVE-SESSION check: the JWT's `session_id` must exist in `auth.sessions` for the same user
 * and not be expired, and the user must not be deleted or banned. Signature validity and `exp` alone are never enough:
 * Auth access tokens stay cryptographically valid after sign-out or revocation. A function guarded only by
 * `auth.uid()` and `is_anonymous` is non-conformant (see migration-conformance.ts and its CI test).
 */
export type AccountGuard = "any_live_session" | "anonymous_owner_live_session" | "registered_live_session";

export const ACCOUNT_RPC_GUARDS: Readonly<Record<AccountRpcName, AccountGuard>> = {
  fdb_account_claim_start: "anonymous_owner_live_session",
  fdb_account_claim_redeem: "registered_live_session",
  fdb_account_guildbook_ingest: "registered_live_session",
  fdb_account_installations: "registered_live_session",
  fdb_account_guildbook_guilds: "registered_live_session",
  fdb_account_guildbook_members: "registered_live_session",
  fdb_account_guildbook_guilds_scoped: "registered_live_session",
  fdb_account_guildbook_members_scoped: "registered_live_session",
  fdb_installation_link_status: "any_live_session",
};

/**
 * Helper functions the account migration may define besides the registered RPCs and guards. Empty today: adding one is a
 * reviewed change to this list (and its test), so a migration cannot smuggle in an unreviewed callable function.
 */
export const ACCOUNT_HELPER_FUNCTIONS: readonly string[] = [
  "private.fdb_public_snapshot",
  "private.foreverdb_ingest_snapshot_impl_v1",
];

/** The private (client-unreachable) function that implements each guard. */
export const ACCOUNT_GUARD_FUNCTIONS: Readonly<Record<AccountGuard, string>> = {
  any_live_session: "private.fdb_caller",
  anonymous_owner_live_session: "private.fdb_anonymous_caller",
  registered_live_session: "private.fdb_registered_caller",
};

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
  "/account/devices",
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
