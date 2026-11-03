/**
 * The interactive-map POC is off by default. It is served only in `next dev`, or when a non-production
 * deployment explicitly sets AZERDEX_POC_MAPS=1. A production deployment never serves it.
 */
export function mapsPocEnabled(env: { FOREVERDB_DEPLOYMENT?: string; AZERDEX_POC_MAPS?: string; NODE_ENV?: string }): boolean {
  if (env.FOREVERDB_DEPLOYMENT === "production") return false;
  return env.NODE_ENV === "development" || env.AZERDEX_POC_MAPS === "1";
}
