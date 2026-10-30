import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { CONSENT_STORAGE_KEY, PRIVACY_NOTICE_VERSION, createConsentRecord } from "../../src/lib/consent";

/**
 * Consent for optional analytics, in a real browser, on the local harness (the layout treats the local e2e server as an analytics-capable host
 * via e2eFixturesAllowed, which every hosted deployment refuses). The Vercel script itself is replaced by a stub that only records calls, so
 * nothing ever leaves the machine; what is asserted is whether the browser WOULD have loaded it and what it would have been told to measure.
 */
test.use({ seedConsent: false });

const SCRIPT = /\/_vercel\/insights\/script\.js|va\.vercel-scripts\.com\/v1\/script\.debug\.js/;
const ANY_VERCEL = /\/_vercel\/|vercel-scripts\.com/;

async function track(page: Page) {
  const requests: string[] = [];
  page.on("request", (r) => {
    if (ANY_VERCEL.test(r.url())) requests.push(r.url());
  });
  await page.route(SCRIPT, (route) => route.fulfill({ status: 200, contentType: "application/javascript", body: "/* stub: records nothing */" }));
  return requests;
}
const stored = (page: Page) => page.evaluate((k) => window.localStorage.getItem(k), CONSENT_STORAGE_KEY);
const queued = (page: Page, name: string) =>
  page.evaluate((n) => ((window as unknown as { vaq?: unknown[][] }).vaq ?? []).filter((e) => e[0] === n).length, name);
const banner = (page: Page) => page.locator('[data-consent="banner"]');
const settings = (page: Page) => page.locator('[data-consent="settings"]');

test("first visit: a bar with equal Accept / Reject / Settings, no preselection, no wall, and NOTHING optional loaded or stored", async ({ page }) => {
  const requests = await track(page);
  await page.goto("/database");
  await expect(banner(page)).toBeVisible();
  const accept = banner(page).getByRole("button", { name: "Accept analytics" });
  const reject = banner(page).getByRole("button", { name: "Reject optional" });
  await expect(banner(page).getByRole("button", { name: "Settings" })).toBeVisible();

  // Equal prominence: identical size and identical visual treatment.
  const [a, r] = [await accept.boundingBox(), await reject.boundingBox()];
  expect(Math.round(a!.width)).toBe(Math.round(r!.width));
  expect(Math.round(a!.height)).toBe(Math.round(r!.height));
  const style = (loc: typeof accept) => loc.evaluate((el) => { const s = getComputedStyle(el); return [s.backgroundImage, s.color, s.fontSize, s.fontWeight, s.borderTopColor].join("|"); });
  expect(await style(accept)).toBe(await style(reject));
  expect(a!.height).toBeGreaterThanOrEqual(44);

  // Not a cookie wall: the page behind it is fully usable, and the bar is not a modal.
  await expect(banner(page)).not.toHaveAttribute("aria-modal", "true");
  await page.getByRole("navigation", { name: "Footer" }).getByRole("link", { name: "Privacy" }).click();
  await expect(page).toHaveURL(/\/about\/privacy/);
  await expect(banner(page)).toBeVisible();

  // Nothing optional before a choice: no storage record, no script element, no request.
  expect(await stored(page)).toBeNull();
  expect(await page.locator('script[src*="_vercel"], script[src*="vercel-scripts"]').count()).toBe(0);
  expect(await page.evaluate(() => typeof (window as unknown as { va?: unknown }).va)).toBe("undefined");
  expect(requests).toEqual([]);
  // The essential rate-limit cookie is independent of the choice.
  expect((await page.context().cookies()).map((c) => c.name)).toContain("fdb_sid");
});

test("reject: remembered, no analytics ever, bar gone across reload and navigation; the site keeps working", async ({ page }) => {
  const requests = await track(page);
  await page.goto("/");
  await banner(page).getByRole("button", { name: "Reject optional" }).click();
  await expect(banner(page)).toHaveCount(0);
  expect(JSON.parse((await stored(page))!)).toEqual({ v: 1, analytics: false, at: createConsentRecord(false).at, notice: PRIVACY_NOTICE_VERSION });

  await page.reload();
  await expect(page.getByRole("contentinfo")).toBeVisible();
  await expect(banner(page)).toHaveCount(0);
  await page.goto("/database");
  await page.goto("/zones");
  expect((await page.request.get("/database")).status()).toBe(200);
  expect(requests).toEqual([]);
  expect(await queued(page, "pageview")).toBe(0);
  expect((await page.context().cookies()).map((c) => c.name)).toContain("fdb_sid");
});

test("accept: the script loads once, only now, page views are queued; remembered across reload; client-side navigation is measured", async ({ page }) => {
  const requests = await track(page);
  await page.goto("/");
  expect(requests).toEqual([]);
  await banner(page).getByRole("button", { name: "Accept analytics" }).click();
  await expect(banner(page)).toHaveCount(0);
  await expect.poll(() => requests.filter((u) => SCRIPT.test(u)).length).toBeGreaterThan(0);
  expect(JSON.parse((await stored(page))!)).toMatchObject({ analytics: true, notice: PRIVACY_NOTICE_VERSION });
  await expect.poll(() => queued(page, "pageview")).toBeGreaterThan(0);

  const before = await queued(page, "pageview");
  await page.getByRole("navigation", { name: "Footer" }).getByRole("link", { name: "How the data works" }).click();
  await expect(page).toHaveURL(/\/about\/data/);
  await expect.poll(() => queued(page, "pageview")).toBeGreaterThan(before);

  await page.reload();
  await expect(banner(page)).toHaveCount(0);
  await expect.poll(() => requests.filter((u) => SCRIPT.test(u)).length).toBeGreaterThan(1);
});

test("the send-time gate: with the script loaded, every event carries the live consent and is URL-redacted", async ({ page }) => {
  await track(page);
  await page.goto("/");
  await banner(page).getByRole("button", { name: "Accept analytics" }).click();
  await expect.poll(() => queued(page, "beforeSend")).toBeGreaterThan(0);
  const call = (url: string) =>
    page.evaluate((u) => {
      const q = ((window as unknown as { vaq?: unknown[][] }).vaq ?? []).filter((e) => e[0] === "beforeSend");
      const fn = q[q.length - 1]![1] as (e: { type: string; url: string }) => { url: string } | null;
      return fn({ type: "pageview", url: u })?.url ?? null;
    }, url);
  // With consent the event is let through, redacted (the event's own URL decides the host policy, not the browser's address).
  expect(await call("https://azerdex.com/database?q=secret#frag")).toBe("https://azerdex.com/database");
  // Consent withdrawn (an outdated notice version counts as withdrawn) or cleared: every event is cancelled.
  await page.evaluate((k) => window.localStorage.setItem(k, JSON.stringify({ v: 1, analytics: false, at: "2026-10-30", notice: "x" })), CONSENT_STORAGE_KEY);
  expect(await call("https://azerdex.com/database")).toBeNull();
  await page.evaluate((k) => window.localStorage.removeItem(k), CONSENT_STORAGE_KEY);
  expect(await call("https://azerdex.com/database")).toBeNull();
});

test("withdrawal from the footer stops measurement at once, without signing out, and survives reload", async ({ page }) => {
  const requests = await track(page);
  await page.goto("/");
  await banner(page).getByRole("button", { name: "Accept analytics" }).click();
  await expect.poll(() => queued(page, "pageview")).toBeGreaterThan(0);

  await page.getByRole("contentinfo").getByRole("button", { name: "Cookie settings" }).click();
  await expect(settings(page)).toBeVisible();
  const box = settings(page).getByRole("checkbox", { name: /Analytics \(optional\)/ });
  await expect(box).toBeChecked();
  await box.uncheck();
  await settings(page).getByRole("button", { name: "Save choices" }).click();
  await expect(settings(page)).toHaveCount(0);
  await expect(banner(page)).toHaveCount(0);
  expect(JSON.parse((await stored(page))!).analytics).toBe(false);

  const frozen = await queued(page, "pageview");
  await page.getByRole("navigation", { name: "Footer" }).getByRole("link", { name: "How the data works" }).click();
  await expect(page).toHaveURL(/\/about\/data/);
  await page.getByRole("navigation", { name: "Footer" }).getByRole("link", { name: "All zones" }).click();
  await expect(page).toHaveURL(/\/zones/);
  expect(await queued(page, "pageview")).toBe(frozen);

  const scriptRequestsBefore = requests.filter((u) => SCRIPT.test(u)).length;
  await page.reload();
  await page.goto("/zones");
  expect(requests.filter((u) => SCRIPT.test(u)).length).toBe(scriptRequestsBefore);
  expect((await page.context().cookies()).map((c) => c.name)).toContain("fdb_sid"); // essential state untouched
});

test("withdrawal in ANOTHER tab reaches this one (storage event) without a reload", async ({ page, context }) => {
  await track(page);
  await page.goto("/");
  await banner(page).getByRole("button", { name: "Accept analytics" }).click();
  await expect.poll(() => queued(page, "pageview")).toBeGreaterThan(0);
  const other = await context.newPage();
  await other.goto("/");
  await other.evaluate((k) => window.localStorage.setItem(k, JSON.stringify({ v: 1, analytics: false, at: "2026-10-30", notice: "2026-10-30" })), CONSENT_STORAGE_KEY);
  await page.waitForTimeout(300); // the storage event is delivered to this tab asynchronously
  const frozen = await queued(page, "pageview");
  await page.getByRole("navigation", { name: "Footer" }).getByRole("link", { name: "How the data works" }).click();
  await expect(page).toHaveURL(/\/about\/data/);
  expect(await queued(page, "pageview")).toBe(frozen);
});

test("a stored choice from an OLDER notice version, or a malformed one, asks again and measures nothing", async ({ page }) => {
  const requests = await track(page);
  for (const value of [JSON.stringify({ ...createConsentRecord(true), notice: "2025-01-01" }), "not json", JSON.stringify({ v: 1, analytics: "yes" })]) {
    await page.goto("/about/data");
    await page.evaluate(([k, v]) => window.localStorage.setItem(k as string, v as string), [CONSENT_STORAGE_KEY, value]);
    await page.goto("/");
    await expect(banner(page)).toBeVisible();
  }
  expect(requests).toEqual([]);
});

test("settings: opens from the bar, nothing preselected, Escape / Cancel return to the bar, focus moves in and back", async ({ page }) => {
  await page.goto("/");
  const opener = banner(page).getByRole("button", { name: "Settings" });
  await opener.focus();
  await opener.click();
  await expect(settings(page)).toBeVisible();
  await expect(banner(page)).toHaveCount(0);
  await expect(settings(page).getByRole("heading", { name: "Cookie and analytics settings" })).toBeFocused();
  await expect(settings(page).getByRole("checkbox", { name: /Analytics \(optional\)/ })).not.toBeChecked();
  await expect(settings(page)).toContainText("Essential — always on");
  await page.keyboard.press("Escape");
  await expect(settings(page)).toHaveCount(0);
  await expect(banner(page)).toBeVisible();
  expect(await stored(page)).toBeNull(); // closing without saving records nothing
  await opener.click();
  await settings(page).getByRole("button", { name: "Cancel" }).click();
  await expect(banner(page)).toBeVisible();
  // Saving with the box left unchecked is a remembered refusal.
  await opener.click();
  await settings(page).getByRole("button", { name: "Save choices" }).click();
  expect(JSON.parse((await stored(page))!).analytics).toBe(false);
});

test("the privacy page has the same way to change the choice, and shows the controller and contact", async ({ page }) => {
  await page.goto("/about/privacy");
  await expect(page.getByText("Hrabovszki Péter").first()).toBeVisible();
  await expect(page.getByRole("link", { name: "privacy@azerdex.com" }).first()).toHaveAttribute("href", "mailto:privacy@azerdex.com");
  await expect(page.getByRole("link", { name: /NAIH/ })).toHaveAttribute("href", "https://www.naih.hu/");
  await banner(page).getByRole("button", { name: "Reject optional" }).click();
  await page.getByRole("button", { name: "change your choice" }).click();
  await expect(settings(page)).toBeVisible();
});

test("keyboard: the skip link stays first, then the bar is reached before the page header", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(banner(page).getByRole("link", { name: "privacy notice" })).toBeFocused();
});

test("accessibility (axe WCAG 2.2 AA): the bar and the settings panel", async ({ page }) => {
  await page.goto("/");
  await expect(banner(page)).toBeVisible();
  const run = () => new AxeBuilder({ page: page as never }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  expect((await run()).violations.map((v) => `${v.id}: ${v.nodes.length} — ${v.help}`)).toEqual([]);
  await banner(page).getByRole("button", { name: "Settings" }).click();
  await expect(settings(page)).toBeVisible();
  expect((await run()).violations.map((v) => `${v.id}: ${v.nodes.length} — ${v.help}`)).toEqual([]);
});

test("layout: the bar fits the viewport without horizontal scrolling and keeps 44px targets", async ({ page }) => {
  await page.goto("/");
  await expect(banner(page)).toBeVisible();
  const vp = page.viewportSize()!;
  const box = (await banner(page).boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 1);
  expect(box.height).toBeLessThanOrEqual(vp.height * 0.6);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  for (const name of ["Accept analytics", "Reject optional", "Settings"]) {
    expect((await banner(page).getByRole("button", { name }).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
});
