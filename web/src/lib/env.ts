import "server-only";
import { z } from "zod";

/**
 * Server-only runtime configuration. Validated once; the process refuses to
 * serve with an unsafe combination (fail closed).
 *
 * Environment boundaries (see docs/web/vercel-environments.md):
 *   local       developer machine: fixture data, memory rate limiter, localhost URLs.
 *   preview     hosted, protected, non-indexable. Fixture data (labelled synthetic) or a
 *               PUBLIC read database. This is also what the temporary demonstration
 *               served from the Vercel production alias must declare.
 *   production  the real public release. Only the separate PUBLIC PostgreSQL read model,
 *               distributed rate limiting, https, validated secrets. Never fixtures.
 *
 * A hosted deployment (Vercel) never falls back to `local`: the designation, the data
 * source and the site URL must be consistent with the platform's own deployment
 * metadata (VERCEL_ENV, VERCEL_PROJECT_PRODUCTION_URL, ...). Note that a Vercel
 * "production" target is NOT proof of a ForeverDB production release: the temporary
 * synthetic demonstration is served through the production alias and must say
 * FOREVERDB_DEPLOYMENT=preview.
 *
 * Only NEXT_PUBLIC_* values may ever reach the browser; none of them are secrets.
 * The website never receives production Supabase credentials. Error messages name
 * variables only, never their values.
 */

// The private production Supabase project. The website must never talk to it.
const FORBIDDEN_DATABASE_MARKERS = ["klxhikdlfwgxurdyexdi"];

/** Variable names the public website must never be given (private backend credentials). */
const FORBIDDEN_VARIABLE_NAME = /(^|_)SUPABASE(_|$)|SERVICE_ROLE|^DATABASE_URL$|^POSTGRES_(URL|PRISMA_URL|URL_NON_POOLING|URL_NO_SSL)$/i;

/** Platform-provided metadata (commit messages, branch names, ...) may legitimately mention anything. */
const SYSTEM_METADATA_NAME = /^(NEXT_PUBLIC_)?VERCEL_/i;

/** Variables whose values are scanned for the private project reference. System metadata is excluded. */
const SCANNED_VARIABLE_NAME = /^(FOREVERDB_|PUBLIC_|SITE_URL$|UPSTASH_|RATE_LIMIT|TURNSTILE_|CHALLENGE_|NEXT_PUBLIC_|TRUSTED_)|DATABASE|POSTGRES|SUPABASE|DB_URL/i;

export type DeploymentKind = "local" | "preview" | "production";
export type RawEnv = Record<string, string | undefined>;

const Base = z.object({
  FOREVERDB_DEPLOYMENT: z.enum(["local", "preview", "production"]).optional(),
  FOREVERDB_DATA_SOURCE: z.enum(["fixture", "postgres"]).optional(),
  PUBLIC_READ_DATABASE_URL: z.string().optional(),
  SITE_URL: z.string().optional(),
  RATE_LIMIT_BACKEND: z.enum(["memory", "upstash"]).default("memory"),
  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(20).optional(),
  RATE_LIMIT_SALT: z.string().min(32).optional(),
  TRUSTED_IP_HEADER: z.enum(["x-real-ip", "x-forwarded-for", "cf-connecting-ip", "none"]).optional(),
  TURNSTILE_SECRET_KEY: z.string().min(10).optional(),
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: z.string().min(10).optional(),
  CHALLENGE_COOKIE_SECRET: z.string().min(32).optional(),
});

export interface ServerEnv {
  FOREVERDB_DEPLOYMENT: DeploymentKind;
  FOREVERDB_DATA_SOURCE: "fixture" | "postgres";
  PUBLIC_READ_DATABASE_URL?: string;
  /** Resolved, normalised origin (no path). Always https on hosted deployments. */
  SITE_URL: string;
  RATE_LIMIT_BACKEND: "memory" | "upstash";
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
  RATE_LIMIT_SALT?: string;
  TRUSTED_IP_HEADER: "x-real-ip" | "x-forwarded-for" | "cf-connecting-ip" | "none";
  TURNSTILE_SECRET_KEY?: string;
  NEXT_PUBLIC_TURNSTILE_SITE_KEY?: string;
  CHALLENGE_COOKIE_SECRET?: string;
  /** True on a hosted (Vercel) deployment or production/preview environment. */
  hosted: boolean;
  /** Vercel's own environment (production | preview), when hosted on Vercel. */
  platformEnv?: "production" | "preview";
}

export function detectHosting(raw: RawEnv): { onVercel: boolean; hosted: boolean; vercelEnv?: "production" | "preview" | "development" } {
  const v = raw.VERCEL_ENV;
  const vercelEnv = v === "production" || v === "preview" || v === "development" ? v : undefined;
  const onVercel = raw.VERCEL === "1" || raw.VERCEL === "true" || v !== undefined;
  // `vercel dev` is a developer machine; every real deployment is hosted.
  return { onVercel, hosted: onVercel && vercelEnv !== "development", vercelEnv };
}

/**
 * Host of any URL, normalised by the WHATWG special-scheme parser (so postgresql:// hosts such as
 * `0x7f.1` or `[::ffff:7f00:1]` are canonicalised exactly like https ones). Lowercase, no brackets,
 * no trailing dot.
 */
function hostOf(url: string): string | null {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^/?#@]*@)?([^/?#]*)/i.exec(url.trim());
  if (!m) return null;
  try {
    return normaliseHost(new URL(`https://${m[1]}`).hostname);
  } catch {
    return null;
  }
}

function normaliseHost(h: string): string {
  return h.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
}

const LOCAL_HOST = /^(localhost|.*\.localhost|.*\.local|.*\.internal|127\.\d+\.\d+\.\d+|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+)$/;
function isLocalHost(host: string | null): boolean {
  if (host === null) return true;
  const h = normaliseHost(host);
  if (h === "" || LOCAL_HOST.test(h)) return true;
  // IPv6 literals: unspecified, loopback, IPv4-mapped (any), unique-local fc00::/7, link-local fe80::/10.
  if (h.includes(":")) return h === "::" || h === "::1" || h.startsWith("::ffff:") || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h);
  return false;
}

/** Case-insensitive check for the private project reference: NFKC-folded and percent-decoded repeatedly (double encoding, fullwidth forms). */
function referencesPrivateProject(value: string): boolean {
  const forms = new Set<string>();
  let current = value;
  for (let i = 0; i < 4; i += 1) {
    forms.add(current.normalize("NFKC").toLowerCase());
    try {
      const next = decodeURIComponent(current);
      if (next === current) break;
      current = next;
    } catch {
      break;
    }
  }
  return [...forms].some((f) => FORBIDDEN_DATABASE_MARKERS.some((m) => f.includes(m)));
}

/**
 * Pure, side-effect-free evaluation of the environment. Returns the resolved
 * configuration or the list of violated rules (variable names only).
 */
export function evaluateEnv(raw: RawEnv): { ok: true; env: ServerEnv } | { ok: false; issues: string[] } {
  const issues: string[] = [];
  const fail = (m: string) => issues.push(m);

  const parsed = Base.safeParse(raw);
  if (!parsed.success) {
    // Never forward Zod's own text for enums: it echoes the received value ("received ' preview'"),
    // and a mis-pasted secret in an enum variable would be thrown and logged.
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => {
        const where = i.path.join(".") || "environment";
        if (i.code === "invalid_enum_value") return `${where}: must be one of ${i.options.join(" | ")}`;
        if (i.code === "too_small") return `${where}: is too short`;
        if (i.code === "invalid_string") return `${where}: is not a valid value`;
        return `${where}: is invalid`;
      }),
    };
  }
  const b = parsed.data;
  const host = detectHosting(raw);

  // 1. Deployment designation ------------------------------------------------
  let deployment: DeploymentKind;
  if (b.FOREVERDB_DEPLOYMENT) {
    deployment = b.FOREVERDB_DEPLOYMENT;
  } else if (host.hosted) {
    fail("FOREVERDB_DEPLOYMENT must be set explicitly on a hosted deployment (preview or production); hosted deployments never default to local");
    deployment = "preview"; // placeholder so later rules can still report; ok:false anyway
  } else {
    deployment = "local";
  }
  if (host.hosted && deployment === "local") fail("FOREVERDB_DEPLOYMENT=local is not permitted on a hosted deployment");
  if (deployment === "production" && host.onVercel && host.vercelEnv !== "production") {
    fail("FOREVERDB_DEPLOYMENT=production is only valid in the Vercel production environment (VERCEL_ENV=production)");
  }

  // 2. Data source -----------------------------------------------------------
  let dataSource: "fixture" | "postgres";
  if (b.FOREVERDB_DATA_SOURCE) dataSource = b.FOREVERDB_DATA_SOURCE;
  else if (host.hosted) {
    fail("FOREVERDB_DATA_SOURCE must be set explicitly on a hosted deployment (fixture or postgres)");
    dataSource = "fixture";
  } else dataSource = "fixture";
  if (deployment === "production" && dataSource !== "postgres") fail("production must not serve the synthetic fixture dataset");

  // 3. Public read database --------------------------------------------------
  if (dataSource === "postgres") {
    const url = b.PUBLIC_READ_DATABASE_URL;
    if (!url) fail("PUBLIC_READ_DATABASE_URL is required for the postgres data source");
    else if (referencesPrivateProject(url)) {
      fail("PUBLIC_READ_DATABASE_URL points at the PRIVATE production database; refusing to start");
    } else {
      let user = "";
      try {
        user = decodeURIComponent(new URL(url).username);
      } catch {
        fail("PUBLIC_READ_DATABASE_URL is not a valid URL");
      }
      // Plain role name, or Supavisor pooler form "<role>.<project-ref>".
      if (user !== "foreverdb_web_reader" && !user.startsWith("foreverdb_web_reader.")) {
        fail("PUBLIC_READ_DATABASE_URL must use the least-privilege foreverdb_web_reader role");
      }
      if (host.hosted && isLocalHost(hostOf(url))) fail("PUBLIC_READ_DATABASE_URL must not point at a local address on a hosted deployment");
    }
  }

  // 4. Private-backend credentials never belong in the public website ----------
  // (A developer machine in plain local mode legitimately carries unrelated tooling variables.)
  for (const [name, value] of Object.entries(raw)) {
    if (!(host.hosted || deployment !== "local")) break;
    if (value === undefined || value === "") continue;
    if (FORBIDDEN_VARIABLE_NAME.test(name)) fail(`${name}: private backend credentials must not be configured for the public website`);
    else if (SCANNED_VARIABLE_NAME.test(name) && !SYSTEM_METADATA_NAME.test(name) && referencesPrivateProject(value)) {
      fail(`${name}: references the PRIVATE production project; refusing to start`);
    }
  }

  // 5. Site URL --------------------------------------------------------------
  let siteUrlRaw = b.SITE_URL;
  if (!siteUrlRaw) {
    if (host.hosted && deployment === "preview") {
      // Preview derives its own origin from the platform (production-target demo uses the production alias).
      const derived = (host.vercelEnv === "production" ? raw.VERCEL_PROJECT_PRODUCTION_URL : undefined) || raw.VERCEL_BRANCH_URL || raw.VERCEL_URL;
      if (derived) siteUrlRaw = `https://${derived}`;
      else fail("SITE_URL is required (no Vercel URL metadata is available to derive it)");
    } else if (host.hosted) {
      fail("SITE_URL must be set explicitly on a hosted production deployment");
    } else {
      siteUrlRaw = "http://localhost:3000";
    }
  }
  let siteUrl = "http://localhost:3000";
  if (siteUrlRaw) {
    let u: URL | null = null;
    try {
      u = new URL(siteUrlRaw);
    } catch {
      fail("SITE_URL is not a valid URL");
    }
    if (u) {
      if (u.username || u.password) fail("SITE_URL must not contain credentials");
      if (u.protocol !== "https:" && u.protocol !== "http:") fail("SITE_URL must be an http(s) URL");
      siteUrl = u.origin;
      const local = isLocalHost(u.hostname.toLowerCase());
      if (host.hosted) {
        if (u.protocol !== "https:") fail("SITE_URL must be https on a hosted deployment");
        if (local) fail("SITE_URL must not be a local address on a hosted deployment");
      }
      if (deployment === "local" && !local) fail("local mode requires a localhost SITE_URL");
      if (deployment === "production") {
        if (u.protocol !== "https:") fail("production SITE_URL must be https");
        const prodHost = raw.VERCEL_PROJECT_PRODUCTION_URL?.toLowerCase();
        if (host.onVercel && prodHost && u.hostname.toLowerCase() !== prodHost) {
          fail("SITE_URL must equal the project's production domain (VERCEL_PROJECT_PRODUCTION_URL)");
        }
      }
    }
  }

  // 6. Abuse controls --------------------------------------------------------
  // Unset on Vercel: x-real-ip is overwritten by the platform, so it is the safe default. An explicit
  // "none" would hash every visitor into ONE bucket (one bot could rate-limit everyone), so hosted rejects it.
  const trustedIp = b.TRUSTED_IP_HEADER ?? (host.onVercel && host.hosted ? "x-real-ip" : "none");
  if (host.hosted && trustedIp === "none") fail("TRUSTED_IP_HEADER=none on a hosted deployment would put every visitor in one rate-limit bucket");
  if (deployment === "production") {
    if (b.RATE_LIMIT_BACKEND !== "upstash") fail("production requires the distributed (upstash) rate limiter");
    if (trustedIp === "none") fail("production requires TRUSTED_IP_HEADER");
    if (!b.RATE_LIMIT_SALT) fail("production requires RATE_LIMIT_SALT");
  }
  if (b.RATE_LIMIT_BACKEND === "upstash" && (!b.UPSTASH_REDIS_REST_URL || !b.UPSTASH_REDIS_REST_TOKEN)) {
    fail("upstash rate limiter requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN");
  }
  if (host.onVercel && trustedIp === "cf-connecting-ip") {
    fail("TRUSTED_IP_HEADER=cf-connecting-ip is only trustworthy behind Cloudflare; on Vercel use x-real-ip");
  }
  if (b.TURNSTILE_SECRET_KEY && (!b.NEXT_PUBLIC_TURNSTILE_SITE_KEY || !b.CHALLENGE_COOKIE_SECRET)) {
    fail("Turnstile requires NEXT_PUBLIC_TURNSTILE_SITE_KEY and CHALLENGE_COOKIE_SECRET");
  }

  if (issues.length) return { ok: false, issues };
  return {
    ok: true,
    env: {
      ...b,
      TRUSTED_IP_HEADER: trustedIp,
      FOREVERDB_DEPLOYMENT: deployment,
      FOREVERDB_DATA_SOURCE: dataSource,
      SITE_URL: siteUrl,
      hosted: host.hosted,
      platformEnv: host.vercelEnv === "production" || host.vercelEnv === "preview" ? host.vercelEnv : undefined,
    },
  };
}

let cached: ServerEnv | null = null;

export function serverEnv(): ServerEnv {
  if (cached) return cached;
  const r = evaluateEnv(process.env);
  if (!r.ok) {
    // Messages name variables only, never their values.
    throw new Error(`Unsafe ForeverDB configuration: ${r.issues.join("; ")}`);
  }
  cached = r.env;
  return cached;
}

/** Only the real production release is indexable. */
export function isIndexable(env: Pick<ServerEnv, "FOREVERDB_DEPLOYMENT">): boolean {
  return env.FOREVERDB_DEPLOYMENT === "production";
}

export function siteUrl(path = "/"): string {
  return new URL(path, serverEnv().SITE_URL).toString();
}
