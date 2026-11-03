import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { isInsightsScript, isSpeedInsights } from "./vercel-urls";

/**
 * Host behaviour of the consent gate against the HOSTED server (the same one preview-safety uses: VERCEL=1, https SITE_URL, harness flag
 * refused). The browser is pointed at genuine https origins (azerdex.com, www.azerdex.com, a generated Vercel preview host, an unrelated host);
 * Playwright answers each request by forwarding it to the hosted server with that Host header, exactly what Vercel's edge does, so the real
 * layout code decides from the real Host. Nothing leaves the machine: the Vercel script itself is a stub that records nothing and sends nothing.
 */
test.use({ seedConsent: false });

// Requests still in flight when a test ends must not turn into a teardown error.
test.afterEach(async ({ page }) => {
  await page.context().unrouteAll({ behavior: "ignoreErrors" });
});

const PREVIEW_PORT = Number(process.env.E2E_PREVIEW_PORT ?? 3201); // same default as playwright.config.ts
const at = (host: string, path = "/") => `https://${host}${path}`;

async function serveAs(page: Page, host: string) {
  const seen: string[] = [];
  page.on("request", (r) => { if (isInsightsScript(r.url())) seen.push(r.url()); });
  await page.context().route((url) => url.hostname === host, async (route) => {
    const u = new URL(route.request().url());
    try {
      const response = await route.fetch({ url: `http://localhost:${PREVIEW_PORT}${u.pathname}${u.search}`, headers: { ...route.request().headers(), host } });
      await route.fulfill({ response });
    } catch {
      /* the test ended while a request (e.g. a prefetch) was in flight: nothing to answer */
    }
  });
  // Registered on the page, so it wins over the context-level forwarder for the script URL.
  await page.route((url) => isInsightsScript(url), (route) => route.fulfill({ status: 200, contentType: "application/javascript", body: "/* stub */" }));
  return seen;
}
const banner = (page: Page) => page.locator('[data-consent="banner"]');
const accept = (page: Page) => banner(page).getByRole("button", { name: "Accept analytics" }).click();
const vaq = (page: Page, name: string) => page.evaluate((n) => ((window as unknown as { vaq?: unknown[][] }).vaq ?? []).filter((e) => e[0] === n).length, name);

for (const host of ["azerdex.com", "www.azerdex.com"]) {
  test(`production host ${host}: nothing before consent; accepting loads the script; withdrawing stops measurement`, async ({ page }) => {
    const seen = await serveAs(page, host);
    await page.goto(at(host));
    await expect(banner(page)).toBeVisible();
    expect(await page.locator('script[src*="_vercel"]').count()).toBe(0);
    expect(seen).toEqual([]);

    await accept(page);
    await expect.poll(() => seen.length).toBeGreaterThan(0);
    await expect.poll(() => vaq(page, "pageview")).toBeGreaterThan(0);

    await page.getByRole("contentinfo").getByRole("button", { name: "Cookie settings" }).click();
    await page.locator('[data-consent="settings"]').getByRole("checkbox").uncheck();
    await page.locator('[data-consent="settings"]').getByRole("button", { name: "Save choices" }).click();
    const frozen = await vaq(page, "pageview");
    await page.getByRole("navigation", { name: "Footer" }).getByRole("link", { name: "How the data works" }).click();
    await expect(page).toHaveURL(/\/about\/data/);
    expect(await vaq(page, "pageview")).toBe(frozen);

    // The refusal survives a full load: no new script request at all.
    const before = seen.length;
    await page.goto(at(host, "/zones"));
    await expect(banner(page)).toHaveCount(0);
    expect(seen.length).toBe(before);
  });
}

test("production host: the very first HTML response carries no analytics script, whatever the visitor has stored", async ({ request }) => {
  const res = await request.get(`http://localhost:${PREVIEW_PORT}/`, { headers: { host: "azerdex.com" } });
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(html).not.toMatch(/_vercel|vercel-scripts|insights\/script/i);
  expect(html).not.toContain('data-consent="banner"'); // the bar is client-rendered; the server never emits optional markup
});

test("with consent on a public host the hook still drops account / auth / verify pages and strips query strings", async ({ page }) => {
  const seen = await serveAs(page, "azerdex.com");
  await page.goto(at("azerdex.com"));
  await accept(page);
  await expect.poll(() => seen.length).toBeGreaterThan(0);
  await expect.poll(() => vaq(page, "beforeSend")).toBeGreaterThan(0);
  const verdict = (url: string) =>
    page.evaluate((u) => {
      const q = ((window as unknown as { vaq?: unknown[][] }).vaq ?? []).filter((e) => e[0] === "beforeSend");
      const fn = q[q.length - 1]![1] as (e: { type: string; url: string }) => { url: string } | null;
      return fn({ type: "pageview", url: u })?.url ?? null;
    }, url);
  for (const p of ["/account/login", "/account/register", "/auth/confirm?token=t", "/verify"]) expect(await verdict(`https://azerdex.com${p}`), p).toBeNull();
  expect(await verdict("https://azerdex.com/database?q=secret#x")).toBe("https://azerdex.com/database");
});

for (const host of ["localhost", "foreverdb-git-preview-test.vercel.app", "other.example.test"]) {
  test(`non-public host ${host}: the bar is shown but analytics can never load, even after accepting`, async ({ page }) => {
    const seen = await serveAs(page, host);
    await page.goto(at(host));
    await expect(banner(page)).toBeVisible();
    await accept(page);
    await expect(banner(page)).toHaveCount(0);
    await page.goto(at(host, "/zones"));
    await expect(page.getByRole("contentinfo")).toBeVisible();
    await page.waitForTimeout(500);
    expect(seen).toEqual([]);
    expect(await page.locator('script[src*="_vercel"]').count()).toBe(0);
  });
}

test("Speed Insights stays off by default: no speed-insights request on a public host even after accepting", async ({ page }) => {
  const asked: string[] = [];
  page.on("request", (r) => { if (isSpeedInsights(r.url())) asked.push(r.url()); });
  const seen = await serveAs(page, "azerdex.com");
  await page.goto(at("azerdex.com"));
  await accept(page);
  await expect.poll(() => seen.length).toBeGreaterThan(0);
  await page.goto(at("azerdex.com", "/zones"));
  await expect(page.getByRole("contentinfo")).toBeVisible();
  await page.waitForTimeout(500);
  expect(asked).toEqual([]);
});
