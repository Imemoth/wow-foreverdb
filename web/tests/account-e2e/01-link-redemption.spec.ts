import { expect, test } from "@playwright/test";
import { cookieOf, json, post, setCookies, newClient } from "../account/helpers";
import { PASSWORD, clientWithSessionCookie, companionWithInstallation, link, loginAgain, startClaim, webUser, uniqueEmail, waitForMail, openSessionCookie } from "./world";
import { admin, auth, claimRows, claimsOf, fingerprint, logoutLocal, ownerOf, registeredSession, resetBudgets, rpc, sessionCount, ingest, snapshot } from "./stack";
import type pg from "pg";

/**
 * Integrated acceptance: website redemption with the pre-hijack protection, against REAL GoTrue + REAL PostgREST + PostgreSQL.
 * Mandatory scenarios 1-14, 19-22 and the pre-hijack matrix. (The Companion is a test client holding real tokens.)
 */
let db: pg.Client;
test.beforeAll(async () => { db = await admin(); });
test.afterAll(async () => { await db.end(); });

test("1-8. registered account A signs in; the Companion's anonymous owner issues a code; the link page shows A's VERIFIED e-mail and never changes ownership on GET", async ({ playwright }) => {
  const a = await webUser(playwright, "acctA");
  const comp = await companionWithInstallation();
  const code = await startClaim(comp);
  expect(code).toMatch(/^[0-9A-F]{32}$/);

  // 3-4: the anonymous identity is a real anonymous Auth user with a session id; the installation exists and is owned by it
  expect(claimsOf(comp.id.token)).toMatchObject({ is_anonymous: true, role: "authenticated" });
  expect(claimsOf(comp.id.token).session_id).toBeTruthy();
  expect(await ownerOf(db, comp.installationId)).toBe(comp.id.uid);

  // 8: GET /account/link: form only, destination e-mail from the server-confirmed identity, no side effect, private headers
  const before = await claimRows(db, comp.installationId);
  const page = await a.c.get("/account/link");
  expect(page.status()).toBe(200);
  const html = await page.text();
  expect(html).toContain(a.email);
  expect(html).toContain("Installation linking code");
  expect(html).toContain("transferred");
  expect(html).not.toContain(code);
  expect(html).not.toContain(comp.installationId);
  expect(page.headers()["cache-control"]).toBe("private, no-store");
  expect(page.headers()["x-robots-tag"]).toBe("noindex, nofollow");
  expect(page.headers()["referrer-policy"]).toBe("no-referrer");
  expect(await ownerOf(db, comp.installationId)).toBe(comp.id.uid);
  expect((await claimRows(db, comp.installationId)).map((r) => r.status)).toEqual(before.map((r) => r.status));
  // a stray GET with the code in the query string does nothing: the query is dropped by a redirect and the code is never reflected
  const sneaky = await a.c.get(`/account/link?code=${code}`, { maxRedirects: 0 });
  expect(sneaky.status()).toBe(307);
  expect(sneaky.headers().location).toBe("/account/link");
  expect(await (await a.c.get(`/account/link?code=${code}`)).text()).not.toContain(code);
  expect(await ownerOf(db, comp.installationId)).toBe(comp.id.uid);
  // an anonymous visitor is sent to sign-in, with a safe return path
  const anon = await (await newClient(playwright)).get("/account/link", { maxRedirects: 0 });
  expect(anon.status()).toBeGreaterThanOrEqual(300);
  expect(anon.headers().location).toContain("/account/login?next=%2Faccount%2Flink");
});

test("9-11. no redemption without a fresh password: missing/empty/foreign/wrong password refuse, change nothing and leave no temporary session", async ({ playwright }) => {
  const a = await webUser(playwright, "acctA9");
  const b = await webUser(playwright, "acctB9");
  const comp = await companionWithInstallation();
  const code = await startClaim(comp);
  const sessionsBefore = await sessionCount(db, a.uid);
  const bSessionsBefore = await sessionCount(db, b.uid);
  const owned = async () => expect(await ownerOf(db, comp.installationId)).toBe(comp.id.uid);
  const pending = async () => expect((await claimRows(db, comp.installationId)).map((r) => r.status)).toEqual(["pending"]);

  // 9: structurally no password / no explicit confirmation -> refused before anything else
  for (const body of [{ code }, { code, confirm: true }, { code, password: "", confirm: true }, { code, password: PASSWORD }, { code, password: PASSWORD, confirm: false }, { password: PASSWORD, confirm: true }]) {
    const r = await post(a.c, "/account/api/link", body);
    expect(r.status(), JSON.stringify(Object.keys(body))).toBe(400);
    expect(await json(r)).toMatchObject({ ok: false, error: "invalid_input" });
  }
  await owned(); await pending();

  // 10: wrong password
  const wrong = await link(a.c, code, "this is definitely not the password");
  expect(wrong.status()).toBe(401);
  expect(await json(wrong)).toEqual({ ok: false, error: "reauth_failed" });
  await owned(); await pending();

  // 11: the password of ANOTHER registered account (B) typed into A's session: still refused, B is untouched
  const foreign = await link(a.c, code, b.password);
  expect(foreign.status()).toBe(401);
  expect(await json(foreign)).toEqual({ ok: false, error: "reauth_failed" });
  // ... and B's session typing A's password for A's code is refused as well (the e-mail is always the SESSION's own)
  const swapped = await link(b.c, code, a.password);
  expect(swapped.status()).toBe(401);
  await owned(); await pending();

  // no temporary Auth session survived any of the above (grant -> validate -> revoke), for either account
  expect(await sessionCount(db, a.uid)).toBe(sessionsBefore);
  expect(await sessionCount(db, b.uid)).toBe(bSessionsBefore);
  // the web sessions are still alive and unchanged
  const me = await a.c.get("/account/api/me");
  expect(me.status()).toBe(200);
  expect(await ownerOf(db, comp.installationId)).toBe(comp.id.uid);
});

test("pre-hijack: an attacker-registered account whose e-mail the victim later CONFIRMS cannot take an installation without the password the victim does not know", async ({ playwright }) => {
  // The attacker registers victim@... with a password only the attacker knows. The victim, who owns the address, clicks the
  // confirmation link (this is the R-M1 scenario). A confirmation alone must not authorise a transfer.
  const victimEmail = uniqueEmail("prehijack");
  const attackerPassword = "attacker-chosen password 7 7 7";
  const attacker = await newClient(playwright);
  expect((await post(attacker, "/account/api/register", { email: victimEmail, password: attackerPassword })).status()).toBe(202);
  const mail = await waitForMail(victimEmail, /confirm/i);
  const victimBrowser = await newClient(playwright);
  const conf = await post(victimBrowser, "/account/api/confirm", { type: mail.type, token_hash: mail.tokenHash });
  expect(conf.status()).toBe(200); // the victim's confirmation yields a session for the account the ATTACKER set up...
  const comp = await companionWithInstallation(); // ...and the victim has an installation they want to link
  const code = await startClaim(comp);
  const sessionsBefore = await sessionCount(db, (await openSessionCookie((await cookieOf(victimBrowser))!.value))!.uid);

  // The victim (or anyone using that confirmed session) does not know the account password: the transfer is refused.
  for (const guess of ["victim guess 1 1 1 1 1", "another guess 2 2 2 2"]) {
    const r = await link(victimBrowser, code, guess);
    expect(r.status()).toBe(401);
    expect(await json(r)).toEqual({ ok: false, error: "reauth_failed" });
  }
  expect(await ownerOf(db, comp.installationId)).toBe(comp.id.uid);
  expect((await claimRows(db, comp.installationId)).map((r) => r.status)).toEqual(["pending"]);
  expect(await sessionCount(db, (await openSessionCookie((await cookieOf(victimBrowser))!.value))!.uid)).toBe(sessionsBefore);
  // Only the password holder (the attacker) could redeem: this is exactly why the page displays the destination e-mail and why
  // the installation must only be linked to an account the user recognises as their own (documented, tested above).
  const page = await victimBrowser.get("/account/link");
  expect(await page.text()).toContain(victimEmail);
});

test("12. a revoked, replaced or stale web session cannot redeem; the pending claim survives", async ({ playwright }) => {
  const a = await webUser(playwright, "acctA12");
  const comp = await companionWithInstallation();
  const code = await startClaim(comp);

  // a SECOND web session of the same account, then A's FIRST session is revoked server-side (another device signed out / revoked)
  const second = await loginAgain(playwright, a);
  const copiedCookie = (await cookieOf(a.c))!.value; // what a thief who copied the browser state would hold
  expect(await logoutLocal(a.accessToken)).toBe(204);
  const stale = await link(a.c, code, a.password);
  expect(stale.status()).toBe(401);
  expect(await json(stale)).toEqual({ ok: false, error: "unauthenticated" });
  expect(await ownerOf(db, comp.installationId)).toBe(comp.id.uid);
  expect((await claimRows(db, comp.installationId)).map((r) => r.status)).toEqual(["pending"]);

  // a copied cookie of the revoked session (stolen browser state) is just as dead
  const thief = await clientWithSessionCookie(playwright, copiedCookie);
  const stolen = await post(thief, "/account/api/link", { code, password: a.password, confirm: true });
  expect(stolen.status()).toBe(401);
  expect(await ownerOf(db, comp.installationId)).toBe(comp.id.uid);

  // the account's other live session works and redeems (13 below is the full success path)
  const ok = await link(second.c, code, a.password);
  expect(ok.status()).toBe(200);
});

test("13-15. a valid redemption transfers the installation exactly once, A sees it and its Guildbook, B sees nothing, the temporary session is gone", async ({ playwright }) => {
  const a = await webUser(playwright, "acctA13");
  const b = await webUser(playwright, "acctB13");
  const comp = await companionWithInstallation({ guilds: 2, members: 4, tag: "AA" });
  const compB = await companionWithInstallation({ guilds: 2, members: 3, tag: "BB" }); // overlapping guild keys/names, different owner
  const code = await startClaim(comp);
  const sessionsBefore = await sessionCount(db, a.uid);
  const frozen = await fingerprint(db);

  const r = await link(a.c, code, a.password);
  expect(r.status()).toBe(200);
  const body = await json<{ ok: boolean; installationId: string; linkedAt: string; reauthCleanup: string }>(r);
  expect(body).toMatchObject({ ok: true, installationId: comp.installationId, reauthCleanup: "revoked" });
  expect(Number.isNaN(Date.parse(body.linkedAt))).toBe(false);
  // the web session cookie was not replaced by the temporary session (no Set-Cookie of the session on this response, or the same session id)
  const sc = setCookies(r).filter((x) => x.name === "fdb_acct");
  for (const c of sc) expect((await openSessionCookie(c.value))!.sid).toBe(a.sid);
  // ... and the temporary reauthentication session was revoked
  expect(await sessionCount(db, a.uid)).toBe(sessionsBefore);

  // 14: ownership changed exactly once; claim consumed; exactly one redeem audit row
  expect(await ownerOf(db, comp.installationId)).toBe(a.uid);
  expect((await claimRows(db, comp.installationId)).map((x) => x.status)).toEqual(["consumed"]);
  const audit = (await db.query("select event from private.account_audit where installation_id = $1 order by id", [comp.installationId])).rows.map((x) => x.event);
  expect(audit.filter((e) => e === "claim_redeemed")).toHaveLength(1);
  // history untouched (the one allowed difference is owner_user_id, which the fingerprint excludes)
  expect(await fingerprint(db)).toEqual({ ...frozen, ...(await fingerprint(db)) }); // shape guard
  const after = await fingerprint(db);
  for (const t of Object.keys(frozen)) if (t !== "public.installations") expect(after[t], t).toEqual(frozen[t]);

  // 15: A sees the installation and the Guildbook through the website; the page shows the id
  const list = await a.c.get("/account/api/installations");
  expect(list.status()).toBe(200);
  const listed = (await json<{ installations: { installationId: string; guildCount: number }[] }>(list)).installations;
  expect(listed.map((i) => i.installationId)).toEqual([comp.installationId]);
  expect(listed[0]!.guildCount).toBe(2);
  const pageHtml = await (await a.c.get("/account/installations")).text();
  expect(pageHtml).toContain(comp.installationId);
  expect(pageHtml).not.toContain(compB.installationId);
  const guilds = await json<{ guilds: { guildKey: string; guildName: string; memberCount: number }[] }>(await post(a.c, "/account/api/guildbook/guilds", { installationId: comp.installationId }));
  expect(guilds.guilds.map((g) => g.guildName).sort()).toEqual(["Guild 1", "Guild 2"]);
  const members = await json<{ members: Record<string, unknown>[]; pageSize: number }>(await post(a.c, "/account/api/guildbook/members", { installationId: comp.installationId, guildKey: guilds.guilds[0]!.guildKey, page: 0 }));
  expect(members.members).toHaveLength(4);
  expect(members.members.map((m) => m.name).every((n) => String(n).startsWith("AA"))).toBe(true);
  expect(Object.keys(members.members[0]!).sort()).toEqual(["classFile", "className", "lastOnlineHours", "level", "name", "online", "rank", "rankIndex", "zone"]);
  expect(JSON.stringify(members)).not.toMatch(/Player-|guid/i);

  // 16: B (registered, owns nothing) sees none of it; even with A's REAL installation id and guild key
  expect((await json<{ installations: unknown[] }>(await b.c.get("/account/api/installations"))).installations).toEqual([]);
  const bGuilds = await json<{ guilds: unknown[] }>(await post(b.c, "/account/api/guildbook/guilds", { installationId: comp.installationId }));
  expect(bGuilds.guilds).toEqual([]);
  const bMembers = await json<{ members: unknown[] }>(await post(b.c, "/account/api/guildbook/members", { installationId: comp.installationId, guildKey: guilds.guilds[0]!.guildKey, page: 0 }));
  expect(bMembers.members).toEqual([]);
  expect(await (await b.c.get("/account/installations")).text()).not.toContain(comp.installationId);
  // an installation owned by ANOTHER (anonymous) identity is not visible to A either
  const aOther = await json<{ guilds: unknown[] }>(await post(a.c, "/account/api/guildbook/guilds", { installationId: compB.installationId }));
  expect(aOther.guilds).toEqual([]);
});

test("17-19. the former anonymous owner loses ingest on the transferred installation, learns `transferred`; the account owner keeps ingesting without duplicates", async ({ playwright }) => {
  const a = await webUser(playwright, "acctA17");
  const b = await webUser(playwright, "acctB17");
  const comp = await companionWithInstallation();
  const second = await companionWithInstallation(); // a different installation of a DIFFERENT anonymous owner (control)
  const code = await startClaim(comp);
  expect((await link(a.c, code, a.password)).status()).toBe(200);
  await resetBudgets(db);

  // 17: the former owner can no longer ingest the installation; the error is an ordinary failure, not a success
  const denied = await ingest(comp.id.token, snapshot(comp.installationId, { updatedAt: 3000 }));
  expect(denied.status).toBeGreaterThanOrEqual(400);
  expect(JSON.stringify(denied.body)).toMatch(/belongs to another authenticated client/);
  // 19: the former owner is told `transferred`; the new owner `owned`; a stranger learns nothing
  expect((await rpc(comp.id.token, "fdb_installation_link_status", { p_installation_id: comp.installationId })).body).toEqual({ state: "transferred" });
  const aCompanion = await registeredSession(a.email, a.password); // the Companion signing in with the account (its OWN Auth session)
  expect((await rpc(aCompanion.token, "fdb_installation_link_status", { p_installation_id: comp.installationId })).body).toEqual({ state: "owned" });
  const bCompanion = await registeredSession(b.email, b.password);
  expect((await rpc(bCompanion.token, "fdb_installation_link_status", { p_installation_id: comp.installationId })).body).toEqual({ state: "unknown" });
  // a control: an unrelated anonymous owner of another installation still owns it
  expect((await rpc(second.id.token, "fdb_installation_link_status", { p_installation_id: second.installationId })).body).toEqual({ state: "owned" });

  // 18: the account owner continues ingestion: replaces rows, never duplicates them
  const count = async () => (await db.query("select (select count(*) from public.installation_item_stats where installation_id = $1)::int i, (select count(*) from public.installation_source_stats where installation_id = $1)::int s, (select count(*) from public.installation_location_stats where installation_id = $1)::int l, (select count(*) from public.installation_guild_members where installation_id = $1)::int m, (select count(*) from public.installation_guild_professions where installation_id = $1)::int p", [comp.installationId])).rows[0];
  const counts = await count();
  const ok = await ingest(aCompanion.token, snapshot(comp.installationId, { updatedAt: 2000, sources: 3, guilds: 2, members: 4 }));
  expect(ok.status).toBe(200);
  expect(ok.body.ok).toBe(true);
  expect(await count()).toEqual(counts);
  // and the former owner could not undo it
  await resetBudgets(db);
  expect((await ingest(comp.id.token, snapshot(comp.installationId, { updatedAt: 4000 }))).status).toBeGreaterThanOrEqual(400);
  expect(await ownerOf(db, comp.installationId)).toBe(a.uid);
});

test("20-22. consumed, expired, malformed, replaced and revoked codes all fail with the SAME answer; authentication failures are never 'invalid claim'", async ({ playwright }) => {
  const a = await webUser(playwright, "acctA20");
  const b = await webUser(playwright, "acctB20");
  const d = await webUser(playwright, "acctD20");
  const c1 = await companionWithInstallation();
  const code1 = await startClaim(c1);
  expect((await link(a.c, code1, a.password)).status()).toBe(200);

  // consumed: replay by the same account and by another account
  const replayA = await link(a.c, code1, a.password);
  const replayB = await link(b.c, code1, b.password);
  // never-issued (random) code
  const random = await link(b.c, "ABCDEF0123456789ABCDEF0123456789", b.password);
  // expired
  const c2 = await companionWithInstallation();
  const code2 = await startClaim(c2);
  await db.query("update private.installation_claims set expires_at = now() - interval '1 minute' where installation_id = $1", [c2.installationId]);
  const expired = await link(b.c, code2, b.password);
  // replaced: a newer code for the same installation invalidates the older one
  const c3 = await companionWithInstallation();
  const old3 = await startClaim(c3);
  await resetBudgets(db);
  const new3 = await startClaim(c3);
  const replaced = await link(b.c, old3, b.password);
  // revoked: the ISSUING session signs out (22): the pending code dies with it
  const c4 = await companionWithInstallation();
  const code4 = await startClaim(c4);
  expect(await logoutLocal(c4.id.token)).toBe(204);
  const revoked = await link(b.c, code4, b.password);

  const answers = await Promise.all([replayA, replayB, random, expired, replaced, revoked].map(async (r) => ({ status: r.status(), body: await r.text() })));
  for (const x of answers) expect(x).toEqual({ status: 422, body: JSON.stringify({ ok: false, error: "invalid_claim" }) });
  // nothing moved
  expect(await ownerOf(db, c2.installationId)).toBe(c2.id.uid);
  expect(await ownerOf(db, c3.installationId)).toBe(c3.id.uid);
  expect(await ownerOf(db, c4.installationId)).toBe(c4.id.uid);
  expect(await ownerOf(db, c1.installationId)).toBe(a.uid);
  // the replacing code (new3) still works for whoever redeems it with a password
  expect((await link(d.c, new3, d.password)).status()).toBe(200);
  expect(await ownerOf(db, c3.installationId)).toBe(d.uid);

  // malformed: rejected locally with a format answer, nothing is sent to the database (no budget burnt, no claim looked up)
  const budgetsBefore = (await db.query("select count(*)::int n from private.foreverdb_api_budgets where bucket like 'claim%'")).rows[0].n;
  const b2 = await loginAgain(playwright, b); // a new browser (the edge budget is per address)
  for (const bad of ["", "short", "ZZZZ0123456789ABCDEF0123456789ABCD", "0123456789ABCDEF0123456789ABCDEF0", "FDB-0123"]) {
    const r = await post(b2.c, "/account/api/link", { code: bad, password: b.password, confirm: true });
    expect([400]).toContain(r.status());
  }
  expect((await db.query("select count(*)::int n from private.foreverdb_api_budgets where bucket like 'claim%'")).rows[0].n).toBe(budgetsBefore);

  // authentication failures are NOT claim failures: no cookie -> 401 unauthenticated, CSRF-less -> 403
  const noSession = await post(await newClient(playwright), "/account/api/link", { code: new3, password: PASSWORD, confirm: true });
  expect(noSession.status()).toBe(401);
  expect(await json(noSession)).toEqual({ ok: false, error: "unauthenticated" });
  const noCsrf = await post(a.c, "/account/api/link", { code: new3, password: a.password, confirm: true }, { csrf: "none" });
  expect(noCsrf.status()).toBe(403);
});

test("12b/25. recovery and password-reset sessions cannot bypass fresh authentication", async ({ playwright }) => {
  const a = await webUser(playwright, "acctA25");
  const comp = await companionWithInstallation();
  const code = await startClaim(comp);

  // request a recovery mail, open the link: a RECOVERY session (kind=recovery cookie) - it opens nothing but the reset form
  const rc = await newClient(playwright);
  expect((await post(rc, "/account/api/forgot-password", { email: a.email })).status()).toBe(202);
  const mail = await waitForMail(a.email, /reset|recover|password/i);
  const conf = await post(rc, "/account/api/confirm", { type: "recovery", token_hash: mail.tokenHash });
  expect(conf.status()).toBe(200);
  expect(await json(conf)).toMatchObject({ kind: "recovery" });
  const viaRecovery = await link(rc, code, a.password);
  expect(viaRecovery.status()).toBe(401); // a recovery-only session is not a user session
  expect(await json(viaRecovery)).toEqual({ ok: false, error: "unauthenticated" });
  expect((await rc.get("/account/api/installations")).status()).toBe(401);
  expect(await ownerOf(db, comp.installationId)).toBe(comp.id.uid);

  // password reset inside the recovery session; the recovery session ends; the NEW password is what link now requires
  const newPassword = "brand new password 4 4 4 4";
  const reset = await post(rc, "/account/api/reset-password", { password: newPassword });
  expect(reset.status()).toBe(200);
  const fresh = await newClient(playwright);
  expect((await post(fresh, "/account/api/login", { email: a.email, password: newPassword })).status()).toBe(200);
  expect((await link(fresh, code, a.password)).status()).toBe(401); // the OLD password no longer confirms anything
  expect(await ownerOf(db, comp.installationId)).toBe(comp.id.uid);
  expect((await link(fresh, code, newPassword)).status()).toBe(200);
  expect(await ownerOf(db, comp.installationId)).toBe(a.uid);
});

test("24. website logout is session-local: it neither revokes the Companion's sessions (anonymous or registered) nor the account's other web sessions", async ({ playwright }) => {
  const a = await webUser(playwright, "acctA24");
  const comp = await companionWithInstallation();
  const code = await startClaim(comp);
  expect((await link(a.c, code, a.password)).status()).toBe(200);
  const registeredCompanion = await registeredSession(a.email, a.password);
  const otherWeb = await loginAgain(playwright, a);
  const out = await post(a.c, "/account/api/logout", {});
  expect(out.status()).toBe(200);
  expect(await json(out)).toMatchObject({ ok: true, revoked: true });
  // the website session is gone ...
  expect((await a.c.get("/account/api/me")).status()).toBe(401);
  // ... the Companion's registered session, its anonymous session and the account's other web session all still work
  await resetBudgets(db);
  expect((await rpc(registeredCompanion.token, "fdb_account_installations")).status).toBe(200);
  expect((await rpc(comp.id.token, "fdb_installation_link_status", { p_installation_id: comp.installationId })).status).toBe(200);
  expect((await otherWeb.c.get("/account/api/me")).status()).toBe(200);
});

test("26. concurrent redemption of one code is atomic: exactly one winner, one owner change, one audit row", async ({ playwright }) => {
  const a = await webUser(playwright, "acctA26");
  const b = await webUser(playwright, "acctB26");
  const comp = await companionWithInstallation();
  const code = await startClaim(comp);
  const results = await Promise.all([link(a.c, code, a.password), link(b.c, code, b.password), link((await loginAgain(playwright, a)).c, code, a.password), link((await loginAgain(playwright, b)).c, code, b.password)]);
  const statuses = results.map((r) => r.status()).sort();
  expect(statuses.filter((s) => s === 200)).toHaveLength(1);
  expect(statuses.filter((s) => s === 422)).toHaveLength(3);
  const owner = await ownerOf(db, comp.installationId);
  expect([a.uid, b.uid]).toContain(owner);
  expect((await claimRows(db, comp.installationId)).map((x) => x.status)).toEqual(["consumed"]);
  const audit = (await db.query("select event from private.account_audit where installation_id = $1", [comp.installationId])).rows.map((x) => x.event);
  expect(audit.filter((e) => e === "claim_redeemed")).toHaveLength(1);
  void auth;
});
