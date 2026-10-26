import { defineConfig, devices } from "@playwright/test";

// Zone atlas maps (P2-Z1): zone directory, /zone/[id] map, source-page maps. Needs a build made WITH the asset base:
//   NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL=https://azerdex-assets.pages.dev npx next build
//   npx playwright test -c playwright.zone-maps.config.ts                                  (synthetic CDN: runs anywhere)
//   ATLAS_REAL_DIST=<approved dist> npx playwright test -c playwright.zone-maps.config.ts  (real artwork, local acceptance)
//   E2E_HERO_SOURCE=cdn npx playwright test -c playwright.zone-maps.config.ts              (cinematic heroes from <CDN>/zone-heroes/...)
// A real local HTTPS server stands in for the CDN host: Chromium resolves azerdex-assets.pages.dev to it, so the BROWSER enforces CORS and
// CSP. --no-proxy-server keeps a sandbox proxy out of the way. Test-only flags; never used by the normal config.
const PORT = Number(process.env.E2E_ZONE_PORT ?? 3310);
const CDN_PORT = Number(process.env.E2E_CDN_ORIGIN_PORT ?? 3443);
const executablePath = process.env.PW_CHROMIUM_PATH || undefined;
const BASE = process.env.NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL ?? "https://azerdex-assets.pages.dev";
// Where the cinematic heroes come from: default "local" (same-origin rollback files); E2E_HERO_SOURCE=cdn serves them from the (synthetic or real)
// CDN host's zone-heroes/ namespace. The whole suite runs in both modes; the CDN-only spec skips itself in local mode.
const HERO_SOURCE = process.env.E2E_HERO_SOURCE === "cdn" ? "cdn" : "local";

export default defineConfig({
  testDir: "tests/zone-maps",
  timeout: 45_000,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    ignoreHTTPSErrors: true,
    launchOptions: { ...(executablePath ? { executablePath } : {}), args: [`--host-resolver-rules=MAP azerdex-assets.pages.dev 127.0.0.1:${CDN_PORT}`, "--ignore-certificate-errors", "--no-proxy-server"] },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1366, height: 900 } } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: `npx next start -p ${PORT}`,
    port: PORT,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      FOREVERDB_DEPLOYMENT: "local", E2E_FIXTURES_ENABLED: "1", AZERDEX_ZONE_MAPS: "1", AZERDEX_POC_MAPS: "1", AZERDEX_ATLAS_CATALOG: "snapshot",
      FOREVERDB_DATA_SOURCE: "fixture", AZERDEX_READ_DB_URL: "", SITE_URL: `http://localhost:${PORT}`, RATE_LIMIT_BACKEND: "memory",
      TRUSTED_IP_HEADER: "x-forwarded-for", NEXT_TELEMETRY_DISABLED: "1",
      // These specs make far more page requests from one client than any person would: lift the page rule (the suite is not about rate limiting).
      RATE_LIMITS_JSON: JSON.stringify({ page_db: { perIp: 100000, perSession: 100000, challengeAt: 100000 } }), NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL: BASE,
      AZERDEX_ZONE_HERO_SOURCE: HERO_SOURCE,
    },
  },
});
