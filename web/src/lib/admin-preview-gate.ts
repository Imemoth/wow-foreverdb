import "server-only";
import { evaluateEnv, type RawEnv } from "./env";

/**
 * ADM-UI-PREVIEW-01 isolation gate. The Admin UI preview is a SYNTHETIC, in-browser demonstration. It must never exist in, or be
 * reachable from, a normal build, a hosted deployment or anything wired to real services. Three independent layers:
 *
 *  1. BUILD: `ADMIN_PREVIEW_BUILD` is inlined by next.config.ts (`env`) at build time from AZERDEX_ADMIN_PREVIEW_BUILD. In a normal build it is the
 *     constant `false`, and the preview route files (`*.preview.tsx`) are not even recognised as routes (pageExtensions), so no preview code is
 *     compiled into the output. A runtime environment variable cannot turn it on.
 *  2. RUNTIME: even in a preview build, `evaluatePreviewGate` must say "allowed". Every condition must hold; absence or inconsistency => closed.
 *  3. ROUTE: the proxy answers 404 before any page code unless 1 and 2 hold, and the preview layout/page re-check (defence in depth).
 *
 * There is deliberately NO preview API route: all preview state lives in the browser tab. Nothing here reads, mints or forwards a credential.
 */
export const ADMIN_PREVIEW_PATH_PREFIX = "/admin-preview";
export const ADMIN_PREVIEW_BUILD: boolean = process.env.AZERDEX_ADMIN_PREVIEW_BUILD === "1";
/** The only accepted runtime value: it states the intent explicitly so a stray boolean-ish value never enables the preview. */
export const ADMIN_PREVIEW_RUNTIME_VALUE = "isolated-synthetic";

/** Names that indicate production/private backends. Presence (non-empty) of ANY of them closes the gate. */
const BACKEND_NAME = /(^|_)SUPABASE(_|$)|(^|_)DATABASE_URL$|^POSTGRES_|^PG(HOST|PASSWORD|USER|DATABASE)$|DB_URL$|^ACCOUNT_(AUTH|CSRF)|UPSTASH|TURNSTILE_SECRET|CHALLENGE_COOKIE_SECRET|RATE_LIMIT_SALT|^ADMIN_(AUTH|OWNER|BOOTSTRAP)|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|API_KEY|PRIVATE_KEY|_KEY$/i;
/** Other hosting platforms' markers: this preview is loopback-only, so any of them closes the gate. */
const OTHER_HOST_SIGNAL = /^(NETLIFY|AWS_LAMBDA_FUNCTION_NAME|AWS_EXECUTION_ENV|K_SERVICE|CF_PAGES|RENDER|FLY_APP_NAME|RAILWAY_ENVIRONMENT|KUBERNETES_SERVICE_HOST|WEBSITE_SITE_NAME|DYNO)$/;
// (The private production project reference is already scanned by evaluateEnv below; it is deliberately not repeated here.)
const PRIVATE_VALUE = /postgres(ql)?:\/\/|-----BEGIN [A-Z ]*PRIVATE KEY-----/i;

export type PreviewGate = { allowed: true } | { allowed: false; reason: string };

export function evaluatePreviewGate(raw: RawEnv = process.env, build: boolean = ADMIN_PREVIEW_BUILD): PreviewGate {
  const no = (reason: string): PreviewGate => ({ allowed: false, reason });
  try {
    if (!build) return no("not a preview build");
    if (raw.AZERDEX_ADMIN_PREVIEW === undefined || raw.AZERDEX_ADMIN_PREVIEW === "") return no("preview runtime flag absent");
    if (raw.AZERDEX_ADMIN_PREVIEW !== ADMIN_PREVIEW_RUNTIME_VALUE) return no("preview runtime flag has an unexpected value");
    if (raw.AZERDEX_ADMIN_PREVIEW_DATA !== "synthetic") return no("synthetic-data acknowledgement absent or inconsistent");
    // A hosted deployment (any Vercel signal) never qualifies here. A hosted preview needs its own approved, access-protected design.
    if (Object.keys(raw).some((k) => /^(NEXT_PUBLIC_)?VERCEL_?/i.test(k) && raw[k] !== undefined && raw[k] !== "")) return no("hosted platform signal present");
    if (Object.keys(raw).some((k) => OTHER_HOST_SIGNAL.test(k) && raw[k] !== undefined && raw[k] !== "")) return no("hosted platform signal present");
    if (raw.FOREVERDB_DEPLOYMENT !== "local" || raw.FOREVERDB_DATA_SOURCE !== "fixture") return no("deployment must be explicitly local with fixture data");
    if (raw.AZERDEX_READ_DB_URL) return no("a database URL is configured");
    if (raw.BETA_SEO_AUTHORIZED_BRANCH) return no("beta SEO authorization present");
    for (const [k, v] of Object.entries(raw)) {
      if (v === undefined || v === "") continue;
      if (BACKEND_NAME.test(k) && !/^NEXT_TELEMETRY|^NODE_/i.test(k)) return no(`backend/secret configuration present (${k})`);
      if (/URL|URI|KEY|TOKEN|SECRET|PASSWORD|DSN|CONN|DATABASE|SITE|FOREVERDB|AZERDEX|ACCOUNT/i.test(k) && PRIVATE_VALUE.test(v)) return no(`private-looking value present in ${k}`);
    }
    const r = evaluateEnv(raw);
    if (!r.ok) return no("environment configuration is invalid");
    if (r.env.hosted || r.env.platformEnv !== undefined) return no("hosted environment");
    const host = new URL(r.env.SITE_URL).hostname;
    if (host !== "localhost" && host !== "127.0.0.1") return no("SITE_URL is not loopback");
    return { allowed: true };
  } catch {
    return no("gate evaluation failed");
  }
}

/** Matches on the DECODED, lower-cased path so encoded or differently-cased spellings of the prefix are still treated as preview paths. */
export const isAdminPreviewPath = (pathname: string): boolean => {
  let p = pathname;
  try { p = decodeURIComponent(pathname); } catch { /* malformed escape: fall through with the raw path, and treat it as a preview path if it looks like one */ }
  p = p.toLowerCase().replace(/\/{2,}/g, "/");
  return p === ADMIN_PREVIEW_PATH_PREFIX || p.startsWith(`${ADMIN_PREVIEW_PATH_PREFIX}/`);
};

/** The preview is loopback-only: a Host header that is not loopback (tunnel, rebinding, 0.0.0.0 exposure) is refused. */
export const isLoopbackHost = (hostHeader: string | null): boolean => {
  const h = (hostHeader ?? "").toLowerCase();
  const name = h.startsWith("[") ? h.slice(0, h.indexOf("]") + 1) : h.split(":")[0];
  return name === "localhost" || name === "127.0.0.1" || name === "[::1]";
};
