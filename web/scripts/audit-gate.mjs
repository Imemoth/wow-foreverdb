#!/usr/bin/env node
// Dependency audit gate (full tree, incl. devDependencies). Replaces the bare `npm audit --audit-level=moderate` step: it still runs the
// FULL npm audit and fails on every moderate-or-higher advisory, except those covered by an exact, in-force, owner-approved exception in
// .github/audit-exceptions.json (see docs/web/dependency-audit-exceptions.md). The production audit step is separate and unchanged.
//
//   npm audit --json            > full.json || true     # npm exits non-zero when it finds something; the JSON is what we judge
//   npm audit --omit=dev --json > prod.json || true     # proves the excepted advisory is dev-only
//   node ../web/scripts/audit-gate.mjs --project web --audit full.json --prod-audit prod.json --package package.json --exceptions ../.github/audit-exceptions.json
//
// Exit 0: nothing blocked and no problem. 1: a finding is blocked, or an exception expired / is obsolete / no longer matches.
// 2: unusable input (missing or malformed file): always a failure, never a pass. There is deliberately no flag to set the clock.
import { readFileSync } from "node:fs";
import { evaluateAudit } from "./lib/audit-policy.mjs";

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const die = (m) => { console.error(`audit-gate: ${m}`); process.exit(2); };
const read = (name, what) => {
  const f = flag(name);
  if (!f) die(`--${name} is required`);
  try { return JSON.parse(readFileSync(f, "utf8")); } catch (e) { return die(`cannot read ${what} (${f}): ${e.code ?? e.message}`); }
};

const project = flag("project");
if (!project) die("--project is required");
const now = new Date();
const result = evaluateAudit({
  project,
  audit: read("audit", "the full audit JSON"),
  prodAudit: read("prod-audit", "the production audit JSON"),
  packageJson: read("package", "package.json"),
  exceptions: read("exceptions", "the exceptions file"),
  now,
  level: flag("level") ?? "moderate",
});

for (const e of result.exceptions) {
  if (e.state === "active") {
    console.log(`EXCEPTION ${e.id}: owner-approved, in force until ${e.expires} (fails closed from ${e.failClosedFrom}; ${e.daysLeft} day(s) left)`);
    if (e.daysLeft <= 14) console.log(`::warning title=Audit exception expires soon::${e.id} stops applying at ${e.failClosedFrom}`);
  }
}
const adv = result.excepted.filter((x) => x.kind === "advisory");
const pk = result.excepted.filter((x) => x.kind === "package");
if (result.excepted.length) console.log(`excepted: ${adv.length} advisory, ${pk.length} dependent package(s): ${pk.map((x) => x.package).sort().join(", ")}`);
for (const b of result.blocked) console.log(`BLOCKED ${b.severity} ${b.kind === "advisory" ? `${b.id} (${b.package} ${b.range})` : b.package}${b.reason ? ` - ${b.reason}` : ""}`);
for (const p of result.problems) console.log(`PROBLEM ${p}`);
console.log(result.ok ? "AUDIT GATE OK" : `AUDIT GATE FAILED: ${result.blocked.length} blocked finding(s), ${result.problems.length} problem(s)`);
process.exit(result.ok ? 0 : 1);
