#!/usr/bin/env node
/**
 * ADM-UI-PREVIEW-01 build-isolation check.
 *
 *   node scripts/check-admin-preview-isolation.mjs                    # a NORMAL build (.next): the preview must be ABSENT
 *   node scripts/check-admin-preview-isolation.mjs --expect=present --dist=.next-admin-preview   # sanity: the check can see it in a preview build
 *
 * Absent means: the preview marker literal appears in no file of the build output, and no route manifest lists an /admin-preview route.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const arg = (name, dflt) => (process.argv.find((a) => a.startsWith(`--${name}=`)) ?? `--${name}=${dflt}`).split("=")[1];
const dist = join(process.cwd(), arg("dist", ".next"));
const expectPresent = arg("expect", "absent") === "present";
const MARKER = "AZERDEX-ADMIN-UI-PREVIEW-ISOLATED-SYNTHETIC-MARKER-v1";
const SKIP_DIRS = new Set(["cache"]);

if (!existsSync(dist)) { console.error(`FAIL: build output not found: ${dist} (run the build first)`); process.exit(2); }

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) { if (!SKIP_DIRS.has(name)) yield* walk(p); } else yield p;
  }
}

let files = 0, markerHits = [], routeHits = [];
for (const file of walk(dist)) {
  files++;
  if (statSync(file).size > 25 * 1024 * 1024) continue;
  const text = readFileSync(file, "latin1");
  if (text.includes(MARKER)) markerHits.push(file.slice(dist.length + 1));
  if (/(routes-manifest|app-path-routes-manifest|app-paths-manifest|prerender-manifest)\.json$/.test(file) && /admin-preview/.test(text)) routeHits.push(file.slice(dist.length + 1));
}

const found = markerHits.length > 0 || routeHits.length > 0;
if (expectPresent) {
  if (!markerHits.length || !routeHits.length) { console.error(`FAIL (sanity): expected the preview in ${dist} but marker files=${markerHits.length}, route manifests=${routeHits.length}`); process.exit(1); }
  console.log(`OK: preview present in ${dist} as expected (${markerHits.length} marker file(s), ${routeHits.length} route manifest(s)); scanned ${files} files.`);
} else {
  if (found) {
    console.error(`FAIL: Admin UI preview code or routes leaked into a normal build (${dist}).`);
    for (const f of markerHits) console.error(`  marker: ${f}`);
    for (const f of routeHits) console.error(`  route:  ${f}`);
    process.exit(1);
  }
  console.log(`OK: no Admin UI preview marker or route in ${dist}; scanned ${files} files.`);
}
