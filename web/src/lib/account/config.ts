/**
 * Account System V1 — Auth-only configuration boundary (pure, side-effect free).
 *
 * The public website never talks to the private Supabase project. The ONLY exception V1
 * designs for is the account (Auth) boundary, and it is configured through a closed set of
 * variables validated here, separately from the public-site rules in `../env.ts`:
 *
 *   ACCOUNT_AUTH_MODE             disabled (default) | local | staging | production
 *   ACCOUNT_AUTH_URL              origin of the Supabase Auth/API gateway (no path, no credentials)
 *   ACCOUNT_AUTH_PUBLISHABLE_KEY  publishable/anon key ONLY (public by design, never a secret)
 *   ACCOUNT_AUTH_PROJECT_REF      staging only: must equal the project ref in the URL (double confirmation)
 *
 * Rules (each one has a negative test in tests/unit/account-config.test.ts):
 *   - `production` is NOT available in V1. Activation needs owner approval AND a reviewed code
 *     change that flips PRODUCTION_ACCOUNT_AUTH_APPROVED; no environment variable can do it.
 *   - `local` only on a developer machine (not hosted, deployment=local) against a loopback origin.
 *   - `staging` only against an https `<ref>.supabase.co` project that is NOT the private
 *     production project, never on ForeverDB production and never on Vercel's production target
 *     (the temporary demonstration alias), so account code cannot reach the production alias.
 *   - A service-role / secret key is rejected (decoded JWT role must be `anon`, or an
 *     `sb_publishable_` key). Any unknown ACCOUNT_AUTH_* variable is rejected (it may be a secret).
 *   - Messages name variables only, never values.
 *
 * Nothing here relaxes the global private-project guard in env.ts: that guard still rejects
 * the private project reference in every other variable, and in the public read database URL.
 */

/** Flipping this is a reviewed code change that requires explicit owner approval (go-live checklist). */
export const PRODUCTION_ACCOUNT_AUTH_APPROVED = false as boolean;

/** The private production Supabase project (Companion ingest, Guildbook). Staging must be a different project. */
export const PRIVATE_PRODUCTION_PROJECT_REF = "klxhikdlfwgxurdyexdi";

export type AccountAuthMode = "disabled" | "local" | "staging" | "production";

export interface AccountAuthConfig {
  mode: "local" | "staging";
  /** Origin only, e.g. https://abcdefghijklmnopqrst.supabase.co or http://127.0.0.1:54321 */
  authOrigin: string;
  projectRef: string | null;
  /** Publishable (anon) key. Public by design; still never logged or sent to the browser by this app. */
  publishableKey: string;
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
]);

const MODES = new Set(["disabled", "local", "staging", "production"]);
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

export function evaluateAccountAuth(raw: Record<string, string | undefined>, ctx: AccountAuthContext): AccountAuthResult {
  const issues: string[] = [];
  const fail = (m: string) => issues.push(m);
  const present = (name: string) => raw[name] !== undefined && raw[name] !== "";

  for (const name of Object.keys(raw)) {
    if (/^ACCOUNT_AUTH_/i.test(name) && !ALLOWED_VARIABLES.has(name) && present(name)) {
      fail(`${name}: unknown account-auth variable (only MODE, URL, PUBLISHABLE_KEY and PROJECT_REF are accepted)`);
    }
  }

  const modeRaw = raw.ACCOUNT_AUTH_MODE === undefined || raw.ACCOUNT_AUTH_MODE === "" ? "disabled" : raw.ACCOUNT_AUTH_MODE;
  if (!MODES.has(modeRaw)) {
    fail("ACCOUNT_AUTH_MODE must be one of disabled, local, staging, production");
    return { config: null, issues };
  }
  const mode = modeRaw as AccountAuthMode;

  if (mode === "disabled") {
    for (const name of ["ACCOUNT_AUTH_URL", "ACCOUNT_AUTH_PUBLISHABLE_KEY", "ACCOUNT_AUTH_PROJECT_REF"]) {
      if (present(name)) fail(`${name}: configured while ACCOUNT_AUTH_MODE is disabled`);
    }
    return { config: null, issues };
  }

  if (mode === "production") {
    if (!PRODUCTION_ACCOUNT_AUTH_APPROVED) {
      fail("ACCOUNT_AUTH_MODE=production is not available in Account System V1 (activation needs owner approval and a reviewed code change)");
    }
    // Even if a future change flips the constant, production requires every platform signal to agree.
    if (ctx.deployment !== "production" || ctx.platformEnv !== "production") {
      fail("ACCOUNT_AUTH_MODE=production requires FOREVERDB_DEPLOYMENT=production on Vercel's production environment");
    }
    return { config: null, issues };
  }

  // --- local / staging ----------------------------------------------------------------------
  if (ctx.deployment === "production") fail(`ACCOUNT_AUTH_MODE=${mode} is not allowed on a production deployment`);
  if (ctx.platformEnv === "production") {
    fail(`ACCOUNT_AUTH_MODE=${mode} is not allowed on Vercel's production target (the demonstration alias); use a preview deployment`);
  }
  if (mode === "local" && (ctx.hosted || ctx.deployment !== "local")) {
    fail("ACCOUNT_AUTH_MODE=local is only allowed on a developer machine (not hosted, FOREVERDB_DEPLOYMENT=local)");
  }

  // URL
  let origin = "";
  let ref: string | null = null;
  const urlRaw = raw.ACCOUNT_AUTH_URL ?? "";
  if (!urlRaw) {
    fail("ACCOUNT_AUTH_URL is required");
  } else if (mentionsPrivateProject(urlRaw)) {
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
      if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) fail("ACCOUNT_AUTH_URL must be an origin only (no path, query or fragment)");
      const hostName = u.hostname.toLowerCase();
      if (mode === "local") {
        if (!LOOPBACK.has(hostName)) fail("ACCOUNT_AUTH_URL must be a loopback address in local mode");
        if (u.protocol !== "http:" && u.protocol !== "https:") fail("ACCOUNT_AUTH_URL must be an http(s) URL");
      } else {
        if (u.protocol !== "https:") fail("ACCOUNT_AUTH_URL must be https in staging mode");
        const m = SUPABASE_HOST.exec(hostName);
        if (!m) fail("ACCOUNT_AUTH_URL must be a <project-ref>.supabase.co origin in staging mode");
        else {
          ref = m[1] ?? null;
          if (ref === PRIVATE_PRODUCTION_PROJECT_REF) fail("ACCOUNT_AUTH_URL is the PRIVATE production project");
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
    /* publishable key format */
  } else {
    const payload = decodeJwtPayload(key);
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

  if (issues.length) return { config: null, issues };
  return {
    config: { mode, authOrigin: origin, projectRef: ref, publishableKey: key },
    issues,
  };
}
