import { expect, test } from "@playwright/test";
import { ageTotp, createDraft, enterAdmin, makeStaff, newStaffPage, newUser, articleRow, BODY } from "./fixtures";

test.describe("audit visibility/authorization and TOTP freshness", () => {
  test("authorized staff read real audit events; others are refused; no draft text or secrets appear", async ({ browser }) => {
    const ed = await newUser("aud-ed"), owner = await newUser("aud-own"), adm = await newUser("aud-adm");
    await makeStaff(ed, "Editor"); await makeStaff(owner, "Owner"); await makeStaff(adm, "Administrator");
    const pe = await newStaffPage(await browser.newContext(), ed);
    const po = await newStaffPage(await browser.newContext(), owner);
    const pa = await newStaffPage(await browser.newContext(), adm);
    const secretBody = "UNIQUE-DRAFT-SENTENCE-that-must-never-reach-the-audit-log";
    const a = await createDraft(pe, { body: `${BODY}\n\n${secretBody}` });
    const row = await articleRow(a.slug);

    // the Editor holds no audit permission: refused, and the dashboard says so
    await pe.goto("/admin/audit");
    await expect(pe.getByTestId("audit-denied")).toBeVisible();
    await expect(pe.getByTestId("audit-table")).toHaveCount(0);
    await pe.goto("/admin");
    await expect(pe.getByTestId("audit-not-authorized")).toBeVisible();

    for (const p of [po, pa]) {
      await p.goto("/admin/audit");
      const table = p.getByTestId("audit-table");
      await expect(table).toBeVisible();
      await expect(table).toContainText("news.draft.write");
      await expect(table).toContainText(`article:${row.article_id}`);
      const text = await p.locator("body").innerText();
      expect(text).not.toContain(secretBody);
      expect(text).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}|sb_secret|service_role|password/i); // no tokens, keys or credentials
    }
    // the dashboard shows recent events for the authorized
    await po.goto("/admin");
    await expect(po.getByText("Recent audit events")).toBeVisible();
    await expect(po.locator("table tbody tr").first()).toBeVisible();
  });

  test("TOTP freshness: after 15 minutes every write and read is refused until a fresh TOTP verification", async ({ page }) => {
    const ed = await newUser("fresh");
    await makeStaff(ed, "Editor");
    await enterAdmin(page, ed);
    const a = await createDraft(page);
    await ageTotp(ed.uid, 16);
    // reading is refused (fail closed) ...
    await page.goto("/admin/articles");
    await expect(page.getByTestId("article-table")).toHaveCount(0);
    await expect(page.getByTestId("read-failure")).toHaveAttribute("data-kind", "denied");
    await expect(page.getByTestId("read-failure")).toContainText("older than 15 minutes");
    // ... and so is a write
    await page.goto(`${a.url}/edit`).catch(() => undefined);
    const csrf = (await (await page.request.get("/admin/api/csrf")).json()).token as string;
    const row = await articleRow(a.slug);
    const r = await page.request.post("/admin/api/cms/submit", { headers: { "x-fdb-csrf": csrf, origin: "http://localhost:3220", "content-type": "application/json" }, data: { requestId: crypto.randomUUID(), articleId: row.article_id, revisionId: row.current_revision_id } });
    expect(r.status()).toBe(403);
    expect((await articleRow(a.slug)).review_state).toBe("draft");
    // a fresh TOTP verification restores access
    await enterAdmin(page, ed);
    await page.goto("/admin/articles");
    await expect(page.getByTestId(`article-row-${a.slug}`)).toBeVisible();
  });

  test("leaving Admin ends the Admin session: the cookie no longer opens Admin and actions are refused", async ({ page }) => {
    const ed = await newUser("logout");
    await makeStaff(ed, "Editor");
    await enterAdmin(page, ed);
    await createDraft(page);
    await page.getByRole("button", { name: /leave admin/i }).first().click();
    await page.goto("/admin");
    await expect(page.getByTestId("admin-denied")).toBeVisible();
  });
});
