import { expect, test } from "@playwright/test";
import {
  JWT_EXP_SEC, clientWithCookie, cookieOf, json, newClient, openSessionCookie, post, sealSessionCookie, setCookies, signedInClient, sleep,
} from "./helpers";

/** Item 10 (token rotation, expiry, concurrent refresh) against real GoTrue with a short access-token lifetime. */

async function untilRefreshWindow(exp: number) {
  // The website refreshes once the access token has <= 15 s left (REFRESH_SKEW). Wait for that moment plus a margin.
  const wait = exp - 15 - Math.floor(Date.now() / 1000) + 1;
  if (wait > 0) await sleep(wait * 1000);
}

test("10a. the cookie is opaque; a refresh rotates the refresh token, keeps the session id and the absolute start", async ({ playwright }) => {
  const { c } = await signedInClient(playwright, "rot");
  const first = (await cookieOf(c))!;
  const before = (await openSessionCookie(first.value))!;

  /**
   * Deterministic structural checks that the cookie is sealed ciphertext, never a directly-readable
   * token - NOT a substring guess. A prior version asserted `.not.toMatch(/eyJ/)` ("no JWT visible"):
   * AES-256-GCM ciphertext is, by design, indistinguishable from random bytes, and "eyJ" is just one
   * specific 3-character sequence in the base64url alphabet. Over a ~200-500 char cookie that is a
   * roughly 1-in-500 to 1-in-1000 chance of a false failure on any given run with no security meaning
   * either way - its absence was never the actual property this test wanted to establish. These
   * checks instead hold by construction (seal()'s format) or by cryptographic guarantee (AES-GCM
   * authentication), so none of them can flake:
   */
  // Shape: `iv.ciphertext` (crypto.ts seal()) - two segments, never the three-segment
  // header.payload.signature shape of a JWT.
  const segments = first.value.split(".");
  expect(segments).toHaveLength(2);
  const iv = Buffer.from((segments[0] ?? "").replace(/-/g, "+").replace(/_/g, "/"), "base64");
  expect(iv.length).toBe(12); // AES-GCM IV size, not a JWT header
  // The payload is unrecoverable without the real key: decrypting with a different (but
  // well-formed) secret must fail outright on AES-GCM's authentication tag, every time.
  const { unseal } = await import("../../src/lib/account/crypto");
  expect(await unseal("a-completely-different-secret-0123456789abcdefgh", first.value, "fdb-acct-session-v1|fdb_acct")).toBeNull();
  // None of the real, known session fields appear as plaintext in the sealed value.
  for (const secretField of [before.uid, before.sid, before.at, before.rt]) {
    expect(first.value).not.toContain(secretField);
  }

  expect(before.k).toBe("user");
  expect(before.ex - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(JWT_EXP_SEC);

  await untilRefreshWindow(before.ex);
  const me = await c.get("/account/api/me");
  expect(me.status()).toBe(200);
  const rotated = setCookies(me).find((x) => x.name === "fdb_acct");
  expect(rotated, "a refresh must persist the rotated session").toBeDefined();
  const after = (await openSessionCookie(rotated!.value))!;
  expect(after.rt).not.toBe(before.rt);
  expect(after.at).not.toBe(before.at);
  expect(after.sid).toBe(before.sid); // same Auth session, so the CSRF binding survives a refresh
  expect(after.uid).toBe(before.uid);
  expect(after.sc).toBe(before.sc); // the absolute session start never slides
  expect(after.ex).toBeGreaterThan(before.ex);
  // The jar picked the new cookie up: the next call needs no refresh and sets nothing.
  const next = await c.get("/account/api/me");
  expect(next.status()).toBe(200);
  expect(setCookies(next).filter((x) => x.name === "fdb_acct")).toEqual([]);
});

test("10b. concurrent requests with an expired access token all succeed and converge on ONE rotated refresh token", async ({ playwright }) => {
  const { c } = await signedInClient(playwright, "conc");
  const before = (await openSessionCookie((await cookieOf(c))!.value))!;
  await untilRefreshWindow(before.ex);
  const replies = await Promise.all(Array.from({ length: 8 }, () => c.get("/account/api/me")));
  expect(replies.map((r) => r.status())).toEqual(Array(8).fill(200));
  const tokens = new Set<string>();
  for (const r of replies) for (const ck of setCookies(r).filter((x) => x.name === "fdb_acct")) tokens.add((await openSessionCookie(ck.value))!.rt);
  expect(tokens.size, "every concurrent refresh must end on the same successor token").toBe(1);
  expect(tokens.has(before.rt)).toBe(false);
  expect((await c.get("/account/api/me")).status()).toBe(200);
});

test("10c. a stale copy of an old cookie is refused and cleared (reuse beyond the window never authenticates)", async ({ playwright }) => {
  const { c } = await signedInClient(playwright, "reuse");
  const original = (await cookieOf(c))!.value;
  const p0 = (await openSessionCookie(original))!;
  // Two rotations, so the copied cookie's refresh token is two behind the live one.
  await untilRefreshWindow(p0.ex);
  expect((await c.get("/account/api/me")).status()).toBe(200);
  const p1 = (await openSessionCookie((await cookieOf(c))!.value))!;
  await untilRefreshWindow(p1.ex);
  expect((await c.get("/account/api/me")).status()).toBe(200);
  await sleep(11_000); // beyond Auth's refresh-token reuse interval (10 s in the stack)
  const thief = await clientWithCookie(playwright, original);
  const stolen = await thief.get("/account/api/me");
  expect(stolen.status()).toBe(401);
  expect(setCookies(stolen).some((x) => x.name === "fdb_acct" && x.flags["max-age"] === "0")).toBe(true);
  // What happens to the VICTIM is Auth's decision (GoTrue v2.197.0 answers the stale refresh with refresh_token_already_used and does
  // not terminate the live session); the invariant the website owns is that the stale copy never authenticates. Record the outcome.
  const live = (await openSessionCookie((await cookieOf(c))!.value))!;
  await untilRefreshWindow(live.ex);
  const victim = (await c.get("/account/api/me")).status();
  test.info().annotations.push({ type: "observed", description: `victim session after a stale-cookie replay: HTTP ${victim}` });
  expect([200, 401]).toContain(victim);
});

test("10d. expiry and tampering: absolute lifetime, foreign user on refresh, garbage and foreign-key cookies", async ({ playwright }) => {
  const a = await signedInClient(playwright, "exp-a");
  const b = await signedInClient(playwright, "exp-b");
  const pa = (await openSessionCookie((await cookieOf(a.c))!.value))!;
  const pb = (await openSessionCookie((await cookieOf(b.c))!.value))!;
  const now = Math.floor(Date.now() / 1000);

  // Older than the 30-day absolute limit: refused and cleared, however valid the tokens still are.
  const old = await clientWithCookie(playwright, await sealSessionCookie({ ...pa, sc: now - 31 * 86400 }));
  const oldReply = await old.get("/account/api/me");
  expect(oldReply.status()).toBe(401);
  expect(setCookies(oldReply).some((x) => x.name === "fdb_acct" && x.flags["max-age"] === "0")).toBe(true);

  // A session whose identity does not match the tokens it carries (uid of B, tokens of A, access token already expired to force
  // a refresh): the refresh answers for A, which is NOT the stored user, so it must end - never authenticate either account.
  const swapped = await clientWithCookie(playwright, await sealSessionCookie({ ...pa, uid: pb.uid, ex: now - 60 }));
  expect((await swapped.get("/account/api/me")).status()).toBe(401);
  // Same swap with a still-valid access token: the confirmed user (A) differs from the stored uid (B): refused.
  const swapped2 = await clientWithCookie(playwright, await sealSessionCookie({ ...pa, uid: pb.uid }));
  expect((await swapped2.get("/account/api/me")).status()).toBe(401);

  // Sealed with another key, truncated, empty, random: all unauthenticated, none of them reaches Auth as a credential.
  const { seal } = await import("../../src/lib/account/crypto");
  const foreign = await seal("another-secret-0123456789abcdefghijklmnopqrstuv", JSON.stringify(pa), "fdb-acct-session-v1|fdb_acct");
  for (const v of [foreign, (await cookieOf(a.c))!.value.slice(0, -4), "x", "a.b", `${pa.at}`, pa.rt]) {
    const t = await clientWithCookie(playwright, v);
    const r = await t.get("/account/api/me");
    expect(r.status(), v.slice(0, 12)).toBe(401);
  }
  // The honest sessions were never affected by any of the above.
  expect((await a.c.get("/account/api/me")).status()).toBe(200);
  expect((await b.c.get("/account/api/me")).status()).toBe(200);
  expect((await json(await b.c.get("/account/api/me"))).user).toMatchObject({ email: b.email });
  void newClient; void post;
});
