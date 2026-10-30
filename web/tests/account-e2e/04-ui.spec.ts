import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { uniqueIp } from "../account/helpers";
import { companionWithInstallation, startClaim, webUser, type WebUser } from "./world";
import { admin, logoutLocal, ownerOf } from "./stack";
import type pg from "pg";

/**
 * Real browser against the real stack: the linking page and the installation list as a person uses them (the Guildbook is Companion-local: no website page), the
 * hygiene of the claim code in the browser (never in a URL, storage, cookie or a request line), accessibility and layout.
 */
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
let db: pg.Client;
test.beforeAll(async () => { db = await admin(); });
test.afterAll(async () => { await db.end(); });

/** A browser signed in as the given web user (the cookie of the API session is handed to the browser context). */
async function browserFor(browser: Browser, u: WebUser, viewport = { width: 1280, height: 900 }) {
  const ctx = await browser.newContext({ baseURL: "http://localhost:3210", extraHTTPHeaders: { "x-forwarded-for": uniqueIp() }, viewport });
  await ctx.addCookies((await u.c.storageState()).cookies);
  const page = await ctx.newPage();
  const problems: string[] = [];
  const requests: string[] = [];
  page.on("console", (m) => { if (m.type() === "error" && !/status of (401|403|409|422)/.test(m.text())) problems.push(`console: ${m.text()}`); });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("request", (r) => requests.push(`${r.method()} ${r.url()}`));
  await page.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`)));
  return { ctx, page, problems, requests };
}
const hscroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);

test("the person's journey: open the link page, paste the code, enter the password, confirm; the code never appears in a URL, storage, cookie or request line", async ({ browser, playwright }, info) => {
  const a = await webUser(playwright, "uiA");
  const comp = await companionWithInstallation({ guilds: 1, members: 3, tag: "UI" });
  const code = await startClaim(comp);
  const { ctx, page, problems, requests } = await browserFor(browser, a);

  await page.goto("/account");
  await page.getByRole("link", { name: "Connect Companion" }).click();
  await expect(page).toHaveURL("/account/link");
  await expect(page.getByRole("heading", { name: "Link a Companion installation" })).toBeVisible();
  await expect(page.getByTestId("link-destination")).toHaveText(a.email); // the SERVER-CONFIRMED address
  await expect(page.getByText("ACCOUNT tab")).toBeVisible();
  await expect(page.getByText(`transferred to ${a.email}`)).toBeVisible();
  const axeBefore = await new AxeBuilder({ page: page as never }).withTags(AXE_TAGS).analyze();
  expect(axeBefore.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  await info.attach("link-form", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });

  const submit = page.getByRole("button", { name: "Link this installation to my account" });
  // empty / unconfirmed submissions are refused locally, with an announced message, and nothing is sent
  await submit.click();
  await expect(page.getByRole("alert").filter({ hasText: /32 letters and digits|32-character|valid linking code/ }).first()).toBeVisible();
  const spaced = code.match(/.{4}/g)!.join(" ").toLowerCase(); // pasted lower-case with spaces: normalised
  await page.getByLabel("Installation linking code").fill(spaced);
  await page.getByLabel("Installation linking code").blur();
  await expect(page.getByLabel("Installation linking code")).toHaveValue(/^FDB-[0-9A-F]{4}(-[0-9A-F]{4}){7}$/);
  await submit.click();
  await expect(page.getByRole("alert").filter({ hasText: /password/i }).first()).toBeVisible();
  await page.getByLabel(/^Password for/).fill("a wrong password that is long");
  await submit.click();
  await expect(page.getByRole("alert").filter({ hasText: /Tick the confirmation/ }).first()).toBeVisible();
  await page.getByRole("checkbox").check();
  await submit.click();
  await expect(page.getByRole("alert").filter({ hasText: /password is incorrect/i }).first()).toBeVisible();
  expect(await ownerOf(db, comp.installationId)).toBe(comp.id.uid);
  await expect(page.getByLabel(/^Password for/)).toHaveValue(""); // a failed attempt never keeps the password
  await info.attach("wrong-password", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });

  await page.getByLabel(/^Password for/).fill(a.password);
  await submit.click();
  await expect(page.getByRole("heading", { name: "Installation linked" })).toBeVisible();
  await expect(page.getByText(comp.installationId)).toBeVisible();
  expect(await ownerOf(db, comp.installationId)).toBe(a.uid);
  await info.attach("linked", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });

  // hygiene: no URL ever carried the code or the password, nothing was stored, no cookie holds it, the DOM no longer shows it
  expect(page.url()).toBe("http://localhost:3210/account/link");
  expect(requests.filter((r) => r.includes(code) || r.toLowerCase().includes(code.toLowerCase()) || /code=|password=/i.test(r))).toEqual([]);
  const storage = await page.evaluate(() => ({ l: JSON.stringify({ ...localStorage }), s: JSON.stringify({ ...sessionStorage }), c: document.cookie }));
  for (const v of Object.values(storage)) { expect(v).not.toContain(code); expect(v).not.toContain(a.password); }
  expect(await page.content()).not.toContain(code);
  for (const c of await ctx.cookies()) { expect(c.value).not.toContain(code); expect(c.name).not.toMatch(/claim|code/i); }
  expect(problems).toEqual([]);
  await ctx.close();
});

test("installation list in the browser: only own data, no Guildbook link or count, accessible, no horizontal scroll at 375px, revocation drops the private UI", async ({ browser, playwright }, info) => {
  const a = await webUser(playwright, "uiG");
  const b = await webUser(playwright, "uiGB");
  const big = await companionWithInstallation({ guilds: 2, members: 60, tag: "GB" });
  const mine2 = await companionWithInstallation({ guilds: 1, members: 2, tag: "G2" });
  const theirs = await companionWithInstallation({ guilds: 2, members: 5, tag: "XX" });
  const { link } = await import("./world");
  expect((await link(a.c, await startClaim(big), a.password)).status()).toBe(200);
  expect((await link(a.c, await startClaim(mine2), a.password)).status()).toBe(200);
  expect((await link(b.c, await startClaim(theirs), b.password)).status()).toBe(200);

  const { ctx, page, problems } = await browserFor(browser, a);
  await page.goto("/account/installations");
  await expect(page.getByTestId("installation-row")).toHaveCount(2);
  await expect(page.getByText(big.installationId)).toBeVisible();
  await expect(page.getByText(theirs.installationId)).toHaveCount(0);
  // the Guildbook stays on the person's computer: no link, no count, no page
  await expect(page.getByRole("link", { name: /guildbook/i })).toHaveCount(0);
  await expect(page.getByText("Guilds", { exact: true })).toHaveCount(0);
  expect((await new AxeBuilder({ page: page as never }).withTags(AXE_TAGS).analyze()).violations.map((v) => v.id)).toEqual([]);
  await info.attach("installations", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  const gb = await page.goto("/account/guildbook");
  expect(gb?.status()).toBe(404);
  await page.goto("/account/installations");

  // narrow screen: no horizontal PAGE scroll
  await page.setViewportSize({ width: 375, height: 800 });
  expect(await hscroll(page)).toBe(false);
  await info.attach("installations-375", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });

  // revocation invalidates the private UI at once: the server-side session dies, the next navigation sends the person to sign in and the DOM is dropped
  expect(await logoutLocal(a.accessToken)).toBe(204);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/account/installations");
  await expect(page).toHaveURL(/\/account\/login/);
  expect(await page.content()).not.toContain(big.installationId);
  expect(problems).toEqual([]);
  await ctx.close();
});

test("a person with no installation sees helpful empty states; an anonymous visitor is sent to sign-in with a safe return path", async ({ browser, playwright }) => {
  const e = await webUser(playwright, "uiEmpty");
  const { ctx, page } = await browserFor(browser, e);
  await page.goto("/account/installations");
  await expect(page.getByText("No installation is linked to this account yet.")).toBeVisible();
  const guildbook = await page.goto("/account/guildbook");
  expect(guildbook?.status()).toBe(404);
  await ctx.close();
  const anon = await browser.newContext({ baseURL: "http://localhost:3210", extraHTTPHeaders: { "x-forwarded-for": uniqueIp() } });
  const p = await anon.newPage();
  for (const path of ["/account/link", "/account/installations"]) {
    await p.goto(path);
    await expect(p).toHaveURL(new RegExp(`/account/login\\?next=${encodeURIComponent(path)}`));
  }
  expect((await p.goto("/account/guildbook"))?.status()).toBe(404); // no page, nothing to sign in for
  await anon.close();
});

test("recovery UX: a reset whose sign-out of other sessions is not confirmed is NEVER shown as done; 'Finish securing my account' completes it without a new password", async ({ browser, playwright }, info) => {
  const { newClient, post, waitForMail, cookieOf } = await import("../account/helpers");
  const v = await webUser(playwright, "uiReset");
  const attacker = await webUser(playwright, "uiResetX"); void attacker;
  const rc = await newClient(playwright);
  expect((await post(rc, "/account/api/forgot-password", { email: v.email })).status()).toBe(202);
  const mail = await waitForMail(v.email, /reset|recover|password/i);
  expect((await post(rc, "/account/api/confirm", { type: "recovery", token_hash: mail.tokenHash })).status()).toBe(200);
  const CHAOS = process.env.E2E_CHAOS_URL ?? "http://127.0.0.1:54330";
  const mode = (m: string) => fetch(`${CHAOS}/__chaos`, { method: "POST", body: JSON.stringify({ mode: m, reset: true }) });
  const ctx = await browser.newContext({ baseURL: "http://localhost:3211", extraHTTPHeaders: { "x-forwarded-for": uniqueIp() } });
  await ctx.addCookies([{ name: "fdb_acct", value: (await cookieOf(rc))!.value, domain: "localhost", path: "/account", httpOnly: true, secure: false, sameSite: "Lax" }]);
  const page = await ctx.newPage();
  await mode("fail-global-logout");
  await page.goto("/account/reset-password");
  await page.getByLabel("New password").fill("ui recovery passphrase 2026 ok");
  await page.getByRole("button", { name: "Set new password" }).click();
  await expect(page.getByRole("heading", { name: "Not fully secured yet" })).toBeVisible();
  await expect(page.getByText(/could not confirm that all other sessions were signed out/)).toBeVisible();
  expect(page.url()).toBe("http://localhost:3211/account/reset-password"); // no redirect to the "password changed" screen
  expect((await new AxeBuilder({ page: page as never }).withTags(AXE_TAGS).analyze()).violations.map((x) => x.id)).toEqual([]);
  await info.attach("recovery-incomplete", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  await mode("pass");
  await page.getByRole("button", { name: "Finish securing my account" }).click();
  await expect(page).toHaveURL(/\/account\/login\?reason=password_reset$/);
  await expect(page.getByText(/every other session was signed out/)).toBeVisible();
  await ctx.close();
});
