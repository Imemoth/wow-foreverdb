/**
 * Account System V1 — Auth-only configuration boundary (pure, side-effect free).
 *
 * The public browsing and publication adapters never talk to the private Supabase project.
 * Only the server-side account boundary may use it in a separately approved pilot/release,
 * and it is configured through a closed set of
 * variables validated here, separately from the public-site rules in `../env.ts`:
 *
 *   ACCOUNT_AUTH_MODE             disabled (default) | local | staging | production
 *   ACCOUNT_AUTH_URL              origin of the Supabase Auth/API gateway (no path, no credentials)
 *   ACCOUNT_AUTH_PUBLISHABLE_KEY  publishable/anon key ONLY (public by design, never a secret)
 *   ACCOUNT_AUTH_PROJECT_REF      required for staging, pilot and production; must match Auth URL exactly
 *   ACCOUNT_CSRF_SECRET           >= 32 characters; signs the CSRF token (a server secret, NOT a Supabase credential)
 *
 * Rules (each one has a negative test in tests/unit/account-config.test.ts):
 *   - `pilot` and `production` have SEPARATE compile-time approval flags, both false.
 *     No environment variable alone can enable either. Owner approval + security review required.
 *   - `local` only on a developer machine (not hosted, deployment=local) against a loopback origin.
 *   - `staging` only against an isolated project on protected Vercel Preview.
 *   - `pilot` only on protected Vercel Preview with the EXACT private project ref; the
 *     website's public adapter stays synthetic. `production` additionally requires actual
 *     ForeverDB production, Vercel Production and all global production environment gates.
 *   - A service-role / secret key is rejected (decoded JWT role must be `anon`, or an
 *     `sb_publishable_` key). Any unknown ACCOUNT_AUTH_* variable is rejected (it may be a secret).
 *   - Messages name variables only, never values.
 *
 * The global guard in env.ts still rejects private-project references in every public
 * adapter, client-exposed variable and public read database URL. This validator owns the
 * ONLY allowlisted account origin and publishable key.
 */

/**
 * Owner-approved private pilot (2026-10-12) ran ONLY on a Vercel-SSO-protected Preview branch with the exact
 * existing private Supabase Auth project. The compiled approval is now OFF on the release line (reverted before
 * the merge to main, 2026-10-16 integration). Re-enabling it is a separate owner-approved code change; the
 * environment alone can never open it. Public production approval remains separate and OFF.
 * Do not promote a pilot build or its configuration to the production target.
 */
export const SINGLE_PROJECT_PILOT_APPROVED = false as boolean;
export const PRODUCTION_ACCOUNT_AUTH_APPROVED = false as boolean;

/** Guildbook is a Companion-local feature; the website must not expose its old private API. */
export const ACCOUNT_GUILDBOOK_WEB_ENABLED = false as boolean;

/** The existing private Supabase project: only an approved account boundary may contact it. */
export const PRIVATE_PRODUCTION_PROJECT_REF = "klxhikdlfwgxurdyexdi";

export type AccountAuthMode = "disabled" | "local" | "staging" | "pilot" | "production";

export interface AccountAuthConfig {
  mode: "local" | "staging" | "pilot" | "production";
  /** Origin only, e.g. https://abcdefghijklmnopqrst.supabase.co or http://127.0.0.1:54321 */
  authOrigin: string;
  projectRef: string | null;
  /** Publishable (anon) key. Public by design; still never logged or sent to the browser by this app. */
  publishableKey: string;
  /** Keys the signed CSRF token (the account cookies cannot use the __Host- prefix because they are path-scoped). */
  csrfSecret: string;
}

export interface AccountAuthContext {
  hosted: boolean;
  deployment: "local" | "preview" | "production";
  /** Vercel's own target (production | preview | development), if any. */
  platformEnv?: string;
}

export interface AccountAuthResult {
  config: AccountAuthConfig | null;
  issues: string[];
}

const ALLOWED_VARIABLES = new Set([
  "ACCOUNT_AUTH_MODE",
  "ACCOUNT_AUTH_URL",
  "ACCOUNT_AUTH_PUBLISHABLE_KEY",
  "ACCOUNT_AUTH_PROJECT_REF",
  "ACCOUNT_CSRF_SECRET",
]);

const MODES = new Set(["disabled", "local", "staging", "pilot", "production"]);
const SUPABASE_HOST = /^([a-z0-9]{20})\.supabase\.co$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  const segment = parts[1];
  if (parts.length !== 3 || !segment) return null;
  try {
    const json = Buffer.from(segment.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const value: unknown = JSON.parse(json);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Case-insensitive, NFKC-folded, repeatedly percent-decoded reference check (mirrors env.ts). */
function mentionsPrivateProject(value: string): boolean {
  let current = value;
  for (let i = 0; i < 4; i += 1) {
    if (current.normalize("NFKC").toLowerCase().includes(PRIVATE_PRODUCTION_PROJECT_REF)) return true;
    try {
      const next = decodeURIComponent(current);
      if (next === current) break;
      current = next;
    } catch {
      break;
    }
  }
  return false;
}

/**
 * approval is an injected pure-test seam. The actual runtime calls this with two arguments,
 * therefore ONLY the compiled, reviewed flags above determine live availability.
 */
export function evaluateAccountAuth(
  raw: Record<string, string | undefined>,
  ctx: AccountAuthContext,
  approval: Readonly<{ pilot: boolean; production: boolean }> = {
    pilot: SINGLE_PROJECT_PILOT_APPROVED,
    production: PRODUCTION_ACCOUNT_AUTH_APPROVED,
  },
): AccountAuthResult {
  const issues: string[] = [];
  const fail = (m: string) => issues.push(m);
  const present = (name: string) => raw[name] !== undefined && raw[name] !== "";

  for (const name of Object.keys(raw)) {
    if (/^ACCOUNT_(AUTH|CSRF)_/i.test(name) && !ALLOWED_VARIABLES.has(name) && present(name)) {
      fail(`${name}: unknown account-auth variable (only ACCOUNT_AUTH_MODE, _URL, _PUBLISHABLE_KEY, _PROJECT_REF and ACCOUNT_CSRF_SECRET are accepted)`);
    }
  }

  const modeRaw = raw.ACCOUNT_AUTH_MODE === undefined || raw.ACCOUNT_AUTH_MODE === "" ? "disabled" : raw.ACCOUNT_AUTH_MODE;
  if (!MODES.has(modeRaw)) {
    fail("ACCOUNT_AUTH_MODE must be one of disabled, local, staging, pilot, production");
    return { config: null, issues };
  }
  const mode = modeRaw as AccountAuthMode;

  if (mode === "disabled") {
    for (const name of ["ACCOUNT_AUTH_URL", "ACCOUNT_AUTH_PUBLISHABLE_KEY", "ACCOUNT_AUTH_PROJECT_REF", "ACCOUNT_CSRF_SECRET"]) {
      if (present(name)) fail(`${name}: configured while ACCOUNT_AUTH_MODE is disabled`);
    }
    return { config: null, issues };
  }

  // A private-project connection is never permitted by configuration alone.
  if (mode === "pilot") {
    if (!approval.pilot) fail("ACCOUNT_AUTH_MODE=pilot requires a reviewed owner-approved code change");
    if (!ctx.hosted || ctx.deployment !== "preview" || ctx.platformEnv !== "preview") {
      fail("ACCOUNT_AUTH_MODE=pilot requires a protected Vercel preview deployment");
    }
  } else if (mode === "production") {
    if (!approval.production) fail("ACCOUNT_AUTH_MODE=production is not available in Account System V1 without a reviewed owner-approved code change");
    if (!ctx.hosted || ctx.deployment !== "production" || ctx.platformEnv !== "production") {
      fail("ACCOUNT_AUTH_MODE=production requires FOREVERDB_DEPLOYMENT=production on Vercel's production environment");
    }
  } else {
    if (ctx.deployment === "production") fail("ACCOUNT_AUTH_MODE=" + mode + " is not allowed on a production deployment");
    if (ctx.platformEnv === "production") {
      fail("ACCOUNT_AUTH_MODE=" + mode + " is not allowed on Vercel's production target (the demonstration alias); use a preview deployment");
    }
    if (mode === "local" && (ctx.hosted || ctx.deployment !== "local")) {
      fail("ACCOUNT_AUTH_MODE=local is only allowed on a developer machine (not hosted, FOREVERDB_DEPLOYMENT=local)");
    }
  }

  // URL
  let origin = "";
  let ref: string | null = null;
  const urlRaw = raw.ACCOUNT_AUTH_URL ?? "";
  if (!urlRaw) {
    fail("ACCOUNT_AUTH_URL is required");
  } else if ((mode === "staging" || mode === "local") && mentionsPrivateProject(urlRaw)) {
    fail("ACCOUNT_AUTH_URL references the PRIVATE production project; only an isolated local or staging Auth is permitted");
  } else {
    let u: URL | null = null;
    try {
      u = new URL(urlRaw);
    } catch {
      fail("ACCOUNT_AUTH_URL is not a valid URL");
    }
    if (u) {
      if (u.username || u.password) fail("ACCOUNT_AUTH_URL must not contain credentials");
      if (mode !== "local" && u.port) fail("ACCOUNT_AUTH_URL must not carry a port in hosted mode");
      if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) fail("ACCOUNT_AUTH_URL must be an origin only (no path, query or fragment)");
      const hostName = u.hostname.toLowerCase();
      if (mode === "local") {
        if (!LOOPBACK.has(hostName)) fail("ACCOUNT_AUTH_URL must be a loopback address in local mode");
        if (u.protocol !== "http:" && u.protocol !== "https:") fail("ACCOUNT_AUTH_URL must be an http(s) URL");
      } else {
        if (u.protocol !== "https:") fail("ACCOUNT_AUTH_URL must be https in hosted account mode");
        const m = SUPABASE_HOST.exec(hostName);
        if (!m) fail("ACCOUNT_AUTH_URL must be a <project-ref>.supabase.co origin in hosted account mode");
        else {
          ref = m[1] ?? null;
          if (mode === "staging" && ref === PRIVATE_PRODUCTION_PROJECT_REF) fail("ACCOUNT_AUTH_URL is the PRIVATE production project");
          if ((mode === "pilot" || mode === "production") && ref !== PRIVATE_PRODUCTION_PROJECT_REF) {
            fail("ACCOUNT_AUTH_URL must match the approved PRIVATE production project for pilot/production");
          }
          if (raw.ACCOUNT_AUTH_PROJECT_REF !== ref) fail("ACCOUNT_AUTH_PROJECT_REF must equal the project reference in ACCOUNT_AUTH_URL");
        }
      }
      origin = u.origin;
    }
  }
  if (mode === "local" && present("ACCOUNT_AUTH_PROJECT_REF")) fail("ACCOUNT_AUTH_PROJECT_REF must not be set in local mode");

  // Key: publishable only
  const key = raw.ACCOUNT_AUTH_PUBLISHABLE_KEY ?? "";
  if (!key) {
    fail("ACCOUNT_AUTH_PUBLISHABLE_KEY is required");
  } else if (key.length > 1024 || /\s/.test(key)) {
    fail("ACCOUNT_AUTH_PUBLISHABLE_KEY is malformed");
  } else if (/^sb_secret_/i.test(key)) {
    fail("ACCOUNT_AUTH_PUBLISHABLE_KEY is a SECRET key; the website only accepts a publishable/anon key");
  } else if (/^sb_publishable_/i.test(key)) {
    if ((mode === "pilot" || mode === "production") && !/^sb_publishable_[A-Za-z0-9_-]{20,}$/.test(key)) {
      fail("ACCOUNT_AUTH_PUBLISHABLE_KEY must use a well-formed sb_publishable_ key in pilot/production");
    }
  } else {
    const payload = decodeJwtPayload(key);
    if (mode === "pilot" || mode === "production") fail("ACCOUNT_AUTH_PUBLISHABLE_KEY must use a modern publishable key in pilot/production");
    if (!payload) fail("ACCOUNT_AUTH_PUBLISHABLE_KEY is neither an sb_publishable_ key nor an anon JWT");
    else {
      if (payload.role !== "anon") fail("ACCOUNT_AUTH_PUBLISHABLE_KEY must carry role=anon (service-role and other keys are refused)");
      if (typeof payload.ref === "string" && payload.ref.toLowerCase() === PRIVATE_PRODUCTION_PROJECT_REF) {
        fail("ACCOUNT_AUTH_PUBLISHABLE_KEY belongs to the PRIVATE production project");
      }
      if (mode === "staging" && ref && typeof payload.ref === "string" && payload.ref.toLowerCase() !== ref) {
        fail("ACCOUNT_AUTH_PUBLISHABLE_KEY belongs to a different project than ACCOUNT_AUTH_URL");
      }
    }
  }

  const csrf = raw.ACCOUNT_CSRF_SECRET ?? "";
  if (csrf.length < 32) fail("ACCOUNT_CSRF_SECRET is required and must be at least 32 characters");
  else if (/\s/.test(csrf) || csrf.length > 512) fail("ACCOUNT_CSRF_SECRET is malformed");

  if (issues.length) return { config: null, issues };
  return {
    config: { mode, authOrigin: origin, projectRef: ref, publishableKey: key, csrfSecret: csrf },
    issues,
  };
}
