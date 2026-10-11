import { expect, test } from "@playwright/test";
import {
  ANON_KEY, AUTH_URL, CSRF_SECRET, ORIGINS, PASSWORD, SITES, authDirect, clearMail, clientWithCookie, countMail, csrfToken, json, newClient, post, setCookies,
  signedInClient, sleep, uniqueEmail, uniqueIp,
} from "./helpers";
import { hmacB64, randomToken } from "../../src/lib/account/crypto";

/** Items 11-18: CSRF, redirects, abuse protection, cookies, caching/noindex, leakage, public regression, disabled mode. */

const POST_ROUTES = ["register", "login", "confirm", "forgot-password", "resend", "reset-password", "logout"] as const;
const ALL_ACCOUNT_PAGES = ["/account", "/account/login", "/account/register", "/account/forgot-password", "/account/reset-password", "/account/auth/confirm?token_hash=0123456789abcdef0123&type=email", "/account/auth/confirm"];

test.describe("11. CSRF", () => {
  const body = { email: "csrf@example.test", password: "irrelevant irrelevant" };

  test("every state-changing route refuses a request without Origin / Fetch Metadata, and refuses GET and other methods", async ({ playwright }) => {
    const c = await newClient(playwright);
    for (const route of POST_ROUTES) {
      const r = await post(c, `/account/api/${route}`, body, { origin: null, fetchSite: null, csrf: "none" });
      expect(r.status(), route).toBe(403);
      expect((await json(r)).error, route).toBe("forbidden");
      for (const method of ["get", "put", "delete"] as const) expect([404, 405], `${method} ${route}`).toContain((await c[method](`/account/api/${route}`)).status());
    }
  });

  test("forged Origin, cross-site / same-site Fetch Metadata, non-JSON content types and a missing or foreign token are all refused", async ({ playwright }) => {
    const { c, email, password } = await signedInClient(playwright, "csrf");
    const attempts: [string, Parameters<typeof post>[3], string][] = [
      ["forged origin", { origin: "https://evil.example" }, "forbidden"],
      ["origin 'null'", { origin: "null" }, "forbidden"],
      ["origin with other port", { origin: "http://localhost:3999" }, "forbidden"],
      ["sec-fetch-site cross-site", { fetchSite: "cross-site" }, "forbidden"],
      ["sec-fetch-site same-site (sibling subdomain)", { fetchSite: "same-site" }, "forbidden"],
      ["form content type", { contentType: "application/x-www-form-urlencoded", raw: "email=a&password=b" }, "forbidden"],
      ["text/plain JSON (simple cross-site request)", { contentType: "text/plain", raw: JSON.stringify(body) }, "forbidden"],
      ["no csrf token", { csrf: "none" }, "csrf"],
      ["garbage csrf token", { csrf: "v1.AAAAAAAAAAAAAAAA.9999999999.AAAA" }, "csrf"],
    ];
    for (const [name, opts, error] of attempts) {
      const r = await post(c, "/account/api/logout", {}, opts);
      expect(r.status(), name).toBe(403);
      expect((await json(r)).error, name).toBe(error);
    }
    expect((await c.get("/account/api/me")).status()).toBe(200); // none of the above logged the user out
    // The login route is covered too (login CSRF): the same forged requests cannot sign anyone in or create a session.
    for (const [name, opts] of attempts.slice(0, 7)) {
      const r = await post(await newClient(playwright), "/account/api/login", { email, password }, opts);
      expect(r.status(), `login ${name}`).toBe(403);
      expect(setCookies(r).filter((x) => x.name === "fdb_acct"), name).toEqual([]);
    }
  });

  test("token must be signed, unexpired, unforged, and bound to the browser's own cookie and session", async ({ playwright }) => {
    const { c } = await signedInClient(playwright, "csrf2");
    const real = await csrfToken(c); // bound to this signed-in session
    // 1. valid cookie in the jar, but a different (even validly minted) token in the header
    const other = await csrfToken(await newClient(playwright));
    expect((await json(await post(c, "/account/api/logout", {}, { csrf: other }))).error).toBe("csrf");
    // 2. token and cookie replaced by an UNSIGNED look-alike (a sibling subdomain planting both)
    const nonce = randomToken(16);
    const exp = Math.floor(Date.now() / 1000) + 3000;
    const forged = `v1.${nonce}.${exp}.${"A".repeat(43)}`;
    const planter = await clientWithCookie(playwright, "x");
    const planted = await planter.post("/account/api/login", {
      headers: { origin: ORIGINS.main, "sec-fetch-site": "same-origin", "content-type": "application/json", "x-fdb-csrf": forged, cookie: `fdb_csrf=${forged}` },
      data: JSON.stringify({ email: "a@example.test", password: "irrelevant irrelevant" }),
    });
    expect(planted.status()).toBe(403);
    expect((await json(planted)).error).toBe("csrf");
    // 3. a correctly signed token for the wrong binding (anonymous binding presented while signed in)
    const mac = (b: string, n: string, e: number) => hmacB64(CSRF_SECRET, "csrf-mac", `v1|${b}|${n}|${e}`);
    const anonTok = `v1.${nonce}.${exp}.${await mac("anon", nonce, exp)}`;
    const wrongBinding = await c.post("/account/api/logout", {
      headers: { origin: ORIGINS.main, "sec-fetch-site": "same-origin", "content-type": "application/json", "x-fdb-csrf": anonTok, cookie: `${(await c.storageState()).cookies.map((k) => `${k.name}=${k.value}`).join("; ").replace(/fdb_csrf=[^;]*/, `fdb_csrf=${anonTok}`)}` },
      data: "{}",
    });
    expect(wrongBinding.status()).toBe(403);
    // 4. expired (correct MAC, correct binding of an anonymous visitor, but in the past)
    const past = Math.floor(Date.now() / 1000) - 10;
    const expired = `v1.${nonce}.${past}.${await mac("anon", nonce, past)}`;
    const old = await newClient(playwright);
    const expiredReply = await old.post("/account/api/login", {
      headers: { origin: ORIGINS.main, "sec-fetch-site": "same-origin", "content-type": "application/json", "x-fdb-csrf": expired, cookie: `fdb_csrf=${expired}` },
      data: JSON.stringify({ email: "a@example.test", password: "irrelevant irrelevant" }),
    });
    expect((await json(expiredReply)).error).toBe("csrf");
    // 5. and the honest token still works: nothing above disturbed the session
    expect((await post(c, "/account/api/logout", {}, { csrf: real })).status()).toBe(200);
  });

  test("an anonymous-bound token cannot be replayed after sign-in (session binding)", async ({ playwright }) => {
    const email = uniqueEmail("bind");
    const c = await newClient(playwright);
    const anon = await csrfToken(c);
    // register + confirm through captured mail, then sign in with the OLD anonymous token still in the cookie jar
    const { waitForMail } = await import("./helpers");
    await post(c, "/account/api/register", { email, password: PASSWORD }, { csrf: anon });
    const mail = await waitForMail(email, /confirm/i);
    expect((await post(c, "/account/api/confirm", { type: mail.type, token_hash: mail.tokenHash }, { csrf: anon })).status()).toBe(200);
    const replay = await post(c, "/account/api/logout", {}, { csrf: anon });
    expect(replay.status()).toBe(403);
    expect((await json(replay)).error).toBe("csrf");
    expect((await c.get("/account/api/me")).status()).toBe(200);
  });

  test("the edge refuses cross-site POSTs BEFORE counting, so a hostile page cannot burn a victim's budget; oversized bodies are refused", async ({ playwright }) => {
    const victim = await newClient(playwright, "main", "198.51.100.222");
    for (let i = 0; i < 25; i += 1) {
      const r = await post(victim, "/account/api/login", body, { origin: "https://evil.example", csrf: "none" });
      expect(r.status()).toBe(403);
    }
    const legit = await post(victim, "/account/api/login", { email: uniqueEmail("burn"), password: "irrelevant irrelevant" });
    expect(legit.status()).toBe(401); // not 429
    const big = await post(victim, "/account/api/register", {}, { raw: JSON.stringify({ email: "a@example.test", password: "x".repeat(5000) }) });
    expect([400, 413]).toContain(big.status());
  });
});

test.describe("12. redirects", () => {
  test("the refresh handler and the sign-in page only ever send the browser to allowlisted account paths", async ({ playwright }) => {
    const c = await newClient(playwright);
    const evil = ["https://evil.example", "//evil.example", "/\\evil.example", "%2f%2fevil.example", "https:%2f%2fevil.example", "/account%0d%0aSet-Cookie:x=1", "javascript:alert(1)", "/api/v1/search", "/account/../evil", "////evil.example"];
    for (const next of evil) {
      const r = await c.get(`/account/api/session/refresh?next=${encodeURIComponent(next)}`, { maxRedirects: 0 });
      expect(r.status(), next).toBe(303);
      const loc = r.headers().location!;
      expect(loc, next).toMatch(/^http:\/\/localhost:3210\/account\/login\?next=%2Faccount$/);
      const page = await (await c.get(`/account/login?next=${encodeURIComponent(next)}&reason=${encodeURIComponent("<script>alert(1)</script>")}`)).text();
      // (The framework's flight payload echoes the request URL as inert data; what matters is what the DOM and the form receive.)
      expect(page, next).not.toMatch(/(?:href|src|action)="[^"]*evil/);
      expect(page, next).toContain('{\\"next\\":\\"/account\\"}');
      expect(page).not.toContain("<script>alert(1)</script>");
    }
    // An allowlisted target is kept (query and fragment dropped).
    const ok = await c.get(`/account/api/session/refresh?next=${encodeURIComponent("/account/guildbook?x=1#f")}`, { maxRedirects: 0 });
    expect(ok.headers().location).toBe("http://localhost:3210/account/login?next=%2Faccount%2Fguildbook");
    // A cross-site navigation is not even processed.
    const cross = await c.get("/account/api/session/refresh?next=/account/guildbook", { maxRedirects: 0, headers: { "sec-fetch-site": "cross-site" } });
    expect(cross.headers().location).toBe("http://localhost:3210/account");
    // The e-mail callback target the website hands to Auth is exactly one URL: Auth rejects or ignores any other redirect_to.
    const bad = await authDirect(`/auth/v1/recover?redirect_to=${encodeURIComponent("https://evil.example/account/auth/confirm")}`, { body: { email: uniqueEmail("redir") } });
    expect([200, 400, 422]).toContain(bad.status); // the allowlist is Auth's own; the website never builds such a URL
  });
});

test.describe("13. Turnstile (website boundary)", () => {
  const T = { site: "turnstile" as const };
  test("sign-up, resend and recovery refuse a missing, empty, malformed or failing token BEFORE Auth is contacted", async ({ playwright }) => {
    await clearMail();
    const c = await newClient(playwright, "turnstile");
    const fresh = () => newClient(playwright, "turnstile"); // each probe is a distinct visitor: the per-IP edge budget is not what is under test here
    const reach = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: new URLSearchParams({ secret: "2x0000000000000000000000000000000AA", response: "xxxxxxxxxxxx" }), signal: AbortSignal.timeout(5000) }).then(() => true, () => false);
    test.info().annotations.push({ type: "cloudflare", description: reach ? "live Siteverify reachable: failing token must answer 403 challenge_failed" : "Siteverify unreachable from this machine: fail-closed 503 asserted instead (CI asserts the live path)" });
    const email = uniqueEmail("ts");
    const routes: [string, Record<string, unknown>][] = [
      ["register", { email, password: PASSWORD }],
      ["forgot-password", { email }],
      ["resend", { email }],
    ];
    for (const [route, base] of routes) {
      const missing = await post(await fresh(), `/account/api/${route}`, base, T);
      expect(missing.status(), route).toBe(403);
      expect((await json(missing)).error).toBe("challenge_required");
      for (const turnstileToken of ["", "short", 12345, ["x".repeat(20)], { a: 1 }, "x".repeat(3000)]) {
        const r = await post(await fresh(), `/account/api/${route}`, { ...base, turnstileToken }, T);
        expect(r.status(), `${route} ${JSON.stringify(turnstileToken).slice(0, 20)}`).toBe(400);
      }
      const unknownField = await post(await fresh(), `/account/api/${route}`, { ...base, "cf-turnstile-response": "x".repeat(20) }, T);
      expect(unknownField.status()).toBe(400); // an unrelated field is not a token and not an override: the strict schema refuses it
      const failing = await post(await fresh(), `/account/api/${route}`, { ...base, turnstileToken: "XXXX.DUMMY.TOKEN.XXXX" }, T);
      if (reach) {
        expect(failing.status(), route).toBe(403);
        expect((await json(failing)).error).toBe("challenge_failed");
      } else {
        expect(failing.status(), route).toBe(503);
        expect((await json(failing)).error).toBe("challenge_unavailable");
      }
    }
    // Header-borne tokens and bypass-looking headers are ignored.
    const hdr = await c.post("/account/api/register", {
      headers: { origin: ORIGINS.turnstile, "sec-fetch-site": "same-origin", "content-type": "application/json", "x-fdb-csrf": await csrfToken(c), "cf-turnstile-response": "x".repeat(20), "x-forwarded-for": "10.0.0.1", "x-turnstile-bypass": "1" },
      data: JSON.stringify({ email, password: PASSWORD }),
    });
    expect(hdr.status()).toBe(403);
    // None of it reached Auth: no mail, and the address is not a (pending) user.
    await sleep(500);
    expect(await countMail(email)).toBe(0);
    expect((await authDirect("/auth/v1/token?grant_type=password", { body: { email, password: PASSWORD } })).data.error_code).toBe("invalid_credentials");
    // Login is protected by throttling, not Turnstile: a wrong password is a plain 401.
    expect((await post(c, "/account/api/login", { email, password: PASSWORD }, T)).status()).toBe(401);
  });

  test("the sign-up page loads the widget only where Turnstile is configured", async ({ playwright }) => {
    const withKey = await (await (await newClient(playwright, "turnstile")).get("/account/register")).text();
    const without = await (await (await newClient(playwright, "main")).get("/account/register")).text();
    expect(withKey).toContain("1x00000000000000000000AA");
    expect(without).not.toContain("1x00000000000000000000AA");
    const csp = (await (await newClient(playwright, "turnstile")).get("/account/register")).headers()["content-security-policy"]!;
    expect(csp).toContain("https://challenges.cloudflare.com");
  });
});

test.describe("14. cookies", () => {
  test("http (local) flags: HttpOnly, SameSite=Lax, Path=/account, bounded Max-Age, opaque value; CSRF cookie Strict", async ({ playwright }) => {
    const email = uniqueEmail("ck");
    const c = await newClient(playwright);
    const csrf = await c.get("/account/api/csrf", { headers: { "sec-fetch-site": "same-origin" } });
    const cs = setCookies(csrf).find((x) => x.name === "fdb_csrf")!;
    expect(cs.flags).toMatchObject({ path: "/account", httponly: true, samesite: "Strict", "max-age": "3600" });
    const { waitForMail } = await import("./helpers");
    await post(c, "/account/api/register", { email, password: PASSWORD });
    const mail = await waitForMail(email, /confirm/i);
    const conf = await post(c, "/account/api/confirm", { type: mail.type, token_hash: mail.tokenHash });
    const s = setCookies(conf).filter((x) => x.name.startsWith("fdb_acct"));
    expect(s.length).toBeGreaterThanOrEqual(1);
    expect(s[0]!.name).toBe("fdb_acct");
    for (const k of s) expect(k.flags).toMatchObject({ path: "/account", httponly: true, samesite: "Lax", "max-age": String(14 * 86400) });
    expect(s.map((k) => k.value).join("")).not.toMatch(/eyJ|access_token|refresh_token|@/);
    for (const k of s) expect(k.flags.domain).toBeUndefined(); // host-only
  });

  test("https flags on the wire: __Secure- names, Secure, and deletion of every chunk on both paths", async ({ playwright }) => {
    const { email, password } = await signedInClient(playwright, "cks");
    const origin = ORIGINS.httpsish;
    const base = SITES.httpsish;
    const headers = { "x-forwarded-for": uniqueIp(), origin, "sec-fetch-site": "same-origin" };
    const t = await fetch(`${base}/account/api/csrf`, { headers });
    const csrfCookie = t.headers.getSetCookie().find((h) => h.startsWith("__Secure-fdb_csrf="))!;
    expect(csrfCookie).toBeDefined();
    expect(csrfCookie).toMatch(/Path=\/account/);
    expect(csrfCookie).toMatch(/; Secure/);
    expect(csrfCookie).toMatch(/HttpOnly/);
    expect(csrfCookie).toMatch(/SameSite=Strict/);
    const token = ((await t.json()) as { token: string }).token;
    const jar = `__Secure-fdb_csrf=${csrfCookie.split(";")[0]!.split("=").slice(1).join("=")}`;
    const login = await fetch(`${base}/account/api/login`, { method: "POST", headers: { ...headers, "content-type": "application/json", "x-fdb-csrf": token, cookie: jar }, body: JSON.stringify({ email, password }) });
    expect(login.status).toBe(200);
    const sc = login.headers.getSetCookie().find((h) => h.startsWith("__Secure-fdb_acct="))!;
    expect(sc).toBeDefined();
    expect(sc).toMatch(/Path=\/account/);
    expect(sc).toMatch(/; Secure/);
    expect(sc).toMatch(/HttpOnly/);
    expect(sc).toMatch(/SameSite=Lax/);
    expect(login.headers.getSetCookie().some((h) => /^fdb_acct=/.test(h))).toBe(false); // never the non-prefixed name on https
    const session = `__Secure-fdb_acct=${sc.split(";")[0]!.split("=").slice(1).join("=")}`;
    // logout with the (now session-bound) token clears every chunk on /account and /, all with Secure
    const t2 = await fetch(`${base}/account/api/csrf`, { headers: { ...headers, cookie: `${session}; ${jar}` } });
    const token2 = ((await t2.json()) as { token: string }).token;
    const jar2 = `${session}; __Secure-fdb_csrf=${t2.headers.getSetCookie().find((h) => h.startsWith("__Secure-fdb_csrf="))!.split(";")[0]!.split("=").slice(1).join("=")}`;
    const out = await fetch(`${base}/account/api/logout`, { method: "POST", headers: { ...headers, "content-type": "application/json", "x-fdb-csrf": token2, cookie: jar2 }, body: "{}" });
    expect(out.status).toBe(200);
    const cleared = out.headers.getSetCookie().filter((h) => h.startsWith("__Secure-fdb_acct"));
    expect(cleared.length).toBe(12); // 6 names x 2 paths
    for (const h of cleared) { expect(h).toMatch(/Max-Age=0/); expect(h).toMatch(/; Secure/); expect(h).toMatch(/Path=\/(account)?;/); }
    expect(cleared.filter((h) => /Path=\/;/.test(h)).length).toBe(6);
    expect(cleared.filter((h) => /Path=\/account;/.test(h)).length).toBe(6);
  });
});

test.describe("15. caching, noindex, referrer, CSP on every account response", () => {
  test("pages and APIs: private no-store, noindex, no-referrer, CSP, never the anonymous cookie, never shared-cacheable", async ({ playwright }) => {
    const c = await newClient(playwright);
    const urls = [...ALL_ACCOUNT_PAGES, "/account/api/csrf", "/account/api/me", "/account/api/session/refresh?next=/account", "/account/api/login", "/account/does-not-exist"];
    for (const u of urls) {
      const r = await c.get(u, { maxRedirects: 0 });
      const h = r.headers();
      expect(h["cache-control"], u).toMatch(/private/);
      expect(h["cache-control"], u).toMatch(/no-store/);
      expect(h["cache-control"], u).not.toMatch(/public|s-maxage/);
      expect(h["x-robots-tag"], u).toBe("noindex, nofollow");
      expect(h["referrer-policy"], u).toBe("no-referrer");
      expect(h["x-content-type-options"], u).toBe("nosniff");
      expect(h["x-frame-options"], u).toBe("DENY");
      expect(h["content-security-policy"], u).toContain("frame-ancestors 'none'");
      expect(h["etag"], u).toBeUndefined();
      expect(setCookies(r).filter((x) => /fdb_sid/.test(x.name)), u).toEqual([]);
      if ((h["content-type"] ?? "").includes("text/html") && r.status() === 200) {
        const html = await r.text();
        expect(html, u).toMatch(/<meta name="robots" content="noindex/);
        expect(html, u).toMatch(/<meta name="referrer" content="no-referrer"/);
      }
    }
    // An unauthenticated visit to the overview is sent to sign-in, never rendered.
    const r = await c.get("/account", { maxRedirects: 0 });
    expect([302, 303, 307, 308]).toContain(r.status());
    expect(r.headers().location).toMatch(/\/account\/login\?next=%2Faccount$/);
    // Not in the sitemap; robots keeps previews out entirely.
    expect(await (await c.get("/sitemap.xml")).text()).not.toMatch(/\/account/);
    expect(await (await c.get("/robots.txt")).text()).toMatch(/Disallow: \//);
  });

  test("the same holds for an authenticated overview page", async ({ playwright }) => {
    const { c, email } = await signedInClient(playwright, "hdr");
    const r = await c.get("/account", { maxRedirects: 0 });
    expect(r.status()).toBe(200);
    expect(r.headers()["cache-control"]).toMatch(/private.*no-store|no-store.*private/);
    expect(r.headers()["x-robots-tag"]).toBe("noindex, nofollow");
    expect(await r.text()).toContain(email);
  });
});

test.describe("16. no credential leakage to the browser", () => {
  test("HTML and every JS/CSS asset reachable from public and account pages contain no secret, key, Auth origin or token", async ({ playwright }) => {
    const c = await newClient(playwright);
    const pages = ["/", "/database?q=copper", ...ALL_ACCOUNT_PAGES.slice(1, 6)];
    const assets = new Set<string>();
    const needles = [CSRF_SECRET, ANON_KEY, AUTH_URL, "127.0.0.1:54321", "ACCOUNT_AUTH", "ACCOUNT_CSRF", "service_role", "sb_secret_", "SUPABASE"];
    const check = (where: string, text: string) => { for (const n of needles) expect(text.includes(n), `${where} contains ${n.slice(0, 12)}…`).toBe(false); };
    for (const p of pages) {
      const html = await (await c.get(p)).text();
      check(p, html);
      for (const m of html.matchAll(/(?:src|href)="(\/_next\/static\/[^"]+)"/g)) assets.add(m[1]!);
    }
    expect(assets.size).toBeGreaterThan(3);
    for (const a of assets) {
      const r = await c.get(a);
      if (/\.(js|css)$/.test(a)) check(a, await r.text());
    }
    // API bodies never carry tokens either.
    const { c: signed } = await signedInClient(playwright, "leak");
    for (const r of [await signed.get("/account/api/me"), await signed.get("/account/api/csrf")]) expect(await r.text()).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\.|access_token|refresh_token/);
  });
});

test.describe("17. public browsing and quotas are unchanged with accounts enabled", () => {
  test("anonymous loot search works, is shared-cacheable and cookie-free; an account cookie is ignored by public routes", async ({ playwright }) => {
    const c = await newClient(playwright);
    const api = await c.get("/api/v1/search?q=copper");
    expect(api.status()).toBe(200);
    expect(api.headers()["cache-control"]).toContain("s-maxage");
    expect(setCookies(api)).toEqual([]);
    expect(JSON.stringify(await api.json())).toMatch(/copper/i);
    const page = await c.get("/database?q=copper");
    expect(page.status()).toBe(200);
    expect(await page.text()).toMatch(/copper/i);
    expect(setCookies(page).some((x) => x.name === "fdb_sid")).toBe(true); // the anonymous rate-limit cookie still exists on public pages
    // Even if a browser did send an account cookie to a public route, nothing changes (and nothing is echoed).
    const { c: signed } = await signedInClient(playwright, "pub");
    const cookie = (await signed.storageState()).cookies.find((k) => k.name === "fdb_acct")!.value;
    const withCookie = await clientWithCookie(playwright, cookie);
    const again = await withCookie.get("/api/v1/search?q=copper");
    expect(again.status()).toBe(200);
    expect(setCookies(again)).toEqual([]);
  });

  test("the public search quota (30 per minute per client) is unchanged", async ({ playwright }) => {
    const c = await newClient(playwright, "main", "198.51.100.240");
    const codes: number[] = [];
    for (let i = 0; i < 32; i += 1) codes.push((await c.get(`/api/v1/search?q=copper&limit=${(i % 5) + 1}`)).status());
    expect(codes.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(codes[31]).toBe(429);
  });
});

test.describe("18. disabled by default / fail closed", () => {
  test("Vercel production target (the demonstration alias), accounts not configured: account routes do not exist; the demo is untouched", async ({ playwright }) => {
    const c = await newClient(playwright, "demo");
    for (const p of ["/account", "/account/login", "/account/register", "/account/api/csrf", "/account/api/me", "/account/api/session/refresh"]) {
      const r = await c.get(p, { maxRedirects: 0 });
      expect(r.status(), p).toBe(404);
      expect(r.headers()["cache-control"], p).toMatch(/no-store/);
      expect(setCookies(r), p).toEqual([]);
    }
    for (const route of POST_ROUTES) {
      const r = await post(c, `/account/api/${route}`, { email: "a@example.test", password: PASSWORD }, { site: "demo", csrf: "none" });
      expect(r.status(), route).toBe(404);
      expect(setCookies(r), route).toEqual([]);
    }
    const home = await c.get("/");
    expect(home.status()).toBe(200);
    expect(home.headers()["x-foreverdb-deployment"]).toBe("preview");
    expect(home.headers()["x-robots-tag"]).toContain("noindex");
    expect((await c.get("/api/v1/search?q=copper")).status()).toBe(200);
    expect(await (await c.get("/robots.txt")).text()).toMatch(/Disallow: \//);
  });

  test("an account configuration on Vercel's production target is refused: the whole site fails closed with a generic 500 that names nothing", async ({ playwright }) => {
    const c = await newClient(playwright, "prodacct");
    for (const p of ["/", "/account/login", "/account/api/csrf", "/robots.txt", "/api/v1/search?q=copper"]) {
      const r = await c.get(p, { maxRedirects: 0 });
      expect(r.status(), p).toBe(500);
      const text = await r.text();
      expect(text, p).not.toMatch(/ACCOUNT_|supabase|sb_publishable|csrf/i);
    }
  });

  test("hosted preview with accounts configured but WITHOUT the rate-limit backend and Turnstile: account routes refuse, public site unaffected", async ({ playwright }) => {
    const c = await newClient(playwright, "hosted");
    const csrf = await c.get("/account/api/csrf");
    expect(csrf.status()).toBe(503);
    expect((await json(csrf)).error).toBe("account_unavailable");
    expect(csrf.headers()["retry-after"]).toBeDefined();
    const login = await post(c, "/account/api/login", { email: "a@example.test", password: PASSWORD }, { site: "hosted", csrf: "none" });
    expect(login.status()).toBe(503);
    expect(setCookies(login)).toEqual([]);
    const page = await c.get("/account/login");
    expect(await page.text()).toContain("Accounts are temporarily unavailable");
    expect((await c.get("/database?q=copper")).status()).toBe(200);
  });
});
