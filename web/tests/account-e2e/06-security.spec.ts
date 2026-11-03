import { expect, test } from "@playwright/test";
import { uniqueIp } from "../account/helpers";
import { cookieOf, csrfToken, json, newClient, post, setCookies } from "../account/helpers";
import { companionWithInstallation, link, loginAgain, startClaim, webUser } from "./world";
import { admin, anonymous, ingest, ownerOf, snapshot, uniq } from "./stack";
import type pg from "pg";

/** CSRF, XSS, redirect and account-isolation checks for the NEW private routes and pages, against the real stack. */
let db: pg.Client;
test.beforeAll(async () => { db = await admin(); });
test.afterAll(async () => { await db.end(); });

const PRIVATE_POSTS = [
  ["/account/api/link", { code: "0123456789ABCDEF0123456789ABCDEF", password: "x", confirm: true, accountId: "00000000-0000-4000-8000-000000000000" }],
] as const;
// (The retired Guildbook routes are deny-by-default 404 stubs without authentication or CSRF handling: they are not part of this matrix;
// 01, 02 and the header test below pin that they answer 404 and carry the account zone's private headers.)

test("CSRF / Origin / Fetch-Metadata / content-type matrix on every private POST route: each protection alone is enough to refuse", async ({ playwright }) => {
  const a = await webUser(playwright, "csrf");
  const other = await webUser(playwright, "csrfO");
  const comp = await companionWithInstallation();
  const code = await startClaim(comp);
  for (const [path, body] of PRIVATE_POSTS) {
    const real = path === "/account/api/link" ? { ...body, code, password: a.password, accountId: a.uid } : body;
    const cases: [string, Parameters<typeof post>[3], number][] = [
      ["no CSRF token", { csrf: "none" }, 403],
      ["garbage CSRF token", { csrf: "v1.AAAAAAAAAAAAAAAA.9999999999.AAAA" }, 403],
      ["token minted for ANOTHER user's session", { csrf: await csrfToken(other.c) }, 403],
      ["foreign Origin", { origin: "https://evil.example" }, 403],
      ["Origin 'null'", { origin: "null" }, 403],
      ["cross-site Fetch-Metadata", { fetchSite: "cross-site" }, 403],
      ["same-site (sibling) Fetch-Metadata", { fetchSite: "same-site" }, 403],
      ["no Origin and no Fetch-Metadata", { origin: null, fetchSite: null }, 403],
      ["form-encoded body", { contentType: "application/x-www-form-urlencoded", raw: "code=1&password=x" }, 403],
      ["text/plain body", { contentType: "text/plain", raw: JSON.stringify(real) }, 403],
    ];
    for (const [label, opts, want] of cases) {
      const r = await post(a.c, path, real, opts);
      expect(r.status(), `${path}: ${label}`).toBe(want);
    }
    // a token minted BEFORE sign-in (bound to "anon") does not work on an authenticated route
    const preLogin = await newClient(playwright);
    const anonToken = await csrfToken(preLogin);
    expect((await post(a.c, path, real, { csrf: anonToken })).status(), `${path}: pre-login token`).toBe(403);
  }
  // nothing happened through any of those
  expect(await ownerOf(db, comp.installationId)).toBe(comp.id.uid);
  // methods: the private POST routes are POST-only, the installation list GET-only
  for (const [path] of PRIVATE_POSTS) for (const m of ["get", "put", "delete", "patch"] as const) expect([404, 405], `${m} ${path}`).toContain((await a.c[m](path)).status());
  for (const m of ["post", "put", "delete"] as const) expect((await a.c[m]("/account/api/installations", { headers: { origin: "http://localhost:3210", "content-type": "application/json" }, data: "{}" })).status()).toBe(405);
  // a malformed/oversized/array body is a 400/413, never a 500
  const big = await a.c.post("/account/api/link", { headers: { "content-type": "application/json", origin: "http://localhost:3210", "sec-fetch-site": "same-origin", "x-fdb-csrf": await csrfToken(a.c) }, data: JSON.stringify({ code: "x".repeat(10_000), password: "y", confirm: true }) });
  expect([400, 413]).toContain(big.status());
  for (const raw of ["[]", "null", '"s"', "{", ""]) {
    const r = await post(a.c, "/account/api/link", null, { raw });
    expect(r.status(), raw).toBeLessThan(500);
    expect(r.status()).toBeGreaterThanOrEqual(400);
  }
  // the CSRF protection also covers a REAL code: with the right password but no token, nothing is redeemed
  const fresh = await loginAgain(playwright, a); // (the per-address edge budget of the first browser is spent by the matrix above)
  expect((await post(fresh.c, "/account/api/link", { code, password: a.password, confirm: true, accountId: a.uid }, { csrf: "none" })).status()).toBe(403);
  expect(await ownerOf(db, comp.installationId)).toBe(comp.id.uid);
});

test("every private route and page: private no-store, noindex, path-hiding referrer policy, API CSP; no cookie beyond session/CSRF; no account-data caching", async ({ playwright }) => {
  const a = await webUser(playwright, "hdr");
  const comp = await companionWithInstallation();
  expect((await link(a.c, await startClaim(comp), a.password)).status()).toBe(200);
  const responses = [
    await a.c.get("/account/link"), await a.c.get("/account/installations"), await a.c.get("/account/guildbook"), await a.c.get("/account/api/installations"),
    await post(a.c, "/account/api/guildbook/guilds", { installationId: comp.installationId }),
    await post(a.c, "/account/api/guildbook/members", { installationId: comp.installationId, guildKey: "Realm:Guild1", page: 0 }),
    await post(a.c, "/account/api/link", { code: "0123456789ABCDEF0123456789ABCDEF", password: "nope nope nope", confirm: true, accountId: a.uid }),
  ];
  for (const r of responses) {
    const h = r.headers();
    expect(h["cache-control"], r.url()).toBe("private, no-store");
    expect(h["x-robots-tag"], r.url()).toBe("noindex, nofollow");
    expect(h["referrer-policy"], r.url()).toBe(r.url().includes("/account/api/") ? "no-referrer" : "strict-origin");
    expect(h["x-content-type-options"], r.url()).toBe("nosniff");
    expect(h["access-control-allow-origin"], r.url()).toBeUndefined();
    expect(setCookies(r).map((c) => c.name).filter((n) => !/^(fdb_acct(\.\d)?|fdb_csrf)$/.test(n)), r.url()).toEqual([]);
    if (r.url().includes("/account/api/")) expect(h["content-security-policy"], r.url()).toMatch(/default-src 'none'/);
  }
  // CORS: a cross-origin preflight is never granted
  const pre = await a.c.fetch("/account/api/link", { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
  expect(pre.headers()["access-control-allow-origin"]).toBeUndefined();
  // robots / sitemap never advertise the private pages
  expect(await (await a.c.get("/robots.txt")).text()).not.toMatch(/guildbook|installations|\/account\/link/);
  expect(await (await a.c.get("/sitemap.xml")).text()).not.toMatch(/guildbook|installations|\/account\/link/);
  // the public loot site never receives the account cookie path (cookie is Path=/account)
  const ck = await cookieOf(a.c);
  expect((await a.c.storageState()).cookies.find((c) => c.name === ck!.name)!.path).toBe("/account");
});

test("redirect allowlist: the new pages are valid return paths, everything else falls back to /account", async ({ playwright }) => {
  const users = [await webUser(playwright, "redir1"), await webUser(playwright, "redir2")]; // (sign-ins are throttled per address: 10 / 15 min)
  const cases: [string, string][] = [
    ["/account/link", "/account/link"], ["/account/installations", "/account/installations"], ["/account/guildbook", "/account"],
    ["/account/link?code=ABCDEF0123456789ABCDEF0123456789", "/account/link"], ["/account/link#x", "/account/link"],
    ["//evil.example/account/link", "/account"], ["https://evil.example", "/account"], ["/\\evil.example", "/account"], ["/account/link/../../admin", "/account"],
    ["/account/linkx", "/account"], ["/account/%2e%2e/api/me", "/account"], ["%2F%2Fevil.example", "/account"], ["/account/guildbook/", "/account"],
  ];
  for (const [i, [next, want]] of cases.entries()) {
    const c = await newClient(playwright);
    const u = users[i % 2]!;
    const r = await post(c, "/account/api/login", { email: u.email, password: u.password, next });
    expect(r.status(), next).toBe(200);
    expect(await json(r), next).toEqual({ ok: true, redirect: want });
  }
  // the unauthenticated page redirect carries only the fixed, allowlisted return path; the retired Guildbook page is not a page at all
  const anonLink = await (await newClient(playwright)).get("/account/link", { maxRedirects: 0 });
  expect(anonLink.headers().location).toBe("/account/login?next=%2Faccount%2Flink");
  expect((await (await newClient(playwright)).get("/account/guildbook", { maxRedirects: 0 })).status()).toBe(404);
});

test("XSS: hostile guild text an old Companion still uploads is dropped by the server and nothing of it can reach the website (the installation page renders inert)", async ({ browser, playwright }) => {
  const a = await webUser(playwright, "xss");
  const id = await anonymous();
  const installationId = uniq("xss");
  const evil = `<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>`;
  const snap = snapshot(installationId, { guilds: 1, members: 3, tag: "XS" });
  snap.guilds[0]!.name = `Guild ${evil}`;
  snap.guilds[0]!.realmName = `Realm ${evil}`;
  for (const m of snap.guilds[0]!.members) { m.name = `N${m.name}${evil}`.slice(0, 48); m.zone = `Zone ${evil}`; m.rankName = `Rank ${evil}`; }
  const r = await ingest(id.token, snap);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  // migration 0018 drops the Guildbook before the legacy ingest: no guild, member or profession row exists for the installation
  expect((await db.query("select count(*)::int n from public.installation_guilds where installation_id = $1", [installationId])).rows[0].n).toBe(0);
  expect((await db.query("select count(*)::int n from public.installation_guild_members where installation_id = $1", [installationId])).rows[0].n).toBe(0);
  const code = (await (await import("./stack")).rpc(id.token, "fdb_account_claim_start", { p_installation_id: installationId })).body.code as string;
  expect((await link(a.c, code, a.password)).status()).toBe(200);

  const ctx = await browser.newContext({ baseURL: "http://localhost:3210", extraHTTPHeaders: { "x-forwarded-for": uniqueIp() } });
  await ctx.addCookies((await a.c.storageState()).cookies);
  const page = await ctx.newPage();
  const violations: string[] = [];
  page.on("console", (m) => { if (/Content Security Policy|CSP violation/i.test(m.text())) violations.push(m.text()); });
  expect((await page.goto("/account/guildbook"))?.status()).toBe(404);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  await page.goto("/account/installations");
  await expect(page.getByText(installationId)).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  expect(await page.locator("main img, main script").count()).toBe(0);
  expect(await page.content()).not.toContain("<img src=x");
  await ctx.close();
  expect(await ownerOf(db, installationId)).toBe(a.uid);
});
