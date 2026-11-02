#!/usr/bin/env node
// Release parity gate: beta vs production effective configuration, and proof that approved features are active.
//
//   node scripts/release-parity.mjs --snapshot env.json [--json]                       offline (tests, review): no network
//   node scripts/release-parity.mjs --live [--deployment <id|host>] [--expect-sha <sha>] [--json]   reads Vercel (read-only GET)
//   node scripts/release-parity.mjs --probe https://<deployment> [--bypass-env NAME] [--asset-origin https://azerdex-assets.pages.dev]
//
// --live needs VERCEL_TOKEN (read-only scope), VERCEL_PROJECT_ID and VERCEL_TEAM_ID in the ENVIRONMENT. It must only ever run from a
// trusted workflow (.github/workflows/release-parity.yml: never on pull_request). Secrets are never printed: variable values are only
// reported for the policy-public switches (talent icons/text, zone maps/heroes, asset host, deployment designation).
// Exit codes: 0 all pass, 1 a parity/probe check failed, 2 usage or an unverifiable input (treated as NO-GO, never as a pass).
import { readFileSync } from "node:fs";
import { evaluateParity, assessClassPage, CLASS_SLUGS, BETA_BRANCH } from "./lib/release-parity.mjs";

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const has = (n) => args.includes(`--${n}`);
const asJson = has("json");
const die = (msg, code = 2) => { console.error(msg); process.exit(code); };

const VERCEL_API = "https://api.vercel.com";
async function vercel(path, query = {}) {
  const token = process.env.VERCEL_TOKEN;
  if (!token) die("VERCEL_TOKEN is not set (live mode runs only from the trusted release gate)");
  const url = new URL(path, VERCEL_API);
  for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, v);
  if (url.origin !== VERCEL_API) die("refusing to send the token to a host other than api.vercel.com");
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000), redirect: "error" });
  if (!r.ok) die(`Vercel API ${path}: HTTP ${r.status} (the token needs read access to project environment variables; this is a NO-GO, not a pass)`);
  return r.json();
}

async function loadEntries() {
  const file = flag("snapshot");
  if (file) {
    const j = JSON.parse(readFileSync(file, "utf8"));
    return { entries: Array.isArray(j) ? j : j.envs ?? j.entries ?? [], deployment: j.deployment };
  }
  if (!has("live")) return null;
  const project = process.env.VERCEL_PROJECT_ID;
  const team = process.env.VERCEL_TEAM_ID;
  if (!project || !team) die("VERCEL_PROJECT_ID and VERCEL_TEAM_ID must be set");
  if (!/^prj_[A-Za-z0-9]+$/.test(project) || !/^team_[A-Za-z0-9]+$/.test(team)) die("malformed VERCEL_PROJECT_ID / VERCEL_TEAM_ID");
  // decrypt is deliberately NOT requested: encrypted/sensitive values stay opaque; the approved switches are plain variables.
  const envs = await vercel(`/v10/projects/${project}/env`, { teamId: team });
  const entries = [...(envs.envs ?? [])];
  let deployment;
  const dep = flag("deployment");
  if (dep) {
    if (!/^(dpl_[A-Za-z0-9]+|[a-z0-9-]+\.vercel\.app)$/i.test(dep)) die("--deployment must be a dpl_ id or a *.vercel.app host");
    const d = await vercel(`/v13/deployments/${dep}`, { teamId: team });
    deployment = { createdAt: d.createdAt ?? d.created, target: d.target ?? null, sha: d.meta?.githubCommitSha, id: d.id, readyState: d.readyState ?? d.status };
    if (deployment.readyState && deployment.readyState !== "READY") die(`deployment ${deployment.id} is ${deployment.readyState}, not READY`, 1);
    const want = flag("expect-sha");
    if (want && deployment.sha !== want) die(`deployment was built from ${deployment.sha}, expected ${want}`, 1);
  }
  return { entries, deployment };
}

const WHERE = (s) => (s.state === "missing" ? "missing" : s.state === "n/a" ? "-" : `${s.state}${s.value !== undefined ? `=${s.value}` : ""}`);

async function runParity() {
  const loaded = await loadEntries();
  if (!loaded) return null;
  const result = evaluateParity(loaded.entries, { betaBranch: flag("beta-branch") ?? BETA_BRANCH, deployment: loaded.deployment });
  if (asJson) console.log(JSON.stringify(result, null, 2));
  else {
    for (const r of result.rows) console.log(`${r.status === "pass" ? "PASS" : "FAIL"}  [${r.class}] ${r.key}  prod:${WHERE(r.production)}  beta:${WHERE(r.beta)}  (${r.evaluation})  ${r.reason}`);
    console.log(`\n${result.ok ? "PARITY OK" : "PARITY FAILED"}: ${result.summary.failed} failing of ${result.summary.total} (${JSON.stringify(result.summary.byClass)})`);
  }
  return result;
}

async function runProbe() {
  const base = flag("probe");
  if (!base) return null;
  const origin = new URL(base).origin;
  const assetOrigin = flag("asset-origin") ?? "https://azerdex-assets.pages.dev";
  const bypassEnv = flag("bypass-env");
  const bypass = bypassEnv ? process.env[bypassEnv] : undefined;
  if (bypassEnv && !bypass) die(`environment variable ${bypassEnv} is not set`);
  if (bypassEnv && !/^https:\/\/[a-z0-9.-]+\.vercel\.app$/i.test(origin)) die("refusing to send a protection-bypass secret to a host that is not https://*.vercel.app");
  const out = [];
  for (const slug of CLASS_SLUGS) {
    const headers = { "user-agent": "foreverdb-parity/1" };
    if (bypass) { headers["x-vercel-protection-bypass"] = bypass; headers["x-vercel-set-bypass-cookie"] = "false"; }
    const r = await fetch(`${origin}/guides/classes/${slug}`, { headers, signal: AbortSignal.timeout(30000), redirect: "manual" });
    const html = await r.text();
    const a = r.status === 200 ? assessClassPage({ html, csp: r.headers.get("content-security-policy") ?? "" }, { assetOrigin }) : { icons: 0, problems: [`HTTP ${r.status}`] };
    out.push({ class: slug, status: r.status, icons: a.icons, problems: a.problems, ok: a.problems.length === 0 });
  }
  if (asJson) console.log(JSON.stringify({ probe: out }, null, 2));
  else for (const o of out) console.log(`${o.ok ? "PASS" : "FAIL"}  /guides/classes/${o.class}  icons-in-html=${o.icons}  ${o.problems.join("; ")}`);
  return { ok: out.every((o) => o.ok) };
}

if (!flag("snapshot") && !has("live") && !flag("probe")) die("usage: release-parity.mjs (--snapshot <file> | --live [--deployment <id>] [--expect-sha <sha>]) [--json]   |   --probe <url> [--bypass-env NAME]");
const parity = await runParity();
const probe = await runProbe();
process.exit([parity, probe].every((r) => r === null || r.ok) ? 0 : 1);
