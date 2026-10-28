#!/usr/bin/env node
// READ-ONLY verification of the talent icons on an asset host (HTTP GET only: no upload, no credentials).
//
//   node scripts/verify-talent-icons-cdn.mjs --base https://azerdex-assets.pages.dev --dataset src/data/talents/forever/<build> > evidence.json    (the evidence JSON goes to stdout; redirect it)
//   node scripts/verify-talent-icons-cdn.mjs --dir <staging dir containing talent-icons/<build>/> --dataset <dir>     (offline, before upload)
//
// For every distinct FileDataID in icons.json it checks, against icons-inventory.json: HTTP 200, Content-Type image/webp,
// the exact byte length and sha256, and reports the cache and nosniff headers. An unknown id must answer 404 (so a host that
// answers 200 to everything, e.g. an SPA fallback, is caught). An unreachable host is a FAIL, never a pass.
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const arg = (n) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const dataset = resolve(arg("dataset") ?? "");
const base = arg("base")?.replace(/\/+$/, "");
const dir = arg("dir") ? resolve(arg("dir")) : null;
if (!arg("dataset") || (!base && !dir)) {
  console.error("usage: verify-talent-icons-cdn.mjs --dataset <dir> (--base <https origin> | --dir <staging dir>)");
  process.exit(2);
}
const icons = JSON.parse(readFileSync(join(dataset, "icons.json"), "utf8"));
const inv = JSON.parse(readFileSync(join(dataset, "icons-inventory.json"), "utf8"));
// Everything taken from the data files that ends up in a URL or a path is validated first: a build is four dot-separated
// numbers and a FileDataID a positive 31-bit integer; anything else aborts before any request is made.
if (!/^\d+\.\d+\.\d+\.\d+$/.test(String(icons.build))) throw new Error("icons.json: malformed build");
const build = String(icons.build);
if (inv.build !== build) throw new Error(`inventory is for ${inv.build}, manifest for ${build}`);
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const ids = [...new Set(Object.values(icons.icons))]
  .map((v) => {
    if (!Number.isSafeInteger(v) || v <= 0 || v >= 2 ** 31) throw new Error(`icons.json: invalid FileDataID ${JSON.stringify(v)}`);
    return v;
  })
  .sort((a, b) => a - b);
const results = [];
const note = (id, ok, detail) => results.push({ id, ok, ...detail });

async function check(id) {
  const rec = inv.files[String(id)];
  if (!rec) return note(id, false, { error: "not in inventory" });
  const rel = `talent-icons/${build}/${id}.webp`;
  if (dir) {
    const p = join(dir, rel);
    if (!existsSync(p)) return note(id, false, { error: "file missing" });
    const b = readFileSync(p);
    return note(id, b.length === rec.webpBytes && sha256(b) === rec.webpSha256, { bytes: b.length });
  }
  try {
    const res = await fetch(`${base}/${rel}`, { headers: { "User-Agent": "AzerDex-talent-icons-readonly/1.0" }, signal: AbortSignal.timeout(30_000) });
    const b = Buffer.from(await res.arrayBuffer());
    const type = res.headers.get("content-type") ?? "";
    note(id, res.status === 200 && /^image\/webp/i.test(type) && b.length === rec.webpBytes && sha256(b) === rec.webpSha256, {
      status: res.status, contentType: type, bytes: b.length, cacheControl: res.headers.get("cache-control"), nosniff: res.headers.get("x-content-type-options"),
    });
  } catch (e) {
    note(id, false, { error: String(e.message ?? e) });
  }
}

const queue = [...ids];
await Promise.all(Array.from({ length: 8 }, async () => { for (let id; (id = queue.shift()) !== undefined; ) await check(id); }));

let negative = null;
if (base) {
  try {
    const res = await fetch(`${base}/talent-icons/${build}/1.webp`, { signal: AbortSignal.timeout(30_000) });
    negative = { url: `talent-icons/${build}/1.webp`, status: res.status, ok: res.status === 404 };
  } catch (e) {
    negative = { error: String(e.message ?? e), ok: false };
  }
}
const failed = results.filter((r) => !r.ok);
const sample = results.find((r) => r.cacheControl !== undefined) ?? null;
const evidence = {
  mode: dir ? "directory" : "http",
  base: base ?? null,
  build,
  checked: results.length,
  expected: ids.length,
  passed: results.length - failed.length,
  failed: failed.slice(0, 20),
  negativeControl: negative,
  headers: sample ? { cacheControl: sample.cacheControl, nosniff: sample.nosniff } : null,
  cacheOk: base ? results.every((r) => /immutable|max-age=(\d{6,})/.test(r.cacheControl ?? "")) : null,
};
const ok = results.length === ids.length && failed.length === 0 && (negative === null || negative.ok);
console.log(JSON.stringify({ ...evidence, ok }, null, 1));
process.exit(ok ? 0 : 1);
