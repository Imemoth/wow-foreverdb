#!/usr/bin/env node
/**
 * ADM-UI-PREVIEW-01 launcher: builds and serves the isolated, synthetic Admin UI preview on loopback.
 *
 *   node scripts/admin-preview.mjs build   # preview build -> .next-admin-preview (never touches .next)
 *   node scripts/admin-preview.mjs start   # serve it on http://localhost:3300/admin-preview
 *   node scripts/admin-preview.mjs dev     # next dev with the preview enabled
 *   node scripts/admin-preview.mjs         # build + start
 *
 * The child process receives a SCRUBBED environment: only what the runtime needs to find Node plus the explicit preview variables below.
 * No ambient secret (Supabase, database URL, Auth keys, Vercel token, ...) can reach the preview process even if the shell has one.
 * It also refuses to start if the shell would leak a platform/hosted signal into a would-be local run.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");
const port = String(process.env.ADMIN_PREVIEW_PORT ?? "3300");
if (!/^\d{2,5}$/.test(port)) { console.error("ADMIN_PREVIEW_PORT must be a number"); process.exit(2); }

const PASS = ["PATH", "Path", "HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP", "SystemRoot", "SYSTEMROOT", "windir", "ComSpec", "APPDATA", "LOCALAPPDATA", "LANG", "LC_ALL", "TERM", "NODE_EXTRA_CA_CERTS", "PLAYWRIGHT_BROWSERS_PATH"];
const env = Object.fromEntries(PASS.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
Object.assign(env, {
  AZERDEX_ADMIN_PREVIEW_BUILD: "1",
  AZERDEX_ADMIN_PREVIEW: "isolated-synthetic",
  AZERDEX_ADMIN_PREVIEW_DATA: "synthetic",
  FOREVERDB_DEPLOYMENT: "local",
  FOREVERDB_DATA_SOURCE: "fixture",
  SITE_URL: `http://localhost:${port}`,
  RATE_LIMIT_BACKEND: "memory",
  NEXT_TELEMETRY_DISABLED: "1",
  NODE_ENV: undefined,
});
for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];

const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [nextBin, ...args], { env, stdio: "inherit" });
  child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`next ${args[0]} exited with ${code}`))));
  child.on("error", reject);
});

const cmd = process.argv[2] ?? "all";
try {
  if (cmd === "build" || cmd === "all") await run(["build"]);
  if (cmd === "start" || cmd === "all") {
    console.log(`\nAzerDex Admin UI preview (SYNTHETIC, isolated): http://localhost:${port}/admin-preview\n`);
    await run(["start", "-p", port, "-H", "127.0.0.1"]);
  }
  if (cmd === "dev") {
    console.log(`\nAzerDex Admin UI preview (dev, SYNTHETIC): http://localhost:${port}/admin-preview\n`);
    await run(["dev", "-p", port, "-H", "127.0.0.1"]);
  }
} catch (e) {
  console.error(String(e instanceof Error ? e.message : e));
  process.exit(1);
}
