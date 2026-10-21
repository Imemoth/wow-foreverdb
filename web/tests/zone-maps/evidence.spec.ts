import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { geometry, markerError, settle } from "../e2e/maps-helpers";
import { REAL_DIST, startCdn, type Cdn } from "./cdn-server";

// Evidence capture (screenshots + browser network log). Skipped unless EVIDENCE_DIR is set:
//   EVIDENCE_DIR=<dir> ATLAS_REAL_DIST=<approved dist> npx playwright test -c playwright.zone-maps.config.ts evidence
const DIR = process.env.EVIDENCE_DIR;
test.skip(!DIR, "EVIDENCE_DIR not set");

let cdn: Cdn;
test.beforeAll(async () => { cdn = await startCdn(); if (DIR) mkdirSync(DIR, { recursive: true }); });
test.afterAll(async () => { await cdn.close(); });

async function ready(page: Page) {
  await page.getByTestId("zone-map-section").or(page.getByTestId("source-maps")).first().scrollIntoViewIfNeeded();
  await page.getByTestId("zone-map").waitFor({ timeout: 20_000 });
  await page.waitForFunction(() => document.querySelector("[data-testid=zone-map]")?.getAttribute("data-ready") === "true");
  await page.waitForFunction(() => ((document.querySelector(".leaflet-image-layer") as HTMLImageElement | null)?.naturalWidth ?? 0) > 100);
  await settle(page, 700);
}

const log: Record<string, unknown>[] = [];
test.afterAll(() => { if (DIR) writeFileSync(join(DIR, `network-${test.info().project.name}.json`), JSON.stringify({ artwork: REAL_DIST ? "REAL approved distribution" : "SYNTHETIC grid images", log }, null, 1)); });

test("capture", async ({ page }, info) => {
  const proj = info.project.name;
  const reqs: { url: string; status: number | null }[] = [];
  page.on("response", (r) => { const u = r.url(); if (/\/forever\/\d+\/v\d+\/|\/atlas\//.test(u)) reqs.push({ url: u, status: r.status() }); });
  const shot = (name: string) => page.screenshot({ path: join(DIR!, `${proj}-${name}.png`), fullPage: false });

  await page.goto("/zones");
  await page.screenshot({ path: join(DIR!, `${proj}-zones-directory.png`), fullPage: true });

  for (const [id, label] of [[1420, "tirisfal-clusters"], [1412, "mulgore"], [1411, "durotar"], [1426, "dun-morogh-empty"]] as const) {
    await page.goto(`/zone/${id}`);
    await ready(page);
    await page.getByTestId("zone-map").scrollIntoViewIfNeeded();
    await shot(`zone-${label}`);
    const g = await geometry(page);
    log.push({ page: `/zone/${id}`, project: proj, image: g.img, box: g.box, requests: reqs.filter((r) => r.url.includes(`/forever/${id}/`)) });
  }
  // markers, individual mode, mining filter on Tirisfal: with registration error against the Companion model
  await page.goto("/zone/1420");
  await ready(page);
  await page.locator('button[data-mode="markers"]').click();
  await settle(page);
  const all = await markerError(page);
  await page.locator('button[data-kind="mining"]').click();
  await settle(page);
  await shot("zone-tirisfal-mining-markers");
  log.push({ page: "/zone/1420 markers", project: proj, markerRegistration: all });

  await page.goto("/object/1731");
  await ready(page);
  await page.getByTestId("source-maps").scrollIntoViewIfNeeded();
  await shot("source-copper-vein");
  expect(await page.locator(".leaflet-marker-icon[data-x]").count()).toBeGreaterThan(0);
  await page.goto("/zone/1420?source=gameobject:1731");
  await ready(page);
  await page.locator('button[data-mode="markers"]').click();
  await settle(page);
  await shot("zone-focus-copper-vein");
  log.push({ project: proj, allAssetRequests: reqs.map((r) => ({ host: new URL(r.url).host, path: new URL(r.url).pathname, status: r.status })) });
});
