import { expect, test } from "@playwright/test";
import { aal2Token, createDraft, enterAdmin, makeStaff, newUser, rest, sessionIdsOf, db } from "./fixtures";

test.describe("authentication and permission denial (real ADM-01B boundary)", () => {
  test("an anonymous visitor gets no Admin; the action API refuses without a session", async ({ page, request }) => {
    await page.goto("/admin");
    await expect(page.getByTestId("admin-denied")).toBeVisible();
    for (const p of ["/admin/articles", "/admin/audit", "/admin/articles/new"]) {
      await page.goto(p);
      await expect(page.getByTestId("admin-denied")).toBeVisible();
      await expect(page.getByTestId("article-table")).toHaveCount(0);
    }
    const r = await request.post("/admin/api/cms/create", { data: {}, headers: { origin: "http://localhost:3220" } });
    expect([401, 403]).toContain(r.status());
    const csrf = await request.get("/admin/api/csrf");
    expect([401, 403, 404]).toContain(csrf.status());
    // no public API exposes anything private
    for (const p of ["/news/rss.xml", "/sitemap.xml"]) expect(await (await request.get(p)).text()).not.toMatch(/draft|editorial_private/i);
  });

  test("an ordinary (non-staff) account completes real TOTP but is refused entry to Admin", async ({ page }) => {
    const u = await newUser("ordinary");
    await page.goto("/account/login");
    await page.getByLabel("Email address").fill(u.email);
    await page.getByLabel("Password").fill(u.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/account(\?|$)/);
    const panel = page.getByRole("region", { name: "Admin authentication" });
    await panel.getByRole("button", { name: "Enroll TOTP" }).click();
    await expect(panel.locator("code")).toBeVisible();
    await page.goto("/admin");
    await expect(page.getByTestId("admin-denied")).toBeVisible();
  });

  test("a staff member with admin.enter only (Moderator) can open Admin but cannot create or act; a forced request is denied by the database", async ({ page }) => {
    const m = await newUser("moderator");
    await makeStaff(m, "Moderator");
    await enterAdmin(page, m);
    // Entry is allowed, but with no CMS permission at all the database denies even the context read: the UI shows a denial, never an empty CMS.
    await expect(page.getByTestId("read-failure")).toHaveAttribute("data-kind", "denied");
    await expect(page.getByTestId("dash-tiles")).toHaveCount(0);
    for (const p of ["/admin/articles", "/admin/articles/new", "/admin/audit"]) {
      await page.goto(p);
      await expect(page.getByTestId("save-draft")).toHaveCount(0);
      await expect(page.getByTestId("article-table")).toHaveCount(0);
    }
    // Force the call anyway through the real action endpoint with a real CSRF token.
    const csrf = (await (await page.request.get("/admin/api/csrf")).json()).token as string;
    const res = await page.request.post("/admin/api/cms/create", {
      headers: { "x-fdb-csrf": csrf, origin: "http://localhost:3220", "content-type": "application/json" },
      data: { requestId: crypto.randomUUID(), slug: "forced-by-moderator", snapshot: { title: "Forced title", summary: "A forced summary that is long enough.", body_markdown: "x", classification: "normal" } },
    });
    expect(res.status()).toBe(403);
    expect((await res.json()).error).toMatchObject({ kind: "denied" });
    const c = await db();
    try { expect((await c.query("select count(*)::int n from editorial_private.articles where slug='forced-by-moderator'")).rows[0].n).toBe(0); } finally { await c.end(); }
  });

  test("the action endpoint enforces CSRF, JSON, origin, strict input and unknown actions", async ({ page }) => {
    const e = await newUser("csrf-editor");
    await makeStaff(e, "Editor");
    await enterAdmin(page, e);
    const body = { requestId: crypto.randomUUID(), slug: "csrf-probe", snapshot: { title: "Probe title", summary: "A probe summary that is long enough.", body_markdown: "x", classification: "normal" } };
    const base = { origin: "http://localhost:3220", "content-type": "application/json" };
    expect((await page.request.post("/admin/api/cms/create", { headers: base, data: body })).status()).toBe(403); // no CSRF header
    expect((await page.request.post("/admin/api/cms/create", { headers: { ...base, "x-fdb-csrf": "v1.forged.1.AAAA" }, data: body })).status()).toBe(403);
    const csrf = (await (await page.request.get("/admin/api/csrf")).json()).token as string;
    expect((await page.request.post("/admin/api/cms/create", { headers: { ...base, origin: "https://evil.example", "x-fdb-csrf": csrf }, data: body })).status()).toBe(403);
    expect((await page.request.post("/admin/api/cms/create", { headers: { "x-fdb-csrf": csrf, origin: base.origin, "content-type": "text/plain" }, data: JSON.stringify(body) })).status()).toBeGreaterThanOrEqual(400);
    expect((await page.request.post("/admin/api/cms/drop_everything", { headers: { ...base, "x-fdb-csrf": csrf }, data: {} })).status()).toBe(404);
    const withActor = await page.request.post("/admin/api/cms/create", { headers: { ...base, "x-fdb-csrf": csrf }, data: { ...body, actor: "00000000-0000-4000-8000-000000000001" } });
    expect(withActor.status()).toBe(422);
    const rawHtml = await page.request.post("/admin/api/cms/create", { headers: { ...base, "x-fdb-csrf": csrf }, data: { ...body, snapshot: { ...body.snapshot, body_markdown: "<script>alert(1)</script>" } } });
    expect(rawHtml.status()).toBe(422);
    expect((await page.request.get("/admin/api/cms/create")).status()).toBe(405);
  });

  test("private CMS tables and functions are not reachable by any browser-held token (no direct PostgREST access)", async () => {
    const e = await newUser("direct-editor");
    await makeStaff(e, "Editor");
    const token = await aal2Token(e);
    for (const path of ["articles", "editorial_private.articles", "revisions", "admin_private.staff_subjects", "delivery_outbox"]) {
      const r = await rest(token, path);
      expect([401, 403, 404], `${path} -> ${r.status}`).toContain(r.status);
    }
    for (const fn of ["editorial_actor", "append_editorial_audit", "cms_dispatch_claim"]) {
      const r = await rest(token, `rpc/${fn}`, { method: "POST", body: {} });
      expect([401, 403, 404], `${fn} -> ${r.status}`).toContain(r.status);
    }
    // the same token CAN use the narrow, audited public functions
    expect((await rest(token, "rpc/fdb_cms_context", { method: "POST", body: {} })).status).toBe(200);
    // an anonymous caller cannot
    expect((await rest(null, "rpc/fdb_cms_context", { method: "POST", body: {} })).status).toBeGreaterThanOrEqual(401);
  });

  test("Staff & Roles is informational: every management control is disabled and no management API exists", async ({ page, request }) => {
    const e = await newUser("staff-view");
    await makeStaff(e, "Editor");
    await enterAdmin(page, e);
    await page.goto("/admin/staff");
    const buttons = page.getByTestId("staff-actions").getByRole("button");
    expect(await buttons.count()).toBeGreaterThanOrEqual(5);
    for (let i = 0; i < (await buttons.count()); i++) await expect(buttons.nth(i)).toBeDisabled();
    for (const p of ["staff", "roles", "grants", "invite"]) expect((await request.post(`/admin/api/${p}`, { data: {} })).status()).toBeGreaterThanOrEqual(404);
  });

  test("revoked sessions and expired grants lock the UI out at the next request", async ({ browser }) => {
    // session revoked at Auth (GoTrue deletes the session) -> the live check fails
    const a = await newUser("revoked-session");
    await makeStaff(a, "Editor");
    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    await enterAdmin(pageA, a);
    await createDraft(pageA);
    const c = await db();
    try {
      for (const sid of await sessionIdsOf(a.uid)) await c.query("delete from auth.sessions where id=$1", [sid]);
    } finally { await c.end(); }
    await pageA.goto("/admin/articles");
    await expect(pageA.getByTestId("admin-denied")).toBeVisible();
    await ctxA.close();

    // grant expired in the database -> admin entry and every CMS call are refused (fail closed)
    const b = await newUser("expired-grant");
    await makeStaff(b, "Editor");
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await enterAdmin(pageB, b);
    await createDraft(pageB);
    const c2 = await db();
    try {
      await c2.query("alter table admin_private.role_assignments disable trigger all");
      await c2.query("update admin_private.role_assignments set starts_at=clock_timestamp()-interval '2 days', expires_at=clock_timestamp()-interval '1 second' where user_id=$1", [b.uid]);
      await c2.query("alter table admin_private.role_assignments enable trigger all");
    } finally { await c2.end(); }
    await pageB.goto("/admin/articles");
    await expect(pageB.getByTestId("admin-denied")).toBeVisible();
    await ctxB.close();
  });
});
