// Dependency-audit policy: parses the structured `npm audit --json` report and applies owner-approved, time-limited, exactly
// matched advisory exceptions (pure: no network, no file system, no clock of its own: `now` is injected).
//
// What this is NOT: an ignore list, a lowered threshold or a way to silence audit output. Every advisory at or above the threshold
// still fails the gate unless an exception in .github/audit-exceptions.json matches it EXACTLY and is still in force. An exception:
//   * names one advisory (GHSA id), its package, the vulnerable range and the severity it was accepted at;
//   * lists every package that may be affected (the verified toolchain) and the node_modules paths of the vulnerable package;
//   * is dev-only: every directly-declared vulnerable package must be a devDependency, and the PRODUCTION audit must not report the
//     advisory or any of the listed packages;
//   * expires: from 00:00 UTC of the day AFTER `expires` it no longer applies, and the gate fails as long as the entry exists;
//   * fails closed when it no longer matches reality (advisory gone, range/severity changed, a new affected package or path), which
//     is also how an obsolete exception gets noticed and removed.
// docs/web/dependency-audit-exceptions.md records the owner's acceptance, rationale and removal criteria.

const SEVERITY = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const GHSA = /^GHSA(-[2-9cfghjmpqrvwx]{4}){3}$/;
const DAY_MS = 86_400_000;

/** First instant at which an exception whose last valid day is `expires` (YYYY-MM-DD, UTC) no longer applies; null if malformed. */
export function failClosedFrom(expires) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expires ?? "");
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const start = Date.UTC(y, mo - 1, d);
  const back = new Date(start);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null; // 2026-02-31 etc.
  return start + DAY_MS;
}

const nonEmpty = (s) => typeof s === "string" && s.trim().length > 0;
const stringList = (a) => Array.isArray(a) && a.length > 0 && a.every(nonEmpty);

/** Strict schema check of one exception entry. Returns a list of problems (empty = valid). */
export function validateException(e) {
  const p = [];
  if (!e || typeof e !== "object") return ["exception is not an object"];
  if (!nonEmpty(e.project)) p.push("project is required");
  if (!GHSA.test(String(e.id ?? ""))) p.push("id must be a GHSA id");
  if (!nonEmpty(e.package)) p.push("package is required");
  if (!nonEmpty(e.range)) p.push("range is required");
  if (e.severity !== "moderate") p.push("an exception can only ever be for a moderate advisory (high and critical are never excepted)");
  if (failClosedFrom(e.expires) === null) p.push("expires must be a valid YYYY-MM-DD date");
  for (const k of ["allowedPackages", "nodes", "directRoots", "affectedPaths"]) if (!stringList(e[k])) p.push(`${k} must be a non-empty list of strings`);
  for (const k of ["approvedBy", "approvedOn", "rationale", "removalCriteria"]) if (!nonEmpty(e[k])) p.push(`${k} (the recorded owner risk acceptance) is required`);
  if (stringList(e.allowedPackages) && nonEmpty(e.package) && !e.allowedPackages.includes(e.package)) p.push("allowedPackages must include the advisory's own package");
  return p;
}

function advisoryId(v) {
  const m = /\/advisories\/GHSA-([a-z0-9-]+)\/?$/i.exec(String(v?.url ?? ""));
  return m ? `GHSA-${m[1].toLowerCase()}` : `source:${v?.source ?? "unknown"}`;
}

function shapeProblems(report, label) {
  if (!report || typeof report !== "object" || Array.isArray(report)) return [`${label}: not a JSON object (fail closed)`];
  if (report.error) return [`${label}: npm audit returned an error instead of a report (fail closed)`];
  if (report.auditReportVersion !== 2 || !report.vulnerabilities || typeof report.vulnerabilities !== "object" || !report.metadata) {
    return [`${label}: not an npm audit v2 report (fail closed)`];
  }
  return [];
}

/** Every advisory object in a report: { id, name, severity, range, via: <package that carries it> }. */
function advisoriesOf(report) {
  const out = [];
  for (const [pkg, v] of Object.entries(report.vulnerabilities)) {
    for (const via of v.via ?? []) if (via && typeof via === "object") out.push({ id: advisoryId(via), name: via.name, severity: via.severity, range: via.range, pkg });
  }
  return out;
}

/**
 * @param input { project, audit, prodAudit, packageJson, exceptions, now, level? }
 * @returns { ok, blocked[], excepted[], problems[], exceptions[] }  (ok only when there is nothing blocked and no problem)
 */
export function evaluateAudit({ project, audit, prodAudit, packageJson, exceptions, now, level = "moderate" }) {
  const problems = [];
  const blocked = [];
  const excepted = [];
  const status = [];
  const nowMs = now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(nowMs)) throw new Error("evaluateAudit needs an explicit `now`");
  const threshold = SEVERITY[level];
  if (threshold === undefined) throw new Error(`unknown audit level ${level}`);

  problems.push(...shapeProblems(audit, "full audit"), ...shapeProblems(prodAudit, "production audit"));
  if (problems.length) return { ok: false, blocked, excepted, problems, exceptions: status };

  if (!exceptions || typeof exceptions !== "object" || !Array.isArray(exceptions.exceptions)) {
    problems.push("audit exceptions file is not { exceptions: [...] } (fail closed)");
    return { ok: false, blocked, excepted, problems, exceptions: status };
  }

  const all = advisoriesOf(audit);
  const prodAll = advisoriesOf(prodAudit);
  const mine = exceptions.exceptions.filter((e) => e && e.project === project);

  // 1. Decide which exceptions are in force.
  const applied = [];
  for (const e of mine) {
    const bad = validateException(e);
    const label = `${e?.id ?? "?"}`;
    if (bad.length) { problems.push(`exception ${label} is invalid: ${bad.join("; ")}`); status.push({ id: label, state: "invalid" }); continue; }
    const until = failClosedFrom(e.expires);
    if (nowMs >= until) {
      problems.push(`exception ${e.id} EXPIRED (it stopped applying at ${new Date(until).toISOString()}); fix the advisory or have the owner renew it in a reviewed change, and remove the entry once it is no longer needed`);
      status.push({ id: e.id, state: "expired", failClosedFrom: new Date(until).toISOString() });
      continue;
    }
    const idLc = e.id.toLowerCase();
    const found = all.filter((a) => a.id.toLowerCase() === idLc);
    if (found.length === 0) {
      problems.push(`exception ${e.id} is OBSOLETE: the advisory is no longer reported for ${project}. Remove it from .github/audit-exceptions.json (fail closed)`);
      status.push({ id: e.id, state: "obsolete" });
      continue;
    }
    const mism = [];
    for (const a of found) {
      if (a.name !== e.package) mism.push(`advisory is now reported for package ${a.name}, not ${e.package}`);
      if (a.range !== e.range) mism.push(`vulnerable range changed to ${a.range}`);
      if (a.severity !== e.severity) mism.push(`severity changed to ${a.severity}`);
    }
    const carrier = audit.vulnerabilities[e.package];
    for (const n of carrier?.nodes ?? []) if (!e.nodes.includes(n)) mism.push(`new affected path ${n}`);
    for (const [pkg, v] of Object.entries(audit.vulnerabilities)) {
      if (SEVERITY[v.severity] >= threshold && v.isDirect && !e.directRoots.includes(pkg)) mism.push(`directly-declared package ${pkg} is outside the verified toolchain`);
    }
    for (const root of e.directRoots) {
      const dev = packageJson?.devDependencies && Object.hasOwn(packageJson.devDependencies, root);
      const prod = ["dependencies", "optionalDependencies", "peerDependencies"].some((k) => packageJson?.[k] && Object.hasOwn(packageJson[k], root));
      if (!dev || prod) mism.push(`${root} is not a devDependency only`);
    }
    // Dev-only: the production audit must not carry this advisory or any listed package.
    if (prodAll.some((a) => a.id.toLowerCase() === idLc)) mism.push("the advisory is present in the PRODUCTION audit (not dev-only)");
    for (const pkg of Object.keys(prodAudit.vulnerabilities)) if (e.allowedPackages.includes(pkg)) mism.push(`${pkg} is vulnerable in the production tree`);
    if (mism.length) {
      problems.push(`exception ${e.id} no longer matches the verified dependency graph: ${[...new Set(mism)].join("; ")} (fail closed)`);
      status.push({ id: e.id, state: "mismatch" });
      continue;
    }
    applied.push(e);
    status.push({ id: e.id, state: "active", expires: e.expires, failClosedFrom: new Date(until).toISOString(), daysLeft: Math.max(0, Math.ceil((until - nowMs) / DAY_MS)) });
  }

  // 2. Classify every advisory and every affected package at or above the threshold.
  for (const a of all) {
    if (SEVERITY[a.severity] === undefined || SEVERITY[a.severity] < threshold) continue;
    const cover = applied.find((e) => e.id.toLowerCase() === a.id.toLowerCase());
    (cover ? excepted : blocked).push({ kind: "advisory", id: a.id, package: a.name, severity: a.severity, range: a.range, via: a.pkg, ...(cover ? { exception: cover.id } : {}) });
  }
  for (const [pkg, v] of Object.entries(audit.vulnerabilities)) {
    if (SEVERITY[v.severity] === undefined || SEVERITY[v.severity] < threshold) continue;
    const cover = applied.find((e) => e.allowedPackages.includes(pkg));
    (cover ? excepted : blocked).push({ kind: "package", package: pkg, severity: v.severity, ...(cover ? { exception: cover.id } : { reason: "not covered by an exception" }) });
  }

  return { ok: problems.length === 0 && blocked.length === 0, blocked, excepted, problems, exceptions: status };
}
