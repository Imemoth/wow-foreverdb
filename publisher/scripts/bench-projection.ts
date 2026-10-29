/**
 * Pure-CPU benchmark of the shared projection (no database): synthetic export at scale N -> buildProjection.
 *   npx tsx scripts/bench-projection.ts 1 10 100
 * Prints the content hash so an optimisation can be proven output-identical (golden hashes in test/golden-hash.test.ts).
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePrivateExportBounded, PublicationConfig } from "../src/core/contract.ts";
import { projectValidatedExport } from "../src/core/project.ts";
import { syntheticExport } from "../src/core/synthetic.ts";

const here = dirname(fileURLToPath(import.meta.url));
// CPU benchmark only: scales above ~83 exceed the production row limit (120,000, a hard ceiling that config cannot raise), so this script does NOT go through
// buildProjection. It validates with the same bounded parser and calls the unguarded projection directly (projectValidatedExport). No production code path does that.
const config = PublicationConfig.parse(JSON.parse(readFileSync(resolve(here, "../publication-config.json"), "utf8")));
for (const arg of process.argv.slice(2)) {
  const scale = Number(arg);
  const t0 = performance.now();
  const raw = syntheticExport(scale);
  const t1 = performance.now();
  const c0 = process.cpuUsage();
  const parsed = parsePrivateExportBounded(raw);
  if (!parsed.success) throw new Error("synthetic export failed validation");
  const { report } = projectValidatedExport(parsed.data, config);
  const c1 = process.cpuUsage(c0);
  const t2 = performance.now();
  console.log(JSON.stringify({ scale, generateMs: Math.round(t1 - t0), buildMs: Math.round(t2 - t1), cpuMs: Math.round((c1.user + c1.system) / 1000), input: report.input, output: report.output, sha256: report.contentSha256 }));
}
