import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

const URL = "/poc/maps/tirisfal";
const W = 1002;
const H = 668;

async function ready(page: Page) {
  await page.goto(URL);
  await expect(page.getByTestId("zone-map")).toHaveAttribute("data-ready", "true");
  await expect(page.locator(".leaflet-image-layer")).toBeVisible();
  await expect.poll(() => page.evaluate(() => (document.querySelector(".leaflet-image-layer") as HTMLImageElement).naturalWidth)).toBe(W);
}

/** Max pixel error between each marker's centre and where the Companion model (x% of W, y% of H) puts it on the rendered image. */
async function misalignment(page: Page, limit = 40) {
  return page.evaluate(({ limit }) => {
    const img = document.querySelector(".leaflet-image-layer")!.getBoundingClientRect();
    const host = document.querySelector("[data-testid=zone-map]")!.getBoundingClientRect();
    let worst = 0, checked = 0;
    for (const m of Array.from(document.querySelectorAll<HTMLElement>(".leaflet-marker-icon[data-x]")).slice(0, limit * 20)) {
      const r = m.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (cx < host.left || cx > host.right || cy < host.top || cy > host.bottom) continue;
      const ex = img.left + (Number(m.dataset.x) / 100) * img.width, ey = img.top + (Number(m.dataset.y) / 100) * img.height;
      worst = Math.max(worst, Math.hypot(cx - ex, cy - ey));
      checked++;
    }
    return { worst, checked, imgW: img.width };
  }, { limit });
}

test.describe("Tirisfal map POC", () => {
  test("is non-indexable, CSP-clean, and renders image + markers", async ({ page }) => {
    const res = await page.goto(URL);
    expect(res!.headers()["x-robots-tag"]).toContain("noindex");
    const csp = res!.headers()["content-security-policy"]!;
    expect(csp).toContain("img-src 'self' data:;");
    expect(csp).not.toContain("unsafe-inline'");
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    const errors: string[] = [];
    page.on("console", (m) => { if (m.type() === "error" && /Content Security Policy|CSP/i.test(m.text())) errors.push(m.text()); });
    await ready(page);
    await expect(page.locator(".leaflet-marker-icon[data-x]").first()).toBeVisible();
    await expect(page.getByTestId("map-summary")).toContainText("aggregated locations");
    expect(errors).toEqual([]);
    await expect(page.getByText("Synthetic sample data.", { exact: true })).toBeVisible();
  });

  test("markers stay registered on the image through zoom and pan", async ({ page }, testInfo) => {
    await ready(page);
    const before = await misalignment(page);
    expect(before.checked).toBeGreaterThan(20);
    expect(before.worst).toBeLessThan(1.5);
    const box = (await page.getByTestId("zone-map").boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    if (testInfo.project.name === "desktop") await page.mouse.wheel(0, -600);
    else { await page.locator(".leaflet-control-zoom-in").click(); await page.locator(".leaflet-control-zoom-in").click(); } // wheel is not emitted under touch emulation
    await page.waitForTimeout(700);
    const zoomed = await misalignment(page);
    expect(zoomed.imgW).toBeGreaterThan(before.imgW * 1.3);
    expect(zoomed.worst).toBeLessThan(1.5);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 120, box.y + box.height / 2 - 60, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    const panned = await misalignment(page);
    expect(panned.worst).toBeLessThan(1.5);
    await page.getByTestId("fit-view").click();
    await page.waitForTimeout(500);
    expect((await misalignment(page)).imgW).toBeCloseTo(before.imgW, 0);
  });

  test("rendered image keeps the 1002x668 aspect (surface = 0-100% square of the Companion model)", async ({ page }) => {
    await ready(page);
    // The image fills the fitted bounds, so its rect IS the 0-100% surface; centre marker expectations hold by construction.
    const r = await page.evaluate(() => { const b = document.querySelector(".leaflet-image-layer")!.getBoundingClientRect(); return { w: b.width, h: b.height }; });
    expect(r.w / r.h).toBeCloseTo(W / H, 1);
  });

  test("mining filter, clusters toggle and empty state", async ({ page }) => {
    await ready(page);
    const markers = page.locator(".leaflet-marker-icon[data-x]");
    const total = await markers.count();
    await page.locator('button[data-kind="mining"]').click();
    await expect(page.locator('button[data-kind="mining"]')).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("filter-active")).toBeVisible();
    await expect.poll(() => markers.count()).toBeLessThan(total);
    const mining = await markers.count();
    expect(mining).toBeGreaterThan(0);
    await expect(page.getByTestId("map-summary")).toContainText(`${mining} of`);

    await page.locator('button[data-mode="clusters"]').click();
    await expect(page.locator('button[data-mode="clusters"]')).toHaveAttribute("aria-checked", "true");
    await page.waitForTimeout(200);
    const clusterCounts = await page.locator(".leaflet-marker-icon[data-cluster-count]").evaluateAll((els) => els.map((e) => Number((e as HTMLElement).dataset.clusterCount)));
    expect(clusterCounts.length).toBeGreaterThan(0);
    expect(clusterCounts.reduce((a, b) => a + b, 0)).toBe(mining);
    expect((await misalignment(page)).worst).toBeLessThan(1.5);

    await page.locator('button[data-mode="markers"]').click();
    await expect.poll(() => markers.count()).toBe(mining);

    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect.poll(() => markers.count()).toBe(total);

    await page.locator('button[data-kind="mob"]').click();
    await page.locator("#lvl-min").fill("999");
    await expect(page.getByTestId("map-empty")).toHaveText(/No observations match/);
  });

  test("marker selection shows accessible details", async ({ page }) => {
    await ready(page);
    const first = page.locator(".leaflet-marker-icon[data-x]").first();
    await expect(first).toHaveAttribute("aria-label", /obs\./);
    await first.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("detail-panel")).toContainText("Observations");
  });

  test("missing image falls back to a labelled coordinate grid with markers", async ({ page }) => {
    await page.route("**/maps/forever/1420/v1/tirisfal-glades.webp", (r) => r.fulfill({ status: 404, body: "" }));
    await page.goto(URL);
    await expect(page.getByTestId("map-fallback")).toContainText("could not be loaded");
    await expect(page.getByTestId("zone-map")).toHaveAttribute("data-ready", "true");
    await expect(page.locator(".leaflet-marker-icon[data-x]").first()).toBeVisible();
  });

  test("missing manifest falls back without crashing", async ({ page }) => {
    await page.route("**/maps/forever/1420/v1/manifest.json", (r) => r.fulfill({ status: 404, body: "" }));
    await page.goto(URL);
    await expect(page.getByTestId("map-fallback")).toContainText("manifest could not be loaded");
    await expect(page.locator(".leaflet-marker-icon[data-x]").first()).toBeVisible();
  });

  test("an invalid manifest is rejected", async ({ page }) => {
    await page.route("**/maps/forever/1420/v1/manifest.json", (r) => r.fulfill({ status: 200, contentType: "application/json", body: '{"zoneId":1420}' }));
    await page.goto(URL);
    await expect(page.getByTestId("map-fallback")).toContainText("invalid");
  });
});
