import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";
import { createHandler, DEFAULT_SIGNED_PATH } from "./handler.ts";

// Thin Deno wiring. All logic (authentication, allow-list, failure mapping) is in handler.ts and is covered by ops-bot/test/gate-c-*.test.ts.
// The database login is the dedicated role `azerdex_ops_reporter` (it can run exactly one function: ops_report.health()), NOT postgres and NOT service_role.
async function readReport(): Promise<unknown> {
  const databaseUrl = Deno.env.get("OPS_HEALTH_DATABASE_URL");
  if (!databaseUrl) throw new Error("OPS_HEALTH_DATABASE_URL is not configured");
  const client = new Client(databaseUrl);
  await client.connect();
  try {
    const result = await client.queryObject<{ report: unknown }>("select ops_report.health() as report");
    return result.rows[0]?.report;
  } finally {
    await client.end();
  }
}

Deno.serve(createHandler({
  secret: Deno.env.get("AZERDEX_OPS_HEALTH_SECRET"),
  signedPath: Deno.env.get("AZERDEX_OPS_HEALTH_SIGNED_PATH") ?? DEFAULT_SIGNED_PATH,
  now: () => Date.now(),
  readReport,
}));
