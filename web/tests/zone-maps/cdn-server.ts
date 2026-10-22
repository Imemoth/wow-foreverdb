import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { deflateSync } from "node:zlib";
import snapshot from "../../src/lib/maps/atlas/atlas-index.snapshot.json";
import heroInventory from "../../../scripts/map-atlas/heroes/zone-heroes.json";
import { hasFile, readDistFile } from "../e2e/maps-helpers";

/**
 * A REAL local HTTPS server on the allow-listed asset host name (azerdex-assets.pages.dev). Chromium is told to resolve that host to it
 * (see playwright.zone-maps.config.ts), so the BROWSER enforces CORS and CSP for real (Playwright's route.fulfill would inject CORS
 * headers and prove nothing). It serves:
 *   - ATLAS_REAL_DIST (the private, approved distribution) when set: real artwork, with exactly the headers of the shipped `_headers`;
 *   - otherwise a SYNTHETIC atlas generated from the bundled catalog snapshot (plain 1002x668 grid images, valid manifests), so the
 *     suite runs in CI without private artwork. Synthetic pixels prove wiring, scaling and security, never real-art registration.
 */
export const ORIGIN = "https://azerdex-assets.pages.dev";
export const CDN_PORT = Number(process.env.E2E_CDN_ORIGIN_PORT ?? 3443);
export const REAL_DIST = process.env.ATLAS_REAL_DIST && hasFile(join(process.env.ATLAS_REAL_DIST, "_headers")) ? process.env.ATLAS_REAL_DIST : null;

const MIME: Record<string, string> = { ".webp": "image/webp", ".png": "image/png", ".json": "application/json" };
const HEADERS = {
  "/forever/": { "Cache-Control": "public, max-age=31536000, immutable", "Access-Control-Allow-Origin": "*", "X-Content-Type-Options": "nosniff" },
  "/atlas/": { "Cache-Control": "public, max-age=300, must-revalidate", "Access-Control-Allow-Origin": "*", "X-Content-Type-Options": "nosniff" },
  // Mirrors the /zone-heroes/* block of the unified `_headers` (scripts/map-atlas/mapatlas/packaging.py ZONE_HEROES_HEADERS).
  "/zone-heroes/": { "Cache-Control": "public, max-age=31536000, immutable", "Access-Control-Allow-Origin": "*", "X-Content-Type-Options": "nosniff", "Timing-Allow-Origin": "*" },
};

/**
 * Synthetic mode serves the cinematic heroes exactly as the unified distribution lays them out: `/zone-heroes/<id>/<version>/<role>-<width>.webp`,
 * with the REAL (public, watermarked) derivative bytes from web/public/zones/hero named by the audited inventory. Unknown paths are 404.
 */
function heroAsset(path: string): Buffer | null {
  const m = /^\/zone-heroes\/(\d+)\/(v\d+)\/((?:desktop|mobile)-\d+\.webp)$/.exec(path);
  if (!m) return null;
  const zone = (heroInventory.zones as Record<string, { versions: Record<string, { renditions: { file: string; source: string }[] }> }>)[m[1]!];
  const r = zone?.versions[m[2]!]?.renditions.find((x) => x.file === m[3]);
  return r ? readFileSync(join(__dirname, "../../public/zones/hero", r.source)) : null;
}

function crc32(buf: Buffer): number {
  let c, crc = ~0;
  for (let i = 0; i < buf.length; i++) { c = (crc ^ buf[i]!) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return ~crc >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** A w x h RGB PNG: dark background with a 10% grid, so geometry/zoom problems are visible in screenshots. */
export function gridPng(w: number, h: number): Buffer {
  const row = Buffer.alloc(1 + w * 3);
  const raw = Buffer.alloc(h * row.length);
  for (let y = 0; y < h; y++) {
    const gy = Math.abs(((y / h) * 100) % 10) < 0.15 || y === 0 || y === h - 1;
    for (let x = 0; x < w; x++) {
      const gx = Math.abs(((x / w) * 100) % 10) < 0.15 || x === 0 || x === w - 1;
      const o = y * row.length + 1 + x * 3;
      const c = gx || gy ? [70, 78, 120] : [30, 40, 60 + ((x + y) % 7)];
      raw[o] = c[0]!; raw[o + 1] = c[1]!; raw[o + 2] = c[2]!;
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

const png = new Map<string, Buffer>();
const pngFor = (w: number, h: number) => png.get(`${w}x${h}`) ?? (png.set(`${w}x${h}`, gridPng(w, h)), png.get(`${w}x${h}`)!);

/** Synthetic manifest/image for `forever/<id>/<ver>/...`, derived from the catalog (never invented for unknown maps). */
function synthetic(path: string): { body: Buffer; type: string } | null {
  const hero = heroAsset(path);
  if (hero) return { body: hero, type: "image/webp" };
  const m = /^\/forever\/(\d+)\/(v\d+)\/(manifest\.json|map\.png|[A-Za-z0-9][A-Za-z0-9._-]*\.webp)$/.exec(path);
  if (!m) return null;
  const map = snapshot.maps.find((x) => x.uiMapId === Number(m[1]) && x.latestVersion === m[2]);
  if (!map || !map.image) return null;
  const { width, height, variant } = map.image;
  // The catalog-declared default image (what the zone hero's map layer requests) is served too, as it is on the real CDN.
  const file = m[3]!;
  if (file.endsWith(".webp") && file !== map.image.path.split("/").pop()) return null;
  if (file !== "manifest.json") return { body: pngFor(width, height), type: "image/png" };
  const manifest = {
    schemaVersion: 1, zoneId: map.uiMapId, slug: map.slug, zoneName: map.name, version: m[2],
    image: { file: "map.png", format: "png", width, height, variant: `synthetic-${variant}` },
    projection: { type: "normalized-percent", origin: "top-left", xDirection: "right", yDirection: "down", range: [0, 100] },
    provenance: { source: "synthetic-test-atlas" }, clientBuild: { version: snapshot.currentBuild.version }, calibration: { status: "provisional" },
  };
  return { body: Buffer.from(JSON.stringify(manifest)), type: "application/json" };
}

function parseHeaders(text: string): { re: RegExp; headers: Record<string, string> }[] {
  const rules: { re: RegExp; headers: Record<string, string> }[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    if (!/^\s/.test(line)) rules.push({ re: new RegExp("^" + line.trim().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"), headers: {} });
    else { const i = line.indexOf(":"); const r = rules[rules.length - 1]; if (r) r.headers[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  }
  return rules;
}

/** The bytes the CDN serves for a path (real dist or synthetic), for tests that tamper with a response. */
export function readAsset(path: string): Buffer | null {
  return REAL_DIST ? readDistFile(REAL_DIST, path) : synthetic(path)?.body ?? null;
}

export interface Cdn {
  seen: { url: string; origin: string | undefined }[];
  stripCors: boolean;
  /** Respond 503 to every request (CDN outage). */
  down: boolean;
  mode: "real" | "synthetic";
  close: () => Promise<void>;
}

export async function startCdn(): Promise<Cdn> {
  const dir = mkdtempSync(join(tmpdir(), "azd-zcdn-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "1",
    "-subj", "/CN=azerdex-assets.pages.dev", "-addext", "subjectAltName=DNS:azerdex-assets.pages.dev"], { stdio: "ignore" });
  const rules = REAL_DIST ? parseHeaders((readDistFile(REAL_DIST, "/_headers") ?? Buffer.alloc(0)).toString("utf8")) : [];
  const state: Cdn = { seen: [], stripCors: false, down: false, mode: REAL_DIST ? "real" : "synthetic", close: async () => {} };
  const server = createServer({ key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")) }, (req, res) => {
    const path = new URL(req.url ?? "/", ORIGIN).pathname;
    state.seen.push({ url: path, origin: req.headers.origin as string | undefined });
    if (state.down) { res.writeHead(503).end("down"); return; }
    let body: Buffer | null; let type: string;
    if (REAL_DIST) { body = readDistFile(REAL_DIST, path); type = MIME[extname(path)] ?? "application/octet-stream"; }
    else {
      const s = synthetic(path);
      body = s?.body ?? null; type = s?.type ?? "text/plain";
      if (!s && path === "/atlas/index.json") { body = Buffer.from(JSON.stringify(snapshot)); type = "application/json"; }
    }
    if (body === null) { res.writeHead(404, { "content-type": "text/plain" }).end("not found"); return; }
    const headers: Record<string, string> = { "content-type": type };
    if (REAL_DIST) { for (const r of rules) if (r.re.test(path)) Object.assign(headers, r.headers); }
    else for (const [p, h] of Object.entries(HEADERS)) if (path.startsWith(p)) Object.assign(headers, h);
    if (state.stripCors) delete headers["Access-Control-Allow-Origin"];
    res.writeHead(200, headers).end(body);
  });
  await new Promise<void>((ok) => server.listen(CDN_PORT, "127.0.0.1", ok));
  state.close = () => new Promise<void>((ok) => { server.close(() => { rmSync(dir, { recursive: true, force: true }); ok(); }); });
  return state;
}
