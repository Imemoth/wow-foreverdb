// Network probe for the cinematic zone heroes: the SAME eight renditions from two origins, for the later Vercel (same-origin) vs Cloudflare Pages
// (CDN) comparison. Read-only GETs of public files; run from an unrestricted machine, ideally from several regions and at different times.
//
//   node scripts/hero-perf-probe.mjs --vercel https://beta.azerdex.com --cloudflare https://azerdex-assets.pages.dev [--runs 10] [--out probe.json]
//
// Vercel/same-origin paths come from the inventory's `source` names (/zones/hero/<source>); Cloudflare paths from `zone-heroes/<id>/<version>/<file>`.
// Per file and origin it records status, bytes, TTFB and total time of cold-ish sequential requests (a cache-busting query is NOT added: the first
// run shows the edge state, later runs the warm state - both are reported), and the cache headers (cache-control, age, x-vercel-cache, cf-cache-status).
// Sanity-checks only; no thresholds. See docs/web/zone-hero-performance-baseline.md for the protocol.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
const runs = Number(args.get("runs") ?? 10);
const origins = { vercel: args.get("vercel"), cloudflare: args.get("cloudflare") };
if (!origins.vercel || !origins.cloudflare || !(runs >= 1 && runs <= 100)) {
  console.error("usage: hero-perf-probe.mjs --vercel <origin> --cloudflare <origin> [--runs 1..100] [--out file.json]");
  process.exit(2);
}
for (const [k, v] of Object.entries(origins)) {
  const u = new URL(v);
  if (u.pathname !== "/" || u.search || u.username) { console.error(`${k}: pass a bare origin`); process.exit(2); }
  origins[k] = u.origin;
}
const inv = JSON.parse(readFileSync(fileURLToPath(new URL("../../scripts/map-atlas/heroes/zone-heroes.json", import.meta.url)), "utf8"));
const files = Object.entries(inv.zones).flatMap(([id, z]) => Object.entries(z.versions).flatMap(([v, ver]) => ver.renditions.map((r) => ({
  zone: id, file: r.file, bytes: r.bytes, sha256: r.sha256,
  paths: { vercel: `/zones/hero/${r.source}`, cloudflare: `/zone-heroes/${id}/${v}/${r.file}` },
}))));

async function one(url) {
  const t0 = performance.now();
  const res = await fetch(url, { redirect: "manual", headers: { "user-agent": "AzerDex-hero-perf-probe/1.0" } });
  const ttfb = performance.now() - t0;
  const body = new Uint8Array(await res.arrayBuffer());
  const total = performance.now() - t0;
  const h = (n) => res.headers.get(n);
  return { status: res.status, bytes: body.length, ttfb, total, type: h("content-type"), cache: h("cache-control"), age: h("age"), encoding: h("content-encoding"),
    edge: h("x-vercel-cache") ?? h("cf-cache-status"), server: h("server") };
}
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const out = { when: new Date().toISOString(), runs, origins, results: [] };
for (const f of files) {
  for (const [name, origin] of Object.entries(origins)) {
    const url = origin + f.paths[name];
    const rs = [];
    for (let i = 0; i < runs; i++) rs.push(await one(url));
    out.results.push({ origin: name, url, expectedBytes: f.bytes, ok: rs.every((r) => r.status === 200 && r.bytes === f.bytes),
      first: rs[0], medianTtfbMs: median(rs.map((r) => r.ttfb)), medianTotalMs: median(rs.map((r) => r.total)), warmEdge: rs.at(-1).edge, cache: rs[0].cache, type: rs[0].type });
  }
}
const bad = out.results.filter((r) => !r.ok);
console.log("origin      | file                              | ok | bytes  | first TTFB | median TTFB | median total | edge | cache-control");
for (const r of out.results) console.log(`${r.origin.padEnd(11)} | ${r.url.split("/").slice(-1)[0].padEnd(33)} | ${r.ok ? "y " : "NO"} | ${String(r.first.bytes).padEnd(6)} | ${r.first.ttfb.toFixed(0).padStart(8)}ms | ${r.medianTtfbMs.toFixed(0).padStart(9)}ms | ${r.medianTotalMs.toFixed(0).padStart(10)}ms | ${r.warmEdge ?? "-"} | ${r.cache}`);
if (args.get("out")) writeFileSync(args.get("out"), JSON.stringify(out, null, 1));
if (bad.length) { console.error(`${bad.length} request series failed (status/bytes mismatch)`); process.exit(1); }
