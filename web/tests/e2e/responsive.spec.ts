import { expect, test } from "./fixtures";

for (const path of ["/", "/database?q=copper", "/item/2770", "/creature/1554", "/zone/1420", "/guides/reading-observed-drop-rates"]) {
  test(`mobile layout has no horizontal page scroll: ${path}`, async ({ page }) => {
    await page.goto(path);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });
}

// These assert the mobile-only presentation (collapsed nav, icon shortcuts, card layout) that
// only renders below Tailwind's `sm`/`md` breakpoints, so they only make sense under the
// "mobile" Playwright project (Pixel 7, ~412px wide) - the "desktop" project runs at 1366px,
// where this UI is deliberately `hidden`.
test.describe("mobile-only UI", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "asserts mobile-breakpoint-only UI");
  });

  test("mobile header: compact single row, full nav and search input collapse to icons", async ({ page }) => {
    await page.goto("/");
    const header = page.locator("header");
    const box = await header.boundingBox();
    expect(box!.height).toBeLessThanOrEqual(72); // ~56-64px target, generous ceiling for font rendering variance
    await expect(page.getByRole("navigation", { name: "Primary" })).toBeHidden();
    await expect(page.getByLabel("Search the database").first()).toBeHidden(); // the always-visible desktop <input>, not the icon link
    await expect(page.getByRole("link", { name: "Search the database" })).toBeVisible(); // mobile icon shortcut
  });

  test("mobile search icon routes to the database's primary search field", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "Search the database" }).click();
    await expect(page).toHaveURL(/\/database$/);
    await expect(page.getByLabel("Name or ID")).toBeVisible();
  });

  test("mobile hamburger menu: keyboard open/close, Escape restores focus, all destinations present", async ({ page }) => {
    await page.goto("/");
    // The toggle's accessible name flips between "Open menu" and "Close menu" with its state, so
    // each assertion below re-locates it by whichever name applies at that moment rather than
    // holding a single `getByRole` locator across the state change.
    await expect(page.getByRole("button", { name: "Open menu" })).toHaveAttribute("aria-expanded", "false");

    await page.getByRole("button", { name: "Open menu" }).focus();
    await page.keyboard.press("Enter");
    const opened = page.getByRole("button", { name: "Close menu" });
    await expect(opened).toHaveAttribute("aria-expanded", "true");
    const nav = page.getByRole("navigation", { name: "Primary" }).last();
    for (const name of ["Database", "Zones", "Guides", "News", "Blog"]) {
      await expect(nav.getByRole("link", { name })).toBeVisible();
    }
    // The Addon/Companion are not released yet: no Download entry in the menu (the /download page itself is kept).
    await expect(nav.getByRole("link", { name: "Download" })).toHaveCount(0);

    await page.keyboard.press("Escape");
    const closed = page.getByRole("button", { name: "Open menu" });
    await expect(closed).toHaveAttribute("aria-expanded", "false");
    await expect(closed).toBeFocused();
  });

  test("mobile hamburger menu: outside click dismisses it and a link navigates", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Open menu" }).click();
    await page.mouse.click(200, 800); // below the short link list, on the backdrop rather than the panel or the header
    await expect(page.getByRole("button", { name: "Open menu" })).toHaveAttribute("aria-expanded", "false");

    await page.getByRole("button", { name: "Open menu" }).click();
    await page.getByRole("navigation", { name: "Primary" }).last().getByRole("link", { name: "Database" }).click();
    await expect(page).toHaveURL(/\/database$/);
  });

  test("database mobile: result cards carry name, ID, acquisition, zone, observations and a working link", async ({ page }) => {
    await page.goto("/database?q=copper");
    await expect(page.locator("table")).toBeHidden(); // desktop presentation is not shown on mobile
    const list = page.getByRole("list", { name: "Search results" });
    await expect(list).toBeVisible();
    const card = list.getByRole("link", { name: /Copper Ore/ });
    await expect(card).toBeVisible();
    await expect(card.getByText(/^ID: 2770$/)).toBeVisible();
    await expect(card.getByText(/^Zone:/)).toBeVisible();
    await expect(card.getByText(/^Observations/)).toBeVisible();
    await expect(card.getByText("View details →")).toBeVisible();
    await card.click();
    await expect(page).toHaveURL(/\/item\/2770/);
  });

  test("database mobile: advanced filters stay collapsed until used, then auto-reveal with an active-filter indicator", async ({ page }) => {
    await page.goto("/database?q=copper");
    const details = page.locator("details");
    await expect(details).not.toHaveJSProperty("open", true);
    const summary = page.getByText("Advanced filters", { exact: false });
    await expect(summary).toBeVisible();
    await expect(page.getByLabel("Type")).toBeHidden();
    await summary.click();
    await expect(page.getByLabel("Type")).toBeVisible();

    await page.goto("/database?q=copper&kind=mining");
    await expect(details).toHaveJSProperty("open", true);
    await expect(page.getByText("1 active")).toBeVisible();
    await expect(page.getByLabel("Acquisition")).toBeVisible();
    await page.getByRole("link", { name: "Reset filters" }).click();
    await expect(page).toHaveURL(/\/database\?q=copper$/);
  });

  test("database mobile: an active filter is still discoverable after a hard reload", async ({ page }) => {
    await page.goto("/database?q=copper&zone=1420&sort=name");
    const details = page.locator("details");
    await expect(details).toHaveJSProperty("open", true);
    await expect(page.getByText("2 active")).toBeVisible();
    await expect(page.getByLabel("Zone")).toBeVisible();
    await page.reload();
    await expect(details).toHaveJSProperty("open", true);
    await expect(page.getByText("2 active")).toBeVisible();
    await expect(page.getByLabel("Zone")).toHaveValue("1420");
    await expect(page.getByLabel("Sort")).toHaveValue("name");
  });
});

// The regression this guards against: an earlier implementation tried to override a closed native
// <details>'s own content-hiding behavior with `md:contents` on its children, which is not reliable
// across browser engines and silently dropped Type/Zone/Acquisition/Sort from the desktop form
// entirely. Pinned to 1440px (not just the "desktop" project's 1366px default) because that is the
// exact width the regression was reported at.
test.describe("database desktop filters (regression: must never collapse on desktop)", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "desktop-only regression check");
  });

  test("no active filters: every filter field is visible and the mobile toggle is not", async ({ page }) => {
    await page.goto("/database?q=copper");
    await expect(page.getByLabel("Name or ID")).toBeVisible();
    await expect(page.getByLabel("Type")).toBeVisible();
    await expect(page.getByLabel("Zone")).toBeVisible();
    await expect(page.getByLabel("Acquisition")).toBeVisible();
    await expect(page.getByLabel("Sort")).toBeVisible();
    await expect(page.getByRole("button", { name: "Search" })).toBeVisible();
    await expect(page.getByText("Advanced filters", { exact: false })).toBeHidden();
  });

  test("with a query and an active filter, every filter field remains visible", async ({ page }) => {
    await page.goto("/database?q=copper&kind=mining&sort=observations");
    await expect(page.getByLabel("Type")).toBeVisible();
    await expect(page.getByLabel("Zone")).toBeVisible();
    await expect(page.getByLabel("Acquisition")).toBeVisible();
    await expect(page.getByLabel("Acquisition")).toHaveValue("mining");
    await expect(page.getByLabel("Sort")).toBeVisible();
    await expect(page.getByLabel("Sort")).toHaveValue("observations");
    // Collapsed-by-default styling never applies at this width even though the disclosure is "open".
    await expect(page.getByText("Advanced filters", { exact: false })).toBeHidden();
  });

  test("filtering and sorting operate correctly from the visible desktop controls", async ({ page }) => {
    await page.goto("/database?q=copper");
    await page.getByLabel("Acquisition").selectOption({ label: "Mining" });
    await expect(page).toHaveURL(/kind=mining/);
    await page.getByLabel("Sort").selectOption({ label: "Most observed" });
    await expect(page).toHaveURL(/sort=observations/);
    await expect(page.getByLabel("Acquisition")).toHaveValue("mining");
    await expect(page.getByLabel("Sort")).toHaveValue("observations");
  });

  test("no duplicate fields and no duplicate query parameters are submitted", async ({ page }) => {
    await page.goto("/database?q=copper");
    // Scoped to the database search form itself: the header elsewhere on the page has its own,
    // separate `name="q"` search input, which is not a duplicate of this form's field.
    const form = page.getByRole("search", { name: "Database search and filters" });
    for (const name of ["q", "category", "zone", "kind", "sort"]) {
      await expect(form.locator(`[name="${name}"]`)).toHaveCount(1);
    }
    await page.getByLabel("Type").selectOption({ label: "Items" });
    const url = new URL(page.url());
    for (const name of ["q", "category", "zone", "kind", "sort"]) {
      expect(url.searchParams.getAll(name).length).toBeLessThanOrEqual(1);
    }
    await expect(page.getByRole("alert")).toHaveCount(0); // no "duplicate_parameter" validation error
  });

  test("search results table remains fully functional alongside the restored filters", async ({ page }) => {
    await page.goto("/database?q=copper");
    const table = page.locator("table");
    await expect(table).toBeVisible();
    await expect(table.getByRole("link", { name: "Copper Ore" })).toBeVisible();
    await expect(page.getByRole("list", { name: "Search results" })).toBeHidden(); // mobile cards stay off at this width
    await table.getByRole("link", { name: "Copper Ore" }).click();
    await expect(page).toHaveURL(/\/item\/2770/);
  });
});

// P1-A regression: the toolbar's fixed-fr single-row grid (`xl:grid-cols-[2fr_1fr_1fr_1fr_1fr_auto]`)
// only takes over at 1280px; below that, tablet widths get an explicit wrapping layout
// (md:grid-cols-2, lg:grid-cols-4) so the Search button and every field stay fully visible and
// in-viewport at every width an owner might actually use, not just the "desktop" project's 1366px.
test.describe("database tablet toolbar (regression: Search button must never clip)", () => {
  test.beforeEach(({}, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "pins exact viewport widths directly; project default is irrelevant");
  });

  for (const width of [320, 375, 390, 440, 768, 820, 1024, 1032, 1280, 1440, 1920]) {
    test(`every field and the Search button are fully visible, in-viewport, with no page overflow @ ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.goto("/database");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);

      const btn = page.getByRole("button", { name: "Search" });
      await expect(btn).toBeVisible();
      const box = (await btn.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);

      if (width >= 768) {
        // At md+ the fields are never behind the mobile "Advanced filters" disclosure.
        for (const label of ["Name or ID", "Type", "Zone", "Acquisition", "Sort"]) {
          await expect(page.getByLabel(label)).toBeVisible();
        }
      }
    });
  }

  test("filtering still works correctly at the previously-broken tablet width (1032px)", async ({ page }) => {
    await page.setViewportSize({ width: 1032, height: 800 });
    await page.goto("/database?q=copper");
    await page.getByLabel("Acquisition").selectOption({ label: "Mining" });
    await expect(page).toHaveURL(/kind=mining/);
    await expect(page.getByRole("button", { name: "Search" })).toBeVisible();
  });

  test("the original single-row desktop layout is unchanged at 1280px and up (xl breakpoint)", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/database?q=copper");
    const form = page.getByRole("search", { name: "Database search and filters" });
    const nameBox = (await form.locator("#db-q").boundingBox())!;
    const btnBox = (await page.getByRole("button", { name: "Search" }).boundingBox())!;
    // Single row: Name/ID and Search sit side by side at the same vertical position, not stacked.
    expect(Math.abs(nameBox.y - btnBox.y)).toBeLessThan(20);
  });
});

// P2-E remediation: a voluntary, no-strings "Buy Me a Coffee" support link - a plain external
// link, never an embedded widget/script/tracking/payment API - visually secondary to primary
// navigation, top-right on desktop and the last hamburger-menu item on mobile.
test.describe("community support link ('Buy Me a Coffee')", () => {
  const SUPPORT_URL = "https://buymeacoffee.com/azerdex";

  test("desktop header carries the support link, opening in a new tab safely", async ({ page }) => {
    test.skip(test.info().project.name !== "desktop", "desktop header only renders at sm+");
    await page.goto("/");
    const link = page.getByRole("banner").getByRole("link", { name: /Support/ });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("href", SUPPORT_URL);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", /noopener/);
    await expect(link).toHaveAttribute("rel", /noreferrer/);
  });

  test("desktop header: the support link is keyboard-focusable with a visible focus state", async ({ page }) => {
    test.skip(test.info().project.name !== "desktop", "desktop header only renders at sm+");
    await page.goto("/");
    const link = page.getByRole("banner").getByRole("link", { name: /Support/ });
    await link.focus();
    await expect(link).toBeFocused();
  });

  test("mobile hamburger menu carries the support link as its last item", async ({ page }) => {
    test.skip(test.info().project.name !== "mobile", "exercises the mobile-only hamburger menu");
    await page.goto("/");
    await page.getByRole("button", { name: "Open menu" }).click();
    const nav = page.getByRole("navigation", { name: "Primary" }).last();
    const items = nav.getByRole("listitem");
    const lastItem = items.last();
    const supportLink = lastItem.getByRole("link", { name: /Support AzerDex/ });
    await expect(supportLink).toBeVisible();
    await expect(supportLink).toHaveAttribute("href", SUPPORT_URL);
    await expect(supportLink).toHaveAttribute("target", "_blank");
    await expect(supportLink).toHaveAttribute("rel", /noopener/);
    await expect(supportLink).toHaveAttribute("rel", /noreferrer/);
  });

  for (const width of [768, 820, 1024, 1032]) {
    test(`header stays overflow-free with the support link present @ ${width}px`, async ({ page }) => {
      test.skip(test.info().project.name !== "desktop", "pins exact viewport widths directly");
      await page.setViewportSize({ width, height: 800 });
      await page.goto("/");
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      await expect(page.getByRole("banner").getByRole("link", { name: /Support/ })).toBeVisible();
      await expect(page.getByLabel("Search the database").first()).toBeVisible();
    });
  }
});

// Regression: on any deployment where Account is not enabled (this e2e stack, production, unrelated previews) the
// global nav carries NO Account entry - a link that always 404s would be misleading. The entry is rendered only by the
// account-zone seam <HeaderAccount /> when Account is enabled and ready (see tests/unit/account-public-beta.test.ts and
// account-boundary.test.ts); SiteHeader/MobileNav never inspect account state (ADR-015). The real /account app stays
// fail-closed with 404 here.
test.describe("global nav has no Account entry point while Account is disabled", () => {
  test("desktop header carries no Account link", async ({ page }) => {
    test.skip(test.info().project.name !== "desktop", "desktop header only renders at sm+");
    await page.goto("/");
    await expect(page.getByRole("banner").getByRole("link", { name: "Account" })).toHaveCount(0);
  });

  test("mobile hamburger menu carries no Account link", async ({ page }) => {
    test.skip(test.info().project.name !== "mobile", "exercises the mobile-only hamburger menu");
    await page.goto("/");
    await page.getByRole("button", { name: "Open menu" }).click();
    const nav = page.getByRole("navigation", { name: "Primary" }).last();
    await expect(nav.getByRole("link", { name: "Account" })).toHaveCount(0);
  });

  test("/account and its sub-routes still fail closed with 404 (unchanged)", async ({ page }) => {
    for (const path of ["/account", "/account/login", "/account/register"]) {
      const res = await page.goto(path);
      expect(res!.status()).toBe(404);
    }
  });
});
