// The cinematic hero's art-directed crop (CSS object-position) must reach the real browser under the strict, nonce-based CSP:
// the effective computed value is asserted for Hillsbrad and Duskwood on desktop and mobile, the <img> carries no inline style attribute,
// and the browser reports no CSP violation at all. Set HERO_SHOT_DIR to also save element screenshots (used for before/after evidence).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { startCdn, type Cdn } from "./cdn-server";

let cdn: Cdn;
test.beforeAll(async () => { cdn = await startCdn(); });
test.afterAll(async () => { await cdn.close(); });

const ZONES = [
  { id: 1424, name: "hillsbrad", position: "85% 50%" },
  { id: 1431, name: "duskwood", position: "85% 45%" },
];
const SHOTS = process.env.HERO_SHOT_DIR;

async function open(page: Page, id: number) {
  await page.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => ((window as unknown as { __csp: string[] }).__csp ??= []).push(`${e.violatedDirective} ${e.blockedURI}`)));
  await page.goto(`/zone/${id}`);
  const img = page.getByTestId("zone-hero").locator("img[fetchpriority=high]");
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBeGreaterThan(0);
  return img;
}

for (const z of ZONES) {
  test.describe(`${z.name} (${z.id})`, () => {
    test("effective object-position is the zone's configured crop; no inline style; no CSP violation", async ({ page }) => {
      const img = await open(page, z.id);
      const r = await img.evaluate((i: HTMLImageElement) => ({ computed: getComputedStyle(i).objectPosition, styleAttr: i.getAttribute("style"), fit: getComputedStyle(i).objectFit }));
      expect(r.fit).toBe("cover");
      expect(r.styleAttr, "no inline style attribute (blocked by the strict CSP)").toBeNull();
      expect(r.computed).toBe(z.position);
      expect(await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? [])).toEqual([]);
    });

    test("evidence screenshot", async ({ page }, info) => {
      const img = await open(page, z.id);
      const hero = page.getByTestId("zone-hero");
      await page.waitForTimeout(300);
      const computed = await img.evaluate((i: HTMLImageElement) => getComputedStyle(i).objectPosition);
      console.log(`HERO_CROP ${z.name} ${info.project.name} computed=${computed}`);
      if (SHOTS) {
        mkdirSync(SHOTS, { recursive: true });
        await hero.screenshot({ path: join(SHOTS, `${z.name}-${info.project.name}.png`) });
      }
    });
  });
}
