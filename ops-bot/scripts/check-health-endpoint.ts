/**
 * Read-only check of the DEPLOYED Supabase health endpoint. Run it from YOUR protected shell after deploying the Edge Function:
 *   HEALTH_API_URL=https://<project>.supabase.co/functions/v1/azerdex-ops-health HEALTH_API_SECRET=... npx tsx scripts/check-health-endpoint.ts
 * Neither value is printed. It makes five requests (four refusals and one signed read of the report) and changes nothing.
 */
import { runEndpointChecks } from "../src/health/endpoint-check";

const { HEALTH_API_URL: url, HEALTH_API_SECRET: secret } = process.env;
if (!url || !secret || secret.length < 32 || !url.startsWith("https://")) {
  console.error("refusing: set HEALTH_API_URL (https) and HEALTH_API_SECRET (at least 32 characters); values are never printed");
  process.exit(2);   // before any request: no connection exists yet, so a forced exit is safe here
}
const checks = await runEndpointChecks({ url, secret });
for (const c of checks) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}: ${c.detail}`);
const ok = checks.every((c) => c.pass);
console.log(ok ? "\nREADY: the endpoint refuses what it must refuse and returns a valid, fresh report." : "\nNOT READY: fix the FAIL items, then re-run.");
// Set the exit code instead of forcing an exit, so Node can close its network handles first (a forced exit right after fetch aborts with a libuv assertion on Windows).
process.exitCode = ok ? 0 : 1;
