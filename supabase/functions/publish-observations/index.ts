// Supabase Edge Function: publish-observations
//
// Runs the genuine publication pipeline (private aggregate export -> validated projection -> public read model)
// inside the Edge runtime. All business logic lives in ./core (an exact copy of publisher/src/core, enforced by
// scripts/sync-edge-core.mjs --check); this file only authenticates, adapts the database driver and reports.
//
// Authentication: the gateway verifies a project JWT (verify_jwt = true) AND the caller must present the Vault-held
// `x-publish-token`, which is validated inside the database (pub_ops.verify_invoke_token). Failures answer 401 with no detail.
//
// Credentials: PRIVATE_EXPORT_DATABASE_URL (secret, role foreverdb_projection_reader) for the private read;
// the public database uses the project's own SUPABASE_DB_URL and assumes `foreverdb_publisher` with SET LOCAL ROLE in every
// transaction, so RLS and the publisher's grants apply. Neither value is ever logged or returned.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import process from "node:process";
import postgres from "postgres";
import { z } from "zod";
import config from "./publication-config.generated.ts";
import { PublicationConfig } from "./core/contract.ts";
import { runPublication } from "./core/run.ts";
import { verifyInvokeToken, type ClosableSqlClient } from "./core/sql.ts";

const WORKER_VERSION = "publisher-0.2.0-edge";
const PUBLISHER_ROLE = "foreverdb_publisher";

const Body = z
  .object({
    mode: z.enum(["publish", "dry_run", "rehearse"]).default("publish"),
    trigger: z.enum(["cron", "manual", "benchmark"]).default("manual"),
    source: z.enum(["private", "synthetic"]).default("private"),
    scale: z.number().int().min(1).max(200).optional(),
    allowShrink: z.boolean().optional(),
  })
  .strict();

function log(event: string, data: Record<string, unknown> = {}) {
  // Structured, single-line JSON: counts, timings and reason codes only (no row values, no secrets).
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

async function open(url: string, appName: string): Promise<ClosableSqlClient> {
  const sql = postgres(url, {
    max: 1,
    prepare: false, // transaction-pooler safe
    idle_timeout: 20,
    connect_timeout: 15,
    connection: { application_name: appName },
    onnotice: () => {},
  });
  await sql.unsafe("select 1"); // connect now, so connection time is measured where it is spent
  return {
    query: async (text, params) => ({ rows: (await sql.unsafe(text, (params ?? []) as never[])) as unknown as Record<string, unknown>[] }),
    close: () => sql.end({ timeout: 5 }),
  };
}

function cpuMs(): number | null {
  try {
    const u = process.cpuUsage();
    const ms = (u.user + u.system) / 1000;
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  } catch {
    return null;
  }
}

function memory() {
  try {
    const m = Deno.memoryUsage();
    return { rssMB: Math.round(m.rss / 1048576), heapUsedMB: Math.round(m.heapUsed / 1048576) };
  } catch {
    return null;
  }
}

addEventListener("beforeunload", (ev) => {
  log("worker_unload", { reason: (ev as unknown as { detail?: { reason?: string } }).detail?.reason ?? null });
});

Deno.serve(async (req) => {
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  const token = req.headers.get("x-publish-token") ?? "";
  if (!/^[0-9a-f]{64}$/.test(token)) {
    log("auth_failed", { reason: "token_format" });
    return json(401, { error: "unauthorized" });
  }
  const dbUrl = Deno.env.get("SUPABASE_DB_URL");
  if (!dbUrl) return json(500, { error: "public_database_not_configured" });

  let authorized = false;
  try {
    const authClient = await open(dbUrl, "publish-observations-auth");
    try {
      authorized = await verifyInvokeToken(authClient, PUBLISHER_ROLE, token);
    } finally {
      await authClient.close().catch(() => undefined);
    }
  } catch {
    log("auth_check_error", {});
  }
  if (!authorized) {
    log("auth_failed", { reason: "token_rejected" });
    return json(401, { error: "unauthorized" });
  }

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return json(400, { error: "invalid_request", fields: parsed.error.issues.map((i) => i.path.join(".")) });
  const body = parsed.data;
  if (body.source === "synthetic" && body.mode === "publish") return json(400, { error: "synthetic_publish_refused" });

  const privateUrl = Deno.env.get("PRIVATE_EXPORT_DATABASE_URL");
  const summary = await runPublication(
    {
      config: PublicationConfig.parse(config),
      workerVersion: WORKER_VERSION,
      runtime: "supabase-edge",
      openPrivate: privateUrl ? () => open(privateUrl, "publish-observations-export") : null,
      openPublic: () => open(dbUrl, "publish-observations-write"),
      publicRole: PUBLISHER_ROLE,
      log,
      cpuMs,
      memory,
    },
    body,
  );
  log("response", { outcome: summary.outcome, errorClass: summary.errorClass, runId: summary.runId });
  return json(summary.ok ? 200 : 500, summary);
});
