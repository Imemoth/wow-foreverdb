import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

/**
 * Account System V1 acceptance against a REAL, ephemeral Auth stack (GoTrue + PostgreSQL + Mailpit; see
 * tests/auth-stack/README.md). Nothing here is mocked: if the stack is not running the suite fails, it never falls back.
 *
 * Website instances (all `next start` of the same production build):
 *   main      3210  accounts ON  (local mode against the stack), Turnstile off
 *   turnstile 3211  accounts ON, Turnstile configured with Cloudflare's "always fails" TEST secret
 *   demo      3212  Vercel PRODUCTION target (the demonstration alias), accounts OFF (default)
 *   prodacct  3213  Vercel production target with an account configuration -> must fail closed
 *   hosted    3214  hosted preview, accounts ON but without the required protections -> account routes refuse (503)
 *   httpsish  3216  accounts ON with an https SITE_URL (exercises __Secure- cookie names / Secure flag on the wire)
 */
function loadStackEnv(): Record<string, string> {
  const file = process.env.ACCOUNT_STACK_ENV_FILE ?? resolve(__dirname, "tests/auth-stack/.stack/env");
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
      if (m) out[m[1]!] = m[2]!;
    }
  } catch {
    /* fall through to process.env */
  }
  return { ...out, ...Object.fromEntries(Object.entries(process.env).filter(([k, v]) => /^(ACCOUNT_STACK_|MAILPIT_URL|STACK_)/.test(k) && v !== undefined)) as Record<string, string> };
}
const stack = loadStackEnv();
// Test workers inherit the environment of this process: hand them the stack coordinates (helpers.ts reads process.env only).
for (const [k, v] of Object.entries(stack)) if (/^(ACCOUNT_STACK_|MAILPIT_URL|STACK_)/.test(k)) process.env[k] = v;
const AUTH_URL = stack.ACCOUNT_STACK_URL ?? "http://127.0.0.1:54321";
const ANON = stack.ACCOUNT_STACK_ANON_KEY ?? "";
export const CSRF_SECRET = "acceptance-csrf-secret-0123456789abcdefghijklmnop";
const executablePath = process.env.PW_CHROMIUM_PATH || undefined;

const base = {
  FOREVERDB_DATA_SOURCE: "fixture",
  RATE_LIMIT_BACKEND: "memory",
  TRUSTED_IP_HEADER: "x-forwarded-for",
  NEXT_TELEMETRY_DISABLED: "1",
  // Tests act as distinct clients through the forwarded IP; the global account budget is raised so a long run cannot trip it
  // (per-IP budgets keep their production defaults: they are part of what is tested).
  RATE_LIMITS_JSON: JSON.stringify({ account_auth: { global: 5000 }, account_light: { global: 50000 } }),
};
const accountsLocal = {
  ACCOUNT_AUTH_MODE: "local",
  ACCOUNT_AUTH_URL: AUTH_URL,
  ACCOUNT_AUTH_PUBLISHABLE_KEY: ANON,
  ACCOUNT_CSRF_SECRET: CSRF_SECRET,
};
const server = (port: number, env: Record<string, string>) => ({
  command: `npx next start -p ${port}`,
  port,
  reuseExistingServer: false,
  timeout: 60_000,
  env: { ...base, ...env } as Record<string, string>,
});

export default defineConfig({
  testDir: "tests/account",
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["json", { outputFile: "test-results/account-results.json" }]],
  use: { baseURL: "http://localhost:3210", launchOptions: executablePath ? { executablePath } : {}, trace: "retain-on-failure" },
  projects: [{ name: "account", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 900 } } }],
  webServer: [
    server(3210, { ...accountsLocal, FOREVERDB_DEPLOYMENT: "local", SITE_URL: "http://localhost:3210" }),
    server(3211, {
      ...accountsLocal, FOREVERDB_DEPLOYMENT: "local", SITE_URL: "http://localhost:3211",
      TURNSTILE_SECRET_KEY: "2x0000000000000000000000000000000AA", // Cloudflare TEST secret: every token FAILS verification
      NEXT_PUBLIC_TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
      CHALLENGE_COOKIE_SECRET: "acceptance-challenge-secret-0123456789abcdef",
    }),
    server(3212, {
      VERCEL: "1", VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "foreverdb-demo.vercel.app", VERCEL_URL: "foreverdb-abc.vercel.app",
      FOREVERDB_DEPLOYMENT: "preview", SITE_URL: "https://foreverdb-demo.vercel.app",
    }),
    server(3213, {
      VERCEL: "1", VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "foreverdb-demo.vercel.app", VERCEL_URL: "foreverdb-abc.vercel.app",
      FOREVERDB_DEPLOYMENT: "preview", SITE_URL: "https://foreverdb-demo.vercel.app",
      ACCOUNT_AUTH_MODE: "staging", ACCOUNT_AUTH_URL: "https://abcdefghijklmnopqrst.supabase.co", ACCOUNT_AUTH_PROJECT_REF: "abcdefghijklmnopqrst",
      ACCOUNT_AUTH_PUBLISHABLE_KEY: "sb_publishable_acceptance_not_a_real_key", ACCOUNT_CSRF_SECRET: CSRF_SECRET,
    }),
    server(3214, {
      VERCEL: "1", VERCEL_ENV: "preview", VERCEL_URL: "foreverdb-preview-abc.vercel.app", VERCEL_BRANCH_URL: "foreverdb-git-x.vercel.app",
      FOREVERDB_DEPLOYMENT: "preview", SITE_URL: "https://foreverdb-git-x.vercel.app",
      ACCOUNT_AUTH_MODE: "staging", ACCOUNT_AUTH_URL: "https://abcdefghijklmnopqrst.supabase.co", ACCOUNT_AUTH_PROJECT_REF: "abcdefghijklmnopqrst",
      ACCOUNT_AUTH_PUBLISHABLE_KEY: "sb_publishable_acceptance_not_a_real_key", ACCOUNT_CSRF_SECRET: CSRF_SECRET,
    }),
    server(3216, { ...accountsLocal, FOREVERDB_DEPLOYMENT: "local", SITE_URL: "https://localhost:3216" }),
  ],
});
