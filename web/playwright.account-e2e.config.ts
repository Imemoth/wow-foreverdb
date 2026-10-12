import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * Account System V1, PR E: INTEGRATED acceptance. The website's production build (one `next start`) talks to a REAL, ephemeral
 * GoTrue and a REAL PostgREST in front of PostgreSQL 16 with migrations 0001-0012 (see tests/e2e-stack/README.md). Test clients
 * stand in for the Companion: they call GoTrue and PostgREST directly with real tokens. Nothing is mocked; if the stack is not
 * running the suite fails (acceptance BLOCKED), it never falls back.
 */
function loadStackEnv(): Record<string, string> {
  const file = process.env.E2E_STACK_ENV_FILE ?? resolve(__dirname, "tests/e2e-stack/.stack/env");
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = /^([A-Z_0-9]+)=(.*)$/.exec(line.trim());
      if (m) out[m[1]!] = m[2]!;
    }
  } catch {
    /* fall through to process.env */
  }
  return out;
}
const stack = loadStackEnv();
for (const [k, v] of Object.entries(stack)) process.env[k] = v; // test workers read the stack coordinates from the environment
if (!stack.ACCOUNT_STACK_ANON_KEY || !stack.E2E_POSTGREST_URL) {
  throw new Error("End-to-end stack not found: start web/tests/e2e-stack/up.sh. Integrated acceptance is BLOCKED without real GoTrue + PostgREST.");
}
const common = {
  FOREVERDB_DATA_SOURCE: "fixture",
  RATE_LIMIT_BACKEND: "memory",
  TRUSTED_IP_HEADER: "x-forwarded-for",
  NEXT_TELEMETRY_DISABLED: "1",
  RATE_LIMITS_JSON: JSON.stringify({ account_auth: { global: 5000 }, account_light: { global: 50000 } }),
  FOREVERDB_DEPLOYMENT: "local",
  ACCOUNT_AUTH_MODE: "local",
  ACCOUNT_AUTH_PUBLISHABLE_KEY: stack.ACCOUNT_STACK_ANON_KEY,
  ACCOUNT_CSRF_SECRET: "acceptance-csrf-secret-0123456789abcdefghijklmnop",
};
export const CSRF_SECRET = "acceptance-csrf-secret-0123456789abcdefghijklmnop";
const executablePath = process.env.PW_CHROMIUM_PATH || undefined;

export default defineConfig({
  testDir: "tests/account-e2e",
  timeout: 180_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["json", { outputFile: "test-results/account-e2e-results.json" }]],
  use: { baseURL: "http://localhost:3210", launchOptions: executablePath ? { executablePath } : {}, trace: "retain-on-failure" },
  projects: [{ name: "account-e2e", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } } }],
  webServer: [
    // chaos: the same website, but its Auth/PostgREST origin is the fault-injecting proxy (lost redemption reply, failing logout)
    { command: "npx next start -p 3211", port: 3211, reuseExistingServer: false, timeout: 60_000,
      env: { ...common, SITE_URL: "http://localhost:3211", ACCOUNT_AUTH_URL: stack.E2E_CHAOS_URL! } as Record<string, string> },
    // dead limiter: the distributed rate limiter is configured but unreachable -> the strict account routes must FAIL CLOSED
    { command: "npx next start -p 3212", port: 3212, reuseExistingServer: false, timeout: 60_000,
      env: { ...common, SITE_URL: "http://localhost:3212", ACCOUNT_AUTH_URL: stack.ACCOUNT_STACK_URL!, RATE_LIMIT_BACKEND: "upstash", UPSTASH_REDIS_REST_URL: "http://127.0.0.1:9", UPSTASH_REDIS_REST_TOKEN: "dead-limiter-token-0123456789abcdef" } as Record<string, string> },
    {
      command: "npx next start -p 3210",
      port: 3210,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        FOREVERDB_DATA_SOURCE: "fixture",
        RATE_LIMIT_BACKEND: "memory",
        TRUSTED_IP_HEADER: "x-forwarded-for",
        NEXT_TELEMETRY_DISABLED: "1",
        // Distinct clients through the forwarded IP; the global budgets are raised so a long run cannot trip them (per-IP budgets keep
        // their production defaults: they are part of what is tested).
        RATE_LIMITS_JSON: JSON.stringify({ account_auth: { global: 5000 }, account_light: { global: 50000 } }),
        FOREVERDB_DEPLOYMENT: "local",
        SITE_URL: "http://localhost:3210",
        ACCOUNT_AUTH_MODE: "local",
        ACCOUNT_AUTH_URL: stack.ACCOUNT_STACK_URL!,
        ACCOUNT_AUTH_PUBLISHABLE_KEY: stack.ACCOUNT_STACK_ANON_KEY,
        ACCOUNT_CSRF_SECRET: CSRF_SECRET,
      } as Record<string, string>,
    },
  ],
});
