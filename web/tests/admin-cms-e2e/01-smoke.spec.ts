import { expect, test } from "@playwright/test";
import { createDraft, enterAdmin, makeStaff, newUser } from "./fixtures";

test("an Editor signs in with real TOTP, creates a draft in the real CMS and sees it after reload", async ({ page }) => {
  const editor = await newUser("editor");
  await makeStaff(editor, "Editor");
  await enterAdmin(page, editor);
  await expect(page.getByTestId("session-identity")).toBeVisible();
  const a = await createDraft(page);
  await page.reload();
  await expect(page.getByRole("heading", { name: a.title })).toBeVisible();
  await expect(page.getByTestId("article-status")).toHaveText("Draft");
});
