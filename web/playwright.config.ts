import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3200);
const executablePath = process.env.PW_CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["json", { outputFile: "test-results/e2e-results.json" }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    launchOptions: executablePath ? { executablePath } : {},
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1366, height: 900 } } },
    { name: "mobile", use: { ...devices["Pixel 7"] }, testMatch: /responsive\.spec\.ts/ },
  ],
  webServer: {
    command: `npx next start -p ${PORT}`,
    port: PORT,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      FOREVERDB_DEPLOYMENT: "local",
      FOREVERDB_DATA_SOURCE: process.env.FOREVERDB_DATA_SOURCE ?? "fixture",
      PUBLIC_READ_DATABASE_URL: process.env.PUBLIC_READ_DATABASE_URL ?? "",
      SITE_URL: `http://localhost:${PORT}`,
      RATE_LIMIT_BACKEND: "memory",
      // Lets each test act as a distinct client; the rate-limit spec relies on it.
      TRUSTED_IP_HEADER: "x-forwarded-for",
      RATE_LIMITS_JSON: JSON.stringify({ api_search: { perIp: 12, perSession: 1000, challengeAt: 1000 } }),
      NEXT_TELEMETRY_DISABLED: "1",
    },
  },
});
