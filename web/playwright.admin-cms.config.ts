import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { consentStorageState } from "./tests/consent-seed";

/**
 * ADM-04: browser acceptance of the REAL Admin CMS UI against the REAL isolated backend: PostgreSQL 16 + pinned GoTrue + pinned PostgREST +
 * the ADM-03B private CMS + the ADM-03C delivery ledger, worker and public-read database + the ADM-04 reads (0027), all native in this repository.
 * The website under test is the production build of this checkout produced by tests/admin-cms-stack/build-site.sh. Nothing is mocked: without the stack
 * the suite fails (acceptance BLOCKED); it never falls back to the synthetic Admin preview.
 */
const stackDir = process.env.E2E_STACK_DIR ?? resolve(__dirname, "tests/admin-cms-stack/.stack");
const out: Record<string, string> = {};
try {
  for (const line of readFileSync(resolve(stackDir, "env"), "utf8").split("\n")) {
    const m = /^([A-Z_0-9]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!;
  }
} catch { /* reported below */ }
for (const [k, v] of Object.entries(out)) process.env[k] = v;
if (!out.ACCOUNT_STACK_ANON_KEY) throw new Error("Admin CMS stack not found: run web/tests/admin-cms-stack/up.sh then build-site.sh. Acceptance is BLOCKED without the real backend.");

export const SITE = "http://localhost:3220";
const executablePath = process.env.PW_CHROMIUM_PATH || undefined;
const env: Record<string, string> = {
  FOREVERDB_DEPLOYMENT: "local",
  RATE_LIMIT_BACKEND: "memory",
  TRUSTED_IP_HEADER: "x-forwarded-for",
  NEXT_TELEMETRY_DISABLED: "1",
  RATE_LIMITS_JSON: JSON.stringify({ account_auth: { global: 5000 }, account_light: { global: 50000 } }),
  SITE_URL: SITE,
  ACCOUNT_AUTH_MODE: "local",
  ACCOUNT_AUTH_URL: out.ACCOUNT_STACK_URL!,
  ACCOUNT_AUTH_PUBLISHABLE_KEY: out.ACCOUNT_STACK_ANON_KEY!,
  ACCOUNT_CSRF_SECRET: "acceptance-csrf-secret-0123456789abcdefghijklmnop",
  FOREVERDB_DATA_SOURCE: "postgres",
  FDB_CMS_DISPOSABLE: "1",
  AZERDEX_READ_DB_URL: `postgres://foreverdb_web_reader:local-test-only@${out.E2E_PG_HOST}:${out.E2E_PG_PORT}/${out.E2E_PUBDB}`,
};

export default defineConfig({
  testDir: "tests/admin-cms-e2e",
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["json", { outputFile: "test-results/admin-cms-e2e-results.json" }]],
  use: { baseURL: SITE, storageState: consentStorageState(SITE), launchOptions: executablePath ? { executablePath } : {}, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [{ name: "admin-cms-e2e", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } } }],
  webServer: { command: "npx next start -p 3220", cwd: __dirname, port: 3220, reuseExistingServer: false, timeout: 90_000, env },
});
