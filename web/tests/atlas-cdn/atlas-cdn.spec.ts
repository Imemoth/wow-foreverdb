import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
// Plain Playwright test (NOT ../e2e/fixtures): that fixture adds an x-forwarded-for header to every request, which would turn the
// cross-origin manifest fetch into a preflighted one and no longer reflect what a real browser sends.
import { expect, test } from "@playwright/test";
import { expectWholeImageFits, geometry, markerError, settle } from "../e2e/maps-helpers";

const DIST = process.env.ATLAS_REAL_DIST;
const ORIGIN = "https://azerdex-assets.pages.dev";
const MIME: Record<string, string> = { ".webp": "image/webp", ".json": "application/json", "": "text/plain" };

/** Cloudflare Pages `_headers`: unindented line = path pattern (`*` splat), indented lines = headers. */
function parseHeaders(text: string): { re: RegExp; headers: Record<string, string> }[] {
  const rules: { re: RegExp; headers: Record<string, string> }[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    if (!/^\s/.test(line)) {
      rules.push({ re: new RegExp("^" + line.trim().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"), headers: {} });
    } else {
      const i = line.indexOf(":");
      const rule = rules[rules.length - 1];
      if (rule) rule.headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  return rules;
}

test.skip(!DIST || !existsSync(join(DIST ?? "", "_headers")), "ATLAS_REAL_DIST not set (private real artwork)");

const CDN_PORT = Number(process.env.E2E_CDN_ORIGIN_PORT ?? 3443);

interface Cdn { seen: { url: string; headers: Record<string, string | string[] | undefined> }[]; stripCors: boolean; rules: ReturnType<typeof parseHeaders>; close: () => Promise<void> }

/** A real HTTPS server on the allow-listed host name serving the real dist with exactly the headers from the shipped `_headers`. */
async function startCdn(): Promise<Cdn> {
  const dir = mkdtempSync(join(tmpdir(), "azd-cdn-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "1",
    "-subj", "/CN=azerdex-assets.pages.dev", "-addext", "subjectAltName=DNS:azerdex-assets.pages.dev"], { stdio: "ignore" });
  const rules = parseHeaders(readFileSync(join(DIST!, "_headers"), "utf8"));
  const state: Cdn = { seen: [], stripCors: false, rules, close: async () => {} };
  const server = createServer({ key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")) }, (req, res) => {
    const path = new URL(req.url ?? "/", ORIGIN).pathname;
    state.seen.push({ url: path, headers: req.headers });
    const file = resolve(DIST!, "." + path);
    if (!file.startsWith(resolve(DIST!) + sep) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404, { "content-type": "text/plain" }).end("not found"); return; }
    const headers: Record<string, string> = { "content-type": MIME[extname(file)] ?? "application/octet-stream" };
    for (const r of rules) if (r.re.test(path)) Object.assign(headers, r.headers);
    if (state.stripCors) delete headers["Access-Control-Allow-Origin"];
    res.writeHead(200, headers).end(readFileSync(file));
  });
  await new Promise<void>((ok) => server.listen(CDN_PORT, "127.0.0.1", ok));
  state.close = () => new Promise<void>((ok) => { server.close(() => { rmSync(dir, { recursive: true, force: true }); ok(); }); });
  return state;
}

let cdn: Cdn;
test.beforeAll(async () => { if (DIST && existsSync(join(DIST, "_headers"))) cdn = await startCdn(); });
test.afterAll(async () => { await cdn?.close(); });
test.beforeEach(() => { if (cdn) { cdn.seen.length = 0; cdn.stripCors = false; } });

test("the _headers policy gives immutable caching to versioned assets and short revalidation to the mutable catalog", () => {
  const { rules } = cdn;
  const h = (p: string) => Object.assign({}, ...rules.filter((r) => r.re.test(p)).map((r) => r.headers));
  for (const p of ["/forever/1420/v2/manifest.json", "/forever/1420/v2/full-reveal.webp", "/forever/1420/v1/tirisfal-glades.webp"]) {
    expect(h(p)["Cache-Control"], p).toBe("public, max-age=31536000, immutable");
    expect(h(p)["Access-Control-Allow-Origin"], p).toBe("*");
  }
  for (const p of ["/atlas/index.json", "/atlas/hierarchy.json", "/atlas/builds.json", "/atlas/instances.json"]) {
    expect(h(p)["Cache-Control"], p).toBe("public, max-age=300, must-revalidate");
    expect(h(p)["Access-Control-Allow-Origin"], p).toBe("*");
  }
  expect(h("/forever/1420/v2/manifest.json")["X-Content-Type-Options"]).toBe("nosniff");
});

test("the POC renders the real v2 atlas from the allow-listed CDN origin under the site's CSP", async ({ page }) => {
  const c = cdn;
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  const res = await page.goto("/poc/maps/tirisfal?version=v2");
  const csp = res!.headers()["content-security-policy"]!;
  const dir = (n: string) => csp.split("; ").find((d) => d.startsWith(`${n} `))!;
  expect(dir("img-src")).toBe(`img-src 'self' data: ${ORIGIN}`);
  expect(dir("connect-src")).toBe(`connect-src 'self' ${ORIGIN}`);
  for (const d of ["script-src", "style-src", "default-src", "frame-src", "font-src", "worker-src"]) expect(dir(d), d).not.toContain("azerdex-assets");
  expect(csp).not.toMatch(/\*|unsafe-eval/);
  await page.waitForFunction(() => (document.querySelector(".leaflet-image-layer") as HTMLImageElement | null)?.naturalWidth === 1002);
  await settle(page);
  await expect(page.getByTestId("map-fallback")).toHaveCount(0);
  await expect(page.getByTestId("map-art")).toHaveText("Artwork: full-reveal · v2 · client 1.60.1.70450");
  expect(await page.evaluate(() => (document.querySelector(".leaflet-image-layer") as HTMLImageElement).src)).toBe(`${ORIGIN}/forever/1420/v2/full-reveal.webp`);
  expectWholeImageFits(await geometry(page), expect, "cdn-origin real art");
  expect((await markerError(page)).worst).toBeLessThan(1.5);
  expect(errors, errors.join("\n")).toEqual([]);
  // no site credentials leak to the CDN
  expect(c.seen.map((r) => r.url).sort()).toEqual(["/forever/1420/v2/full-reveal.webp", "/forever/1420/v2/manifest.json"]);
  for (const r of c.seen) {
    expect(r.headers.cookie, r.url).toBeUndefined();
    expect(r.headers.authorization, r.url).toBeUndefined();
  }
});

test("CORS is genuinely required for the manifest: without the header the browser blocks it and the viewer degrades to its labelled fallback grid", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  cdn.stripCors = true;
  await page.goto("/poc/maps/tirisfal?version=v2");
  await expect(page.getByTestId("map-fallback")).toContainText("manifest could not be loaded");
  await expect(page.locator(".leaflet-marker-icon[data-x]").first()).toBeVisible();
  // the failure must be the CORS one (the request reached the CDN and the browser refused the response), not a network problem
  expect(cdn.seen.some((r) => r.url === "/forever/1420/v2/manifest.json")).toBe(true);
  expect(consoleErrors.some((e) => /CORS policy|Access-Control-Allow-Origin/.test(e)), consoleErrors.join("\n")).toBe(true);
});

test("a missing CDN asset (unknown version) falls back and does not break the page", async ({ page }) => {
  await page.goto("/poc/maps/tirisfal?version=v77");
  await expect(page.getByTestId("map-fallback")).toBeVisible();
});

test("every other page keeps the original CSP (the CDN origin is allowed for the POC route only)", async ({ page }) => {
  for (const path of ["/database", "/zones", "/about/data", "/"]) {
    const res = await page.goto(path);
    expect(res!.headers()["content-security-policy"], path).not.toContain("azerdex-assets");
  }
});
