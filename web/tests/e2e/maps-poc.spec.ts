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
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error" && /Content Security Policy|CSP|hydrat|did not match/i.test(m.text())) errors.push(m.text()); });
    const res = await page.goto(URL);
    expect(res!.headers()["x-robots-tag"]).toContain("noindex");
    const csp = res!.headers()["content-security-policy"]!;
    expect(csp).toContain("img-src 'self' data:;");
    expect(csp).not.toContain("unsafe-inline'");
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
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
    await expect(first).toHaveAttribute("aria-label", /coordinates X \d+(\.\d+)?, Y \d+(\.\d+)?, \d+ observation/);
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

  test("manifest and image load when the deployment requires a same-origin auth cookie (Vercel Authentication)", async ({ page, context, baseURL }) => {
    await context.addCookies([{ name: "_vercel_jwt", value: "t", url: baseURL! }]);
    const seen: { url: string; cookie: boolean }[] = [];
    await page.route("**/maps/forever/1420/v1/**", async (route) => {
      const cookie = (route.request().headers()["cookie"] ?? "").includes("_vercel_jwt");
      seen.push({ url: route.request().url(), cookie });
      return cookie ? route.fallback() : route.fulfill({ status: 401, body: "authentication required" });
    });
    await ready(page);
    await expect(page.getByTestId("map-fallback")).toHaveCount(0);
    expect(seen.some((r) => r.url.endsWith("manifest.json") && r.cookie)).toBe(true);
    expect(seen.every((r) => r.cookie)).toBe(true);
  });

  /** A marker that is the topmost element at its own centre (so a real pointer lands on it, not on a neighbour). */
  async function isolatedMarker(page: Page, sel = ".leaflet-marker-icon[data-marker-id]") {
    await page.getByTestId("zone-map").evaluate((e) => e.scrollIntoView({ block: "start" })); // elementFromPoint only sees the viewport
    const id = await page.evaluate((sel) => {
      const host = document.querySelector("[data-testid=zone-map]")!.getBoundingClientRect();
      for (const m of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
        const r = m.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        if (cy < host.top + 10 || cy > host.bottom - 10 || cx < host.left + 10 || cx > host.right - 10 || (cx < host.left + 60 && cy < host.top + 90)) continue;
        if (document.elementFromPoint(cx, cy)?.closest(".leaflet-marker-icon") === m) return m.dataset.markerId!;
      }
      return null;
    }, sel);
    expect(id).not.toBeNull();
    return page.locator(`.leaflet-marker-icon[data-marker-id="${id}"]`);
  }

  test("hovering a marker shows an on-brand tooltip above it with name, X/Y, category and observations", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "hover is desktop-only");
    await ready(page);
    await page.locator('button[data-kind="mining"]').click();
    await page.waitForTimeout(300);
    const m = await isolatedMarker(page);
    const x = await m.getAttribute("data-x"), y = await m.getAttribute("data-y");
    const read = async () => {
      await page.mouse.move(0, 0);
      await m.hover();
      const tip = page.locator(".leaflet-tooltip.azd-tooltip");
      await expect(tip).toBeVisible();
      return tip;
    };
    const tip = await read();
    await expect(tip).toContainText(`Coordinates: ${x}, ${y}`);
    await expect(tip).toContainText("Mining · ");
    await expect(tip).toContainText(/\d+ observations?/);
    expect(await tip.locator(".azd-tip-title").innerText()).toMatch(/\S/);
    // never pixel or lat/lng values
    expect(await tip.innerText()).not.toMatch(/\d{3,}\.\d/);
    const mb = (await m.boundingBox())!, tb = (await tip.boundingBox())!;
    expect(tb.y + tb.height).toBeLessThanOrEqual(mb.y + 2);
    expect(Math.abs(tb.x + tb.width / 2 - (mb.x + mb.width / 2))).toBeLessThan(6);
    const text = await tip.innerText();

    // zoom + pan + reset: same coordinates, tooltip still above its marker
    const box = (await page.getByTestId("zone-map").boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(700);
    await page.mouse.down(); await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 20, { steps: 5 }); await page.mouse.up();
    await page.waitForTimeout(400);
    await page.getByTestId("fit-view").click();
    await page.waitForTimeout(600);
    const m2 = page.locator(`.leaflet-marker-icon[data-marker-id="${await m.getAttribute("data-marker-id")}"]`);
    await page.mouse.move(0, 0);
    await m2.hover({ force: true });
    const tip2 = page.locator(".leaflet-tooltip.azd-tooltip");
    await expect(tip2).toBeVisible();
    expect(await tip2.innerText()).toBe(text);
    const mb2 = (await m2.boundingBox())!, tb2 = (await tip2.boundingBox())!;
    expect(tb2.y + tb2.height).toBeLessThanOrEqual(mb2.y + 2);
  });

  test("tapping/clicking a marker shows its coordinates in the Details panel", async ({ page }, testInfo) => {
    await ready(page);
    await page.locator('button[data-kind="mining"]').click();
    await page.waitForTimeout(300);
    const m = await isolatedMarker(page);
    const x = await m.getAttribute("data-x"), y = await m.getAttribute("data-y");
    if (testInfo.project.name === "mobile") await m.tap(); else await m.click();
    const panel = page.getByTestId("detail-panel");
    await expect(panel).toContainText("Coordinates (X, Y)");
    await expect(page.getByTestId("detail-coords")).toHaveText(`${x}, ${y}`);
    await expect(panel).toContainText("Mining");
  });

  test("keyboard focus opens the tooltip and Enter/Space select the marker", async ({ page }) => {
    await ready(page);
    await page.locator('button[data-kind="mining"]').click();
    await page.waitForTimeout(300);
    const m = page.locator(".leaflet-marker-icon[data-marker-id]").first();
    const x = await m.getAttribute("data-x"), y = await m.getAttribute("data-y");
    await m.focus();
    await expect(page.locator(".leaflet-tooltip.azd-tooltip")).toContainText(`Coordinates: ${x}, ${y}`);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("detail-coords")).toHaveText(`${x}, ${y}`);
    await page.getByTestId("map-summary").click(); // clear focus target, then Space on the marker
    await page.locator(".leaflet-container").click({ position: { x: 5, y: 5 } });
    await m.focus();
    await page.keyboard.press("Space");
    await expect(page.getByTestId("detail-coords")).toHaveText(`${x}, ${y}`);
  });

  test("cluster tooltip shows the approximate centroid, never presented as a spawn position", async ({ page }, testInfo) => {
    await ready(page);
    await page.locator('button[data-kind="mining"]').click();
    await page.locator('button[data-mode="clusters"]').click();
    await page.waitForTimeout(400);
    const sel = ".leaflet-marker-icon[data-cluster-count]";
    await page.getByTestId("zone-map").evaluate((e) => e.scrollIntoView({ block: "start" }));
    const multi = await page.evaluate((sel) => {
      const host = document.querySelector("[data-testid=zone-map]")!.getBoundingClientRect();
      for (const m of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
        if (Number(m.dataset.clusterCount) < 2) continue;
        const r = m.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        if (cy < host.top + 10 || cy > host.bottom - 10 || cx < host.left + 10 || cx > host.right - 10 || (cx < host.left + 60 && cy < host.top + 90)) continue;
        if (document.elementFromPoint(cx, cy)?.closest(".leaflet-marker-icon") === m) return m.getAttribute("aria-label");
      }
      return null;
    }, sel);
    expect(multi).toMatch(/Mining cluster, \d+ locations, \d+ observations?, approximate cluster centre X \d+\.\d, Y \d+\.\d, not an observed position/);
    const m = page.locator(`${sel}[aria-label="${multi}"]`);
    const cx = Number(await m.getAttribute("data-x")).toFixed(1), cy = Number(await m.getAttribute("data-y")).toFixed(1);
    if (testInfo.project.name === "desktop") {
      await m.hover();
      const tip = page.locator(".leaflet-tooltip.azd-tooltip");
      await expect(tip).toContainText("Mining cluster");
      await expect(tip).toContainText(`Approximate cluster centre: ${cx}, ${cy}`);
      await expect(tip).toContainText(/\d+ locations · \d+ observations?/);
    }
    // an aggregate marker still zooms in on click (existing behaviour)
    const before = (await misalignment(page)).imgW;
    if (testInfo.project.name === "mobile") await m.tap(); else await m.click();
    await page.waitForTimeout(900);
    expect((await misalignment(page)).imgW).toBeGreaterThan(before);
  });
});
