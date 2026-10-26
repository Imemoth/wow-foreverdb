import { evaluateEnv, type RawEnv } from "./env";

/**
 * Gate for the Playwright-only harness pages under /test-fixtures (synthetic data that must never be reachable on a real site).
 * `E2E_FIXTURES_ENABLED=1` alone is NOT enough: a copy of that variable into the beta or Production environment (or a `next start` of a
 * hosted build) must still 404. Every condition below must hold, and any doubt means "not allowed":
 *  - the flag is exactly "1";
 *  - no Vercel platform signal at all (VERCEL, VERCEL_ENV, VERCEL_URL, VERCEL_GIT_*, ...): a hosted deployment, preview or production, never qualifies;
 *  - the configuration is valid and EXPLICITLY `FOREVERDB_DEPLOYMENT=local` with the synthetic fixture data source and no database URL
 *    (the beta serves PostgreSQL and always has one);
 *  - no beta SEO branch authorization and a localhost SITE_URL.
 */
export function e2eFixturesAllowed(raw: RawEnv = process.env): boolean {
  try {
    if (raw.E2E_FIXTURES_ENABLED !== "1") return false;
    if (Object.keys(raw).some((k) => /^(NEXT_PUBLIC_)?VERCEL_?/i.test(k) && raw[k] !== undefined && raw[k] !== "")) return false;
    if (raw.FOREVERDB_DEPLOYMENT !== "local" || raw.FOREVERDB_DATA_SOURCE !== "fixture") return false;
    if (raw.AZERDEX_READ_DB_URL) return false;
    if (raw.BETA_SEO_AUTHORIZED_BRANCH) return false;
    const r = evaluateEnv(raw);
    if (!r.ok) return false;
    const e = r.env;
    if (e.hosted || e.platformEnv !== undefined) return false;
    if (e.FOREVERDB_DEPLOYMENT !== "local" || e.FOREVERDB_DATA_SOURCE !== "fixture") return false;
    const host = new URL(e.SITE_URL).hostname;
    return host === "localhost" || host === "127.0.0.1";
  } catch {
    return false;
  }
}

/** The whole harness tree this gate protects (the proxy refuses it before any page code runs). */
export const E2E_FIXTURE_PATH_PREFIX = "/test-fixtures";
