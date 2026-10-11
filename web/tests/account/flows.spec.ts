import { expect, test } from "@playwright/test";
import {
  PASSWORD, authDirect, clearMail, clientWithCookie, cookieOf, countMail, json, jwtClaims, newClient, post, setCookies, signedInClient, sleep, uniqueEmail, waitForMail,
} from "./helpers";

/**
 * Real-GoTrue acceptance, core flows (items 1-9 of the PR B acceptance list). Everything goes through the website's
 * /account/api/* backend-for-frontend against a real Auth server and captured mail: no mocks.
 */
test.beforeAll(async () => { await clearMail(); });

test("1-2. registration, captured confirmation mail, GET interstitial has no side effect, explicit POST confirms once", async ({ playwright }) => {
  const email = uniqueEmail("reg");
  const c = await newClient(playwright);
  const reg = await post(c, "/account/api/register", { email, password: PASSWORD });
  expect(reg.status()).toBe(202);
  expect(await json(reg)).toEqual({ ok: true, status: "check_email" });
  expect(setCookies(reg).filter((x) => x.name === "fdb_acct")).toEqual([]); // registration never signs in

  const mail = await waitForMail(email, /confirm/i);
  // The link goes to OUR page (server-computed callback), carries a token_hash and no session.
  expect(mail.link).toMatch(/^http:\/\/localhost:3210\/account\/auth\/confirm\?token_hash=[0-9a-f]{20,}&type=email$/);

  // A mail scanner prefetching the link (any number of GETs) must not consume the one-time token.
  for (let i = 0; i < 3; i += 1) {
    const scan = await c.get(`/account/auth/confirm?token_hash=${mail.tokenHash}&type=email`);
    expect(scan.status()).toBe(200);
    expect(setCookies(scan).filter((x) => x.name === "fdb_acct")).toEqual([]);
    expect(await scan.text()).toContain("Confirm email address");
  }
  const noSession = await post(c, "/account/api/login", { email, password: PASSWORD });
  expect(noSession.status()).toBe(401); // still unconfirmed after the scans

  const ok = await post(c, "/account/api/confirm", { type: mail.type, token_hash: mail.tokenHash });
  expect(ok.status()).toBe(200);
  expect(await json(ok)).toEqual({ ok: true, kind: "user", redirect: "/account?welcome=1" });
  expect(setCookies(ok).some((x) => x.name === "fdb_acct" && x.value.length > 50)).toBe(true);

  const replay = await post(await newClient(playwright), "/account/api/confirm", { type: mail.type, token_hash: mail.tokenHash });
  expect(replay.status()).toBe(400);
  expect(await json(replay)).toMatchObject({ ok: false, error: "invalid_or_expired" });
});

test("3. unverified users get no session, and the website hides Auth's distinct 'not confirmed' answer", async ({ playwright }) => {
  const email = uniqueEmail("unv");
  const c = await newClient(playwright);
  await post(c, "/account/api/register", { email, password: PASSWORD });
  // Real Auth refuses an unconfirmed password sign-in, and says so distinctly (an enumeration oracle if forwarded):
  const direct = await authDirect("/auth/v1/token?grant_type=password", { body: { email, password: PASSWORD } });
  expect(direct.status).toBe(400);
  expect(direct.data.error_code).toBe("email_not_confirmed");
  const ghost = await authDirect("/auth/v1/token?grant_type=password", { body: { email: uniqueEmail("ghost"), password: PASSWORD } });
  expect(ghost.data.error_code).toBe("invalid_credentials");
  // The website answers all three failures identically.
  const a = await post(await newClient(playwright), "/account/api/login", { email, password: PASSWORD });
  const b = await post(await newClient(playwright), "/account/api/login", { email: uniqueEmail("ghost"), password: PASSWORD });
  const w = await post(await newClient(playwright), "/account/api/login", { email, password: "wrong wrong wrong wrong" });
  for (const r of [a, b, w]) expect(r.status()).toBe(401);
  expect(await a.text()).toBe(await b.text());
  expect(await b.text()).toBe(await w.text());
  expect(setCookies(a).filter((x) => x.name === "fdb_acct")).toEqual([]);
  // No cookie, no account data.
  const me = await (await newClient(playwright)).get("/account/api/me");
  expect(me.status()).toBe(401);
});

test("4. valid login, server-confirmed profile, closed redirect allowlist for `next`", async ({ playwright }) => {
  const { c, email, password } = await signedInClient(playwright, "login");
  const out = await newClient(playwright);
  const ok = await post(out, "/account/api/login", { email, password });
  expect(ok.status()).toBe(200);
  expect(await json(ok)).toEqual({ ok: true, redirect: "/account" });
  const me = await out.get("/account/api/me");
  expect(me.status()).toBe(200);
  expect(await json(me)).toMatchObject({ ok: true, user: { email, emailVerified: true } });
  // Mixed case / padding in the address still signs the same user in. (Each sign-in counts toward the per-address budget of 10.)
  const again = await post(await newClient(playwright), "/account/api/login", { email: `  ${email.toUpperCase()} `, password });
  expect(again.status()).toBe(200);
  // `next`: only an exact allowlisted pathname survives.
  const nexts: [string, string][] = [
    ["/account/guildbook", "/account/guildbook"],
    ["/account/guildbook?x=1#y", "/account/guildbook"],
    ["https://evil.example/", "/account"],
    ["//evil.example", "/account"],
    ["/\\evil.example", "/account"],
    ["%2f%2fevil.example", "/account"],
    ["javascript:alert(1)", "/account"],
  ];
  for (const [next, want] of nexts) {
    const r = await post(await newClient(playwright), "/account/api/login", { email, password, next });
    expect((await json<{ redirect: string }>(r)).redirect, next).toBe(want);
  }
  await c.dispose();
});

test("4b. signing in again in the same browser revokes the session it replaces (no orphaned live session)", async ({ playwright }) => {
  const { c, email, password } = await signedInClient(playwright, "replace");
  const first = (await cookieOf(c))!.value;
  expect((await post(c, "/account/api/login", { email, password })).status()).toBe(200);
  const second = (await cookieOf(c))!.value;
  expect(second).not.toBe(first);
  expect((await c.get("/account/api/me")).status()).toBe(200);
  const old = await clientWithCookie(playwright, first);
  expect((await old.get("/account/api/me")).status()).toBe(401); // the replaced session is dead server-side
});

test("5. invalid login: one generic answer, per-email throttle independent of IP, per-IP edge throttle", async ({ playwright }) => {
  const { email } = await signedInClient(playwright, "thr");
  // Wrong password against an existing and a non-existing address: byte-identical.
  const wrong = await post(await newClient(playwright), "/account/api/login", { email, password: "definitely not it 1" });
  const none = await post(await newClient(playwright), "/account/api/login", { email: uniqueEmail("nobody"), password: "definitely not it 1" });
  expect(wrong.status()).toBe(401);
  expect(await wrong.text()).toBe(await none.text());
  // Per-email budget (10 / 15 min) spans IPs: a distributed attacker is still stopped. 9 more attempts from fresh IPs, then refusal.
  let last = 0;
  for (let i = 0; i < 10; i += 1) last = (await post(await newClient(playwright), "/account/api/login", { email, password: "definitely not it 2" })).status();
  expect(last).toBe(429);
  const reply = await post(await newClient(playwright), "/account/api/login", { email, password: "definitely not it 2" });
  expect(await json(reply)).toMatchObject({ error: "too_many_attempts" });
  // ...and the same throttle answers for a non-existing address after the same number of tries (no existence oracle).
  const ghost = uniqueEmail("ghostthr");
  for (let i = 0; i < 10; i += 1) await post(await newClient(playwright), "/account/api/login", { email: ghost, password: "definitely not it 3" });
  expect((await json(await post(await newClient(playwright), "/account/api/login", { email: ghost, password: "x y z x y z x y z" }))).error).toBe("too_many_attempts");
  // Per-IP edge budget (10 strict calls / 5 min): the 11th from ONE address is refused by the proxy before any handler runs.
  const one = await newClient(playwright);
  const codes: number[] = [];
  for (let i = 0; i < 12; i += 1) codes.push((await post(one, "/account/api/login", { email: uniqueEmail("ip"), password: "definitely not it 4" })).status());
  expect(codes.slice(0, 10).every((s) => s === 401)).toBe(true);
  expect(codes[10]).toBe(429);
  const limited = await post(one, "/account/api/login", { email: uniqueEmail("ip"), password: "definitely not it 4" });
  expect(limited.headers()["retry-after"]).toMatch(/^\d+$/);
  expect(limited.headers()["cache-control"]).toContain("no-store");
});

test("6. logout revokes the current session server-side; the old cookie is dead everywhere", async ({ playwright }) => {
  const { c, email, password } = await signedInClient(playwright, "logout");
  const cookie = (await c.storageState()).cookies.find((x) => x.name === "fdb_acct")!;
  expect((await c.get("/account/api/me")).status()).toBe(200);
  const out = await post(c, "/account/api/logout", {});
  expect(out.status()).toBe(200);
  expect(await json(out)).toEqual({ ok: true, revoked: true });
  // The cookie is cleared on both paths (and every chunk name) ...
  const cleared = setCookies(out).filter((x) => x.name.startsWith("fdb_acct"));
  expect(cleared.some((x) => x.name === "fdb_acct" && x.flags.path === "/account" && x.flags["max-age"] === "0")).toBe(true);
  expect(cleared.some((x) => x.name === "fdb_acct" && x.flags.path === "/" && x.flags["max-age"] === "0")).toBe(true);
  expect(cleared.filter((x) => x.flags.path === "/account").map((x) => x.name).sort()).toEqual(["fdb_acct", "fdb_acct.1", "fdb_acct.2", "fdb_acct.3", "fdb_acct.4", "fdb_acct.5"]);
  expect((await c.get("/account/api/me")).status()).toBe(401);
  // ... and even a thief replaying the OLD cookie value is refused: Auth revoked the session (server-confirmed), refresh fails too.
  const thief = await playwright.request.newContext({ baseURL: "http://localhost:3210", extraHTTPHeaders: { "x-forwarded-for": "198.51.100.77", cookie: `fdb_acct=${cookie.value}` } });
  for (let i = 0; i < 2; i += 1) expect((await thief.get("/account/api/me")).status()).toBe(401);
  // A fresh login still works (only that one session was revoked).
  expect((await post(await newClient(playwright), "/account/api/login", { email, password })).status()).toBe(200);
});

test("7. sessions stay independent: a website logout does not touch a Companion-style or anonymous session (and vice versa)", async ({ playwright }) => {
  const { c, email, password } = await signedInClient(playwright, "indep");
  // A second session of the SAME account created directly against Auth (what the Companion's registered sign-in does)...
  const companion = await authDirect("/auth/v1/token?grant_type=password", { body: { email, password } });
  expect(companion.status).toBe(200);
  const companionAt = companion.data.access_token as string;
  // ...and an anonymous session (the Companion's existing anonymous mode).
  const anon = await authDirect("/auth/v1/signup", { body: {} });
  expect(anon.status).toBe(200);
  const anonAt = anon.data.access_token as string;
  expect(jwtClaims(anonAt).is_anonymous).toBe(true);
  expect(typeof jwtClaims(companionAt).session_id).toBe("string"); // live-session guards (PR C) rely on this claim

  expect((await post(c, "/account/api/logout", {})).status()).toBe(200);

  expect((await authDirect("/auth/v1/user", { method: "GET", bearer: companionAt })).status).toBe(200);
  expect((await authDirect("/auth/v1/user", { method: "GET", bearer: anonAt })).status).toBe(200);
  const refreshed = await authDirect("/auth/v1/token?grant_type=refresh_token", { body: { refresh_token: companion.data.refresh_token } });
  expect(refreshed.status).toBe(200);
  // The reverse direction: a Companion-side sign-out must not end the website session.
  const web = await newClient(playwright);
  expect((await post(web, "/account/api/login", { email, password })).status()).toBe(200);
  expect((await authDirect("/auth/v1/logout?scope=local", { bearer: refreshed.data.access_token as string })).status).toBe(204);
  expect((await web.get("/account/api/me")).status()).toBe(200);
});

test("8-9. recovery: generic answers, interstitial, explicit POST, restricted recovery session, reset and re-login", async ({ playwright }) => {
  const { email, password } = await signedInClient(playwright, "rec");
  const other = await signedInClient(playwright, "rec-other");
  await clearMail();
  const c = await newClient(playwright);
  const known = await post(c, "/account/api/forgot-password", { email });
  const unknown = await post(await newClient(playwright), "/account/api/forgot-password", { email: uniqueEmail("nobody-rec") });
  expect(known.status()).toBe(202);
  expect(await known.text()).toBe(await unknown.text());
  const mail = await waitForMail(email, /reset|password/i);
  expect(mail.type).toBe("recovery");
  expect(mail.link).toMatch(/^http:\/\/localhost:3210\/account\/auth\/confirm\?token_hash=/);
  expect(await countMail(email)).toBe(1);

  // Scanner GETs do nothing; the explicit POST yields a RECOVERY session.
  expect((await c.get(`/account/auth/confirm?token_hash=${mail.tokenHash}&type=recovery`)).status()).toBe(200);
  const conf = await post(c, "/account/api/confirm", { type: "recovery", token_hash: mail.tokenHash });
  expect(await json(conf)).toEqual({ ok: true, kind: "recovery", redirect: "/account/reset-password" });
  const rc = setCookies(conf).find((x) => x.name === "fdb_acct")!;
  expect(Number(rc.flags["max-age"])).toBeLessThanOrEqual(900); // a recovery session is short-lived
  // A recovery session is NOT a login: it opens no account page or API.
  expect((await c.get("/account/api/me")).status()).toBe(401);
  // A recovery token cannot be replayed.
  expect((await post(await newClient(playwright), "/account/api/confirm", { type: "recovery", token_hash: mail.tokenHash })).status()).toBe(400);

  // Weak / identical passwords are refused; the real reset succeeds and ends the recovery session.
  expect((await post(c, "/account/api/reset-password", { password: "short" })).status()).toBe(400);
  expect((await post(c, "/account/api/reset-password", { password })).status()).toBe(422); // same password
  const fresh = "a brand new passphrase 2026";
  const done = await post(c, "/account/api/reset-password", { password: fresh });
  expect(done.status()).toBe(200);
  expect(await json(done)).toEqual({ ok: true, redirect: "/account/login?reason=password_reset" });
  expect((await post(c, "/account/api/reset-password", { password: "yet another passphrase 1" })).status()).toBe(401); // session ended
  expect((await post(await newClient(playwright), "/account/api/login", { email, password })).status()).toBe(401);
  expect((await post(await newClient(playwright), "/account/api/login", { email, password: fresh })).status()).toBe(200);
  // Another account is unaffected.
  expect((await other.c.get("/account/api/me")).status()).toBe(200);
});

test("resend confirmation is generic and sends one mail only for a pending address", async ({ playwright }) => {
  const email = uniqueEmail("resend");
  await post(await newClient(playwright), "/account/api/register", { email, password: PASSWORD });
  await waitForMail(email, /confirm/i);
  await sleep(1300); // GoTrue's own per-address send gap (1 s in the test stack)
  const a = await post(await newClient(playwright), "/account/api/resend", { email });
  const b = await post(await newClient(playwright), "/account/api/resend", { email: uniqueEmail("never") });
  expect(a.status()).toBe(202);
  expect(await a.text()).toBe(await b.text());
  const start = Date.now();
  while ((await countMail(email)) < 2 && Date.now() - start < 8000) await sleep(250);
  expect(await countMail(email)).toBe(2);
});
