/**
 * ForeverDB publication worker CLI (local diagnostics and recovery; the scheduled production path is the
 * Supabase Edge Function in supabase/functions/publish-observations, which runs the SAME core/ code).
 *
 *   export   --out <file>                          Read the private aggregate export (PRIVATE_EXPORT_DATABASE_URL).
 *   build    --from-export <file> --out <file>     Build the public projection offline (no DB access).
 *   publish  [--from-export <file>] [--dry-run] [--rehearse] [--allow-shrink]
 *            Build and write a new publication (PUBLIC_PUBLISHER_DATABASE_URL).
 *            --dry-run   build + validate only, nothing written
 *            --rehearse  full write/finalize path, then ROLLBACK (persists nothing)
 *   publish  --synthetic <scale>  (with --dry-run or --rehearse only)   deterministic synthetic export for scale tests
 *
 * Logs are single-line JSON with counts/reasons only — never row values.
 * Exit code is non-zero on any failure; nothing partial is ever activated.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { maxExportRows, PublicationConfig } from "./core/contract.ts";
import { buildProjection, PublicationError } from "./core/project.ts";
import { runPublication, type RunMode } from "./core/run.ts";
import { readPrivateExport } from "./core/sql.ts";
import { openPg, requireUrl } from "./node-sql.ts";

export const WORKER_VERSION = "publisher-0.2.0";
const here = dirname(fileURLToPath(import.meta.url));

function log(event: string, data: Record<string, unknown> = {}) {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...data })}\n`);
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(name);

function loadConfig() {
  const path = arg("--config") ?? resolve(here, "../publication-config.json");
  return PublicationConfig.parse(JSON.parse(readFileSync(path, "utf8")));
}

async function main() {
  const cmd = process.argv[2];
  const config = loadConfig();

  if (cmd === "export") {
    const out = arg("--out");
    if (!out) throw new Error("--out is required");
    const c = await openPg(requireUrl("PRIVATE_EXPORT_DATABASE_URL"), "foreverdb-publisher-export");
    try {
      writeFileSync(out, `${JSON.stringify(await readPrivateExport(c, config.locationGrid, maxExportRows(config)), null, 1)}\n`);
    } finally {
      await c.close();
    }
    log("export_written", { out });
    return;
  }

  if (cmd === "build") {
    const from = arg("--from-export");
    const out = arg("--out");
    if (!from || !out) throw new Error("--from-export and --out are required");
    const { projection, report } = buildProjection(JSON.parse(readFileSync(from, "utf8")), config);
    log("projection_built", { ...report });
    writeFileSync(out, `${JSON.stringify({ report, projection }, null, 1)}\n`);
    log("projection_written", { out });
    return;
  }

  if (cmd === "publish") {
    const from = arg("--from-export");
    const synthetic = arg("--synthetic");
    const mode: RunMode = flag("--rehearse") ? "rehearse" : flag("--dry-run") ? "dry_run" : "publish";
    const fileExport = from ? JSON.parse(readFileSync(from, "utf8")) : null;
    // A file export is exposed to the shared runner as a private-export opener that serves the parsed file.
    const summary = await runPublication(
      {
        config,
        workerVersion: WORKER_VERSION,
        runtime: "node",
        openPrivate: fileExport
          ? null
          : synthetic
            ? null
            : () => openPg(requireUrl("PRIVATE_EXPORT_DATABASE_URL"), "foreverdb-publisher-export"),
        openPublic: () => openPg(requireUrl("PUBLIC_PUBLISHER_DATABASE_URL"), "foreverdb-publisher-write"),
        publicRole: null,
        log,
        cpuMs: () => {
          const u = process.cpuUsage();
          return (u.user + u.system) / 1000;
        },
        memory: () => {
          const m = process.memoryUsage();
          return { rssMB: Math.round(m.rss / 1048576), heapUsedMB: Math.round(m.heapUsed / 1048576) };
        },
        fileExport,
      },
      {
        mode,
        trigger: "cli",
        source: synthetic ? "synthetic" : "private",
        scale: synthetic ? Number(synthetic) : undefined,
        allowShrink: flag("--allow-shrink"),
      },
    );
    log("publication_finished", { ...summary });
    if (!summary.ok) process.exitCode = 1;
    return;
  }

  throw new Error("usage: cli.ts <export|build|publish> [options]");
}

main().catch((e: unknown) => {
  if (e instanceof PublicationError) {
    log("publication_failed_closed", { reason: e.message, detail: e.detail });
  } else {
    // Do not print connection strings or row data: message class only.
    const msg = e instanceof Error ? e.message.replace(/postgres(ql)?:\/\/\S+/g, "postgres://[redacted]") : "unknown";
    log("publication_error", { message: msg.slice(0, 300) });
  }
  process.exitCode = 1;
});
