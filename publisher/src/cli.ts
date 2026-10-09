/**
 * ForeverDB publication worker CLI.
 *
 *   export   --out <file>                 Read the private aggregate export (PRIVATE_EXPORT_DATABASE_URL).
 *   build    --from-export <file> --out <file>   Build the public projection offline (no DB access).
 *   publish  [--from-export <file>] [--dry-run] [--allow-shrink]
 *            Build and write a new publication (PUBLIC_PUBLISHER_DATABASE_URL).
 *
 * Logs are single-line JSON with counts/reasons only — never row values.
 * Exit code is non-zero on any failure; nothing partial is ever activated.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PublicationConfig } from "./contract.js";
import { readPrivateExport, requireUrl, writePublication } from "./db.js";
import { buildProjection, PublicationError } from "./project.js";

const WORKER_VERSION = "publisher-0.1.0";
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

async function loadExport(config: ReturnType<typeof loadConfig>): Promise<unknown> {
  const from = arg("--from-export");
  if (from) return JSON.parse(readFileSync(from, "utf8"));
  return readPrivateExport(requireUrl("PRIVATE_EXPORT_DATABASE_URL"), config.locationGrid);
}

async function main() {
  const cmd = process.argv[2];
  const config = loadConfig();

  if (cmd === "export") {
    const out = arg("--out");
    if (!out) throw new Error("--out is required");
    const data = await readPrivateExport(requireUrl("PRIVATE_EXPORT_DATABASE_URL"), config.locationGrid);
    writeFileSync(out, `${JSON.stringify(data, null, 1)}\n`);
    log("export_written", { out });
    return;
  }

  if (cmd === "build" || cmd === "publish") {
    const raw = await loadExport(config);
    const { projection, report } = buildProjection(raw, config);
    log("projection_built", { ...report });
    if (cmd === "build") {
      const out = arg("--out");
      if (!out) throw new Error("--out is required");
      writeFileSync(out, `${JSON.stringify({ report, projection }, null, 1)}\n`);
      log("projection_written", { out });
      return;
    }
    if (flag("--dry-run")) {
      log("dry_run_complete", { sha256: report.contentSha256 });
      return;
    }
    const result = await writePublication(requireUrl("PUBLIC_PUBLISHER_DATABASE_URL"), projection, {
      workerVersion: WORKER_VERSION,
      exportedAt: report.exportedAt,
      sha256: report.contentSha256,
      config,
      allowShrink: flag("--allow-shrink"),
    });
    log("publication_finished", { ...result, sha256: report.contentSha256 });
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
