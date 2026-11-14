import { expect, test } from "@playwright/test";

const PORT = Number(process.env.ADMIN_PREVIEW_PORT ?? 3300);
const CLOSED = `http://localhost:${PORT + 2}`;
const BACKEND = `http://localhost:${PORT + 3}`;
const MAIN = `http://localhost:${PORT}`;

test.describe("preview runtime isolation (fail closed)", () => {
  test("the preview build refuses to serve when its runtime flag is absent", async ({ request }) => {
    for (const path of ["/admin-preview", "/admin-preview/articles", "/admin-preview/settings"]) {
      const r = await request.get(`${CLOSED}${path}`);
      expect(r.status(), path).toBe(404);
      expect(await r.text()).not.toContain("Admin");
    }
  });

  test("a backend/database configuration present in the environment closes the preview", async ({ request }) => {
    const r = await request.get(`${BACKEND}/admin-preview`);
    expect(r.status()).toBe(404);
  });

  test("a non-loopback Host header is refused, and encoded or re-cased spellings of the path are still guarded", async ({ request }) => {
    expect((await request.get(`${MAIN}/admin-preview`, { headers: { host: "preview.example.test" } })).status()).toBe(404);
    for (const p of ["/%61dmin-preview", "/ADMIN-PREVIEW", "/admin-preview%2Farticles"]) {
      const r = await request.post(`${MAIN}${p}`, { data: {} });
      expect([404, 405], p).toContain(r.status());
    }
  });

  test("the correctly isolated preview is private, uncached, not indexable and has no API surface", async ({ request, page }) => {
    const r = await request.get(`${MAIN}/admin-preview`);
    expect(r.status()).toBe(200);
    expect(r.headers()["cache-control"]).toContain("no-store");
    expect(r.headers()["x-robots-tag"]).toContain("noindex");
    expect(r.headers()["content-security-policy"]).toContain("script-src 'self' 'nonce-");
    expect(r.headers()["set-cookie"]).toBeUndefined();
    for (const p of ["/admin-preview/api", "/admin-preview/api/session", "/admin-preview/api/anything"]) {
      const a = await request.post(`${MAIN}${p}`, { data: {} });
      expect(a.status(), `POST ${p}`).toBe(405);
      expect(a.headers()["set-cookie"]).toBeUndefined();
    }
    await page.goto(`${MAIN}/admin-preview`);
    await expect(page.locator('meta[name="robots"]').first()).toHaveAttribute("content", /noindex/);
    expect(await page.context().cookies()).toEqual([]);
    await expect(page.getByRole("banner")).toHaveCount(0);
    await expect(page.getByText("Skip to content")).toHaveCount(0);
  });

  test("the preview's client bundle carries no environment value, secret or production endpoint", async ({ request, page }) => {
    const scripts: string[] = [];
    page.on("response", (res) => { if (res.url().includes("/_next/static/") && res.url().endsWith(".js")) scripts.push(res.url()); });
    await page.goto(`${MAIN}/admin-preview`);
    await page.getByRole("heading", { name: "Sign in to the Admin preview" }).waitFor();
    expect(scripts.length).toBeGreaterThan(0);
    const FORBIDDEN = [/service_role/i, /SUPABASE_[A-Z_]+/, /postgres(ql)?:\/\//i, /sb_secret_/, /sb_publishable_/, /klxhikdlfwgxurdyexdi/, /\/auth\/v1\//, /\/rest\/v1/, /AZERDEX_READ_DB_URL/, /ACCOUNT_AUTH/];
    for (const url of scripts) {
      const body = await (await request.get(url)).text();
      for (const re of FORBIDDEN) expect(re.test(body), `${url} matched ${re}`).toBe(false);
    }
  });

  test("every network request made while using the preview is a same-origin GET for the document or a static asset", async ({ page }) => {
    const seen: { method: string; url: string }[] = [];
    page.on("request", (r) => seen.push({ method: r.method(), url: r.url() }));
    await page.goto(`${MAIN}/admin-preview`);
    await page.getByLabel("Act as synthetic persona (preview-only)").selectOption("st-selene");
    await page.goto(`${MAIN}/admin-preview/articles`);
    await page.getByRole("link", { name: "Blue post digest: week 46" }).click();
    await page.getByTestId("act-publish").click();
    await page.getByRole("button", { name: "Queue publication" }).click();
    await page.getByTestId("sim-receipt").click();
    expect(seen.filter((r) => r.method !== "GET")).toEqual([]);
    expect(seen.filter((r) => !r.url.startsWith(MAIN))).toEqual([]);
    expect(seen.filter((r) => /\/api\/|\/account\/api|\/admin\/api/.test(r.url))).toEqual([]);
  });
});
