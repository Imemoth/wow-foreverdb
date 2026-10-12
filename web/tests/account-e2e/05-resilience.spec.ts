import { expect, test } from "@playwright/test";
import { cookieOf, json, newClient, post } from "../account/helpers";
import { clientWithSessionCookie, companionWithInstallation, link, startClaim, webUser, type WebUser } from "./world";
import { admin, claimRows, ownerOf, sessionCount } from "./stack";
import type { APIRequestContext, PlaywrightWorkerArgs } from "@playwright/test";
import type pg from "pg";

/**
 * Failure behaviour of the redemption path, with faults injected between the website and the REAL stack (tests/e2e-stack/chaos-proxy.mjs):
 * a lost reply after the one-time call was sent (UNKNOWN outcome, never retried), an unrevocable temporary reauthentication session,
 * budgets of the website itself (per account and per address), and a dead rate limiter (fail closed).
 */
type Playwright = PlaywrightWorkerArgs["playwright"];
const CHAOS = process.env.E2E_CHAOS_URL ?? "http://127.0.0.1:54330";
const chaos = async (mode: string, reset = false) => (await fetch(`${CHAOS}/__chaos`, { method: "POST", body: JSON.stringify({ mode, reset }) })).json() as Promise<{ mode: string; redeems: number }>;
const ORIGIN_CHAOS = "http://localhost:3211";
let db: pg.Client;
test.beforeAll(async () => { db = await admin(); });
test.afterAll(async () => { await chaos("pass"); await db.end(); });

/** The same signed-in session, presented to the chaos instance of the website (cookies are per host, not per port; secrets are shared). */
async function onChaosSite(playwright: Playwright, u: WebUser): Promise<APIRequestContext> {
  return playwright.request.newContext({
    baseURL: ORIGIN_CHAOS,
    extraHTTPHeaders: { "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200) + 20}` },
    storageState: { cookies: [{ name: "fdb_acct", value: (await cookieOf(u.c))!.value, domain: "localhost", path: "/account", httpOnly: true, secure: false, sameSite: "Lax", expires: -1 }], origins: [] },
  });
}

async function csrf(c: APIRequestContext) {
  const r = await c.get("/account/api/csrf", { headers: { "sec-fetch-site": "same-origin" } });
  return ((await r.json()) as { token: string }).token;
}
async function linkVia(c: APIRequestContext, origin: string, code: string, password: string, accountId: string) {
  return c.post("/account/api/link", { headers: { "content-type": "application/json", origin, "sec-fetch-site": "same-origin", "x-fdb-csrf": await csrf(c) }, data: JSON.stringify({ code, password, confirm: true, accountId }) });
}

test("a lost reply AFTER the redemption was sent is an UNKNOWN outcome: reported as such, never retried automatically, reconcilable through the installation list", async ({ playwright }) => {
  const a = await webUser(playwright, "chaosA");
  const comp = await companionWithInstallation();
  const code = await startClaim(comp);
  const c = await onChaosSite(playwright, a);
  await chaos("drop-redeem-response", true);
  const r = await linkVia(c, ORIGIN_CHAOS, code, a.password, a.uid);
  expect(r.status()).toBe(502);
  expect(await json(r)).toEqual({ ok: false, error: "outcome_unknown", reconcile: "/account/installations" });
  const state = await chaos("pass");
  expect(state.redeems).toBe(1); // exactly ONE redemption request left the website: no automatic retry
  // The database DID commit: this is why "failed" would have been a lie. The outcome is discoverable, safely, by reading the list.
  expect(await ownerOf(db, comp.installationId)).toBe(a.uid);
  const list = await json<{ installations: { installationId: string }[] }>(await c.get("/account/api/installations"));
  expect(list.installations.map((i) => i.installationId)).toEqual([comp.installationId]);
  // a (human) retry of the same code is the ordinary one-time answer
  const again = await linkVia(c, ORIGIN_CHAOS, code, a.password, a.uid);
  expect(again.status()).toBe(422);
  expect((await claimRows(db, comp.installationId)).map((x) => x.status)).toEqual(["consumed"]);
});

test("a hung redemption times out as UNKNOWN (not as a failure) and the claim stays consistent", async ({ playwright }) => {
  test.setTimeout(60_000);
  const a = await webUser(playwright, "chaosH");
  const comp = await companionWithInstallation();
  const code = await startClaim(comp);
  const c = await onChaosSite(playwright, a);
  await chaos("hang-redeem", true);
  const started = Date.now();
  const r = await linkVia(c, ORIGIN_CHAOS, code, a.password, a.uid);
  const took = Date.now() - started;
  await chaos("pass");
  expect(r.status()).toBe(502);
  expect((await json<{ error: string }>(r)).error).toBe("outcome_unknown");
  expect(took).toBeGreaterThan(7000); // the explicit client timeout (8 s)
  expect(took).toBeLessThan(20_000);
  expect(await ownerOf(db, comp.installationId)).toBe(a.uid); // it was processed
});

test("an unrevocable temporary reauthentication session is reported as UNCONFIRMED (not claimed revoked), is never the redemption identity, and the web session stays the original", async ({ playwright }) => {
  const a = await webUser(playwright, "chaosL");
  const comp = await companionWithInstallation();
  const code = await startClaim(comp);
  const c = await onChaosSite(playwright, a);
  const before = await sessionCount(db, a.uid);
  await chaos("fail-logout", true);
  const r = await linkVia(c, ORIGIN_CHAOS, code, a.password, a.uid);
  await chaos("pass");
  expect(r.status()).toBe(200);
  const body = await json<{ ok: boolean; reauthCleanup: string }>(r);
  expect(body).toMatchObject({ ok: true, reauthCleanup: "unconfirmed" });
  // the orphan is real and visible: exactly one extra Auth session exists for the account (tokens were dropped, nobody holds them)
  expect(await sessionCount(db, a.uid)).toBe(before + 1);
  // the redemption used the ORIGINAL web session: the owner is A and the redeem audit row belongs to A's uid; the web session cookie is unchanged
  expect(await ownerOf(db, comp.installationId)).toBe(a.uid);
  const sessions = (await db.query("select id from auth.sessions where user_id = $1 order by created_at", [a.uid])).rows.map((x) => x.id);
  expect(sessions).toContain(a.sid);
  const setCookie = r.headersArray().filter((h) => h.name.toLowerCase() === "set-cookie" && h.value.startsWith("fdb_acct"));
  for (const h of setCookie) expect(h.value).not.toContain("Max-Age=0");
  // the UI is told; the orphan is cleaned up here (operators would see it as an unused session, bounded by one per attempt and by the attempt budgets)
  await db.query("delete from auth.sessions where user_id = $1 and id <> $2", [a.uid, a.sid]);
  expect((await c.get("/account/api/me")).status()).toBe(200);
});

test("the website's own budgets: 6th password attempt of one account in 15 minutes and 11th request of one address in 5 minutes are refused with Retry-After, whatever the code is", async ({ playwright }) => {
  // per verified ACCOUNT (independent of the address): 5 password attempts per 15 minutes, from five DIFFERENT addresses
  const a = await webUser(playwright, "limitA");
  const comp = await companionWithInstallation();
  const code = await startClaim(comp);
  const statuses: number[] = [];
  // ONE web session presented from six different addresses, no extra sign-ins: only the per-account budget can trip
  const cookie = (await cookieOf(a.c))!.value;
  const sessions = [];
  for (let i = 0; i < 6; i += 1) sessions.push({ c: await clientWithSessionCookie(playwright, cookie, `203.0.113.${100 + i}`) });
  for (let i = 0; i < 6; i += 1) statuses.push((await link(sessions[i]!.c, code, "wrong password number " + i, a.uid)).status());
  expect(statuses).toEqual([401, 401, 401, 401, 401, 429]);
  const limited = await link(sessions[5]!.c, code, a.password, a.uid); // even the CORRECT password is refused while the account budget is spent
  expect(limited.status()).toBe(429);
  expect(limited.headers()["retry-after"]).toBeTruthy();
  expect(await json(limited)).toEqual({ ok: false, error: "too_many_attempts" });
  expect(await ownerOf(db, comp.installationId)).toBe(comp.id.uid);
  // per ADDRESS (edge): one browser address may make 10 strict account requests in 5 minutes
  const b = await webUser(playwright, "limitB");
  const edge: number[] = [];
  const c = await newClient(playwright, "main", "192.0.2.250");
  for (let i = 0; i < 12; i += 1) edge.push((await post(c, "/account/api/link", { code: "0123456789ABCDEF0123456789ABCDEF", password: b.password, confirm: true, accountId: b.uid })).status());
  expect(edge.slice(0, 10).every((s) => s === 401)).toBe(true); // unauthenticated (no cookie) but counted
  expect(edge.slice(10)).toEqual([429, 429]);
});

test("a dead rate limiter FAILS CLOSED: the link route answers 503 and nothing reaches Auth or the database", async ({ playwright }) => {
  const a = await webUser(playwright, "deadlim");
  const comp = await companionWithInstallation();
  const code = await startClaim(comp);
  const c = await playwright.request.newContext({
    baseURL: "http://localhost:3212",
    extraHTTPHeaders: { "x-forwarded-for": "198.51.100.77" },
    storageState: { cookies: [{ name: "fdb_acct", value: (await cookieOf(a.c))!.value, domain: "localhost", path: "/account", httpOnly: true, secure: false, sameSite: "Lax", expires: -1 }], origins: [] },
  });
  const before = await sessionCount(db, a.uid);
  const token = await c.get("/account/api/csrf", { headers: { "sec-fetch-site": "same-origin" } });
  // the csrf route is a cheap account route (also limiter-backed): it too refuses rather than waving requests through
  expect([503, 429]).toContain(token.status());
  const r = await c.post("/account/api/link", { headers: { "content-type": "application/json", origin: "http://localhost:3212", "sec-fetch-site": "same-origin" }, data: JSON.stringify({ code, password: a.password, confirm: true, accountId: a.uid }) });
  expect(r.status()).toBe(503);
  expect(await ownerOf(db, comp.installationId)).toBe(comp.id.uid);
  expect(await sessionCount(db, a.uid)).toBe(before); // no password grant was attempted
});
