#!/usr/bin/env node
/**
 * HTTP-level verification of a ForeverDB web deployment. Dependency-free (Node >= 22, global fetch).
 *
 *   node scripts/verify-deployment.mjs <base-url> --expect <mode> [--bypass-env NAME] [--json]
 *
 * Modes
 *   protected   The URL is behind Vercel Deployment Protection. An UNAUTHENTICATED visitor must NOT
 *               reach the application: every probe must answer 401/403 or redirect to a Vercel login,
 *               and must carry no ForeverDB cookie, header or data. Run this from OUTSIDE your network
 *               allow-list (a plain laptop, no Vercel login). A protection flag in the dashboard is not
 *               proof; this is.
 *   preview     The application is reachable (locally, or with a protection-bypass secret passed through
 *               the environment variable named by --bypass-env) and must behave as a PREVIEW: synthetic
 *               banner, noindex everywhere, empty sitemap, robots disallow-all, hardened headers,
 *               Secure cookie on https, generic errors, no secrets.
 *   production  The future public release: indexable, real data banner (never the synthetic one),
 *               allow robots + sitemap, hardened headers. Not used until production is approved.
 *
 * Exit code 0 only if every check passes. Secrets are only ever read from the named environment
 * variable and are never printed.
 */

const args = process.argv.slice(2);
const base = args.find((a) => /^https?:\/\//.test(a));
const flag = (n) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const mode = flag("--expect");
const bypassEnv = flag("--bypass-env");
const asJson = args.includes("--json");

if (!base || !["protected", "preview", "production"].includes(mode ?? "")) {
  console.error("usage: verify-deployment.mjs <base-url> --expect protected|preview|production [--bypass-env NAME] [--json]");
  process.exit(2);
}

const origin = new URL(base).origin;
const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: Boolean(ok), detail: ok ? "" : String(detail) });

const bypass = bypassEnv ? process.env[bypassEnv] : undefined;
if (bypassEnv && mode === "protected") {
  console.error("--bypass-env cannot be combined with --expect protected: the protection test must be unauthenticated");
  process.exit(2);
}
if (bypassEnv && !/^https:\/\/[a-z0-9.-]+\.vercel\.app$/i.test(origin) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
  console.error("refusing to send a protection-bypass secret to a host that is not https://*.vercel.app or localhost");
  process.exit(2);
}
if (bypassEnv && !bypass) {
  console.error(`environment variable ${bypassEnv} is not set`);
  process.exit(2);
}
let n = 100;
async function get(path, extra = {}) {
  n += 1;
  const headers = { "user-agent": "foreverdb-verify/1", ...extra };
  if (bypass) {
    headers["x-vercel-protection-bypass"] = bypass;
    headers["x-vercel-set-bypass-cookie"] = "false";
  }
  // Distinct client per probe when the deployment trusts x-forwarded-for (local runs).
  if (!headers["x-forwarded-for"] && /localhost|127\.0\.0\.1/.test(origin)) headers["x-forwarded-for"] = `198.51.100.${n % 250}`;
  const r = await fetch(origin + path, { redirect: "manual", headers, signal: AbortSignal.timeout(20000) });
  const text = await r.text();
  return { status: r.status, headers: r.headers, text, setCookies: r.headers.getSetCookie?.() ?? [] };
}
const h = (r, k) => r.headers.get(k) ?? "";

const PROBES = ["/", "/robots.txt", "/sitemap.xml", "/item/2770", "/api/v1/meta", "/api/v1/search?q=copper", "/api/v1/item/2770"];

if (mode === "protected") {
  for (const p of PROBES) {
    const r = await get(p);
    const loc = h(r, "location");
    const blocked = r.status === 401 || r.status === 403 || (r.status >= 300 && r.status < 400 && /vercel\.com|sso-api/i.test(loc));
    check(`${p} is not reachable without authentication`, blocked, `HTTP ${r.status}${loc ? ` -> ${loc}` : ""}`);
    check(`${p} leaks no ForeverDB data`, !/ForeverDB|synthetic-sample|"items"|"dataset"/i.test(r.text.replace(/<title>[^<]*<\/title>/i, "")) || r.status === 401 || r.status === 403, "application content in a blocked response");
    check(`${p} sets no ForeverDB cookie`, !r.setCookies.some((c) => /fdb_/i.test(c)), "fdb_* cookie on a blocked response");
    check(`${p} carries no ForeverDB deployment header`, !h(r, "x-foreverdb-deployment"), "application header on a blocked response");
  }
} else {
  const home = await get("/");
  check("home page is served (HTTP 200)", home.status === 200, `HTTP ${home.status}`);
  const robotsMeta = /<meta name="robots" content="([^"]*)"/.exec(home.text)?.[1] ?? "";
  const canonical = /<link rel="canonical" href="([^"]+)"/.exec(home.text)?.[1];
  const synthetic = /Preview with synthetic sample data/.test(home.text);
  check("security: nosniff", h(home, "x-content-type-options") === "nosniff");
  check("security: frame denial", h(home, "x-frame-options") === "DENY" && /frame-ancestors 'none'/.test(h(home, "content-security-policy")));
  check("security: nonce CSP with strict-dynamic, no unsafe-inline/eval", /script-src [^;]*'nonce-[^']+'[^;]*'strict-dynamic'/.test(h(home, "content-security-policy")) && !/unsafe-(inline|eval)/.test(h(home, "content-security-policy")), h(home, "content-security-policy").slice(0, 120));
  check("security: referrer and permissions policy", Boolean(h(home, "referrer-policy")) && /camera=\(\)/.test(h(home, "permissions-policy")));
  check("cache: HTML is never shared-cached", /no-store|private/.test(h(home, "cache-control")), h(home, "cache-control"));
  check("no X-Powered-By", !h(home, "x-powered-by"));
  check("canonical link is on the deployment's own origin (never localhost on a hosted URL)", Boolean(canonical) && (/localhost|127\.0\.0\.1/.test(origin) || !/localhost/i.test(canonical)), canonical);
  const sid = home.setCookies.find((c) => /fdb_sid=/.test(c)) ?? "";
  if (origin.startsWith("https://")) {
    check("security: HSTS on https", /max-age=\d{7,}/.test(h(home, "strict-transport-security")));
    check("cookie: Secure, HttpOnly, SameSite, __Host- prefix", /^__Host-fdb_sid=/.test(sid) && /;\s*Secure/i.test(sid) && /HttpOnly/i.test(sid) && /SameSite=/i.test(sid) && !/Domain=/i.test(sid), sid.replace(/=[^;]+/, "=<redacted>"));
  } else if (sid) {
    check("cookie: HttpOnly and SameSite (plain http local run)", /HttpOnly/i.test(sid) && /SameSite=/i.test(sid), sid.replace(/=[^;]+/, "=<redacted>"));
  }
  const meta = await get("/api/v1/meta");
  check("API meta responds with JSON", meta.status === 200 && /json/.test(h(meta, "content-type")), `HTTP ${meta.status}`);
  check("API responses set no cookie", meta.setCookies.length === 0);
  const bad = await get("/api/v1/search?q=%25&bogus=1");
  check("API validation error is generic and uncached", bad.status === 400 && /^\{"error":"[a-z_]+"\}$/.test(bad.text) && h(bad, "cache-control") === "no-store", `HTTP ${bad.status} ${bad.text.slice(0, 60)}`);
  check("error bodies contain no stack, SQL or connection string", !/stack|node_modules|select .* from|postgres(ql)?:\/\//i.test(bad.text + (await get("/item/not-a-number")).text));
  check("no connection strings, keys or private project references in the page", !/postgres(ql)?:\/\/|foreverdb_web_reader|klxhikdlfwgxurdyexdi|service_role|\.supabase\.co/i.test(home.text));
  const robots = await get("/robots.txt");
  const sitemap = await get("/sitemap.xml");

  if (mode === "preview") {
    check("deployment header says preview", h(home, "x-foreverdb-deployment") === "preview", h(home, "x-foreverdb-deployment"));
    check("X-Robots-Tag: noindex, nofollow on HTML", h(home, "x-robots-tag") === "noindex, nofollow", h(home, "x-robots-tag"));
    check("X-Robots-Tag: noindex, nofollow on API", h(meta, "x-robots-tag") === "noindex, nofollow", h(meta, "x-robots-tag"));
    check("robots meta is noindex, nofollow", robotsMeta === "noindex, nofollow", robotsMeta);
    check("deployment meta says preview", /<meta name="foreverdb-deployment" content="preview"/.test(home.text));
    check("robots.txt disallows everything", /Disallow: \/\s*$/m.test(robots.text) && !/^Allow:/im.test(robots.text) && !/sitemap/i.test(robots.text), robots.text.slice(0, 80));
    check("sitemap lists no URLs", !/<loc>/.test(sitemap.text));
    check("synthetic banner present (or real-data banner when a public DB is configured)", synthetic || /Observed data/.test(home.text));
  } else {
    check("deployment header says production", h(home, "x-foreverdb-deployment") === "production", h(home, "x-foreverdb-deployment"));
    check("pages are indexable (no noindex header or meta)", !/noindex/i.test(h(home, "x-robots-tag")) && !/noindex/i.test(robotsMeta), `${h(home, "x-robots-tag")} / ${robotsMeta}`);
    check("production never shows the synthetic banner", !synthetic);
    check("robots.txt allows crawling and names the sitemap", /Allow: \//i.test(robots.text) && /sitemap/i.test(robots.text));
    check("sitemap lists URLs", /<loc>/.test(sitemap.text));
  }
}

const failed = results.filter((r) => !r.ok);
if (asJson) console.log(JSON.stringify({ origin, mode, passed: results.length - failed.length, failed: failed.length, results }, null, 2));
else {
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  [${r.detail}]`}`);
  console.log(`\n${origin} (${mode}): ${results.length - failed.length}/${results.length} checks passed`);
}
process.exit(failed.length ? 1 : 0);
