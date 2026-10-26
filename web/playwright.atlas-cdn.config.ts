import { defineConfig, devices } from "@playwright/test";

// Local acceptance only (needs the private real atlas dist). Requires a build made WITH the asset base URL:
//   NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL=https://azerdex-assets.pages.dev npx next build
//   ATLAS_REAL_DIST=<out>/dist npx playwright test -c playwright.atlas-cdn.config.ts
const PORT = Number(process.env.E2E_CDN_PORT ?? 3300);
const executablePath = process.env.PW_CHROMIUM_PATH || undefined;
const BASE = process.env.NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL ?? "https://azerdex-assets.pages.dev";
// A real local HTTPS server (started by the spec) stands in for the CDN: Chromium resolves the allow-listed asset host to it, so the BROWSER enforces
// CORS and CSP for real (Playwright's route.fulfill would inject CORS headers and prove nothing). --no-proxy-server: the sandbox's HTTPS proxy must not sit
// between Chromium and this local server. Test-only flags; never used by the normal config.
const CDN_PORT = Number(process.env.E2E_CDN_ORIGIN_PORT ?? 3443);

export default defineConfig({
  testDir: "tests/atlas-cdn",
  timeout: 30_000,
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
      FOREVERDB_DEPLOYMENT: "local", AZERDEX_POC_MAPS: "1", FOREVERDB_DATA_SOURCE: "fixture", AZERDEX_READ_DB_URL: "",
      SITE_URL: `http://localhost:${PORT}`, RATE_LIMIT_BACKEND: "memory", TRUSTED_IP_HEADER: "x-forwarded-for", NEXT_TELEMETRY_DISABLED: "1",
      NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL: BASE,
    },
  },
});
