import { createHandler, DEFAULT_SIGNED_PATH } from "./handler.ts";
import { createGatedReportSource } from "./report-source.ts";

// Thin Deno wiring. All logic is in handler.ts (the external HMAC contract, unchanged) and report-source.ts (the gated Data API read); both are covered by ops-bot/test/gate-*.test.ts.
// There is NO database connection and NO SQL LOGIN credential here: the report is read through the Supabase Data API as plain `anon`, authorised by a 60-second HMAC
// signature made with a key that lives only in the OPS_HEALTH_GATE_KEY secret and in the database (database/ops/0020_ops_health_gated_rpc.sql).
// Secrets this function reads: AZERDEX_OPS_HEALTH_SECRET (the bot's HMAC), OPS_HEALTH_GATE_KEY (64 hex), OPS_HEALTH_APIKEY (the PUBLISHABLE key, public by design).
// SUPABASE_URL is provided by the platform. Nothing is logged.
Deno.serve(createHandler({
  secret: Deno.env.get("AZERDEX_OPS_HEALTH_SECRET"),
  signedPath: Deno.env.get("AZERDEX_OPS_HEALTH_SIGNED_PATH") ?? DEFAULT_SIGNED_PATH,
  now: () => Date.now(),
  readReport: createGatedReportSource({
    supabaseUrl: Deno.env.get("SUPABASE_URL"),
    apikey: Deno.env.get("OPS_HEALTH_APIKEY"),
    gateKeyHex: Deno.env.get("OPS_HEALTH_GATE_KEY"),
    now: () => Date.now(),
  }),
}));
