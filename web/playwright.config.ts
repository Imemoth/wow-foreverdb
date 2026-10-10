import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3200);
// Second server: simulates a hosted Vercel PREVIEW deployment (explicit designation, https site URL,
// Vercel deployment metadata). Used only by HTTP-level specs (tests/e2e/preview-safety.spec.ts).
export const PREVIEW_PORT = Number(process.env.E2E_PREVIEW_PORT ?? 3201);
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
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1366, height: 900 } },
      testIgnore: /preview-safety\.spec\.ts/,
    },
    { name: "mobile", use: { ...devices["Pixel 7"] }, testMatch: /responsive\.spec\.ts/ },
    {
      name: "preview",
      testMatch: /preview-safety\.spec\.ts/,
      use: { baseURL: `http://localhost:${PREVIEW_PORT}` },
    },
  ],
  webServer: [
    {
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
    {
      command: `npx next start -p ${PREVIEW_PORT}`,
      port: PREVIEW_PORT,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        // Hosted-preview simulation: what Vercel provides plus the explicit ForeverDB designation.
        VERCEL: "1",
        VERCEL_ENV: "preview",
        VERCEL_URL: "foreverdb-preview-abc123.vercel.app",
        VERCEL_BRANCH_URL: "foreverdb-git-preview-test.vercel.app",
        FOREVERDB_DEPLOYMENT: "preview",
        FOREVERDB_DATA_SOURCE: "fixture",
        PUBLIC_READ_DATABASE_URL: "",
        SITE_URL: "https://preview.foreverdb.test",
        RATE_LIMIT_BACKEND: "memory",
        TRUSTED_IP_HEADER: "x-forwarded-for",
        RATE_LIMITS_JSON: JSON.stringify({ api_search: { perIp: 12, perSession: 1000, challengeAt: 1000 } }),
        NEXT_TELEMETRY_DISABLED: "1",
      },
    },
  ],
});
