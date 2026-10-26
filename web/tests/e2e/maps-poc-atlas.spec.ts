import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { TOL, expectNoBlankSpace, expectWholeImageFits, geometry, hasFile, markerError, openMap, readDistFile, settle, zoomIn } from "./maps-helpers";

const DIST = process.env.ATLAS_REAL_DIST;
const MIME: Record<string, string> = { ".webp": "image/webp", ".json": "application/json" };

/** Serve the real atlas dist under the same-origin /maps path the POC resolves against (what NEXT_PUBLIC_AZERDEX_ASSET_BASE_URL unset means). */
async function serveDist(page: Page) {
  await page.route(/\/maps\/forever\/[^?]*$/, async (route) => {
    const rel = new URL(route.request().url()).pathname.replace(/^\/maps/, "");
    const body = readDistFile(DIST!, rel);
    if (body === null) return route.continue();
    return route.fulfill({ status: 200, contentType: MIME[extname(rel)] ?? "application/octet-stream", body });
  });
}

test.describe("POC version parameter (no atlas needed)", () => {
  test("an unknown version falls back gracefully; malformed versions are ignored, never put in a URL", async ({ page }) => {
    await page.goto("/poc/maps/tirisfal?version=v99");
    await expect(page.getByTestId("map-fallback")).toContainText("manifest could not be loaded");
    await expect(page.locator(".leaflet-marker-icon[data-x]").first()).toBeVisible(); // markers still render on the labelled grid
    const requested: string[] = [];
    page.on("request", (r) => { if (r.url().includes("/maps/forever/")) requested.push(new URL(r.url()).pathname); });
    for (const bad of ["../../x", "v1/../v2", "V2", "v0", "v12345", "v2%2f..%2fv1", ""]) {
      requested.length = 0;
      await page.goto(`/poc/maps/tirisfal?version=${bad}`);
      await expect(page.getByTestId("map-art")).toContainText("owner-supplied POC image · v1");
      expect(requested.every((p) => p.startsWith("/maps/forever/1420/v1/")), `${bad}: ${requested}`).toBe(true);
    }
  });

  test("the default (no parameter) is still the untouched POC v1", async ({ page }) => {
    await openMap(page);
    await expect(page.getByTestId("map-art")).toHaveText(/owner-supplied POC image · v1/);
    expect(await page.evaluate(() => (document.querySelector(".leaflet-image-layer") as HTMLImageElement).src)).toMatch(/\/maps\/forever\/1420\/v1\/tirisfal-glades\.webp$/);
  });
});

test.describe("REAL atlas distribution rendered by the POC (local acceptance: ATLAS_REAL_DIST)", () => {
  test.skip(!DIST || !hasFile(join(DIST ?? "", "atlas/index.json")), "ATLAS_REAL_DIST not set (private real artwork)");

  async function openV2(page: Page, size?: { width: number; height: number }) {
    await serveDist(page);
    if (size) await page.setViewportSize(size);
    await page.goto("/poc/maps/tirisfal?version=v2");
    await page.waitForFunction(() => document.querySelector("[data-testid=zone-map]")?.getAttribute("data-ready") === "true");
    await page.waitForFunction(() => (document.querySelector(".leaflet-image-layer") as HTMLImageElement | null)?.naturalWidth === 1002);
    await settle(page);
  }

  test("the manifest loads, the verified full-reveal is the displayed default, at its true dimensions", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error" && /Content Security Policy|CSP|hydrat|did not match|leaflet/i.test(m.text())) errors.push(m.text()); });
    await openV2(page);
    await expect(page.getByTestId("map-fallback")).toHaveCount(0);
    await expect(page.getByTestId("map-art")).toHaveText("Artwork: full-reveal · v2 · client 1.60.1.70450");
    const img = await page.evaluate(() => { const i = document.querySelector(".leaflet-image-layer") as HTMLImageElement; return { src: i.src, w: i.naturalWidth, h: i.naturalHeight }; });
    expect(img.src).toMatch(/\/maps\/forever\/1420\/v2\/full-reveal\.webp$/);
    expect([img.w, img.h]).toEqual([1002, 668]);
    const man = JSON.parse(readFileSync(join(DIST!, "forever/1420/v2/manifest.json"), "utf8"));
    expect(man.image.file).toBe("full-reveal.webp");
    expect(man.variants.map((v: { variant: string }) => v.variant).sort()).toEqual(["base", "full-reveal"]);
    expect(errors).toEqual([]);
  });

  for (const [label, size] of [["desktop", { width: 1366, height: 900 }], ["phone 390", { width: 390, height: 844 }], ["phone 320", { width: 320, height: 640 }]] as const) {
    test(`whole real image fits and markers register on it (${label})`, async ({ page }) => {
      await openV2(page, size);
      expectWholeImageFits(await geometry(page), expect, `real v2 @${label}`);
      const e = await markerError(page);
      expect(e.checked).toBeGreaterThan(20);
      expect(e.worst).toBeLessThan(TOL);
    });
  }

  test("zoom, drag and reset keep markers aligned on the real artwork and the edges bounded", async ({ page }) => {
    await openV2(page, { width: 1100, height: 900 });
    await zoomIn(page, 2);
    expect((await markerError(page)).worst).toBeLessThan(TOL);
    const b = (await page.getByTestId("zone-map").boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 + 900, b.y + b.height / 2 + 600, { steps: 10 });
    await page.mouse.up();
    await settle(page);
    expectNoBlankSpace(await geometry(page), expect, "dragged on real art");
    expect((await markerError(page)).worst).toBeLessThan(TOL);
    await page.getByTestId("fit-view").click();
    await settle(page);
    expectWholeImageFits(await geometry(page), expect, "reset on real art");
  });

  test("tooltips and cluster mode work on the real artwork", async ({ page }, ti) => {
    await openV2(page, { width: 1100, height: 900 });
    await page.locator('button[data-kind="mining"]').click();
    await settle(page, 300);
    if (ti.project.name === "desktop") {
      const m = page.locator(".leaflet-marker-icon[data-marker-id]").first();
      await m.hover({ force: true });
      await expect(page.locator(".leaflet-tooltip.azd-tooltip")).toContainText("Coordinates:");
    }
    await page.locator('button[data-mode="clusters"]').click();
    await settle(page, 400);
    expect(await page.locator(".leaflet-marker-icon[data-cluster-count]").count()).toBeGreaterThan(0);
  });
});
