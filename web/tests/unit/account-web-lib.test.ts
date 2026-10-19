import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "@/lib/security/rate-limit";
import { auth, callbackUrlFor } from "@/lib/account/auth-client";
import type { AccountAuthConfig } from "@/lib/account/config";
import { b64urlDecode, b64urlEncode, hmacB64, seal, timingSafeEqualStr, unseal, unverifiedJwtPayload } from "@/lib/account/crypto";
import { CSRF_TTL_SEC, checkCsrf, csrfBinding, currentOrNewCsrf, mintCsrf, originAllowed, verifyCsrf } from "@/lib/account/csrf";
import { INPUTS } from "@/lib/account/inputs";
import { EMAIL_LIMITS, __setAccountStoreForTests, chargeEmail } from "@/lib/account/limits";
import { messageFor } from "@/lib/account/messages";
import {
  RECOVERY_SESSION_MAX_SEC, SESSION_ABSOLUTE_MAX_SEC, clearSession, cookieNames, fromAuthSession, jarFrom, readSession, recoverySessionActive,
  resolveSession, serializeCookie, writeSession, type StoredSession,
} from "@/lib/account/session";
import { verifyTurnstile } from "@/lib/account/turnstile";
import { classifyRequest, isStrictRule, loadRules } from "@/lib/security/rate-limit";

/**
 * UNIT tests (a stubbed `fetch` stands in for Auth where Auth is involved). They prove the website's own logic, branch by
 * branch; they are NOT evidence of real Auth behaviour: that is tests/account/*.spec.ts against real GoTrue.
 */
const SECRET = "unit-test-secret-0123456789abcdefghijklmnopqrstuvwxyz";
const UID = "123e4567-e89b-42d3-a456-426614174000";
const OTHER = "223e4567-e89b-42d3-a456-426614174000";
const cfg: AccountAuthConfig = { mode: "local", authOrigin: "http://127.0.0.1:54321", projectRef: null, publishableKey: "sb_publishable_unit_key_not_real", csrfSecret: SECRET };

const jwt = (claims: Record<string, unknown>) => {
  const enc = (o: unknown) => b64urlEncode(new TextEncoder().encode(JSON.stringify(o)));
  return `${enc({ alg: "HS256" })}.${enc(claims)}.${"s".repeat(43)}`;
};
const NOW = 1_800_000_000;
const user = (over: Record<string, unknown> = {}) => ({ id: UID, email: "a@example.test", email_confirmed_at: "2026-01-01T00:00:00Z", created_at: "2026-01-01T00:00:00Z", is_anonymous: false, ...over });
const authSession = (over: Record<string, unknown> = {}, uid = UID) => ({
  access_token: jwt({ exp: NOW + 3600, session_id: "sess-1", sub: uid }), refresh_token: "refresh-token-new", expires_in: 3600, expires_at: NOW + 3600, token_type: "bearer", user: user({ id: uid }), ...over,
});
const stored = (over: Partial<StoredSession> = {}): StoredSession => ({ v: 1, k: "user", uid: UID, at: jwt({ exp: NOW + 3600, session_id: "sess-1" }), rt: "refresh-token-old", ex: NOW + 3600, sid: "sess-1", sc: NOW - 100, rf: NOW - 100, ...over });

type Reply = { status: number; body?: unknown; throws?: boolean; raw?: string };
function stubAuth(routes: Record<string, Reply | Reply[]>) {
  const calls: { method: string; url: string; headers: Record<string, string>; body: unknown }[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const key = Object.keys(routes).find((k) => url.includes(k));
    calls.push({ method: init?.method ?? "GET", url, headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (!key) throw new Error(`unexpected Auth call ${url}`);
    const entry = routes[key]!;
    const r = Array.isArray(entry) ? (entry.length > 1 ? entry.shift()! : entry[0]!) : entry;
    if (r.throws) throw new Error("network down");
    return new Response(r.raw ?? (r.status === 204 ? null : JSON.stringify(r.body ?? {})), { status: r.status, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); __setAccountStoreForTests(null); });

const jar = (all: Record<string, string>) => jarFrom(() => Object.entries(all).map(([name, value]) => ({ name, value })));
class Sink { headers: string[] = []; append(_: string, v: string) { this.headers.push(v); } cookies() { return Object.fromEntries(this.headers.filter((h) => !/Max-Age=0/.test(h)).map((h) => [h.split("=")[0]!, h.slice(h.indexOf("=") + 1).split(";")[0]!])); } }

describe("crypto helpers", () => {
  it("base64url round-trips and rejects malformed input", () => {
    for (const n of [0, 1, 2, 3, 31, 32, 33, 1000]) { const b = crypto.getRandomValues(new Uint8Array(n)); expect([...b64urlDecode(b64urlEncode(b))!]).toEqual([...b]); }
    for (const bad of ["a", "ab+c", "ab=c", "a b", "é"]) expect(b64urlDecode(bad)).toBeNull();
  });
  it("seal / unseal: authentic round trip, AAD binding, tamper, truncation and wrong key all fail closed", async () => {
    const s = await seal(SECRET, "hello", "aad-1");
    expect(await unseal(SECRET, s, "aad-1")).toBe("hello");
    expect(await unseal(SECRET, s, "aad-2")).toBeNull();
    expect(await unseal(`${SECRET}x`, s, "aad-1")).toBeNull();
    const [iv, ct] = s.split(".");
    expect(await unseal(SECRET, `${iv}.${ct!.slice(0, -2)}A`, "aad-1")).toBeNull();
    expect(await unseal(SECRET, `${iv}.${ct!.slice(0, 5)}`, "aad-1")).toBeNull();
    expect(await unseal(SECRET, "nodot", "aad-1")).toBeNull();
    expect(await unseal(SECRET, "", "aad-1")).toBeNull();
    expect(await seal(SECRET, "hello", "aad-1")).not.toBe(s); // random IV
  });
  it("purpose-separated keys: the CSRF MAC key is not the throttle hash key", async () => {
    expect(await hmacB64(SECRET, "csrf-mac", "x")).not.toBe(await hmacB64(SECRET, "throttle-hash", "x"));
    expect(await hmacB64(SECRET, "csrf-mac", "x")).toBe(await hmacB64(SECRET, "csrf-mac", "x"));
  });
  it("constant-time comparison and the unverified-JWT reader", () => {
    expect(timingSafeEqualStr("abc", "abc")).toBe(true);
    expect(timingSafeEqualStr("abc", "abd")).toBe(false);
    expect(timingSafeEqualStr("abc", "abcd")).toBe(false);
    expect(unverifiedJwtPayload(jwt({ exp: 5, session_id: "x" }))).toEqual({ exp: 5, session_id: "x" });
    for (const bad of ["", "a.b", "a.!.c", "a.e30.c.d", "x.WzFd.y"]) expect(unverifiedJwtPayload(bad)).toBeNull();
  });
});

describe("cookies", () => {
  it("names follow the scheme; serialisation carries every attribute (Expires only for deletion)", () => {
    expect(cookieNames(true)).toEqual({ session: "__Secure-fdb_acct", csrf: "__Secure-fdb_csrf" });
    expect(cookieNames(false)).toEqual({ session: "fdb_acct", csrf: "fdb_csrf" });
    expect(serializeCookie("n", "v", { httpOnly: true, secure: true, sameSite: "Lax", path: "/account", maxAge: 60 })).toBe("n=v; Path=/account; Max-Age=60; HttpOnly; Secure; SameSite=Lax");
    expect(serializeCookie("n", "", { httpOnly: true, secure: false, sameSite: "Strict", path: "/", maxAge: 0 })).toBe("n=; Path=/; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Strict");
  });
  it("https session cookie: __Secure- name, HttpOnly, Secure, SameSite=Lax, Path=/account, sliding 14 days; value is opaque", async () => {
    const sink = new Sink();
    const session = stored();
    await writeSession(SECRET, sink, jar({}), true, session);
    expect(sink.headers).toHaveLength(1);
    expect(sink.headers[0]).toMatch(/^__Secure-fdb_acct=[A-Za-z0-9_.-]+; Path=\/account; Max-Age=1209600; HttpOnly; Secure; SameSite=Lax$/);
    const value = sink.cookies()["__Secure-fdb_acct"]!;
    expect(value.split(".")).toHaveLength(2);
    expect(value).not.toBe(session.at);
    expect(value).not.toBe(session.rt);
    expect(unverifiedJwtPayload(value)).toBeNull();
    expect(await readSession(SECRET, jar(sink.cookies()), true)).toEqual({ present: true, session });
  });
  it("a recovery session is short-lived", async () => {
    const sink = new Sink();
    await writeSession(SECRET, sink, jar({}), false, stored({ k: "recovery" }));
    expect(sink.headers[0]).toContain(`Max-Age=${RECOVERY_SESSION_MAX_SEC}`);
    expect(sink.headers[0]).not.toContain("Secure");
  });
  it("an oversized session is split into chunks, read back intact, and stale chunks are deleted when it shrinks", async () => {
    const big = stored({ at: jwt({ exp: NOW + 3600, session_id: "s", pad: "x".repeat(6000) }) });
    const sink = new Sink();
    await writeSession(SECRET, sink, jar({}), true, big);
    expect(sink.headers.length).toBeGreaterThan(1);
    const c = sink.cookies();
    expect(Object.keys(c)[0]).toBe("__Secure-fdb_acct");
    expect(Object.keys(c)[1]).toBe("__Secure-fdb_acct.1");
    expect((await readSession(SECRET, jar(c), true)).session).toEqual(big);
    // shrink: chunks beyond the new size that exist in the jar are expired
    const small = new Sink();
    await writeSession(SECRET, small, jar(c), true, stored());
    expect(small.headers.filter((h) => /Max-Age=0/.test(h)).map((h) => h.split("=")[0])).toEqual(Object.keys(c).slice(1));
    // a missing middle chunk reads as an invalid (present) session, never a partial one
    const broken = { ...c }; delete broken["__Secure-fdb_acct.1"];
    expect(await readSession(SECRET, jar(broken), true)).toEqual({ session: null, present: true });
  });
  it("clearSession expires the cookie and every chunk on /account AND on /, with Secure on https", () => {
    for (const https of [true, false]) {
      const sink = new Sink();
      clearSession(sink, https);
      const base = cookieNames(https).session;
      expect(sink.headers).toHaveLength(12);
      for (const path of ["/account", "/"]) for (const name of [base, ...[1, 2, 3, 4, 5].map((i) => `${base}.${i}`)]) {
        expect(sink.headers.some((h) => h.startsWith(`${name}=;`) && h.includes(`Path=${path};`) && h.includes("Max-Age=0") && h.includes("Expires=Thu, 01 Jan 1970") && h.includes("HttpOnly") && (https ? h.includes("; Secure") : !h.includes("Secure")))).toBe(true);
      }
    }
  });
  it("readSession: absent / tampered / foreign-key / wrong-shape cookies", async () => {
    expect(await readSession(SECRET, jar({}), false)).toEqual({ session: null, present: false });
    const sink = new Sink();
    await writeSession(SECRET, sink, jar({}), false, stored());
    const good = sink.cookies().fdb_acct!;
    expect((await readSession(SECRET, jar({ fdb_acct: good }), false)).session).toEqual(stored());
    expect(await readSession(SECRET, jar({ fdb_acct: `${good.slice(0, -3)}AAA` }), false)).toEqual({ session: null, present: true });
    expect(await readSession("another-secret-0123456789abcdefghijklmnopqrstuvw", jar({ fdb_acct: good }), false)).toEqual({ session: null, present: true });
    // valid seal under the HTTPS name's AAD does not open under the http name (cookie-name binding)
    expect(await readSession(SECRET, jar({ fdb_acct: await seal(SECRET, JSON.stringify(stored()), "fdb-acct-session-v1|__Secure-fdb_acct") }), false)).toEqual({ session: null, present: true });
    expect(await readSession(SECRET, jar({ fdb_acct: await seal(SECRET, JSON.stringify({ ...stored(), extra: 1 }), "fdb-acct-session-v1|fdb_acct") }), false)).toEqual({ session: null, present: true });
    expect(await readSession(SECRET, jar({ fdb_acct: await seal(SECRET, "not json", "fdb-acct-session-v1|fdb_acct") }), false)).toEqual({ session: null, present: true });
  });
  it("recoverySessionActive", () => {
    expect(recoverySessionActive(stored({ k: "recovery", sc: NOW - 10 }), NOW)).toBe(true);
    expect(recoverySessionActive(stored({ k: "recovery", sc: NOW - RECOVERY_SESSION_MAX_SEC - 1 }), NOW)).toBe(false);
    expect(recoverySessionActive(stored({ k: "user" }), NOW)).toBe(false);
    expect(recoverySessionActive(null, NOW)).toBe(false);
  });
});

describe("resolveSession (stubbed Auth): who is signed in, refresh, failure classes", () => {
  const withCookie = async (s: StoredSession) => { const sink = new Sink(); await writeSession(SECRET, sink, jar({}), false, s); return jar(sink.cookies()); };
  const resolve = async (s: StoredSession, o: { kind?: "user" | "recovery"; canWrite?: boolean; now?: number } = {}) =>
    resolveSession(cfg, await withCookie(s), false, { kind: o.kind ?? "user", canWrite: o.canWrite ?? true, now: o.now ?? NOW });

  it("anonymous without a cookie; no Auth call", async () => {
    const calls = stubAuth({});
    expect(await resolveSession(cfg, jar({}), false, { kind: "user", canWrite: true, now: NOW })).toEqual({ state: "anonymous" });
    expect(calls).toHaveLength(0);
  });
  it("authenticated only when Auth CONFIRMS the user with the stored access token (GET /user), never from cookie contents", async () => {
    const calls = stubAuth({ "/auth/v1/user": { status: 200, body: user() } });
    const r = await resolve(stored());
    expect(r).toMatchObject({ state: "authenticated", user: { id: UID, email: "a@example.test" }, rotated: null });
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual(["GET /auth/v1/user"]);
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${stored().at}`);
    expect(calls[0]!.headers.apikey).toBe(cfg.publishableKey);
  });
  it("a revoked session (Auth: 403 session_not_found) is ended, after one refresh attempt that also fails", async () => {
    const calls = stubAuth({ "/auth/v1/user": { status: 403, body: { error_code: "session_not_found" } }, "/auth/v1/token": { status: 400, body: { error_code: "refresh_token_not_found" } } });
    expect((await resolve(stored())).state).toBe("ended");
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/auth/v1/user", "/auth/v1/token"]);
  });
  it("an expiring access token is refreshed first; the rotated session is returned and keeps sid, uid and the absolute start", async () => {
    const calls = stubAuth({ "/auth/v1/token": { status: 200, body: authSession() }, "/auth/v1/user": { status: 200, body: user() } });
    const r = await resolve(stored({ ex: NOW + 5 }));
    expect(r.state).toBe("authenticated");
    if (r.state !== "authenticated") return;
    expect(r.rotated).toMatchObject({ rt: "refresh-token-new", uid: UID, sid: "sess-1", sc: NOW - 100, rf: NOW, k: "user" });
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/auth/v1/token", "/auth/v1/user"]);
    expect(calls[0]!.body).toEqual({ refresh_token: "refresh-token-old" });
  });
  it("a refresh that answers for a DIFFERENT user ends the session: never authenticates another account", async () => {
    stubAuth({ "/auth/v1/token": { status: 200, body: authSession({}, OTHER) }, "/auth/v1/user": { status: 200, body: user({ id: OTHER }) } });
    expect((await resolve(stored({ ex: NOW + 5 }))).state).toBe("ended");
  });
  it("a confirmed user that differs from the stored uid is refused (swapped cookie contents)", async () => {
    stubAuth({ "/auth/v1/user": { status: 200, body: user({ id: OTHER }) } });
    expect((await resolve(stored())).state).toBe("ended");
  });
  it.each([
    ["anonymous identity", { is_anonymous: true }],
    ["unverified e-mail", { email_confirmed_at: null }],
    ["no e-mail", { email: null }],
  ])("%s never becomes a web session", async (_n, over) => {
    stubAuth({ "/auth/v1/user": { status: 200, body: user(over) } });
    expect((await resolve(stored())).state).toBe("ended");
  });
  it("transient failures (network, 5xx, 429) never end the session", async () => {
    for (const reply of [{ status: 0, throws: true }, { status: 503 }, { status: 502, raw: "<html>" }, { status: 429, body: { error_code: "over_request_rate_limit" } }]) {
      stubAuth({ "/auth/v1/user": reply, "/auth/v1/token": reply });
      expect((await resolve(stored())).state, JSON.stringify(reply)).toBe("unavailable");
      expect((await resolve(stored({ ex: NOW + 1 }))).state, `refresh ${JSON.stringify(reply)}`).toBe("unavailable");
    }
  });
  it("only refusals that name a dead credential end a session; a code-less or unknown 4xx (rotated key, misconfiguration) never signs anyone out", async () => {
    for (const reply of [{ status: 401, body: { message: "Invalid API key" } }, { status: 400, body: { error_code: "validation_failed" } }, { status: 403, body: { error_code: "something_new" } }]) {
      stubAuth({ "/auth/v1/user": reply, "/auth/v1/token": reply });
      expect((await resolve(stored())).state, JSON.stringify(reply)).toBe("unavailable");
    }
    for (const code of ["refresh_token_already_used", "session_not_found", "bad_jwt"]) {
      stubAuth({ "/auth/v1/user": { status: 403, body: { error_code: code } }, "/auth/v1/token": { status: 400, body: { error_code: code } } });
      expect((await resolve(stored())).state, code).toBe("ended");
    }
  });
  it("a redirect or an oversized / malformed Auth answer is an outage, never an identity", async () => {
    for (const reply of [{ status: 302, raw: "" }, { status: 200, raw: "x".repeat(70_000) }, { status: 200, raw: "{not json" }, { status: 200, body: { id: 5 } }]) {
      stubAuth({ "/auth/v1/user": reply });
      expect((await resolve(stored())).state, JSON.stringify(reply).slice(0, 30)).toBe("unavailable");
    }
  });
  it("hard limits: absolute 30 days and a 15-minute recovery session end the session before any Auth call", async () => {
    const calls = stubAuth({});
    expect((await resolve(stored({ sc: NOW - SESSION_ABSOLUTE_MAX_SEC - 1 }))).state).toBe("ended");
    expect((await resolve(stored({ k: "recovery", sc: NOW - RECOVERY_SESSION_MAX_SEC - 1 }), { kind: "recovery" })).state).toBe("ended");
    expect(calls).toHaveLength(0);
  });
  it("a recovery cookie is not a user session and vice versa", async () => {
    const calls = stubAuth({});
    expect((await resolve(stored({ k: "recovery" }), { kind: "user" })).state).toBe("anonymous");
    expect((await resolve(stored({ k: "user" }), { kind: "recovery" })).state).toBe("anonymous");
    expect(calls).toHaveLength(0);
  });
  it("tampered / garbage cookies end (and are cleared) without contacting Auth", async () => {
    const calls = stubAuth({});
    expect(await resolveSession(cfg, jar({ fdb_acct: "garbage" }), false, { kind: "user", canWrite: true, now: NOW })).toEqual({ state: "ended", stale: null });
    expect(calls).toHaveLength(0);
  });
  it("pages (cannot set cookies) are routed to the refresh handler instead of refreshing; a just-refreshed session does not loop", async () => {
    const calls = stubAuth({ "/auth/v1/user": { status: 200, body: user() } });
    expect((await resolve(stored({ ex: NOW + 5 }), { canWrite: false })).state).toBe("needs_refresh");
    expect(calls).toHaveLength(0);
    // refreshed 2 s ago with a very short token: proceed with the confirmed user instead of redirecting forever
    expect((await resolve(stored({ ex: NOW + 5, rf: NOW - 2 }), { canWrite: false })).state).toBe("authenticated");
    // access token refused by Auth while a page cannot refresh: go through the handler (which can) ...
    stubAuth({ "/auth/v1/user": { status: 401, body: { error_code: "bad_jwt" } } });
    expect((await resolve(stored(), { canWrite: false })).state).toBe("needs_refresh");
    // ... but not again right after a refresh: that is a dead session
    expect((await resolve(stored({ rf: NOW - 1 }), { canWrite: false })).state).toBe("ended");
  });
});

describe("CSRF", () => {
  const NOWS = 1_800_000_000;
  it("tokens are bound to the binding, expire, and reject every malformed shape", async () => {
    const t = await mintCsrf(SECRET, "anon", NOWS);
    expect(await checkCsrf(SECRET, t, "anon", NOWS)).toEqual({ exp: NOWS + CSRF_TTL_SEC });
    expect(await checkCsrf(SECRET, t, "s:other", NOWS)).toBeNull();
    expect(await checkCsrf(SECRET, t, "anon", NOWS + CSRF_TTL_SEC + 1)).toBeNull();
    expect(await checkCsrf("another-secret-0123456789abcdefghijklmnopqrstuv", t, "anon", NOWS)).toBeNull();
    const [v, n, e, m] = t.split(".");
    for (const bad of [undefined, "", "x", `${v}.${n}.${e}`, `${v}.${n}.${e}.${m}.x`, `v2.${n}.${e}.${m}`, `${v}.short.${e}.${m}`, `${v}.${n}.abc.${m}`, `${v}.${n}.${Number(e) + 1}.${m}`, `${v}.${n}.${e}.${m!.slice(0, -1)}${m!.endsWith("A") ? "B" : "A"}`, "v1." + "a".repeat(300)]) {
      expect(await checkCsrf(SECRET, bad, "anon", NOWS), String(bad).slice(0, 20)).toBeNull();
    }
    expect(csrfBinding(null)).toBe("anon");
    expect(csrfBinding(stored())).toBe("s:sess-1");
  });
  it("a still-valid token is reused (open tabs agree); a stale or foreign-bound one is replaced", async () => {
    const t = await mintCsrf(SECRET, "anon", NOWS);
    expect(await currentOrNewCsrf(SECRET, t, "anon", NOWS + 100)).toBe(t);
    expect(await currentOrNewCsrf(SECRET, t, "anon", NOWS + CSRF_TTL_SEC - 100)).not.toBe(t); // about to expire
    expect(await currentOrNewCsrf(SECRET, t, "s:x", NOWS)).not.toBe(t);
    expect(await currentOrNewCsrf(SECRET, undefined, "anon", NOWS)).toMatch(/^v1\./);
  });
  it("Origin / Fetch-Metadata decision table", () => {
    const h = (o: Record<string, string | undefined>) => new Headers(Object.entries(o).filter((kv): kv is [string, string] => kv[1] !== undefined));
    const site = "https://foreverdb.example";
    expect(originAllowed(h({ origin: site }), site)).toBe(true);
    expect(originAllowed(h({ "sec-fetch-site": "same-origin" }), site)).toBe(true);
    expect(originAllowed(h({ origin: site, "sec-fetch-site": "same-origin" }), site)).toBe(true);
    for (const bad of [{}, { origin: "https://evil.example" }, { origin: "null" }, { origin: `${site}.evil.example` }, { origin: "http://foreverdb.example" }, { origin: site, "sec-fetch-site": "cross-site" }, { origin: site, "sec-fetch-site": "same-site" }, { "sec-fetch-site": "none" }, { "sec-fetch-site": "same-site" }]) {
      expect(originAllowed(h(bad), site), JSON.stringify(bad)).toBe(false);
    }
  });
  it("verifyCsrf requires origin, JSON, matching cookie+header, valid MAC and binding", async () => {
    const site = "https://foreverdb.example";
    const t = await mintCsrf(SECRET, "anon");
    const base = { headers: new Headers({ origin: site, "content-type": "application/json; charset=utf-8", "x-fdb-csrf": t }), jar: jar({ fdb_csrf: t }), cookieName: "fdb_csrf", siteOrigin: site, secret: SECRET, session: null };
    expect(await verifyCsrf(base)).toBe("ok");
    expect(await verifyCsrf({ ...base, headers: new Headers({ "content-type": "application/json", "x-fdb-csrf": t }) })).toBe("origin");
    expect(await verifyCsrf({ ...base, headers: new Headers({ origin: site, "content-type": "text/plain", "x-fdb-csrf": t }) })).toBe("content_type");
    expect(await verifyCsrf({ ...base, headers: new Headers({ origin: site, "content-type": "application/json" }) })).toBe("token");
    expect(await verifyCsrf({ ...base, jar: jar({}) })).toBe("token");
    expect(await verifyCsrf({ ...base, jar: jar({ fdb_csrf: await mintCsrf(SECRET, "anon") }) })).toBe("token"); // header != cookie
    expect(await verifyCsrf({ ...base, session: stored() })).toBe("token"); // anon token while signed in
  });
});

describe("the single Auth wrapper", () => {
  it("builds fixed URLs, sends only the publishable key (+ the user's own token), pins logout to scope=local", async () => {
    const calls = stubAuth({ "/auth/v1/signup": { status: 200, body: {} }, "/auth/v1/logout": { status: 204 }, "/auth/v1/recover": { status: 200, body: {} } });
    const cb = callbackUrlFor("https://foreverdb.example");
    expect(cb).toBe("https://foreverdb.example/account/auth/confirm");
    await auth.signUp(cfg, { email: " A@Example.TEST ", password: "correct horse battery" }, cb);
    await auth.logout(cfg, "user-access-token-aaaaaaaa");
    await auth.recover(cfg, { email: "a@example.test" }, cb);
    expect(calls[0]!.url).toBe(`http://127.0.0.1:54321/auth/v1/signup?redirect_to=${encodeURIComponent(cb)}`);
    expect(calls[0]!.body).toEqual({ email: "a@example.test", password: "correct horse battery" }); // normalised, nothing else
    expect(calls[0]!.headers).toEqual({ apikey: cfg.publishableKey, Accept: "application/json", "Content-Type": "application/json" });
    expect(calls[1]!.url).toBe("http://127.0.0.1:54321/auth/v1/logout?scope=local");
    expect(calls[1]!.headers.Authorization).toBe("Bearer user-access-token-aaaaaaaa");
    expect(calls[2]!.headers.Authorization).toBeUndefined();
    for (const c of calls) { expect(Object.keys(c.headers).join()).not.toMatch(/service|secret/i); }
  });
  it("strict bodies: extra fields (user_metadata), weak or oversized passwords and bad e-mail never leave the process", () => {
    stubAuth({});
    const bad = (f: () => unknown) => expect(f).toThrow();
    bad(() => auth.signUp(cfg, { email: "a@example.test", password: "correct horse battery", data: { role: "admin" } } as never, "https://x.example/account/auth/confirm"));
    bad(() => auth.signUp(cfg, { email: "a@example.test", password: "short" }, "https://x.example/account/auth/confirm"));
    bad(() => auth.signUp(cfg, { email: "a@example.test", password: "€".repeat(25) }, "https://x.example/account/auth/confirm"));
    bad(() => auth.signUp(cfg, { email: "not an email", password: "correct horse battery" }, "https://x.example/account/auth/confirm"));
    bad(() => auth.passwordGrant(cfg, { email: "a@example.test", password: "" }));
    bad(() => auth.refresh(cfg, "short"));
    bad(() => auth.verify(cfg, { type: "magiclink" as never, token_hash: "0123456789abcdef" }));
    bad(() => auth.updatePassword(cfg, "tok-aaaaaaaaaaaaaaaaaaaa", "short"));
    expect(fetch).not.toHaveBeenCalled();
  });
  it("maps outcomes to machine codes only (no Auth text), rate limits and outages", async () => {
    stubAuth({ "/auth/v1/token": [{ status: 400, body: { error_code: "invalid_credentials", msg: "Invalid login credentials <secret text>" } }, { status: 429, body: { error_code: "over_request_rate_limit" } }, { status: 500, raw: "boom" }, { status: 400, raw: "not json" }] });
    const body = { email: "a@example.test", password: "x" };
    expect(await auth.passwordGrant(cfg, body)).toEqual({ ok: false, status: 400, code: "invalid_credentials", kind: "rejected" });
    expect(await auth.passwordGrant(cfg, body)).toEqual({ ok: false, status: 429, code: "over_request_rate_limit", kind: "rate_limited" });
    expect(await auth.passwordGrant(cfg, body)).toMatchObject({ ok: false, status: 500, kind: "unavailable" });
    expect(await auth.passwordGrant(cfg, body)).toMatchObject({ ok: false, code: null, kind: "rejected" });
  });
  it("no redirects are followed and no credentials/cookies are attached", async () => {
    stubAuth({ "/auth/v1/user": { status: 200, body: user() } });
    await auth.getUser(cfg, "tok-aaaaaaaaaaaaaaaaaaaa");
    const init = vi.mocked(fetch).mock.calls[0]![1]!;
    expect(init.redirect).toBe("manual");
    expect(init.credentials).toBe("omit");
    expect(init.cache).toBe("no-store");
    expect(init.signal).toBeDefined();
  });
});

describe("abuse controls", () => {
  it("Turnstile: success only on an explicit success:true; failure and unreachable verifier are distinguished and never pass", async () => {
    const mk = (r: () => Promise<Response>) => verifyTurnstile("secret", "token-token-token", (async () => r()) as unknown as typeof fetch);
    expect(await mk(async () => Response.json({ success: true }))).toBe("passed");
    expect(await mk(async () => Response.json({ success: false, "error-codes": ["invalid-input-response"] }))).toBe("failed");
    for (const v of [1, "true", null, undefined, {}]) expect(await mk(async () => Response.json({ success: v }))).toBe("failed");
    expect(await mk(async () => new Response("no", { status: 500 }))).toBe("unavailable");
    expect(await mk(async () => { throw new Error("offline"); })).toBe("unavailable");
    expect(await mk(async () => new Response("not json", { status: 200 }))).toBe("unavailable");
  });
  it("per-address throttle: counts every attempt alike, exhausts after the budget, never stores the address", async () => {
    const store = new MemoryStore();
    const spy = vi.spyOn(store, "incr");
    __setAccountStoreForTests(store);
    const env = { RATE_LIMIT_BACKEND: "memory" } as never;
    for (let i = 0; i < EMAIL_LIMITS.recover.max; i += 1) expect(await chargeEmail(env, SECRET, "recover", "victim@example.test")).toBe("allowed");
    expect(await chargeEmail(env, SECRET, "recover", "victim@example.test")).toBe("exhausted");
    expect(await chargeEmail(env, SECRET, "recover", "someone-else@example.test")).toBe("allowed"); // per address
    expect(await chargeEmail(env, SECRET, "register", "victim@example.test")).toBe("allowed"); // per action
    for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toMatch(/victim|example\.test|@/);
  });
  it("a store outage surfaces as an error (callers fail closed)", async () => {
    __setAccountStoreForTests({ incr: async () => { throw new Error("redis down"); } });
    await expect(chargeEmail({ RATE_LIMIT_BACKEND: "memory" } as never, SECRET, "login", "a@example.test")).rejects.toThrow("redis down");
  });
  it("edge rules: account POSTs that call Auth are strict per-IP rules, stricter than Auth's recorded per-IP limit; other methods are not limited", () => {
    for (const r of ["register", "login", "confirm", "forgot-password", "resend", "reset-password"]) {
      expect(classifyRequest(`/account/api/${r}`, "POST")).toBe("account_auth");
      expect(classifyRequest(`/account/api/${r}`, "GET")).toBe("account_light");
      expect(classifyRequest(`/account/api/${r}`, "DELETE")).toBeNull();
    }
    expect(classifyRequest("/account/api/logout", "POST")).toBe("account_light");
    expect(classifyRequest("/account/api/csrf", "GET")).toBe("account_light");
    expect(classifyRequest("/account/api/login/", "POST")).toBe("account_auth");
    expect(classifyRequest("/account/login", "GET")).toBeNull(); // pages
    expect(classifyRequest("/api/v1/search", "GET")).toBe("api_search"); // public quotas unchanged
    expect(isStrictRule("account_auth") && isStrictRule("account_light") && isStrictRule("api_challenge")).toBe(true);
    expect(isStrictRule("api_search")).toBe(false);
    const rules = loadRules(undefined);
    // L-2 (docs/account-v1/acceptance-and-owner-actions.md): Auth sign-in/sign-up <= 30 per 5 minutes per IP; the website must be stricter (L-8).
    expect(rules.account_auth.windowSec).toBe(300);
    expect(rules.account_auth.perIp).toBeLessThan(30);
    expect(rules.account_auth.global).toBeLessThanOrEqual(30); // the website as a whole never exceeds Auth's per-IP bucket (shared egress, L-8)
  });
});

describe("inputs and messages", () => {
  it("browser bodies are strict extensions of the Auth schemas", () => {
    expect(INPUTS.register.safeParse({ email: "A@Example.test", password: "correct horse battery", turnstileToken: "t".repeat(20) }).success).toBe(true);
    expect(INPUTS.register.safeParse({ email: "a@example.test", password: "correct horse battery", role: "admin" }).success).toBe(false);
    expect(INPUTS.register.safeParse({ email: "a@example.test", password: "short" }).success).toBe(false);
    expect(INPUTS.login.safeParse({ email: "a@example.test", password: "x", next: "/account" }).success).toBe(true);
    expect(INPUTS.login.safeParse({ email: "a@example.test", password: "x", next: "x".repeat(201) }).success).toBe(false);
    expect(INPUTS.confirm.safeParse({ type: "recovery", token_hash: "0123456789abcdef" }).success).toBe(true);
    expect(INPUTS.confirm.safeParse({ type: "magiclink", token_hash: "0123456789abcdef" }).success).toBe(false);
    expect(INPUTS.logout.safeParse({ everyone: true }).success).toBe(false); // no scope can be supplied by a caller
    expect(INPUTS.reset.safeParse({ password: "x".repeat(73) }).success).toBe(false);
  });
  it("unknown error codes show a generic message, never the code", () => {
    expect(messageFor("invalid_credentials")).toMatch(/incorrect/);
    expect(messageFor("<script>")).toBe("Something went wrong. Please try again.");
    expect(messageFor(undefined)).toBe("Something went wrong. Please try again.");
  });
  it("fromAuthSession reads exp and session id from the issued token and carries identity", () => {
    const s = fromAuthSession(authSession() as never, { kind: "user", now: NOW });
    expect(s).toMatchObject({ uid: UID, sid: "sess-1", ex: NOW + 3600, sc: NOW, rf: NOW, k: "user" });
    expect(fromAuthSession(authSession({ access_token: "x".repeat(30) }) as never, { kind: "recovery", now: NOW, sc: 5 })).toMatchObject({ sid: "none", ex: NOW + 3600, sc: 5, k: "recovery" });
  });
});
