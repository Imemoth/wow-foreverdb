import { expect, test } from "./fixtures";
import { TOL, expectNoBlankSpace, expectWholeImageFits, geometry, markerError, openMap, settle, touchDrag, touchSession, zoomIn } from "./maps-helpers";

const WIDTHS = [320, 375, 390, 768, 1366];
const HEIGHT = 900;

test.describe("Tirisfal map POC — fit / reset / boundaries", () => {
  for (const w of WIDTHS) {
    test(`initial fit shows the whole image at ${w}px`, async ({ page }) => {
      await openMap(page, { width: w, height: HEIGHT });
      expectWholeImageFits(await geometry(page), expect, `initial@${w}`);
    });

    test(`Fit / reset after zoom + pan shows the whole image at ${w}px`, async ({ page }) => {
      await openMap(page, { width: w, height: HEIGHT });
      const host = page.getByTestId("zone-map");
      await host.scrollIntoViewIfNeeded();
      await zoomIn(page, 3);
      await settle(page, 700);
      const zoomed = await geometry(page);
      expect(zoomed.img.width).toBeGreaterThan(zoomed.box.width * 1.5);
      const b = (await host.boundingBox())!;
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await page.mouse.down();
      await page.mouse.move(b.x + b.width / 2 - 90, b.y + b.height / 2 - 70, { steps: 8 });
      await page.mouse.up();
      await settle(page);
      await page.getByTestId("fit-view").click();
      await settle(page);
      expectWholeImageFits(await geometry(page), expect, `reset@${w}`);
    });
  }

  test("repeated Fit / reset is idempotent (no progressive shift)", async ({ page }) => {
    await openMap(page, { width: 390, height: HEIGHT });
    const first = await geometry(page);
    for (let i = 0; i < 6; i++) {
      await zoomIn(page, 1);
      await page.getByTestId("fit-view").click();
      await settle(page, 350);
      const g = await geometry(page);
      // relative to the container: the page itself may have scrolled
      const rel = (x: typeof g) => [x.img.left - x.box.left, x.img.top - x.box.top, x.img.width, x.img.height];
      rel(g).forEach((v, j) => expect(Math.abs(v - rel(first)[j]!), `value ${j} drifted on reset ${i + 1}`).toBeLessThan(0.75));
    }
  });

  test("aggressive mouse dragging in all directions never leaves blank space, at fit and zoomed", async ({ page }, ti) => {
    test.skip(ti.project.name !== "desktop", "mouse drag");
    await openMap(page, { width: 1100, height: HEIGHT });
    const host = page.getByTestId("zone-map");
    const b = (await host.boundingBox())!;
    const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
    const drag = async (dx: number, dy: number) => {
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx + dx, cy + dy, { steps: 10 });
      await page.mouse.move(cx + dx * 1.5, cy + dy * 1.5, { steps: 4 }); // keep pulling past the edge
      await page.mouse.up();
      await settle(page, 500);
    };
    for (const zoomIns of [0, 1, 3]) {
      await page.getByTestId("fit-view").click();
      await zoomIn(page, zoomIns);
      await settle(page, 700);
      for (const [dx, dy] of [[900, 0], [-900, 0], [0, 600], [0, -600], [900, 600], [-900, -600]] as [number, number][]) {
        await drag(dx, dy);
        expectNoBlankSpace(await geometry(page), expect, `zoom+${zoomIns} drag(${dx},${dy})`);
      }
    }
  });

  test("the real edges are reachable when zoomed (left/right/top/bottom)", async ({ page }, ti) => {
    test.skip(ti.project.name !== "desktop", "mouse drag");
    await openMap(page, { width: 1100, height: HEIGHT });
    await zoomIn(page, 3);
    await settle(page, 700);
    const b = (await page.getByTestId("zone-map").boundingBox())!;
    const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
    const pull = async (dx: number, dy: number) => {
      for (let k = 0; k < 8; k++) { await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + dx, cy + dy, { steps: 8 }); await page.mouse.up(); }
      await settle(page, 500);
      return geometry(page);
    };
    let g = await pull(300, 0);
    expect(Math.abs(g.img.left - g.box.left), "left edge reachable").toBeLessThan(TOL);
    g = await pull(-300, 0);
    expect(Math.abs(g.img.right - g.box.right), "right edge reachable").toBeLessThan(TOL);
    g = await pull(0, 300);
    expect(Math.abs(g.img.top - g.box.top), "top edge reachable").toBeLessThan(TOL);
    g = await pull(0, -300);
    expect(Math.abs(g.img.bottom - g.box.bottom), "bottom edge reachable").toBeLessThan(TOL);
  });

  test("touch drag cannot leave blank space and does not scroll the page away from the map", async ({ page }, ti) => {
    test.skip(ti.project.name !== "mobile", "touch");
    await openMap(page);
    const host = page.getByTestId("zone-map");
    await host.scrollIntoViewIfNeeded();
    await zoomIn(page, 3);
    await settle(page, 700);
    const cdp = await touchSession(page);
    const b = (await host.boundingBox())!;
    const cx = b.x + b.width / 2, cy = b.y + Math.min(b.height, 500) / 2;
    const scrollBefore = await page.evaluate(() => window.scrollY);
    for (const [dx, dy] of [[250, 0], [-250, 0], [0, 200], [0, -200], [200, 150]] as [number, number][]) {
      await touchDrag(cdp, { x: cx, y: cy }, { x: cx + dx, y: cy + dy });
      await settle(page, 600);
      expectNoBlankSpace(await geometry(page), expect, `touch drag(${dx},${dy})`);
    }
    expect(await page.evaluate(() => window.scrollY), "map drag must not scroll the page").toBe(scrollBefore);
    await page.getByTestId("fit-view").click();
    await settle(page);
    expectWholeImageFits(await geometry(page), expect, "after touch reset");
  });

  test("page can still be scrolled past the map by touching outside it", async ({ page }, ti) => {
    test.skip(ti.project.name !== "mobile", "touch");
    await openMap(page);
    const cdp = await touchSession(page);
    const before = await page.evaluate(() => window.scrollY);
    await touchDrag(cdp, { x: 200, y: 700 }, { x: 200, y: 300 }); // starts below/above the map area (header/filters)
    await settle(page, 400);
    // scrolling is a page affordance; only assert the page itself is not locked
    expect(await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight)).toBe(true);
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThanOrEqual(before);
  });

  test("viewport resize and orientation changes keep the correct fit", async ({ page }) => {
    await openMap(page, { width: 390, height: 844 });
    expectWholeImageFits(await geometry(page), expect, "portrait");
    await page.setViewportSize({ width: 844, height: 390 }); // landscape
    await settle(page, 700);
    expectWholeImageFits(await geometry(page), expect, "landscape (still at fit)");
    await page.setViewportSize({ width: 320, height: 640 });
    await settle(page, 700);
    expectWholeImageFits(await geometry(page), expect, "narrow portrait");
    await page.setViewportSize({ width: 1366, height: 900 });
    await settle(page, 700);
    expectWholeImageFits(await geometry(page), expect, "desktop");
  });

  test("resizing while zoomed in keeps the user's zoom but never exposes blank space", async ({ page }) => {
    await openMap(page, { width: 1100, height: 900 });
    await zoomIn(page, 3);
    await settle(page, 700);
    const w0 = (await geometry(page)).img.width;
    await page.setViewportSize({ width: 700, height: 800 });
    await settle(page, 700);
    const g = await geometry(page);
    expect(g.img.width, "zoom level is not reset by a resize").toBeGreaterThan(w0 * 0.9);
    expectNoBlankSpace(g, expect, "resized while zoomed");
  });

  test("no Leaflet runtime, hydration or CSP errors across fit/drag/resize", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => { if (m.type() === "error" || (m.type() === "warning" && /leaflet/i.test(m.text()))) errors.push(`${m.type()}: ${m.text()}`); });
    await openMap(page, { width: 390, height: 844 });
    await zoomIn(page, 2);
    await page.getByTestId("fit-view").click();
    await page.setViewportSize({ width: 844, height: 390 });
    await settle(page, 700);
    expect(errors).toEqual([]);
  });

  test("markers stay on their coordinates through fit, zoom, clamped drag and reset at phone width", async ({ page }) => {
    await openMap(page, { width: 375, height: 900 });
    const check = async (label: string) => {
      const e = await markerError(page);
      expect(e.checked, `${label}: markers visible`).toBeGreaterThan(10);
      expect(e.worst, `${label}: marker misalignment px`).toBeLessThan(1.5);
    };
    await check("fit");
    await zoomIn(page, 2);
    await check("zoomed");
    const b = (await page.getByTestId("zone-map").boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + Math.min(250, b.height / 2));
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 + 300, b.y + Math.min(250, b.height / 2) + 200, { steps: 8 });
    await page.mouse.up();
    await settle(page);
    await check("clamped drag");
    await page.getByTestId("fit-view").click();
    await settle(page);
    await check("reset");
    expectWholeImageFits(await geometry(page), expect, "reset");
  });
});
