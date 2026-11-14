import { defineConfig, devices } from "@playwright/test";

/**
 * ADM-UI-PREVIEW-01 browser acceptance. Builds the dedicated preview build (.next-admin-preview) and serves it on loopback with the scrubbed
 * environment from scripts/admin-preview.mjs. Two extra servers serve the SAME preview build with its runtime gate deliberately broken, to prove it
 * fails closed. Nothing here touches production services; no credential is read or written.
 */
const PORT = Number(process.env.ADMIN_PREVIEW_PORT ?? 3300);
const CLOSED_PORT = PORT + 2;
const BACKEND_PORT = PORT + 3;
const reuse = process.env.REUSE_PREVIEW_SERVERS === "1";
const executablePath = process.env.PW_CHROMIUM_PATH || undefined;
const nextBin = "node_modules/next/dist/bin/next";
// A deliberately minimal environment for the gate-failure servers (build flag only picks the dist dir / page extensions).
const base = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NEXT_TELEMETRY_DISABLED: "1", AZERDEX_ADMIN_PREVIEW_BUILD: "1", FOREVERDB_DEPLOYMENT: "local", FOREVERDB_DATA_SOURCE: "fixture", RATE_LIMIT_BACKEND: "memory" };

export default defineConfig({
  testDir: "tests/admin-preview",
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["json", { outputFile: "test-results/admin-preview-results.json" }]],
  outputDir: "test-results/admin-preview",
  use: { baseURL: `http://localhost:${PORT}`, launchOptions: executablePath ? { executablePath } : {}, trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1366, height: 900 } }, testIgnore: /isolation\.spec\.ts/ },
    { name: "isolation", testMatch: /isolation\.spec\.ts/, use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: [
    { command: "node scripts/admin-preview.mjs all", url: `http://localhost:${PORT}/admin-preview`, reuseExistingServer: reuse, timeout: 240_000, env: { ADMIN_PREVIEW_PORT: String(PORT), PATH: process.env.PATH ?? "" } },
    // Gate failure 1: the preview build with its runtime flag ABSENT.
    { command: `node ${nextBin} start -p ${CLOSED_PORT} -H 127.0.0.1`, port: CLOSED_PORT, reuseExistingServer: reuse, timeout: 120_000, env: { ...base, SITE_URL: `http://localhost:${CLOSED_PORT}` } },
    // Gate failure 2: every preview flag correct, but a backend variable (a database/Auth configuration) is present. (A hosted Vercel environment cannot even
    // load this build: next.config.ts refuses it, which tests/unit/admin-preview-build-config.test.ts covers.)
    { command: `node ${nextBin} start -p ${BACKEND_PORT} -H 127.0.0.1`, port: BACKEND_PORT, reuseExistingServer: reuse, timeout: 120_000, env: { ...base, AZERDEX_ADMIN_PREVIEW: "isolated-synthetic", AZERDEX_ADMIN_PREVIEW_DATA: "synthetic", SUPABASE_URL: "https://example.invalid", SITE_URL: `http://localhost:${BACKEND_PORT}` } },
  ],
});
