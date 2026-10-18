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
    for (const name of ["Database", "Zones", "Guides", "News", "Blog", "Download", "Account"]) {
      await expect(nav.getByRole("link", { name })).toBeVisible();
    }

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
