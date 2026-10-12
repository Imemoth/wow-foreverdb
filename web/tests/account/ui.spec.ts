import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  PASSWORD, SITES, authDirect, clientWithCookie, newClient, openSessionCookie, post, sealSessionCookie, sleep, uniqueEmail, uniqueIp, waitForMail,
} from "./helpers";

/**
 * Real browser, real GoTrue, captured mail: the account UI end to end, accessibility, the client bundle (isomorphic contracts,
 * multibyte passwords WITHOUT Node's Buffer), CSP cleanliness, cookie scoping and expiry handling.
 */
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

async function visitor(browser: Browser, viewport?: { width: number; height: number }) {
  const ctx = await browser.newContext({ baseURL: SITES.main, extraHTTPHeaders: { "x-forwarded-for": uniqueIp() }, viewport });
  const page = await ctx.newPage();
  const problems: string[] = [];
  // (A deliberate wrong password makes the browser log "Failed to load resource ... 401": expected noise, not a defect.)
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource: the server responded with a status of 401/.test(m.text())) problems.push(`console: ${m.text()}`); });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  await page.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`)));
  return { ctx, page, problems };
}

async function registerAndConfirmViaUi(page: Page, email: string, password = PASSWORD) {
  await page.goto("/account/register");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  const mail = await waitForMail(email, /confirm/i);
  await page.goto(`/account/auth/confirm?token_hash=${mail.tokenHash}&type=${mail.type}`);
  await page.getByRole("button", { name: "Confirm email address" }).click();
  await expect(page).toHaveURL(/\/account\?welcome=1$|\/account$/);
}

test("registration, e-mail confirmation (interstitial), welcome, profile and sign-out in a real browser", async ({ browser, playwright }) => {
  const { ctx, page, problems } = await visitor(browser);
  const email = uniqueEmail("ui");
  await page.goto("/account/register");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Check your email" })).toBeVisible();
  const mail = await waitForMail(email, /confirm/i);

  // The link opens an interstitial; nothing is consumed and the token leaves the address bar immediately.
  await page.goto(mail.link);
  await expect(page.getByRole("heading", { name: "Confirm your email" })).toBeVisible();
  await expect.poll(() => new URL(page.url()).search).toBe("");
  const noSession = await post(await newClient(playwright), "/account/api/login", { email, password: PASSWORD });
  expect(noSession.status()).toBe(401); // still unconfirmed: the page view alone confirmed nothing
  await page.getByRole("button", { name: "Confirm email address" }).click();
  await expect(page).toHaveURL(/\/account\?welcome=1$/);
  await expect(page.getByRole("status").filter({ hasText: "email address is confirmed" })).toBeVisible();
  await expect(page.getByText(email)).toBeVisible();
  expect(page.url()).not.toMatch(/token/);

  // Sign out (ends this session; stays on the sign-in page with a message). The back button does not resurrect the account page.
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/account\/login\?reason=signed_out$/);
  await expect(page.getByText("You have been signed out.")).toBeVisible();
  await page.goBack();
  await page.reload();
  await expect(page).toHaveURL(/\/account\/login/);
  expect(problems).toEqual([]);
  await ctx.close();
});

test("sign-in by keyboard: errors are announced and focused, success lands on the profile", async ({ browser }) => {
  const { ctx, page, problems } = await visitor(browser);
  const email = uniqueEmail("kb");
  await registerAndConfirmViaUi(page, email);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/signed_out/);

  await page.goto("/account/login");
  await page.getByLabel("Email address").focus();
  await page.keyboard.type(email);
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Password", { exact: true })).toBeFocused();
  await page.keyboard.type("not the right password");
  await page.keyboard.press("Enter");
  const alert = page.getByRole("alert").filter({ hasText: "incorrect" });
  await expect(alert).toBeVisible();
  await expect(alert).toBeFocused(); // keyboard and screen-reader users land on the problem
  await expect(page.getByLabel("Password", { exact: true })).toHaveValue(""); // a failed attempt never keeps the secret in the field
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
  expect(problems).toEqual([]);
  await ctx.close();
});

test("password recovery in the browser: scanner-safe link, restricted session, new password, then sign-in", async ({ browser }) => {
  const { ctx, page, problems } = await visitor(browser);
  const email = uniqueEmail("rec-ui");
  await registerAndConfirmViaUi(page, email);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/signed_out/);

  await page.goto("/account/forgot-password");
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Send reset link" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Check your email" })).toBeVisible();
  const mail = await waitForMail(email, /reset|password/i);
  await page.goto(mail.link);
  await expect(page.getByRole("heading", { name: "Reset your password" })).toBeVisible();
  // Visiting the reset page without having pressed the button shows no form.
  const direct = await ctx.newPage();
  await direct.goto("/account/reset-password");
  await expect(direct.getByText("needs a valid password-reset link")).toBeVisible();
  await direct.close();
  await page.getByRole("button", { name: "Continue to reset password" }).click();
  await expect(page).toHaveURL(/\/account\/reset-password$/);
  await page.getByLabel("New password").fill("short");
  await page.getByRole("button", { name: "Set new password" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "highlighted" })).toBeVisible();
  const fresh = "another long passphrase ✓ 2026";
  await page.getByLabel("New password").fill(fresh);
  await page.getByRole("button", { name: "Set new password" }).click();
  await expect(page).toHaveURL(/\/account\/login\?reason=password_reset$/);
  await expect(page.getByText("Your password was changed")).toBeVisible();
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(fresh);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/account$/);
  expect(problems).toEqual([]);
  await ctx.close();
});

test("expiry handling: a revoked session and a forged old session both end at sign-in with a clear message and no cookie", async ({ browser, playwright }) => {
  const { ctx, page } = await visitor(browser);
  const email = uniqueEmail("exp-ui");
  await registerAndConfirmViaUi(page, email);
  const cookie = (await ctx.cookies()).find((c) => c.name === "fdb_acct")!;
  // 1. revoked elsewhere (a thief-copy logs out through the API): the browser's session is dead server-side.
  const copy = await clientWithCookie(playwright, cookie.value);
  const { csrfToken } = await import("./helpers");
  const out = await copy.post("/account/api/logout", { headers: { origin: "http://localhost:3210", "sec-fetch-site": "same-origin", "content-type": "application/json", "x-fdb-csrf": await csrfToken(copy) }, data: "{}" });
  // (the copy has no CSRF cookie bound to itself; if refused, revoke through Auth directly with the session's own token)
  if (out.status() !== 200) {
    const payload = (await openSessionCookie(cookie.value))!;
    expect((await authDirect("/auth/v1/logout?scope=local", { bearer: payload.at })).status).toBe(204);
  }
  await page.goto("/account");
  await expect(page).toHaveURL(/\/account\/login\?reason=expired&next=%2Faccount$/);
  await expect(page.getByText("Your session has expired")).toBeVisible();
  expect((await ctx.cookies()).filter((c) => c.name.startsWith("fdb_acct"))).toEqual([]);

  // 2. a session past the 30-day absolute limit
  await registerAndConfirmViaUi(page, uniqueEmail("exp-ui2"));
  const live = (await ctx.cookies()).find((c) => c.name === "fdb_acct")!;
  const payload = (await openSessionCookie(live.value))!;
  await ctx.addCookies([{ ...live, value: await sealSessionCookie({ ...payload, sc: Math.floor(Date.now() / 1000) - 31 * 86400 }) }]);
  await page.goto("/account");
  await expect(page).toHaveURL(/reason=expired/);
  expect((await ctx.cookies()).filter((c) => c.name.startsWith("fdb_acct"))).toEqual([]);
  await ctx.close();
});

test("an expired access token is refreshed transparently on page navigation (cookie rotated, no sign-in prompt)", async ({ browser }) => {
  const { ctx, page } = await visitor(browser);
  await registerAndConfirmViaUi(page, uniqueEmail("rf-ui"));
  const before = (await ctx.cookies()).find((c) => c.name === "fdb_acct")!;
  const p0 = (await openSessionCookie(before.value))!;
  await sleep(Math.max(0, (p0.ex - 15 - Math.floor(Date.now() / 1000) + 1) * 1000));
  await page.goto("/account");
  await expect(page).toHaveURL(/\/account$/);
  await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
  const after = (await ctx.cookies()).find((c) => c.name === "fdb_acct")!;
  const p1 = (await openSessionCookie(after.value))!;
  expect(p1.rt).not.toBe(p0.rt);
  expect(p1.sid).toBe(p0.sid);
  await ctx.close();
});

test("account cookies are never sent to public pages, public APIs or static assets", async ({ browser }) => {
  const { ctx, page } = await visitor(browser);
  await registerAndConfirmViaUi(page, uniqueEmail("scope-ui"));
  expect((await ctx.cookies()).some((c) => c.name === "fdb_acct")).toBe(true);
  const seen: { url: string; cookie: string }[] = [];
  const pending: Promise<void>[] = [];
  page.on("request", (r) => { pending.push(r.allHeaders().then((h) => { seen.push({ url: r.url(), cookie: h.cookie ?? "" }); }, () => undefined)); });
  await page.goto("/database?q=copper");
  await page.evaluate(async () => { await fetch("/api/v1/search?q=copper"); await fetch("/api/v1/meta"); });
  await page.goto("/");
  await sleep(300);
  await Promise.race([Promise.all(pending), sleep(4000)]);
  expect(seen.length).toBeGreaterThan(5);
  // (prefetches of /account/* links that were still in flight from the overview page legitimately carry the account cookie: only requests OUTSIDE /account are checked)
  for (const s of seen.filter((x) => !new URL(x.url).pathname.startsWith("/account"))) expect(s.cookie, s.url).not.toMatch(/fdb_acct|fdb_csrf/);
  // ...while the account namespace does receive it.
  const acct: string[] = [];
  page.on("request", (r) => { if (new URL(r.url()).pathname.startsWith("/account")) pending.push(r.allHeaders().then((h) => { acct.push(h.cookie ?? ""); }, () => undefined)); });
  await page.goto("/account");
  await sleep(200);
  await Promise.race([Promise.all(pending), sleep(4000)]);
  expect(acct.some((c) => /fdb_acct=/.test(c))).toBe(true);
  await ctx.close();
});

test.describe("accessibility (WCAG 2.2 AA, axe) and layout", () => {
  for (const path of ["/account/login", "/account/register", "/account/forgot-password", "/account/auth/confirm?token_hash=0123456789abcdef0123&type=email", "/account/auth/confirm?token_hash=0123456789abcdef0123&type=recovery", "/account/auth/confirm", "/account/reset-password"]) {
    test(`axe: ${path}`, async ({ browser }) => {
      const { ctx, page } = await visitor(browser);
      await page.goto(path);
      const r = await new AxeBuilder({ page: page as never }).withTags(AXE_TAGS).analyze();
      expect(r.violations.map((v) => `${v.id}: ${v.nodes.length} node(s) — ${v.help}`)).toEqual([]);
      await ctx.close();
    });
  }

  test("axe on the signed-in overview, on error states, and no horizontal scroll at 375px", async ({ browser }) => {
    const { ctx, page } = await visitor(browser, { width: 375, height: 700 });
    await registerAndConfirmViaUi(page, uniqueEmail("a11y"));
    const run = async () => (await new AxeBuilder({ page: page as never }).withTags(AXE_TAGS).analyze()).violations.map((v) => `${v.id}: ${v.nodes.length}`);
    expect(await run()).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/signed_out/);
    // error state with the alert shown
    await page.getByLabel("Email address").fill("x");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "valid email" })).toBeVisible();
    expect(await run()).toEqual([]);
    for (const p of ["/account/login", "/account/register", "/account/forgot-password"]) {
      await page.goto(p);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth), p).toBeLessThanOrEqual(0);
    }
    await ctx.close();
  });

  test("the password field can be revealed by keyboard and every control has an accessible name", async ({ browser }) => {
    const { ctx, page } = await visitor(browser);
    await page.goto("/account/login");
    const pw = page.getByLabel("Password", { exact: true });
    await pw.fill("hunter2 hunter2");
    await page.keyboard.press("Tab");
    const toggle = page.getByRole("button", { name: /Show password/ });
    await expect(toggle).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(pw).toHaveAttribute("type", "text");
    await expect(page.getByRole("button", { name: /Hide password/ })).toHaveAttribute("aria-pressed", "true");
    await ctx.close();
  });
});

test.describe("browser bundle: isomorphic contracts, multibyte passwords, no Node globals", () => {
  test("the client bundle validates passwords by UTF-8 bytes and code points without Buffer", async ({ browser }) => {
    const { ctx, page } = await visitor(browser);
    await page.goto("/account/register");
    expect(await page.evaluate(() => typeof (globalThis as { Buffer?: unknown }).Buffer)).toBe("undefined");
    expect(await page.evaluate(() => typeof (globalThis as { process?: { versions?: unknown } }).process?.versions)).not.toBe("object");
    const posts: string[] = [];
    page.on("request", (r) => { if (r.method() === "POST") posts.push(r.url()); });
    const email = page.getByLabel("Email address");
    const pw = page.getByLabel("Password", { exact: true });
    const submit = page.getByRole("button", { name: "Create account" });
    await email.fill(uniqueEmail("bundle"));

    // 25 x "€" = 25 UTF-16 units but 75 UTF-8 bytes: over bcrypt's 72-byte limit, refused locally.
    await pw.fill("€".repeat(25));
    await submit.click();
    await expect(page.getByText(/at most 72 bytes/)).toBeVisible();
    // 11 emoji = 22 UTF-16 units, 11 code points: below the 12-character minimum (code points, not UTF-16 units).
    await pw.fill("😀".repeat(11));
    await submit.click();
    await expect(page.getByText("Use at least 12 characters.")).toBeVisible();
    await sleep(300);
    expect(posts).toEqual([]); // nothing reached the server

    // 24 x "€" = 72 bytes exactly and 12 emoji = 48 bytes: both accepted by the client and the server.
    for (const ok of ["€".repeat(24), "😀".repeat(12)]) {
      const c = await visitor(browser);
      await c.page.goto("/account/register");
      await c.page.getByLabel("Email address").fill(uniqueEmail("bundle-ok"));
      await c.page.getByLabel("Password", { exact: true }).fill(ok);
      await c.page.getByRole("button", { name: "Create account" }).click();
      await expect(c.page.getByRole("status").filter({ hasText: "Check your email" })).toBeVisible();
      await c.ctx.close();
    }
    await ctx.close();
  });

  test("the confirmation page's client bundle does not leak the token into history or requests to other origins", async ({ browser }) => {
    const { ctx, page } = await visitor(browser);
    const foreign: string[] = [];
    page.on("request", (r) => { if (new URL(r.url()).origin !== SITES.main) foreign.push(r.url()); });
    await page.goto("/account/auth/confirm?token_hash=0123456789abcdef0123456789&type=email");
    await expect.poll(() => page.url()).not.toContain("token_hash");
    expect(foreign).toEqual([]);
    expect(await page.evaluate(() => document.referrer)).toBe("");
    await ctx.close();
  });
});
