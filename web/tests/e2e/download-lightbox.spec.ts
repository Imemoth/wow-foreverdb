import { expect, test } from "./fixtures";

/**
 * P2-E remediation: "Screenshot gallery accessibility and Lightbox hardening" for
 * MediaSlotGallery's modal. All eight public /download media slots ship as placeholders
 * (no real asset), so the open-image interaction itself is never exercised by a normal
 * page visit - this spec drives it against the internal-only, fail-closed
 * /test-fixtures/lightbox harness (gated by E2E_FIXTURES_ENABLED, only ever set by this
 * Playwright config's webServer, never in the real app/beta/production). The harness
 * renders the same MediaSlotGallery component used on /download with one slot pointed at
 * an obviously-synthetic test-pattern image, never a real Addon/Companion screenshot.
 */

test.describe("MediaSlotGallery lightbox: focus, keyboard trap and scroll lock", () => {
  test("opening the lightbox moves focus into the dialog and labels it for screen readers", async ({ page }) => {
    await page.goto("/test-fixtures/lightbox");
    await page.getByRole("button", { name: "Test fixture image" }).click();
    const dialog = page.getByRole("dialog", { name: "Test fixture image" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toBeFocused();
  });

  test("Tab and Shift+Tab stay trapped between the dialog's own focusable elements", async ({ page }) => {
    await page.goto("/test-fixtures/lightbox");
    await page.getByRole("button", { name: "Test fixture image" }).click();
    const dialog = page.getByRole("dialog", { name: "Test fixture image" });
    const closeBtn = dialog.getByRole("button", { name: "Close enlarged image" });

    // The close button is the dialog's only focusable element, so Tab from it wraps
    // straight back to itself rather than escaping to the (now-inert) page behind it.
    await page.keyboard.press("Tab");
    await expect(closeBtn).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(closeBtn).toBeFocused();
  });

  test("background content (e.g. the site header) is inert while the modal is open, and restored on close", async ({ page }) => {
    await page.goto("/test-fixtures/lightbox");
    await page.getByRole("button", { name: "Test fixture image" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();

    // `inert` keeps the element present and visually unchanged but unfocusable and hidden
    // from the accessibility tree, so assert the attribute directly rather than visibility.
    const header = page.getByRole("banner");
    const headerIsInert = await header.evaluate((el) => el.closest("[inert]") !== null);
    expect(headerIsInert).toBe(true);
    // A direct focus attempt on a background link must not land, confirming the trap holds
    // in practice and not just via the attribute's presence.
    const headerLink = header.getByRole("link").first();
    await headerLink.focus({ timeout: 1000 }).catch(() => {});
    await expect(headerLink).not.toBeFocused();

    await page.keyboard.press("Escape");
    const headerStillInert = await header.evaluate((el) => el.closest("[inert]") !== null);
    expect(headerStillInert).toBe(false);
  });

  test("Escape closes the lightbox and returns focus to the originating gallery trigger", async ({ page }) => {
    await page.goto("/test-fixtures/lightbox");
    const trigger = page.getByRole("button", { name: "Test fixture image" });
    await trigger.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test("the close button closes the lightbox via pointer click and returns focus to the trigger", async ({ page }) => {
    await page.goto("/test-fixtures/lightbox");
    const trigger = page.getByRole("button", { name: "Test fixture image" });
    await trigger.click();
    await page.getByRole("button", { name: "Close enlarged image" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test("the close button closes the lightbox via keyboard activation (Enter)", async ({ page }) => {
    await page.goto("/test-fixtures/lightbox");
    const trigger = page.getByRole("button", { name: "Test fixture image" });
    await trigger.click();
    const closeBtn = page.getByRole("button", { name: "Close enlarged image" });
    await closeBtn.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });

  test("clicking the backdrop closes the lightbox, but clicking inside the dialog does not", async ({ page }) => {
    await page.goto("/test-fixtures/lightbox");
    await page.getByRole("button", { name: "Test fixture image" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // Click inside the dialog's own content (its caption), away from the close button.
    await dialog.getByText("Test fixture image").click();
    await expect(dialog).toBeVisible();

    // Click the backdrop itself, outside the dialog's bounding box.
    await page.mouse.click(5, 5);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });

  test("page scroll is locked while the lightbox is open and restored on close", async ({ page }) => {
    await page.goto("/test-fixtures/lightbox");
    const isLocked = () => page.evaluate(() => document.documentElement.classList.contains("body-scroll-locked"));

    expect(await isLocked()).toBe(false);
    await page.getByRole("button", { name: "Test fixture image" }).click();
    expect(await isLocked()).toBe(true);
    await page.keyboard.press("Escape");
    expect(await isLocked()).toBe(false);
  });
});

test.describe("Lightbox test fixture harness stays internal-only", () => {
  test("the harness page is noindex", async ({ page }) => {
    await page.goto("/test-fixtures/lightbox");
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  });
});
