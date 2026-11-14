import { expect, test } from "@playwright/test";

/**
 * ADM-UI-PREVIEW-01: in a NORMAL production build (this suite's server), the synthetic Admin preview does not exist at any path.
 * (The build-output scan in scripts/check-admin-preview-isolation.mjs proves the code is not even compiled in.)
 */
test.describe("Admin UI preview is absent from a normal build", () => {
  for (const path of ["/admin-preview", "/admin-preview/", "/admin-preview/articles", "/admin-preview/staff/st-selene", "/admin-preview/settings", "/admin-preview/api/session"]) {
    test(`GET ${path} -> 404`, async ({ request }) => {
      const r = await request.get(path);
      expect(r.status()).toBe(404);
      expect(r.headers()["x-robots-tag"]).toContain("noindex");
      expect(await r.text()).not.toMatch(/ISOLATED PREVIEW|Sign in to the Admin preview/);
    });
  }
  test("no request header can enable it at runtime (the build flag is a compile-time constant)", async ({ request }) => {
    const r = await request.get("/admin-preview", { headers: { "x-admin-preview": "isolated-synthetic" } });
    expect(r.status()).toBe(404);
  });
  test("the existing /admin entry point is unchanged and never shows the preview", async ({ request }) => {
    const r = await request.get("/admin");
    expect(await r.text()).not.toContain("DEMO / ISOLATED PREVIEW");
  });
});
