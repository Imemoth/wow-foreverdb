import { expect, test } from "@playwright/test";
import type { APIRequestContext, PlaywrightWorkerArgs } from "@playwright/test";
import type pg from "pg";
import { cookieOf, json, newClient, post, setCookies, waitForMail } from "../account/helpers";
import { clientWithSessionCookie, companionWithInstallation, link, loginAgain, startClaim, webUser, type WebUser } from "./world";
import { admin, auth, fingerprint, ingest, ownerOf, registeredSession, relaxFixtureCeilings, resetBudgets, rpc, sha, snapshot } from "./stack";

/**
 * Owner decision (PR E): a successful password reset revokes EVERY session of the Auth user (attacker's, other browsers, the registered
 * Companion), verified against real GoTrue v2.197.0 + real PostgREST; partial success is recoverable without a second password update.
 */
type Playwright = PlaywrightWorkerArgs["playwright"];
const CHAOS = process.env.E2E_CHAOS_URL ?? "http://127.0.0.1:54330";
const chaos = async (mode: string, reset = false) => (await fetch(`${CHAOS}/__chaos`, { method: "POST", body: JSON.stringify({ mode, reset }) })).json() as Promise<{ mode: string; globalLogouts: number }>;
const ORIGIN_CHAOS = "http://localhost:3211";
let db: pg.Client;
test.beforeAll(async () => { db = await admin(); });
test.afterAll(async () => { await chaos("pass"); await db.end(); });

/** Requests a recovery mail and opens it on the MAIN site: returns a client holding the RECOVERY session cookie. */
async function recoverySession(playwright: Playwright, email: string): Promise<{ c: APIRequestContext; cookie: string }> {
  const c = await newClient(playwright);
  expect((await post(c, "/account/api/forgot-password", { email })).status()).toBe(202);
  const mail = await waitForMail(email, /reset|recover|password/i);
  const conf = await post(c, "/account/api/confirm", { type: "recovery", token_hash: mail.tokenHash });
  expect(await json(conf)).toMatchObject({ ok: true, kind: "recovery" });
  return { c, cookie: (await cookieOf(c))!.value };
}
const onChaosSite = (playwright: Playwright, cookie: string) => playwright.request.newContext({
  baseURL: ORIGIN_CHAOS, extraHTTPHeaders: { "x-forwarded-for": `198.51.100.${60 + Math.floor(Math.random() * 100)}` },
  storageState: { cookies: [{ name: "fdb_acct", value: cookie, domain: "localhost", path: "/account", httpOnly: true, secure: false, sameSite: "Lax", expires: -1 }], origins: [] },
});
async function csrfOn(c: APIRequestContext) { return ((await (await c.get("/account/api/csrf", { headers: { "sec-fetch-site": "same-origin" } })).json()) as { token: string }).token; }
const postChaos = async (c: APIRequestContext, path: string, body: unknown) =>
  c.post(path, { headers: { "content-type": "application/json", origin: ORIGIN_CHAOS, "sec-fetch-site": "same-origin", "x-fdb-csrf": await csrfOn(c) }, data: JSON.stringify(body) });

const liveSessions = async (uid: string) => (await db.query("select count(*)::int n from auth.sessions where user_id = $1", [uid])).rows[0].n as number;
const liveRefreshTokens = async (uid: string) => (await db.query("select count(*)::int n from auth.refresh_tokens where user_id = $1 and not revoked", [uid])).rows[0].n as number;
const PRIVATE: [string, Record<string, unknown>][] = [
  ["fdb_account_installations", {}],
  ["fdb_account_claim_redeem", { p_code: "0123456789ABCDEF0123456789ABCDEF" }],
];

test("a successful reset revokes every session of the account (attacker, other browser, registered Companion), keeps unrelated identities and all data, and the new password works", async ({ playwright }) => {
  const victim = await webUser(playwright, "resetV");
  const mine = await companionWithInstallation({ guilds: 2, members: 4, tag: "RV" }); // linked to the victim before the reset
  expect((await link(victim.c, await startClaim(mine), victim.password)).status()).toBe(200);
  const legacy = await companionWithInstallation({ guilds: 1, members: 2, tag: "LG" }); // an UNRELATED anonymous identity with its own installation

  // sessions that exist before the reset: the attacker's (second web login), another browser, the registered Companion
  const attacker: WebUser = await loginAgain(playwright, victim);
  const otherBrowser: WebUser = await loginAgain(playwright, victim);
  const companion = await registeredSession(victim.email, victim.password);
  const companion2 = await registeredSession(victim.email, victim.password);
  expect(await liveSessions(victim.uid)).toBeGreaterThanOrEqual(5);
  for (const [n, a] of PRIVATE) expect((await rpc(companion.token, n, a)).status, `before: ${n}`).toBe(200);
  expect((await attacker.c.get("/account/api/installations")).status()).toBe(200); // the attacker can read the installation inventory now
  const historyBefore = await fingerprint(db);
  await resetBudgets(db);
  const statsBefore = (await rpc(companion.token, "get_foreverdb_item_stats", { p_item_id: 7001 })).body;

  // --- the reset (honest owner, via the mailed link)
  const { c: rc } = await recoverySession(playwright, victim.email);
  const fresh = "a brand new passphrase 2026 revoke";
  const done = await post(rc, "/account/api/reset-password", { password: fresh });
  expect(done.status()).toBe(200);
  expect(await json(done)).toEqual({ ok: true, passwordChanged: true, sessionsRevoked: true, redirect: "/account/login?reason=password_reset" });
  expect(setCookies(done).filter((x) => x.name === "fdb_acct").every((x) => x.value === "" || /Max-Age=0/.test(x.raw))).toBe(true);

  // --- every Auth session and refresh token of the user is gone
  expect(await liveSessions(victim.uid)).toBe(0);
  expect(await liveRefreshTokens(victim.uid)).toBe(0);
  for (const old of [attacker, otherBrowser]) {
    expect((await old.c.get("/account/api/me")).status()).toBe(401); // server-confirmed identity: session_not_found
    expect((await old.c.get("/account/api/installations")).status()).toBe(401);
    const stolen = await clientWithSessionCookie(playwright, (await cookieOf(old.c))?.value ?? "x");
    // the retired Guildbook route has no session handling at all: 404 for every caller, a stolen cookie included (it is never an oracle for session validity)
    expect((await post(stolen, "/account/api/guildbook/guilds", { installationId: mine.installationId })).status()).toBe(404);
    expect((await post(stolen, "/account/api/link", { code: "0123456789ABCDEF0123456789ABCDEF", password: fresh, confirm: true, accountId: victim.uid })).status()).toBe(401);
  }
  // refresh tokens are dead: they cannot mint new access tokens
  for (const s of [companion, companion2]) {
    const r = await auth("/token?grant_type=refresh_token", { body: { refresh_token: s.refresh } });
    expect(r.status, "refresh after reset").toBeGreaterThanOrEqual(400);
    expect(r.body.access_token).toBeUndefined();
    expect(["refresh_token_not_found", "refresh_token_already_used", "session_not_found", "session_expired"]).toContain(r.body.error_code);
  }
  // private RPCs refuse every old JWT (correctly signed and unexpired) with PT401, through real PostgREST
  for (const tok of [companion.token, companion2.token, attacker.accessToken, otherBrowser.accessToken]) {
    for (const [n, a] of PRIVATE) {
      const r = await rpc(tok, n, a);
      expect([r.status, r.body.code], n).toEqual([401, "PT401"]);
    }
  }

  // --- the new password works; the old one does not; ownership, history and the unrelated identity are untouched
  const oldPw = await post(await newClient(playwright), "/account/api/login", { email: victim.email, password: victim.password });
  expect(oldPw.status()).toBe(401);
  const back = await newClient(playwright);
  expect((await post(back, "/account/api/login", { email: victim.email, password: fresh })).status()).toBe(200);
  const listed = await json<{ installations: { installationId: string }[] }>(await back.get("/account/api/installations"));
  expect(listed.installations.map((i) => i.installationId)).toEqual([mine.installationId]);
  expect(await ownerOf(db, mine.installationId)).toBe(victim.uid);
  const newCompanion = await registeredSession(victim.email, fresh); // the Companion signs in again with the new password
  expect((await rpc(newCompanion.token, "fdb_account_installations")).status).toBe(200);
  expect(await fingerprint(db)).toEqual(historyBefore); // no observation, location, loot or owner changed
  expect(sha((await rpc(newCompanion.token, "get_foreverdb_item_stats", { p_item_id: 7001 })).body)).toBe(sha(statsBefore));
  // the separate anonymous legacy identity: same user, same session, still the owner, still able to use its installation
  await relaxFixtureCeilings();
  expect(await ownerOf(db, legacy.installationId)).toBe(legacy.id.uid);
  expect((await rpc(legacy.id.token, "fdb_installation_link_status", { p_installation_id: legacy.installationId })).body).toEqual({ state: "owned" });
  expect((await ingest(legacy.id.token, snapshot(legacy.installationId, { updatedAt: 5000, guilds: 1, members: 2, tag: "LG" }))).status).toBe(200);
  expect((await rpc(legacy.id.token, "fdb_account_claim_start", { p_installation_id: legacy.installationId })).body.ok).toBe(true);
  const anonRefresh = await auth("/token?grant_type=refresh_token", { body: { refresh_token: legacy.id.refresh } });
  expect(anonRefresh.status).toBe(200); // its refresh token still works
  // another, unrelated registered account is untouched
  const bystander = await webUser(playwright, "resetBy");
  expect((await bystander.c.get("/account/api/me")).status()).toBe(200);
});

test("KNOWN LIMITATION (documented): an already-issued registered JWT keeps working for the legacy ingest/stats RPCs until it expires, because those functions check only the JWT, not the session row", async ({ playwright }) => {
  const w = await webUser(playwright, "resetLim");
  const comp = await companionWithInstallation({ guilds: 1, members: 2, tag: "LM" });
  expect((await link(w.c, await startClaim(comp), w.password)).status()).toBe(200);
  const old = await registeredSession(w.email, w.password);
  const { c: rc } = await recoverySession(playwright, w.email);
  expect((await post(rc, "/account/api/reset-password", { password: "limitation passphrase 2026 x" })).status()).toBe(200);
  expect(await liveSessions(w.uid)).toBe(0);
  // account (guarded) RPCs refuse it ...
  expect((await rpc(old.token, "fdb_account_installations")).status).toBe(401);
  // ... the pre-existing, unguarded RPCs still accept the unexpired JWT (the access token's remaining lifetime is the exposure window)
  await relaxFixtureCeilings();
  expect((await rpc(old.token, "get_foreverdb_item_stats", { p_item_id: 7001 })).status).toBe(200);
  expect((await ingest(old.token, snapshot(comp.installationId, { updatedAt: 6000, guilds: 1, members: 2, tag: "LM" }))).status).toBe(200);
  expect(await ownerOf(db, comp.installationId)).toBe(w.uid);
});

test("partial success 1: password changed but the global logout FAILED -> 202 revocation_incomplete (never a complete reset), the new password already works, and 'finish' revokes without a second password update", async ({ playwright }) => {
  const v = await webUser(playwright, "partF");
  const attacker = await loginAgain(playwright, v);
  const companion = await registeredSession(v.email, v.password);
  const { cookie } = await recoverySession(playwright, v.email);
  const site = await onChaosSite(playwright, cookie);
  await chaos("fail-global-logout", true);
  const fresh = "partial failure passphrase 2026";
  const r = await postChaos(site, "/account/api/reset-password", { password: fresh });
  expect(r.status()).toBe(202);
  expect(await json(r)).toEqual({ ok: false, error: "revocation_incomplete", passwordChanged: true, sessionsRevoked: false, retryable: true });
  expect(r.headersArray().filter((h) => h.name.toLowerCase() === "set-cookie" && h.value.startsWith("fdb_acct") && /Max-Age=0/.test(h.value))).toEqual([]); // recovery cookie KEPT
  // The global logout did not happen, so the recovery session is still alive (and is NOT reported as a secured account). NOTE (observed, real GoTrue v2.197.0):
  // Auth itself already ends the account's other sessions when the password is updated inside a recovery session; the website does not rely on that
  // (hosted version unverified) and reports "secured" only after its own confirmed global logout.
  expect(await liveSessions(v.uid)).toBeGreaterThanOrEqual(1);
  const probe = await newClient(playwright);
  expect((await post(probe, "/account/api/login", { email: v.email, password: fresh })).status()).toBe(200);
  // sessions created AFTER the password update (the attacker who now knows nothing but already holds the old credentials cannot, but a Companion
  // signing in with the new password can): they are untouched by Auth's own side effect, so only the website's global logout can end them
  const late = await registeredSession(v.email, fresh);
  const lateWeb = await loginAgain(playwright, { email: v.email, password: fresh });
  expect((await rpc(late.token, "fdb_account_installations")).status).toBe(200);
  expect((await lateWeb.c.get("/account/api/me")).status()).toBe(200);
  // retry still failing: the same honest answer
  const again = await postChaos(site, "/account/api/reset-password/revoke", {});
  expect(again.status()).toBe(202);
  expect((await json<{ sessionsRevoked: boolean }>(again)).sessionsRevoked).toBe(false);
  // Auth recovers: finishing needs NO new password
  await chaos("pass");
  const fin = await postChaos(site, "/account/api/reset-password/revoke", {});
  expect(fin.status()).toBe(200);
  expect(await json(fin)).toEqual({ ok: true, sessionsRevoked: true, redirect: "/account/login?reason=password_reset" });
  expect(await liveSessions(v.uid)).toBe(0);
  expect((await attacker.c.get("/account/api/me")).status()).toBe(401);
  expect([(await rpc(companion.token, "fdb_account_installations")).status]).toEqual([401]);
  expect((await rpc(late.token, "fdb_account_installations")).status).toBe(401); // proves the retry sent the GLOBAL scope
  expect((await lateWeb.c.get("/account/api/me")).status()).toBe(401);
  expect((await post(await newClient(playwright), "/account/api/login", { email: v.email, password: fresh })).status()).toBe(200); // unchanged new password
  // the recovery session is gone: a further finish call is refused
  expect((await postChaos(site, "/account/api/reset-password/revoke", {})).status()).toBe(401);
});

test("partial success 2: the global logout TOOK EFFECT but its reply was lost (ambiguous) -> reported incomplete; recovery from a fresh link with the SAME password finishes without changing it", async ({ playwright }) => {
  const v = await webUser(playwright, "partD");
  const attacker = await loginAgain(playwright, v);
  const { cookie } = await recoverySession(playwright, v.email);
  const site = await onChaosSite(playwright, cookie);
  await chaos("drop-global-logout-response", true);
  const fresh = "ambiguous outcome passphrase 2026";
  const r = await postChaos(site, "/account/api/reset-password", { password: fresh });
  const state = await chaos("pass");
  expect(r.status()).toBe(202);
  expect(await json(r)).toMatchObject({ ok: false, error: "revocation_incomplete", sessionsRevoked: false });
  expect(state.globalLogouts).toBe(1);
  // the truth the website could not know: everything WAS revoked (the recovery session included)
  expect(await liveSessions(v.uid)).toBe(0);
  expect((await attacker.c.get("/account/api/me")).status()).toBe(401);
  // "finish" cannot prove anything with a dead recovery session: it says so and asks for a new link (it never claims success)
  const fin = await postChaos(site, "/account/api/reset-password/revoke", {});
  expect(fin.status()).toBe(401);
  expect(await json(fin)).toEqual({ ok: false, error: "recovery_required" });
  // new link, SAME password: no second password update is needed (Auth says "same password"), the revocation is re-run and CONFIRMED
  const second = await recoverySession(playwright, v.email);
  // (a different browser WITHOUT the marker is refused: an identical password is not a reset)
  const stranger = await post(second.c, "/account/api/reset-password", { password: fresh });
  expect(stranger.status()).toBe(422);
  expect(await json(stranger)).toMatchObject({ ok: false, error: "same_password" });
  // the same browser (marker cookie present) finishes it
  const marker = (await site.storageState()).cookies.find((x) => x.name === "fdb_reset");
  expect(marker, "the 202 set the sealed reset marker").toBeTruthy();
  const sameBrowser = await playwright.request.newContext({
    baseURL: "http://localhost:3210", extraHTTPHeaders: { "x-forwarded-for": "198.51.100.200" },
    storageState: { cookies: [{ ...marker!, domain: "localhost" }, { name: "fdb_acct", value: second.cookie, domain: "localhost", path: "/account", httpOnly: true, secure: false, sameSite: "Lax", expires: -1 }], origins: [] },
  });
  const done = await post(sameBrowser, "/account/api/reset-password", { password: fresh });
  expect(done.status()).toBe(200);
  expect(await json(done)).toEqual({ ok: true, passwordChanged: false, sessionsRevoked: true, redirect: "/account/login?reason=password_reset" });
  expect((await post(await newClient(playwright), "/account/api/login", { email: v.email, password: fresh })).status()).toBe(200);
});

test("the revoke endpoint is not a back door: it needs a live recovery session and CSRF, never accepts a normal session, and never takes a scope", async ({ playwright }) => {
  const v = await webUser(playwright, "revDoor");
  const other = await webUser(playwright, "revDoorO");
  // a NORMAL signed-in session cannot use it (it is recovery-only): 401, nothing revoked
  const normal = await post(v.c, "/account/api/reset-password/revoke", {});
  expect(normal.status()).toBe(401);
  expect(await liveSessions(v.uid)).toBeGreaterThanOrEqual(1);
  expect((await v.c.get("/account/api/me")).status()).toBe(200);
  // no cookie, no CSRF, extra fields (a scope), wrong method
  expect((await post(await newClient(playwright), "/account/api/reset-password/revoke", {})).status()).toBe(401);
  const rs = await recoverySession(playwright, v.email);
  expect((await post(rs.c, "/account/api/reset-password/revoke", {}, { csrf: "none" })).status()).toBe(403);
  for (const body of [{ scope: "others" }, { scope: "global" }, { everyone: true }]) expect((await post(rs.c, "/account/api/reset-password/revoke", body)).status()).toBe(400);
  expect((await rs.c.get("/account/api/reset-password/revoke")).status()).toBe(405);
  expect(await liveSessions(v.uid)).toBeGreaterThanOrEqual(1);
  expect((await other.c.get("/account/api/me")).status()).toBe(200); // another account is never affected
  // a recovery session of another account cannot revoke THIS account's sessions
  const ro = await recoverySession(playwright, other.email);
  expect((await post(ro.c, "/account/api/reset-password/revoke", {})).status()).toBe(409); // a recovery session alone, without a prior password change here
  expect((await v.c.get("/account/api/me")).status()).toBe(200);
  expect((await other.c.get("/account/api/me")).status()).toBe(200);
});

test("an identical password is not a reset: without a pending marker it is refused (422), nothing is revoked and nothing is claimed secure", async ({ playwright }) => {
  const v = await webUser(playwright, "sameP");
  const attacker = await loginAgain(playwright, v);
  const { c: rc } = await recoverySession(playwright, v.email);
  const r = await post(rc, "/account/api/reset-password", { password: v.password });
  expect(r.status()).toBe(422);
  expect(await json(r)).toEqual({ ok: false, error: "same_password" });
  expect((await attacker.c.get("/account/api/me")).status()).toBe(200); // not revoked: the password was never changed
  expect((await post(rc, "/account/api/reset-password/revoke", {})).status()).toBe(409); // and the finish endpoint refuses without a prior change
  expect(await json(await post(rc, "/account/api/reset-password/revoke", {}))).toEqual({ ok: false, error: "no_pending_reset" });
  expect((await attacker.c.get("/account/api/me")).status()).toBe(200);
});
