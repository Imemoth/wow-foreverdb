/**
 * Pure-CPU benchmark of the shared projection (no database): synthetic export at scale N -> buildProjection.
 *   npx tsx scripts/bench-projection.ts 1 10 100
 * Prints the content hash so an optimisation can be proven output-identical (golden hashes in test/golden-hash.test.ts).
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PublicationConfig } from "../src/core/contract.ts";
import { buildProjection } from "../src/core/project.ts";
import { syntheticExport } from "../src/core/synthetic.ts";

const here = dirname(fileURLToPath(import.meta.url));
const config = PublicationConfig.parse(JSON.parse(readFileSync(resolve(here, "../publication-config.json"), "utf8")));
for (const arg of process.argv.slice(2)) {
  const scale = Number(arg);
  const t0 = performance.now();
  const raw = syntheticExport(scale);
  const t1 = performance.now();
  const c0 = process.cpuUsage();
  const { report } = buildProjection(raw, config);
  const c1 = process.cpuUsage(c0);
  const t2 = performance.now();
  console.log(JSON.stringify({ scale, generateMs: Math.round(t1 - t0), buildMs: Math.round(t2 - t1), cpuMs: Math.round((c1.user + c1.system) / 1000), input: report.input, output: report.output, sha256: report.contentSha256 }));
}
