// Performance baseline of the cinematic zone hero, recorded the same way for either hero source so the Vercel (same-origin) and Cloudflare
// Pages (CDN) deliveries can be compared later. Local numbers measure rendering/decoding, NOT network latency (both origins are loopback);
// they are written to test-results/hero-perf-*.json and documented in docs/web/zone-hero-performance-baseline.md. Sanity assertions only.
import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { startCdn, type Cdn } from "./cdn-server";

let cdn: Cdn;
test.beforeAll(async () => { cdn = await startCdn(); });
test.afterAll(async () => { await cdn.close(); });

const SOURCE = process.env.E2E_HERO_SOURCE === "cdn" ? "cdn" : "local";

for (const id of [1424, 1431]) {
  test(`hero metrics /zone/${id} (${SOURCE})`, async ({ page }, info) => {
    await page.addInitScript(() => {
      (window as unknown as { __lcp: unknown[] }).__lcp = [];
      new PerformanceObserver((l) => (window as unknown as { __lcp: unknown[] }).__lcp.push(...l.getEntries().map((e) => ({ t: e.startTime, url: (e as PerformanceEntry & { url?: string }).url ?? "", size: (e as PerformanceEntry & { size?: number }).size ?? 0 }))))
        .observe({ type: "largest-contentful-paint", buffered: true });
    });
    await page.goto(`/zone/${id}`, { waitUntil: "load" });
    const img = page.getByTestId("zone-hero").locator("img[fetchpriority=high]");
    await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBeGreaterThan(0);
    await page.waitForTimeout(400);
    const m = await page.evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
      const hero = performance.getEntriesByType("resource").find((x) => /\/zone-heroes\/|\/zones\/hero\//.test(x.name)) as PerformanceResourceTiming | undefined;
      const lcp = (window as unknown as { __lcp: { t: number; url: string; size: number }[] }).__lcp;
      const el = document.querySelector("[data-testid=zone-hero] img[fetchpriority=high]") as HTMLImageElement;
      return {
        viewport: [innerWidth, innerHeight], dpr: devicePixelRatio,
        nav: { ttfb: nav.responseStart, domContentLoaded: nav.domContentLoadedEventEnd, load: nav.loadEventEnd },
        lcp: lcp.at(-1) ?? null,
        hero: hero && { url: hero.name, encodedBodySize: hero.encodedBodySize, decodedBodySize: hero.decodedBodySize, transferSize: hero.transferSize, start: hero.startTime, duration: hero.duration, responseEnd: hero.responseEnd },
        chosen: { currentSrc: el.currentSrc, natural: [el.naturalWidth, el.naturalHeight], rendered: [el.clientWidth, el.clientHeight] },
      };
    });
    expect(m.hero, "hero resource timing entry").toBeTruthy();
    expect(m.hero!.encodedBodySize).toBeGreaterThan(20_000);
    expect(m.lcp, "LCP candidate").toBeTruthy();
    mkdirSync("test-results", { recursive: true });
    writeFileSync(`test-results/hero-perf-${SOURCE}-${info.project.name}-${id}.json`, JSON.stringify({ source: SOURCE, project: info.project.name, zone: id, ...m }, null, 1));
  });
}
