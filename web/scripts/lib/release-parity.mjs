// Release parity policy and evaluator (pure: no network, no file system, no secrets).
//
// Why this exists: a green build is NOT proof that an approved public feature is live. The talent icons and rank descriptions are
// switched on by Vercel environment variables (AZERDEX_TALENT_ICONS=cdn, AZERDEX_TALENT_TEXT=1) that a build never validates: with
// them missing the production build succeeds, the deployment is READY, and the feature is silently absent. This module compares the
// EFFECTIVE configuration of the beta and of the production deployment and fails on any approved switch that is missing or wrong.
//
// Input is the metadata of a Vercel project's environment variables (the shape of `GET /v10/projects/{id}/env`, plus optional
// team-level shared variables). It is never printed back verbatim: only variable NAMES, classes and verdicts are reported, and a
// value only for the handful of switches that are public by construction (policy entries with `publicValue: true`).
//
// Classes (docs/web/release-parity.md):
//   1 required-match      approved public functionality: production MUST carry the exact value (and beta must not drift from it)
//   2 intentional         differs by design (credentials, databases, rate limiting, SEO, beta authorisation, feedback ...)
//   3 requires-approval   publication of third-party content that has NOT been approved: production must keep it off
//   4 unexpected          anything else that differs: needs a classification or a fix. Fails the check.

export const BETA_BRANCH = "web/azerdex-beta";
export const PRODUCTION_BRANCH = "release";

/** Hosts the asset base may point at. Kept identical to ALLOWED_ASSET_HOSTS in src/lib/maps/asset-url.ts (a unit test pins this). */
export const ALLOWED_ASSET_HOSTS = ["azerdex-assets.pages.dev", "assets.azerdex.com"];

export const CLASS = Object.freeze({
  REQUIRED: "required-match",
  INTENTIONAL: "intentional",
  APPROVAL: "requires-approval",
  UNEXPECTED: "unexpected",
});

const APPROVAL_NOTE = "Owner approval recorded for production publication (docs/web/release-parity.md, section 'Approvals').";

/**
 * Approved public functionality. `value` is the exact production value. `evaluation` says when the value is read:
 *   runtime  read by the server per request/render, but ONLY by a deployment created after the variable was saved
 *   build    inlined into the bundle at `next build` (NEXT_PUBLIC_*): a deployment built before the change keeps the old value
 */
export const REQUIRED_FEATURES = [
  { key: "AZERDEX_TALENT_ICONS", value: "cdn", evaluation: "runtime", feature: "Talent icons (cdn, not 1: src/lib/talents/icons.ts)", approval: APPROVAL_NOTE },
  { key: "AZERDEX_TALENT_TEXT", value: "1", evaluation: "runtime", feature: "Talent rank descriptions (src/lib/talents/text.ts)", approval: APPROVAL_NOTE },
  { key: "AZERDEX_ZONE_MAPS", value: "1", evaluation: "runtime", feature: "Zone maps (src/lib/maps/zone-maps-gate.ts)", approval: APPROVAL_NOTE },
  { key: "AZERDEX_ZONE_HERO_SOURCE", value: "cdn", evaluation: "runtime", feature: "Zone hero art from the asset CDN", approval: APPROVAL_NOTE },
].map((f) => Object.freeze({ ...f, publicValue: true }));

/** The shared asset CDN host: required in both, identical, https, on the allow-list. */
export const ASSET_BASE_KEY = "NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL";

/**
 * Variables that are deliberately different between beta and production. `expect` pins what is known to be right for an
 * environment (names and enumerations only, never secrets); everything else is simply allowed to differ.
 *   absent: true        the variable must not exist in that environment
 *   oneOf / notOneOf    exact allowed / forbidden values (only for policy-public values)
 */
export const INTENTIONAL = [
  { match: "FOREVERDB_DEPLOYMENT", why: "Environment designation: production vs preview", publicValue: true, expect: { production: { oneOf: ["production"] }, beta: { oneOf: ["preview"] } } },
  { match: "FOREVERDB_DATA_SOURCE", why: "Data source: public read DB vs fixture/beta data", publicValue: true },
  { match: "SITE_URL", why: "Canonical origin differs per environment", publicValue: false },
  { match: "BETA_SEO_AUTHORIZED_BRANCH", why: "Beta-only noindex/branch authorisation; must never exist in production", publicValue: true, expect: { production: { absent: true }, beta: { oneOf: [BETA_BRANCH] } } },
  { match: "AZERDEX_READ_DB_URL", why: "Database connection (secret)", publicValue: false },
  { match: /^RATE_LIMIT/, why: "Rate limiting (security)", publicValue: false },
  { match: /^UPSTASH_/, why: "Rate-limit store credentials (secret)", publicValue: false },
  { match: "TRUSTED_IP_HEADER", why: "Client-IP trust (security)", publicValue: false },
  { match: /^(NEXT_PUBLIC_)?TURNSTILE_/, why: "Bot challenge keys (security)", publicValue: false },
  { match: "CHALLENGE_COOKIE_SECRET", why: "Challenge cookie secret", publicValue: false },
  { match: /^ACCOUNT_/, why: "Account authentication and credentials (secret/environment bound)", publicValue: false },
  { match: /^(NEXT_PUBLIC_)?(FEEDBACK|BETA_FEEDBACK)/, why: "Preview feedback settings (beta only)", publicValue: false },
  { match: "AZERDEX_ATLAS_CATALOG", why: "Hermetic-CI pin; production must serve the CDN catalog", publicValue: true, expect: { production: { notOneOf: ["snapshot"] } } },
  { match: /^(NEXT_)?TELEMETRY|^NEXT_TELEMETRY_DISABLED$|^NODE_ENV$|^CI$/, why: "Tooling", publicValue: false },
];

/** Third-party content whose publication has NOT been approved: production must not enable it. */
export const REQUIRES_APPROVAL = [
  { key: "AZERDEX_POC_MAPS", why: "Proof-of-concept map route (never served by a production deployment)", enabledWhen: (v) => v === "1" },
];

/** Names no public deployment may ever carry (mirrors FORBIDDEN_VARIABLE_NAME in src/lib/env.ts). */
export const FORBIDDEN_NAME = /(^|_)SUPABASE(_|$)|SERVICE_ROLE|^DATABASE_URL$|^POSTGRES_(URL|PRISMA_URL|URL_NON_POOLING|URL_NO_SSL)$/i;

/** Platform variables Vercel injects itself: never compared. */
const SYSTEM = /^(NEXT_PUBLIC_)?VERCEL_|^TURBO_|^VERCEL$/;

const matches = (m, key) => (typeof m === "string" ? m === key : m.test(key));
const intentionalRule = (key) => INTENTIONAL.find((r) => matches(r.match, key));

// ---------------------------------------------------------------------------------------------------------------------
// Effective environment resolution
// ---------------------------------------------------------------------------------------------------------------------

const hasTarget = (e, t) => Array.isArray(e.target) ? e.target.includes(t) : e.target === t;

/**
 * Resolve the effective variables of one environment.
 *   production: entries targeting production (shared team variables as the lowest layer).
 *   beta:       preview-wide entries, overridden by entries bound to the beta branch, over shared preview variables.
 * Precedence (highest first): branch-specific project > project-wide > shared. Entries bound to a OTHER branch are ignored
 * (they cannot reach the beta), which is exactly how Vercel applies them.
 * Returns Map(key -> { type, value|undefined, layer, updatedAt }). `value` is kept ONLY for plain variables.
 */
export function effectiveEnv(entries, which, opts = {}) {
  const betaBranch = opts.betaBranch ?? BETA_BRANCH;
  const layerOf = (e) => {
    const shared = e.type === "shared" || e.source === "shared" || e.shared === true;
    if (which === "beta" && hasTarget(e, "preview") && e.gitBranch === betaBranch) return shared ? 2 : 3;
    if (which === "beta" && hasTarget(e, "preview") && !e.gitBranch) return shared ? 0 : 1;
    if (which === "production" && hasTarget(e, "production") && !e.gitBranch) return shared ? 0 : 1;
    return null;
  };
  const out = new Map();
  for (const e of entries ?? []) {
    if (!e || typeof e.key !== "string" || SYSTEM.test(e.key)) continue;
    const layer = layerOf(e);
    if (layer === null) continue;
    const prev = out.get(e.key);
    if (prev && prev.rank >= layer) continue;
    out.set(e.key, {
      rank: layer,
      type: e.type ?? "unknown",
      // Only a plain value is ever readable; sensitive/encrypted values are opaque and must never be treated as a value.
      value: e.type === "plain" || e.type === "shared" ? (typeof e.value === "string" ? e.value : undefined) : undefined,
      layer: ["shared", "project", "shared-branch", "branch"][layer],
      updatedAt: typeof e.updatedAt === "number" ? e.updatedAt : undefined,
    });
  }
  return out;
}

const describe = (v, publicValue) =>
  v === undefined ? { state: "missing" } : { state: v.value === undefined ? "present-opaque" : "present", type: v.type, layer: v.layer, ...(publicValue && v.value !== undefined ? { value: v.value } : {}) };

// ---------------------------------------------------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------------------------------------------------

function parseAssetBaseOrNull(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || u.port) return null;
  return ALLOWED_ASSET_HOSTS.includes(u.hostname) ? u.origin + u.pathname.replace(/\/+$/, "") : null;
}

function checkExpect(expect, v) {
  if (!expect) return null;
  if (expect.absent && v) return "must not exist in this environment";
  if (expect.oneOf) {
    if (!v) return `must be set to one of: ${expect.oneOf.join(", ")}`;
    if (v.value === undefined) return "value is not readable (store it as a plain variable so it can be verified)";
    if (!expect.oneOf.includes(v.value)) return `must be one of: ${expect.oneOf.join(", ")}`;
  }
  if (expect.notOneOf && v?.value !== undefined && expect.notOneOf.includes(v.value)) return `must not be: ${expect.notOneOf.join(", ")}`;
  return null;
}

/**
 * @param entries  project env metadata (+ optional shared entries), see effectiveEnv
 * @param opts     { betaBranch, deployment?: { target, createdAt }, requireBeta?: boolean }
 * @returns { ok, rows[], failures[], summary }
 */
export function evaluateParity(entries, opts = {}) {
  const prod = effectiveEnv(entries, "production", opts);
  const beta = effectiveEnv(entries, "beta", opts);
  const rows = [];
  const add = (row) => rows.push(row);

  // Class 1a: approved switches (exact production value; beta must equal it so beta really previews what production serves).
  for (const f of REQUIRED_FEATURES) {
    const p = prod.get(f.key);
    const b = beta.get(f.key);
    let status = "pass";
    const reasons = [];
    if (!p) { status = "fail"; reasons.push(`MISSING in production: required value is ${f.value}`); }
    else if (p.value === undefined) { status = "fail"; reasons.push("production value is not readable: store it as a plain variable so it can be verified exactly"); }
    else if (p.value !== f.value) { status = "fail"; reasons.push(`production value must be exactly ${f.value}`); }
    if (opts.requireBeta !== false) {
      if (!b) { status = "fail"; reasons.push("missing in beta (beta must preview what production serves)"); }
      else if (b.value !== undefined && b.value !== f.value) { status = "fail"; reasons.push(`beta value differs from the approved value ${f.value}`); }
    }
    add({ key: f.key, class: CLASS.REQUIRED, evaluation: f.evaluation, feature: f.feature, status, production: describe(p, true), beta: describe(b, true), reason: reasons.join("; ") || "ok" });
  }

  // Class 1b: the shared asset CDN host.
  {
    const p = prod.get(ASSET_BASE_KEY);
    const b = beta.get(ASSET_BASE_KEY);
    const reasons = [];
    const bad = (v, where) => {
      if (!v) reasons.push(`MISSING in ${where}`);
      else if (v.value === undefined) reasons.push(`${where} value is not readable (use a plain variable)`);
      else if (!parseAssetBaseOrNull(v.value)) reasons.push(`${where} value is not an https URL on an allow-listed asset host`);
    };
    bad(p, "production");
    if (opts.requireBeta !== false) bad(b, "beta");
    if (p?.value !== undefined && b?.value !== undefined && parseAssetBaseOrNull(p.value) && p.value.replace(/\/+$/, "") !== b.value.replace(/\/+$/, "")) reasons.push("production and beta point at different asset hosts");
    add({ key: ASSET_BASE_KEY, class: CLASS.REQUIRED, evaluation: "build", feature: "Shared asset CDN host (NEXT_PUBLIC_*: inlined at build time)", status: reasons.length ? "fail" : "pass", production: describe(p, true), beta: describe(b, true), reason: reasons.join("; ") || "ok" });
  }

  // Class 3: unapproved third-party content: must be off in production.
  for (const r of REQUIRES_APPROVAL) {
    const p = prod.get(r.key);
    const on = p ? (p.value === undefined ? true : r.enabledWhen(p.value)) : false;
    add({ key: r.key, class: CLASS.APPROVAL, evaluation: "runtime", feature: r.why, status: on ? "fail" : "pass", production: describe(p, true), beta: describe(beta.get(r.key), true), reason: on ? "enabled (or unreadable) in production without a recorded publication approval" : "off in production, as required" });
  }

  const handled = new Set([...REQUIRED_FEATURES.map((f) => f.key), ASSET_BASE_KEY, ...REQUIRES_APPROVAL.map((r) => r.key)]);

  // Forbidden names, anywhere.
  for (const [which, env] of [["production", prod], ["beta", beta]]) {
    for (const key of env.keys()) {
      if (FORBIDDEN_NAME.test(key)) add({ key, class: CLASS.UNEXPECTED, evaluation: "runtime", feature: "Forbidden variable name for a public deployment", status: "fail", production: describe(which === "production" ? env.get(key) : undefined, false), beta: describe(which === "beta" ? env.get(key) : undefined, false), reason: `${which}: a public deployment must never be given this variable (private backend credential)` });
    }
  }

  // Everything else, by name only.
  const keys = [...new Set([...prod.keys(), ...beta.keys()])].filter((k) => !handled.has(k) && !FORBIDDEN_NAME.test(k)).sort();
  for (const key of keys) {
    const p = prod.get(key);
    const b = beta.get(key);
    const rule = intentionalRule(key);
    if (rule) {
      const reasons = [rule.expect?.production && checkExpect(rule.expect.production, p) && `production ${checkExpect(rule.expect.production, p)}`, rule.expect?.beta && b && checkExpect(rule.expect.beta, b) && `beta ${checkExpect(rule.expect.beta, b)}`].filter(Boolean);
      // A required expectation on a variable that is missing entirely (e.g. FOREVERDB_DEPLOYMENT) is also checked:
      if (rule.expect?.production?.oneOf && !p && !reasons.some((r) => r.startsWith("production"))) reasons.push(`production must be set to one of: ${rule.expect.production.oneOf.join(", ")}`);
      add({ key, class: CLASS.INTENTIONAL, evaluation: /^NEXT_PUBLIC_/.test(key) ? "build" : "runtime", feature: rule.why, status: reasons.length ? "fail" : "pass", production: describe(p, rule.publicValue), beta: describe(b, rule.publicValue), reason: reasons.join("; ") || "intentional difference" });
      continue;
    }
    // Not classified. Presence or value differences are unexpected; a variable identical in both is just reported (warn-free pass).
    const same = !!p && !!b && p.value !== undefined && b.value !== undefined && p.value === b.value;
    const differs = !p !== !b || (p && b && p.value !== undefined && b.value !== undefined && p.value !== b.value);
    add({ key, class: CLASS.UNEXPECTED, evaluation: /^NEXT_PUBLIC_/.test(key) ? "build" : "runtime", feature: "Unclassified variable", status: differs ? "fail" : "pass", production: describe(p, false), beta: describe(b, false), reason: differs ? "differs between beta and production and has no classification in scripts/lib/release-parity.mjs: classify it (intentional / required) or align it" : same ? "identical in both" : "present in both (values not comparable)" });
  }

  // Staleness: the deployment under test must have been created AFTER the last change of every approved variable.
  if (opts.deployment) {
    const { createdAt, target } = opts.deployment;
    if (target !== undefined && target !== "production") add({ key: "(deployment)", class: CLASS.UNEXPECTED, evaluation: "build", feature: "Deployment under test", status: "fail", production: { state: "n/a" }, beta: { state: "n/a" }, reason: `deployment target is ${JSON.stringify(target)}, expected production` });
    if (typeof createdAt === "number") {
      const stale = [...REQUIRED_FEATURES.map((f) => f.key), ASSET_BASE_KEY].filter((k) => (prod.get(k)?.updatedAt ?? 0) > createdAt);
      add({ key: "(deployment freshness)", class: CLASS.REQUIRED, evaluation: "build", feature: "Deployment created after the last change of every approved variable", status: stale.length ? "fail" : "pass", production: { state: "n/a" }, beta: { state: "n/a" }, reason: stale.length ? `deployment predates the latest change of: ${stale.join(", ")}; build a NEW deployment (a previously promoted build does not carry them)` : "ok" });
    }
  }

  const failures = rows.filter((r) => r.status === "fail");
  return {
    ok: failures.length === 0,
    rows,
    failures,
    summary: {
      total: rows.length,
      failed: failures.length,
      byClass: Object.fromEntries(Object.values(CLASS).map((c) => [c, rows.filter((r) => r.class === c).length])),
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Live-site probe (class pages): proves the approved features are ACTIVE on a deployment, which a green build does not.
// ---------------------------------------------------------------------------------------------------------------------

export const CLASS_SLUGS = ["warrior", "paladin", "hunter", "rogue", "priest", "shaman", "mage", "warlock", "druid"];

/** Pure assessment of one class page response. */
export function assessClassPage({ html, csp }, { assetOrigin }) {
  const problems = [];
  const iconRe = new RegExp(`${assetOrigin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/talent-icons/[0-9.]+/[0-9]+\\.webp`, "g");
  const icons = html.match(iconRe) ?? [];
  if (icons.length === 0) problems.push("no talent icon URL from the asset host in the page");
  const imgSrc = /(?:^|;)\s*img-src\s+([^;]*)/.exec(csp ?? "")?.[1] ?? "";
  if (!imgSrc.split(/\s+/).includes(assetOrigin)) problems.push("CSP img-src does not allow the asset origin");
  const scriptSrc = /(?:^|;)\s*script-src\s+([^;]*)/.exec(csp ?? "")?.[1] ?? "";
  if (/'unsafe-inline'/.test(scriptSrc)) problems.push("CSP script-src contains 'unsafe-inline'");
  if (/'unsafe-inline'/.test(/(?:^|;)\s*style-src\s+([^;]*)/.exec(csp ?? "")?.[1] ?? "")) problems.push("CSP style-src contains 'unsafe-inline'");
  if (hasRawTemplateToken(visibleText(html))) problems.push("unresolved raw template token in visible text");
  return { icons: icons.length, problems };
}

/** Blizzard spell-description tokens that must never reach a page: $s1, $d, $a1, $<n>s1, ${...}, {{...}}. Unresolved values are shown as an explicit "?" gap instead. */
export function hasRawTemplateToken(text) {
  return /\$\{|\{\{|\$[a-z]\d{0,3}(?![a-z0-9])|\$\d+[a-z]\d?/i.test(text);
}

/** Visible text only: scripts/styles removed, tags stripped. */
export function visibleText(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
}
