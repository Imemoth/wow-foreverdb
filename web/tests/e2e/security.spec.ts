import { expect, test } from "./fixtures";

test("HTML responses carry a nonce CSP and every script is nonce'd", async ({ page }) => {
  const res = await page.goto("/item/2770");
  const h = res!.headers();
  const csp = h["content-security-policy"]!;
  expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
  expect(csp).toContain("frame-ancestors 'none'");
  expect(h["x-content-type-options"]).toBe("nosniff");
  expect(h["x-frame-options"]).toBe("DENY");
  expect(h["cache-control"]).toContain("private");
  const nonce = /'nonce-([^']+)'/.exec(csp)![1];
  const scripts = await page.locator("script").evaluateAll((els) => els.map((e) => (e as HTMLScriptElement).nonce));
  expect(scripts.length).toBeGreaterThan(0);
  for (const n of scripts) expect(n).toBe(nonce);
  const html = await (await page.request.get("/item/2770")).text();
  expect(html).not.toMatch(/x-powered-by/i);
});

test("no CSP violations or console errors on key pages", async ({ page }) => {
  const problems: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") problems.push(m.text()); });
  page.on("pageerror", (e) => problems.push(e.message));
  for (const p of ["/", "/database?q=copper", "/item/2770", "/creature/1554", "/zone/1420", "/guides/mining-copper-in-tirisfal"]) {
    await page.goto(p, { waitUntil: "networkidle" });
  }
  expect(problems).toEqual([]);
});

test("reflected XSS attempts are rendered inert", async ({ page }) => {
  let dialog = false;
  page.on("dialog", async (d) => { dialog = true; await d.dismiss(); });
  await page.goto(`/database?q=${encodeURIComponent('"><img src=x onerror=alert(1)>')}`);
  await page.goto(`/zone/1420?q=${encodeURIComponent("<script>alert(1)</script>")}`);
  expect(dialog).toBe(false);
  expect(await page.locator("img[src=x]").count()).toBe(0);
});

test("API: strict validation, no cookies on cacheable responses, generic errors", async ({ request }) => {
  const okRes = await request.get("/api/v1/search?q=copper");
  expect(okRes.status()).toBe(200);
  expect(okRes.headers()["cache-control"]).toContain("s-maxage");
  expect(okRes.headers()["set-cookie"]).toBeUndefined();
  const body = await okRes.json();
  expect(body.dataset).toBe(process.env.FOREVERDB_DATA_SOURCE === "postgres" ? "published" : "synthetic-sample");
  expect(JSON.stringify(body)).not.toMatch(/installation|owner|guild/i);

  for (const [url, code] of [
    ["/api/v1/search?q=copper&table=items", 400],
    ["/api/v1/search?q=%25", 400],
    ["/api/v1/search", 400],
    ["/api/v1/search?q=copper&limit=500", 400],
    ["/api/v1/item/0", 400],
    ["/api/v1/item/1;drop", 400],
    ["/api/v1/source/installation/1", 400],
    ["/api/v1/source/creature/999999", 404],
  ] as const) {
    const r = await request.get(url);
    expect(r.status(), url).toBe(code);
    expect(r.headers()["cache-control"]).toBe("no-store");
    expect(await r.text()).not.toMatch(/stack|at \/|postgres|Error:/);
  }
  expect((await request.post("/api/v1/search?q=copper")).status()).toBe(405);
  expect((await request.delete("/api/v1/item/2770")).status()).toBe(405);
});

test("challenge endpoint is closed when not configured and rejects cross-site posts", async ({ request }) => {
  const r = await request.post("/api/v1/challenge", { data: { token: "x".repeat(20) }, headers: { origin: "https://evil.example" } });
  expect([403, 404]).toContain(r.status());
});

test("rate limiting returns 429 with Retry-After after the per-client budget", async ({ playwright, baseURL }) => {
  const ctx = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": "203.0.113.77" } });
  const statuses: number[] = [];
  for (let i = 0; i < 14; i++) statuses.push((await ctx.get(`/api/v1/search?q=tin${i % 2 ? "" : " ore"}`)).status());
  expect(statuses.slice(0, 12).every((s) => s === 200)).toBe(true);
  const limited = await ctx.get("/api/v1/search?q=tin");
  expect(limited.status()).toBe(429);
  expect(Number(limited.headers()["retry-after"])).toBeGreaterThan(0);
  expect(limited.headers()["cache-control"]).toBe("no-store");
  expect((await limited.json()).error).toBe("rate_limited");
  // A different client is unaffected.
  const other = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { "x-forwarded-for": "203.0.113.78" } });
  expect((await other.get("/api/v1/search?q=tin")).status()).toBe(200);
  await ctx.dispose();
  await other.dispose();
});
