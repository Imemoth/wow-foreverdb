import { expect, test } from "./fixtures";

/**
 * P2-E "Addon & Companion Experience" regression coverage for the rebuilt /download
 * page: section navigation, the future-ready screenshot-slot placeholders (never a
 * broken-image request), the release-gated installation flow (no fake download link),
 * no fabricated Discord invite, and that the synthetic-data/Account boundaries this
 * page must not touch stay intact. WCAG 2.2 AA coverage for this path already lives in
 * a11y-seo.spec.ts's PAGES loop.
 */

const VIEWPORTS = [320, 390, 440, 768, 820, 1024, 1032, 1280, 1920];

async function assertNoOverflow(page: import("@playwright/test").Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe("Download page: hero, nav and no overflow", () => {
  for (const width of VIEWPORTS) {
    test(`renders the hero and section nav with no overflow @ ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/download");
      await assertNoOverflow(page);
      await expect(page.getByRole("heading", { level: 1, name: "Addon & Companion" })).toBeVisible();
      await expect(page.getByRole("navigation", { name: "Addon & Companion sections" })).toBeVisible();
    });
  }

  test("every in-page section anchor lands on its own section", async ({ page }) => {
    await page.goto("/download");
    const nav = page.getByRole("navigation", { name: "Addon & Companion sections" });
    const sections = [
      ["Overview", "overview"],
      ["In-game Addon", "addon"],
      ["Windows Companion", "companion"],
      ["How It Works", "how-it-works"],
      ["Installation", "installation"],
      ["FAQ & Support", "faq"],
    ] as const;
    for (const [label, id] of sections) {
      await expect(nav.getByRole("link", { name: label })).toHaveAttribute("href", `#${id}`);
      await expect(page.locator(`#${id}`)).toBeAttached();
    }
  });
});

test.describe("Download page: feature content is accurate, not fabricated", () => {
  test("Addon section lists only verified features and real commands", async ({ page }) => {
    await page.goto("/download");
    const addon = page.locator("#addon");
    await expect(addon.getByText("Creature loot and skinning observations", { exact: true })).toBeVisible();
    await expect(addon.getByText("Mining and herbalism nodes", { exact: true })).toBeVisible();
    await expect(addon.getByText("/fdb status", { exact: true })).toBeVisible();
    await expect(addon.getByRole("link", { name: "View addon source" })).toHaveAttribute(
      "href", "https://github.com/Imemoth/wow-foreverdb/tree/main/addon/ForeverDB",
    );
  });

  test("Companion section distinguishes anonymous features from account-linked ones still rolling out", async ({ page }) => {
    await page.goto("/download");
    const companion = page.locator("#companion");
    await expect(companion.getByRole("heading", { name: "Multi-zone map viewer" })).toBeVisible();
    await expect(companion.getByText("Account sign-in & registered devices")).toBeVisible();
    await expect(companion.getByText("Rolling out").first()).toBeVisible();
  });
});

test.describe("Download page: screenshot galleries never request a nonexistent asset", () => {
  test("every gallery image request that fires actually resolves (no broken-image icon)", async ({ page }) => {
    const failed: string[] = [];
    page.on("requestfailed", (req) => { if (req.url().includes("/download/screenshots/")) failed.push(req.url()); });
    const badStatuses: string[] = [];
    page.on("response", (res) => {
      if (res.url().includes("/download/screenshots/") && res.status() >= 400) badStatuses.push(`${res.status()} ${res.url()}`);
    });
    await page.goto("/download");
    await page.waitForLoadState("networkidle");
    expect(failed).toEqual([]);
    expect(badStatuses).toEqual([]);
  });

  test("placeholder slots render the polished placeholder, not a broken image, and are not focusable triggers", async ({ page }) => {
    await page.goto("/download");
    await expect(page.getByText("Screenshot coming soon").first()).toBeVisible();
    // No slot has a real asset this round, so no lightbox-opening button should exist in the galleries.
    await expect(page.getByRole("button", { name: "Loot collection & tooltip" })).toHaveCount(0);
  });
});

test.describe("Download page: installation is release-gated, no fake links", () => {
  test("no active Download-now button points at a nonexistent installer, and pending steps are labeled", async ({ page }) => {
    await page.goto("/download");
    const install = page.locator("#installation");
    await expect(install.getByText("Pending release")).toBeVisible();
    await expect(install.getByText(/signed, one-download Companion installer is not available yet/)).toBeVisible();
    // Only real, existing GitHub links are present as actionable hrefs in this section.
    const links = await install.locator("a[href]").all();
    for (const link of links) {
      const href = await link.getAttribute("href");
      expect(href === null || href.startsWith("https://github.com/Imemoth/wow-foreverdb") || href.startsWith("/guides/")).toBe(true);
    }
  });
});

test.describe("Download page: FAQ, Discord placeholder and support", () => {
  test("Discord has no fabricated invite link; GitHub Issues is the real, clickable support path", async ({ page }) => {
    await page.goto("/download");
    const faq = page.locator("#faq");
    await expect(faq.getByRole("link", { name: "Report an issue on GitHub" })).toHaveAttribute(
      "href", "https://github.com/Imemoth/wow-foreverdb/issues",
    );
    const discordLink = faq.getByRole("link", { name: /Discord/ });
    await expect(discordLink).toHaveCount(0);
    await expect(faq.getByText("Discord community (coming soon)")).toBeVisible();
  });

  test("FAQ accordion is a native, keyboard-toggleable disclosure", async ({ page }) => {
    await page.goto("/download");
    const first = page.locator("#faq details").first();
    await expect(first).not.toHaveAttribute("open", "");
    await first.locator("summary").click();
    await expect(first).toHaveAttribute("open", "");
  });

  test("public beta contents are described honestly in the FAQ", async ({ page }) => {
    await page.goto("/download");
    await page.locator("#faq details", { hasText: "What does the public beta currently contain?" }).locator("summary").click();
    await expect(page.getByText(/synthetic sample data from the publication pipeline/)).toBeVisible();
  });
});

test.describe("Download page: boundaries untouched", () => {
  test("stays noindex on the public beta and carries the synthetic-data banner", async ({ page }) => {
    await page.goto("/download");
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    await expect(page.getByText("Preview with synthetic sample data.")).toBeVisible();
  });

  test("no account/sign-in form is introduced on this page", async ({ page }) => {
    await page.goto("/download");
    // The sitewide header search form is expected on every page; this page itself must add none of its own,
    // and in particular no credential input.
    await expect(page.locator("main form")).toHaveCount(0);
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
    await expect(page.getByRole("link", { name: /sign in/i })).toHaveCount(0);
  });
});
