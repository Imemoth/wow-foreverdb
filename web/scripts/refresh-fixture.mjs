#!/usr/bin/env node
/**
 * Regenerates the SYNTHETIC sample projection used by the fixture adapter by
 * running the real publisher over database/tests/fixtures/synthetic_private_export.json.
 * Never feed real/private data into this script: its output is committed.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dirname, "..", "..");
const out = join(mkdtempSync(join(tmpdir(), "fdb-fixture-")), "projection.json");
execFileSync("npx", ["tsx", "src/cli.ts", "build", "--from-export", join(repo, "database/tests/fixtures/synthetic_private_export.json"), "--out", out],
  { cwd: join(repo, "publisher"), stdio: "inherit" });
const d = JSON.parse(readFileSync(out, "utf8"));
const fixture = {
  _notice: "SYNTHETIC SAMPLE DATA generated from database/tests/fixtures/synthetic_private_export.json by the publisher. Not real ForeverDB observations.",
  report: { output: d.report.output, contentSha256: d.report.contentSha256 },
  publishedAt: "2026-10-09T00:00:00Z",
  projection: d.projection,
};
writeFileSync(join(repo, "web/src/lib/data/fixture/public-projection.sample.json"), JSON.stringify(fixture));
console.log(`fixture refreshed: ${d.report.contentSha256}`);
