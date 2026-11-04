import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * The owner-approved, time-limited exception for GHSA-g3hv-75wg-m249 (docs/web/dependency-audit-exceptions.md). Real `npm audit --json`
 * output of the `release` lockfile (8d033a4) drives the positive case; every negative case mutates it and must FAIL CLOSED.
 */
const run = promisify(execFile);
const ROOT = join(process.cwd(), "..");
const FIX = join(process.cwd(), "tests", "fixtures", "audit");
const json = (p: string) => JSON.parse(readFileSync(p, "utf8"));
const FULL = json(join(FIX, "web-full-release-8d033a4.json"));
const PROD = json(join(FIX, "web-prod-release-8d033a4.json"));
const SHIPPED = json(join(ROOT, ".github", "audit-exceptions.json"));
const PKG = json(join(process.cwd(), "package.json"));
const GHSA = "GHSA-g3hv-75wg-m249";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let P: any;
beforeAll(async () => {
  P = await import(pathToFileURL(join(process.cwd(), "scripts", "lib", "audit-policy.mjs")).href);
});

const clone = <T,>(x: T): T => structuredClone(x);
const T0 = Date.parse("2026-11-02T12:00:00Z");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const ev = (over: Any = {}) => P.evaluateAudit({ project: "web", audit: clone(FULL), prodAudit: clone(PROD), packageJson: clone(PKG), exceptions: clone(SHIPPED), now: T0, ...over });
const advisory = (id: string, name: string, severity: string, range = "<9.9.9") => ({ source: 9_000_000 + id.length, name, dependency: name, title: "synthetic", url: `https://github.com/advisories/${id}`, severity, cwe: [], cvss: { score: 0, vectorString: null }, range });
const vuln = (name: string, severity: string, via: Any[], extra: Any = {}) => ({ name, severity, isDirect: false, via, effects: [], range: "*", nodes: [`node_modules/${name}`], fixAvailable: false, ...extra });

describe("shipped exception record", () => {
  it("is exactly one exception: GHSA-g3hv-75wg-m249, web, moderate, expiring 2026-12-15 (amended 2026-11-04: scope narrowed only)", () => {
    expect(SHIPPED.exceptions).toHaveLength(1);
    const e = SHIPPED.exceptions[0];
    expect(e).toMatchObject({ project: "web", id: GHSA, package: "minimatch", range: ">=7.0.0 <11.0.1", severity: "moderate", expires: "2026-12-15", approvedOn: "2026-11-02", amendedOn: "2026-11-04" });
    expect(P.validateException(e)).toEqual([]);
    expect(e.approvedBy).toMatch(/owner/i);
    expect(e.removalCriteria).toMatch(/2026-12-16 00:00 UTC/);
  });
  it("fails closed from exactly 2026-12-16 00:00 UTC", () => {
    expect(P.failClosedFrom("2026-12-15")).toBe(Date.UTC(2026, 11, 16, 0, 0, 0, 0));
    expect(new Date(P.failClosedFrom("2026-12-15")).toISOString()).toBe("2026-12-16T00:00:00.000Z");
  });
  it("lists exactly the verified toolchain: the vulnerable packages of the real audit, the real minimatch paths, the real direct roots", () => {
    const e = SHIPPED.exceptions[0];
    expect([...e.allowedPackages].sort()).toEqual(Object.keys(FULL.vulnerabilities).sort());
    expect([...e.nodes].sort()).toEqual([...FULL.vulnerabilities.minimatch.nodes].sort());
    expect([...e.directRoots].sort()).toEqual(Object.entries(FULL.vulnerabilities).filter(([, v]) => (v as Any).isDirect).map(([k]) => k).sort());
  });
  it("introduces no dependency override and keeps both audit steps' thresholds in the workflow", () => {
    expect(PKG.overrides).toBeUndefined();
    const wf = readFileSync(join(ROOT, ".github", "workflows", "web-ci.yml"), "utf8");
    expect(wf).toContain("run: npm audit --omit=dev --audit-level=high"); // production audit: unchanged and mandatory
    expect(wf).toMatch(/audit-gate\.mjs[\s\S]*--exceptions \.\.\/\.github\/audit-exceptions\.json/);
    expect(wf).not.toMatch(/run: npm audit --audit-level=moderate/); // the bare full audit was replaced by the gate, not removed
    expect(wf).not.toMatch(/continue-on-error|npm audit fix|--force/);
    expect(wf).toMatch(/needs: \[web-quality, web-e2e, publisher-and-pipeline, codeql, dependency-audit\]/);
  });
});

describe("positive: the exception applies to exactly what was approved", () => {
  it("passes the real audit of the release lockfile and excepts the advisory and the 8 dependent packages", () => {
    const r = ev();
    expect(r.problems).toEqual([]);
    expect(r.blocked).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.excepted.filter((x: Any) => x.kind === "advisory")).toHaveLength(1);
    expect(r.excepted.filter((x: Any) => x.kind === "package")).toHaveLength(8);
    expect(r.exceptions[0]).toMatchObject({ id: GHSA, state: "active", failClosedFrom: "2026-12-16T00:00:00.000Z" });
  });
  it("still applies in the last millisecond of 2026-12-15 UTC", () => {
    const r = ev({ now: Date.parse("2026-12-15T23:59:59.999Z") });
    expect(r.ok).toBe(true);
    expect(r.exceptions[0]).toMatchObject({ state: "active", daysLeft: 1 });
  });
  it("ignores findings below the threshold (low, info) without needing an exception", () => {
    const audit = clone(FULL);
    audit.vulnerabilities.lowpkg = vuln("lowpkg", "low", [advisory("GHSA-aaaa-bbbb-cccc", "lowpkg", "low")]);
    expect(ev({ audit }).ok).toBe(true);
  });
  it("is scoped to its project: the same finding in another project is NOT excepted", () => {
    const r = ev({ project: "publisher" });
    expect(r.ok).toBe(false);
    expect(r.blocked.length).toBe(9);
  });
  it("a clean project with no exceptions passes", () => {
    const clean = { auditReportVersion: 2, vulnerabilities: {}, metadata: { vulnerabilities: { total: 0 } } };
    expect(ev({ project: "publisher", audit: clean, prodAudit: clean }).ok).toBe(true);
  });
});

describe("negative: hard expiry (fails closed from 2026-12-16 00:00 UTC)", () => {
  it("the first instant after the deadline fails, the exception stops applying and every finding is blocked again", () => {
    const r = ev({ now: Date.parse("2026-12-16T00:00:00.000Z") });
    expect(r.ok).toBe(false);
    expect(r.exceptions[0]).toMatchObject({ id: GHSA, state: "expired" });
    expect(r.problems.join()).toMatch(/EXPIRED/);
    expect(r.excepted).toEqual([]);
    expect(r.blocked.length).toBe(9);
  });
  it("any later time fails too", () => {
    for (const t of ["2026-12-16T00:00:00.001Z", "2027-01-01T00:00:00Z", "2030-06-01T00:00:00Z"]) expect(ev({ now: Date.parse(t) }).ok).toBe(false);
  });
  it("an expired entry fails even when the advisory is gone (the dead entry must be removed)", () => {
    const empty = { auditReportVersion: 2, vulnerabilities: {}, metadata: {} };
    const r = ev({ audit: empty, prodAudit: empty, now: Date.parse("2027-02-01T00:00:00Z") });
    expect(r.ok).toBe(false);
    expect(r.problems.join()).toMatch(/EXPIRED/);
  });
  it("malformed expiry dates make the entry invalid and fail the gate", () => {
    for (const expires of ["2026-02-31", "15/12/2026", "", "2026-12-15T00:00:00Z", undefined]) {
      const exceptions = clone(SHIPPED);
      exceptions.exceptions[0].expires = expires;
      const r = ev({ exceptions });
      expect(r.ok, String(expires)).toBe(false);
      expect(r.exceptions[0].state).toBe("invalid");
    }
  });
  it("evaluation requires an explicit clock", () => {
    expect(() => P.evaluateAudit({ project: "web", audit: FULL, prodAudit: PROD, packageJson: PKG, exceptions: SHIPPED })).toThrow(/now/);
  });
});

describe("negative: every other advisory still fails", () => {
  it("a different moderate advisory on another package is blocked while the approved one stays excepted", () => {
    const audit = clone(FULL);
    audit.vulnerabilities.leftpad = vuln("leftpad", "moderate", [advisory("GHSA-aaaa-bbbb-cccc", "leftpad", "moderate")]);
    const r = ev({ audit });
    expect(r.ok).toBe(false);
    expect(r.blocked.map((b: Any) => b.id ?? b.package).sort()).toEqual(["GHSA-aaaa-bbbb-cccc", "leftpad"]);
    expect(r.exceptions[0].state).toBe("active");
  });
  it("an ADDITIONAL advisory affecting minimatch itself is blocked", () => {
    const audit = clone(FULL);
    audit.vulnerabilities.minimatch.via.push(advisory("GHSA-xxxx-yyyy-zzzz", "minimatch", "moderate", "<10.0.0"));
    const r = ev({ audit });
    expect(r.ok).toBe(false);
    expect(r.blocked.some((b: Any) => b.id === "GHSA-xxxx-yyyy-zzzz")).toBe(true);
    expect(r.blocked.some((b: Any) => b.id === GHSA)).toBe(false);
  });
  it.each(["high", "critical"])("a %s advisory anywhere is blocked", (sev) => {
    const audit = clone(FULL);
    audit.vulnerabilities.badpkg = vuln("badpkg", sev, [advisory("GHSA-hhhh-iiii-jjjj", "badpkg", sev)]);
    const r = ev({ audit });
    expect(r.ok).toBe(false);
    expect(r.blocked.some((b: Any) => b.severity === sev)).toBe(true);
  });
  it("a high or critical exception cannot even be written", () => {
    for (const severity of ["high", "critical", "low"]) {
      const exceptions = clone(SHIPPED);
      exceptions.exceptions[0].severity = severity;
      expect(ev({ exceptions }).ok).toBe(false);
    }
  });
  it("a new affected package outside the verified toolchain is blocked, even when it only inherits minimatch", () => {
    const audit = clone(FULL);
    audit.vulnerabilities["eslint-plugin-newcomer"] = vuln("eslint-plugin-newcomer", "moderate", ["minimatch"]);
    const r = ev({ audit });
    expect(r.ok).toBe(false);
    expect(r.blocked).toEqual([expect.objectContaining({ kind: "package", package: "eslint-plugin-newcomer" })]);
  });
});

describe("negative: fails closed when the exception no longer matches the verified graph", () => {
  it("OBSOLETE: the advisory disappears (a fix landed) -> fail until the entry is removed", () => {
    const audit = { auditReportVersion: 2, vulnerabilities: {}, metadata: {} };
    const r = ev({ audit, prodAudit: audit });
    expect(r.ok).toBe(false);
    expect(r.exceptions[0].state).toBe("obsolete");
    expect(r.problems.join()).toMatch(/OBSOLETE.*Remove it/);
  });
  it("severity escalates -> mismatch, nothing is excepted", () => {
    const audit = clone(FULL);
    audit.vulnerabilities.minimatch.via[0].severity = "high";
    audit.vulnerabilities.minimatch.severity = "high";
    const r = ev({ audit });
    expect(r.ok).toBe(false);
    expect(r.exceptions[0].state).toBe("mismatch");
    expect(r.excepted).toEqual([]);
  });
  it("the vulnerable range changes -> mismatch", () => {
    const audit = clone(FULL);
    audit.vulnerabilities.minimatch.via[0].range = "<12.0.0";
    expect(ev({ audit }).exceptions[0].state).toBe("mismatch");
  });
  it("the advisory moves to a different package -> mismatch", () => {
    const audit = clone(FULL);
    audit.vulnerabilities.minimatch.via[0].name = "glob";
    expect(ev({ audit }).exceptions[0].state).toBe("mismatch");
  });
  it("minimatch appears at a new path (e.g. pulled in by something else) -> mismatch", () => {
    const audit = clone(FULL);
    audit.vulnerabilities.minimatch.nodes.push("node_modules/some-prod-lib/node_modules/minimatch");
    const r = ev({ audit });
    expect(r.ok).toBe(false);
    expect(r.problems.join()).toMatch(/new affected path node_modules\/some-prod-lib/);
  });
  it("a directly-declared vulnerable package outside the toolchain -> mismatch", () => {
    const audit = clone(FULL);
    audit.vulnerabilities.next = vuln("next", "moderate", ["minimatch"], { isDirect: true });
    const r = ev({ audit });
    expect(r.ok).toBe(false);
    expect(r.problems.join()).toMatch(/directly-declared package next is outside the verified toolchain/);
  });
  it("dev-only: a toolchain root declared in dependencies (or missing from devDependencies) -> mismatch", () => {
    const moved = clone(PKG);
    moved.dependencies = { ...moved.dependencies, "eslint-config-next": moved.devDependencies["eslint-config-next"] };
    expect(ev({ packageJson: moved }).exceptions[0].state).toBe("mismatch");
    const gone = clone(PKG);
    delete gone.devDependencies["eslint-config-next"];
    expect(ev({ packageJson: gone }).exceptions[0].state).toBe("mismatch");
  });
  it("dev-only: the advisory, or a listed package, in the PRODUCTION audit -> mismatch", () => {
    const withAdvisory = clone(PROD);
    withAdvisory.vulnerabilities.minimatch = clone(FULL.vulnerabilities.minimatch);
    const a = ev({ prodAudit: withAdvisory });
    expect(a.ok).toBe(false);
    expect(a.problems.join()).toMatch(/PRODUCTION audit/);
    const withPackage = clone(PROD);
    withPackage.vulnerabilities["eslint-config-next"] = vuln("eslint-config-next", "moderate", ["minimatch"]);
    expect(ev({ prodAudit: withPackage }).exceptions[0].state).toBe("mismatch");
  });
});

describe("negative: malformed input fails closed", () => {
  it.each([
    ["npm audit error payload", { error: { code: "ENOAUDIT", summary: "boom" } }],
    ["wrong report version", { auditReportVersion: 1, vulnerabilities: {}, metadata: {} }],
    ["null", null],
    ["array", []],
    ["no vulnerabilities map", { auditReportVersion: 2, metadata: {} }],
  ])("full audit: %s", (_n, audit) => {
    const r = ev({ audit });
    expect(r.ok).toBe(false);
    expect(r.problems.join()).toMatch(/fail closed/);
  });
  it("production audit missing or errored -> fail (dev-only cannot be proven)", () => {
    expect(ev({ prodAudit: undefined }).ok).toBe(false);
    expect(ev({ prodAudit: { error: { code: "X" } } }).ok).toBe(false);
  });
  it("exceptions file malformed -> fail", () => {
    for (const exceptions of [undefined, {}, { exceptions: "x" }, []]) expect(ev({ exceptions }).ok).toBe(false);
  });
  it.each(["approvedBy", "approvedOn", "rationale", "removalCriteria", "allowedPackages", "nodes", "directRoots", "affectedPaths"])("an exception without %s (the recorded acceptance / verified graph) is invalid", (k) => {
    const exceptions = clone(SHIPPED);
    delete exceptions.exceptions[0][k];
    const r = ev({ exceptions });
    expect(r.ok).toBe(false);
    expect(r.exceptions[0].state).toBe("invalid");
  });
  it("a malformed advisory id is invalid", () => {
    const exceptions = clone(SHIPPED);
    exceptions.exceptions[0].id = "minimatch";
    expect(ev({ exceptions }).ok).toBe(false);
  });
});

describe("audit-gate CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "azerdex-audit-gate-"));
  const put = (name: string, v: unknown) => { const f = join(dir, name); writeFileSync(f, typeof v === "string" ? v : JSON.stringify(v)); return f; };
  const gate = async (over: Record<string, string> = {}) => {
    const a = {
      audit: join(FIX, "web-full-release-8d033a4.json"),
      "prod-audit": join(FIX, "web-prod-release-8d033a4.json"),
      package: join(process.cwd(), "package.json"),
      exceptions: join(ROOT, ".github", "audit-exceptions.json"),
      ...over,
    };
    const argv = [join(process.cwd(), "scripts", "audit-gate.mjs"), "--project", "web", ...Object.entries(a).flatMap(([k, v]) => [`--${k}`, v])];
    try { const r = await run(process.execPath, argv); return { code: 0, out: r.stdout + r.stderr }; }
    catch (e) { const x = e as { code: number; stdout: string; stderr: string }; return { code: x.code, out: x.stdout + x.stderr }; }
  };
  it("exits 0 for the real audit with the shipped exception and states the hard expiry", async () => {
    const r = await gate();
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/AUDIT GATE OK/);
    expect(r.out).toMatch(/fails closed from 2026-12-16T00:00:00.000Z/);
  });
  it("exits 1 and names every blocked finding when there is no exception", async () => {
    const r = await gate({ exceptions: put("none.json", { exceptions: [] }) });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/BLOCKED moderate GHSA-g3hv-75wg-m249 \(minimatch >=7.0.0 <11.0.1\)/);
    expect(r.out).toMatch(/AUDIT GATE FAILED: 9 blocked/);
  });
  it("exits 1 for an expired entry (real clock is past 2020)", async () => {
    const e = clone(SHIPPED);
    e.exceptions[0].expires = "2020-01-01";
    const r = await gate({ exceptions: put("expired.json", e) });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/EXPIRED/);
  });
  it("exits 1 for an obsolete exception", async () => {
    const empty = put("empty.json", { auditReportVersion: 2, vulnerabilities: {}, metadata: {} });
    const r = await gate({ audit: empty, "prod-audit": empty });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/OBSOLETE/);
  });
  it("exits 2 (never 0) for a missing or malformed input, and has no way to set the clock", async () => {
    expect((await gate({ audit: join(dir, "does-not-exist.json") })).code).toBe(2);
    expect((await gate({ audit: put("bad.json", "{not json") })).code).toBe(2);
    expect((await gate({ "prod-audit": put("err.json", { error: { code: "E" } }) })).code).toBe(1);
    expect(readFileSync(join(process.cwd(), "scripts", "audit-gate.mjs"), "utf8")).not.toMatch(/--now|AUDIT_GATE_NOW|process\.env/);
  });
});
