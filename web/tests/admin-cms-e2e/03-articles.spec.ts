import { expect, test } from "@playwright/test";
import { BODY, createDraft, enterAdmin, makeStaff, newStaffPage, newUser, revisionCount, uniqueSlug, articleRow } from "./fixtures";

test.describe("articles, revisions and drafts (real persistence)", () => {
  test("create persists in the database; the list, detail and a brand-new browser session all see it", async ({ page, browser }) => {
    const ed = await newUser("author");
    await makeStaff(ed, "Editor");
    await enterAdmin(page, ed);
    const a = await createDraft(page);
    // database truth
    const row = await articleRow(a.slug);
    expect(row.review_state).toBe("draft");
    expect(await revisionCount(a.slug)).toBe(1);
    // list
    await page.goto("/admin/articles");
    await expect(page.getByTestId(`article-row-${a.slug}`)).toContainText(a.title);
    // dashboard tile counts at least this draft
    await page.goto("/admin");
    expect(Number(await page.getByTestId("tile-draft-count").textContent())).toBeGreaterThanOrEqual(1);
    // a different browser context signing in again sees the same persisted draft
    const ctx2 = await browser.newContext();
    const p2 = await newStaffPage(ctx2, ed);
    await p2.goto(a.url);
    await expect(p2.getByRole("heading", { name: a.title })).toBeVisible();
    await expect(p2.getByTestId("article-body")).toContainText("First paragraph of a real article.");
    await ctx2.close();
  });

  test("the editor mirrors database limits, shows field errors and saves nothing when invalid", async ({ page }) => {
    const ed = await newUser("validator");
    await makeStaff(ed, "Editor");
    await enterAdmin(page, ed);
    await page.goto("/admin/articles/new");
    await page.getByLabel("Slug (permanent)", { exact: true }).fill("Bad Slug!");
    await page.getByLabel("Title", { exact: true }).fill("ab");
    await page.getByLabel("Summary", { exact: true }).fill("short");
    await page.getByLabel("Markdown", { exact: true }).fill("<script>alert(1)</script>");
    await page.getByTestId("save-draft").click();
    await expect(page.getByTestId("editor-notice")).toContainText("Check the form");
    await expect(page.getByText("Lowercase letters, digits and single hyphens only.")).toBeVisible();
    await expect(page.getByText("Raw HTML is not allowed in Markdown.")).toBeVisible();
    expect(page.url()).toMatch(/\/articles\/new$/);
  });

  test("slugs are reserved: a second article with the same slug is refused and nothing is overwritten", async ({ page }) => {
    const ed = await newUser("slugger");
    await makeStaff(ed, "Editor");
    await enterAdmin(page, ed);
    const first = await createDraft(page, { title: "Original title" });
    await createDraftExpectError(page, first.slug);
    expect((await articleRow(first.slug)).slug).toBe(first.slug);
    expect(await revisionCount(first.slug)).toBe(1);
  });

  test("editing writes a NEW immutable revision, keeps history, and the diff shows exactly what changed", async ({ page }) => {
    const ed = await newUser("reviser");
    await makeStaff(ed, "Editor");
    await enterAdmin(page, ed);
    const a = await createDraft(page);
    await page.getByTestId("edit-link").click();
    await expect(page.getByRole("heading", { name: new RegExp(`Edit “${a.title}”`) })).toBeVisible();
    await page.getByLabel("Title", { exact: true }).fill(`${a.title} v2`);
    await page.getByLabel("Markdown", { exact: true }).fill(`${BODY}\n\nAn added second paragraph.`);
    await page.getByTestId("save-draft").click();
    await page.waitForURL(/\/admin\/articles\/[0-9a-f-]{36}$/);
    expect(await revisionCount(a.slug)).toBe(2);
    await page.getByRole("tab", { name: /Revisions/ }).click();
    await expect(page.getByTestId("rev-1")).toBeVisible();
    await expect(page.getByTestId("rev-2")).toContainText("current");
    await expect(page.getByTestId("diff")).toContainText("An added second paragraph.");
    await expect(page.getByTestId("diff")).toContainText(`${a.title} v2`);
    // revision 1 is untouched and still readable
    await page.getByLabel("To", { exact: true }).selectOption({ index: 1 });
    await expect(page.getByTestId("diff-none")).toBeVisible();
    // database immutability: revision rows cannot be updated or deleted even by the owner role of the app tables
    const c = (await import("./fixtures")).db;
    const cl = await c();
    try {
      await expect(cl.query("update editorial_private.revisions set snapshot=snapshot where true")).rejects.toThrow();
      await expect(cl.query("delete from editorial_private.revisions")).rejects.toThrow();
    } finally { await cl.end(); }
  });

  test("a draft saved in one tab can be reopened, edited again and keeps its identity", async ({ page }) => {
    const ed = await newUser("reopener");
    await makeStaff(ed, "Editor");
    await enterAdmin(page, ed);
    const a = await createDraft(page);
    await page.goto(`${a.url}/edit`);
    await expect(page.getByLabel("Title", { exact: true })).toHaveValue(a.title);
    await expect(page.getByLabel("Slug (permanent)", { exact: true })).toBeDisabled();
    await page.getByLabel("Summary", { exact: true }).fill("A rewritten summary that is long enough to pass the check.");
    await page.getByTestId("save-draft").click();
    await page.waitForURL(/\/admin\/articles\/[0-9a-f-]{36}$/);
    await expect(page.getByText("A rewritten summary that is long enough to pass the check.")).toBeVisible();
    expect(await revisionCount(a.slug)).toBe(2);
  });

  test("concurrent edits: the second writer is refused as stale, the first revision wins and nothing is lost", async ({ browser }) => {
    const ed = await newUser("racer");
    await makeStaff(ed, "Editor");
    const ctx = await browser.newContext();
    const p1 = await newStaffPage(ctx, ed);
    const a = await createDraft(p1);
    const p2 = await ctx.newPage();
    await p1.goto(`${a.url}/edit`);
    await p2.goto(`${a.url}/edit`);
    await p1.getByLabel("Title", { exact: true }).fill("Winner title from tab one");
    await p2.getByLabel("Title", { exact: true }).fill("Loser title from tab two");
    await p1.getByTestId("save-draft").click();
    await p1.waitForURL(/\/admin\/articles\/[0-9a-f-]{36}$/);
    await p2.getByTestId("save-draft").click();
    await expect(p2.getByTestId("editor-notice")).toContainText("Out of date");
    expect(await revisionCount(a.slug)).toBe(2);
    const row = await articleRow(a.slug);
    expect(row.review_state).toBe("draft");
    await p2.getByRole("button", { name: "Reload" }).click();
    await expect(p2.getByLabel("Title", { exact: true })).toHaveValue("Winner title from tab one");
    await ctx.close();
  });

  test("Markdown is rendered safely: no raw HTML, scripts, images or non-https links reach the DOM", async ({ page }) => {
    const ed = await newUser("md");
    await makeStaff(ed, "Editor");
    await enterAdmin(page, ed);
    const a = await createDraft(page, { body: "# Heading\n\n[good](https://example.com/ok) and [bad](ftp://example.com/x) and ![img](https://example.com/x.png)\n\n```\ncode block stays text\n```" });
    const body = page.getByTestId("article-body");
    await expect(body.locator("h1")).toHaveText("Heading");
    await expect(body.locator("a[href='https://example.com/ok']")).toHaveAttribute("rel", "noopener noreferrer nofollow ugc");
    await expect(body.locator("a[href^='ftp:'], img, script, iframe")).toHaveCount(0);
    await expect(body.locator("pre")).toContainText("code block stays text");
    expect(a.slug.length).toBeGreaterThan(3);
  });
});

async function createDraftExpectError(page: import("@playwright/test").Page, slug: string): Promise<void> {
  await page.goto("/admin/articles/new");
  await page.getByLabel("Slug (permanent)", { exact: true }).fill(slug);
  await page.getByLabel("Title", { exact: true }).fill("Attempted duplicate");
  await page.getByLabel("Summary", { exact: true }).fill("A summary that is certainly long enough to pass.");
  await page.getByLabel("Markdown", { exact: true }).fill("dup");
  await page.getByTestId("save-draft").click();
  await expect(page.getByText("This slug is already reserved by another article.")).toBeVisible();
  void uniqueSlug;
}
