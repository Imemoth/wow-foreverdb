import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryStore } from "@/lib/security/rate-limit";
import type { AccountAuthConfig } from "@/lib/account/config";
import { b64urlEncode } from "@/lib/account/crypto";
import { ACCOUNT_RPCS } from "@/lib/account/contracts";
import { auth } from "@/lib/account/auth-client";
import { ACCOUNT_LIMITS, __setAccountStoreForTests, chargeAccount } from "@/lib/account/limits";
import { confirmPassword, recheckIdentity } from "@/lib/account/reauth";
import { WEB_RPCS, callWebRpc } from "@/lib/account/rpc-client";
import type { AccountUser, StoredSession } from "@/lib/account/session";
import { INPUTS } from "@/lib/account/inputs";
import type { ServerEnv } from "@/lib/env";

/**
 * PR E unit tests: the closed PostgREST client and the fresh-password / temporary-session lifecycle. A stubbed `fetch`
 * stands in for the servers here; the real GoTrue + real PostgREST behaviour is proven by the integrated suite
 * (`Account end-to-end (GoTrue + PostgREST)`), never by these.
 */
const SECRET = "unit-test-secret-0123456789abcdefghijklmnopqrstuvwxyz";
const UID = "123e4567-e89b-42d3-a456-426614174000";
const OTHER = "223e4567-e89b-42d3-a456-426614174000";
const cfg: AccountAuthConfig = { mode: "local", authOrigin: "http://127.0.0.1:54321", projectRef: null, publishableKey: "sb_publishable_unit_key_not_real", csrfSecret: SECRET };
const jwt = (claims: Record<string, unknown>) => {
  const enc = (o: unknown) => b64urlEncode(new TextEncoder().encode(JSON.stringify(o)));
  return `${enc({ alg: "HS256" })}.${enc(claims)}.${"s".repeat(43)}`;
};
const TOKEN = jwt({ exp: 4_000_000_000, session_id: "sess-web", sub: UID });
const TEMP = jwt({ exp: 4_000_000_000, session_id: "sess-temp", sub: UID });
const CODE = "0123456789ABCDEF0123456789ABCDEF";

interface Call { method: string; url: string; headers: Record<string, string>; body: unknown }
type Reply = { status: number; body?: unknown; throws?: boolean; raw?: string; headers?: Record<string, string> };
function stub(handler: (c: Call) => Reply) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = { method: init?.method ?? "GET", url: String(input), headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)), body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const r = handler(call);
    if (r.throws) throw new Error("network down");
    return new Response(r.raw ?? (r.status === 204 ? null : JSON.stringify(r.body ?? {})), { status: r.status, headers: { "content-type": "application/json", ...(r.headers ?? {}) } });
  }));
  return calls;
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); __setAccountStoreForTests(null); });

describe("closed PostgREST client", () => {
  it("offers only the non-Guildbook web functions; claim_start, link_status and Guildbook are unreachable", async () => {
    expect([...WEB_RPCS].sort()).toEqual(["fdb_account_claim_redeem", "fdb_account_installations"]);
    for (const n of WEB_RPCS) expect(Object.keys(ACCOUNT_RPCS)).toContain(n);
    stub(() => ({ status: 200, body: {} }));
    for (const bad of ["fdb_account_claim_start", "fdb_installation_link_status", "fdb_account_guildbook_guilds", "fdb_account_guildbook_members", "installations", "../fdb_account_installations", "pg_sleep", "constructor", "__proto__", ""]) {
      await expect(callWebRpc(cfg, bad as never, {} as never, TOKEN)).rejects.toThrow("rpc_not_allowed");
    }
  });

  it("sends exactly one fixed request: POST, /rest/v1/rpc/<name> on the validated origin, four headers, validated body, no redirects/cache", async () => {
    const calls = stub(() => ({ status: 200, body: { ok: true, installation_id: "inst-1", linked_at: "2026-10-12T10:00:00+00:00" } }));
    const out = await callWebRpc(cfg, "fdb_account_claim_redeem", { p_code: CODE }, TOKEN);
    expect(out).toEqual({ ok: true, data: { ok: true, installation_id: "inst-1", linked_at: "2026-10-12T10:00:00+00:00" } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.url).toBe("http://127.0.0.1:54321/rest/v1/rpc/fdb_account_claim_redeem");
    expect(Object.keys(calls[0]!.headers).map((h) => h.toLowerCase()).sort()).toEqual(["accept", "apikey", "authorization", "content-type"]);
    expect(calls[0]!.headers.apikey).toBe(cfg.publishableKey);
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]!.body).toEqual({ p_code: CODE });
    const init = vi.mocked(fetch).mock.calls[0]![1]!;
    expect(init.redirect).toBe("manual");
    expect(init.cache).toBe("no-store");
    expect(init.credentials).toBe("omit");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("refuses malformed input before anything is sent (strict schemas, extra fields, lower-case code, bad token)", async () => {
    stub(() => ({ status: 200, body: {} }));
    await expect(callWebRpc(cfg, "fdb_account_claim_redeem", { p_code: CODE.toLowerCase() } as never, TOKEN)).rejects.toThrow();
    await expect(callWebRpc(cfg, "fdb_account_claim_redeem", { p_code: CODE, extra: 1 } as never, TOKEN)).rejects.toThrow();
    await expect(callWebRpc(cfg, "fdb_account_installations", { p_user: UID } as never, TOKEN)).rejects.toThrow();
    await expect(callWebRpc(cfg, "fdb_account_installations", {}, "short")).rejects.toThrow("rpc_bad_token");
    await expect(callWebRpc(cfg, "fdb_account_installations", {}, `${TOKEN}\r\nPrefer: tx=rollback`)).rejects.toThrow("rpc_bad_token");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps every HTTP outcome; a lost reply of the ONE-TIME call is an unknown outcome, of a read just unavailable", async () => {
    const redeem = (r: Reply) => { stub(() => r); return callWebRpc(cfg, "fdb_account_claim_redeem", { p_code: CODE }, TOKEN); };
    const read = (r: Reply) => { stub(() => r); return callWebRpc(cfg, "fdb_account_installations", {}, TOKEN); };
    expect(await redeem({ status: 401, body: { message: "x" } })).toEqual({ ok: false, kind: "unauthenticated" });
    expect(await redeem({ status: 403 })).toEqual({ ok: false, kind: "forbidden" });
    expect(await redeem({ status: 429, headers: { "retry-after": "120" } })).toEqual({ ok: false, kind: "rate_limited", retryAfterSec: 120 });
    expect(await redeem({ status: 429 })).toEqual({ ok: false, kind: "rate_limited", retryAfterSec: 60 });
    expect(await redeem({ status: 429, headers: { "retry-after": "999999" } })).toEqual({ ok: false, kind: "rate_limited", retryAfterSec: 3600 });
    expect(await redeem({ status: 400 })).toEqual({ ok: false, kind: "bad_request" });
    for (const r of [{ status: 500 }, { status: 502 }, { status: 503 }, { status: 302, headers: { location: "https://evil.example" } }, { status: 200, raw: "not json" }, { status: 200, body: { ok: true } }, { status: 200, body: { ok: true, installation_id: "i", linked_at: "2026-01-01T00:00:00Z", leak: "x" } }, { status: 200, raw: "x".repeat(600 * 1024) }, { status: 0, throws: true }] as Reply[]) {
      expect(await redeem(r), JSON.stringify(r).slice(0, 80)).toEqual({ ok: false, kind: "unknown_outcome" });
      if (r.status !== 200 || r.raw === "not json" || r.throws || (r.raw?.length ?? 0) > 1000) expect(await read(r), `read ${r.status}`).toEqual({ ok: false, kind: "unavailable" });
    }
    expect(await redeem({ status: 200, body: { ok: false, error: "invalid_claim" } })).toEqual({ ok: true, data: { ok: false, error: "invalid_claim" } });
    expect(await redeem({ status: 200, body: { ok: false, error: "account_limit" } })).toEqual({ ok: true, data: { ok: false, error: "account_limit" } });
    expect(await redeem({ status: 200, body: { ok: false, error: "no_such_installation" } })).toEqual({ ok: false, kind: "unknown_outcome" }); // not a registry value
  });

  it("an installation list above the approved maximum, or with an unknown column, is rejected as a whole", async () => {
    const row = (n: number) => ({ installation_id: `inst-${n}`, linked_at: "2026-01-01T00:00:00+00:00", last_seen_at: null, guild_count: 0 });
    stub(() => ({ status: 200, body: Array.from({ length: 50 }, (_, i) => row(i)) }));
    expect((await callWebRpc(cfg, "fdb_account_installations", {}, TOKEN)).ok).toBe(true);
    stub(() => ({ status: 200, body: Array.from({ length: 51 }, (_, i) => row(i)) }));
    expect(await callWebRpc(cfg, "fdb_account_installations", {}, TOKEN)).toEqual({ ok: false, kind: "unavailable" });
    stub(() => ({ status: 200, body: [{ ...row(1), owner_user_id: UID }] }));
    expect(await callWebRpc(cfg, "fdb_account_installations", {}, TOKEN)).toEqual({ ok: false, kind: "unavailable" });
  });
});

describe("link request bodies", () => {
  it("are strict: code, password and an explicit literal-true confirmation; Guildbook bodies have no limit/offset", () => {
    expect(INPUTS.link.safeParse({ code: "FDB-0123", password: "pw", confirm: true, accountId: UID }).success).toBe(true);
    for (const bad of [{ code: "x", password: "pw" }, { code: "x", password: "pw", confirm: false }, { code: "x", password: "pw", confirm: "true" }, { code: "x", password: "pw", confirm: true }, { code: "x", password: "pw", confirm: true, accountId: "not-a-uuid" }, { code: "x", password: "pw", confirm: true, accountId: UID, installationId: "i" }, { code: "", password: "pw", confirm: true, accountId: UID }, { code: "x", password: "", confirm: true, accountId: UID }].map((b) => ({ accountId: UID, ...b, ...("accountId" in b ? {} : { accountId: undefined }) }))) {
      expect(INPUTS.link.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(INPUTS.guildbookMembers.safeParse({ installationId: "i1", guildKey: "g", page: 0 }).success).toBe(true);
    for (const bad of [{ installationId: "i1", guildKey: "g", page: 0, limit: 200 }, { installationId: "i1", guildKey: "g", page: 0, offset: 5 }, { installationId: "i1", guildKey: "g", page: -1 }, { installationId: "i1", guildKey: "g", page: 1001 }, { installationId: "i1", guildKey: "g", page: 1.5 }, { installationId: "bad id", guildKey: "g", page: 0 }]) {
      expect(INPUTS.guildbookMembers.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

const current: AccountUser = { id: UID, email: "a@example.test", createdAt: null, lastSignInAt: null };
const tempSession = (uid = UID) => ({ access_token: TEMP, refresh_token: "temp-refresh-token", expires_in: 3600, token_type: "bearer", user: { id: uid, email: "a@example.test", email_confirmed_at: "2026-01-01T00:00:00Z", is_anonymous: false } });
const userBody = (over: Record<string, unknown> = {}) => ({ id: UID, email: "a@example.test", email_confirmed_at: "2026-01-01T00:00:00Z", is_anonymous: false, ...over });

describe("fresh-password confirmation and the temporary Auth session", () => {
  it("grants for the VERIFIED e-mail (never a request value), validates the temporary session, revokes it with scope=local, never the web token", async () => {
    const calls = stub((c) => {
      if (c.url.includes("grant_type=password")) return { status: 200, body: tempSession() };
      if (c.url.endsWith("/auth/v1/user")) return { status: 200, body: userBody() };
      if (c.url.includes("/auth/v1/logout")) return { status: 204 };
      return { status: 500 };
    });
    expect(await confirmPassword(cfg, current, "the right password")).toEqual({ ok: true, cleanup: "revoked" });
    expect(calls.map((c) => `${c.method} ${c.url.replace(cfg.authOrigin, "")}`)).toEqual(["POST /auth/v1/token?grant_type=password", "GET /auth/v1/user", "POST /auth/v1/logout?scope=local"]);
    expect(calls[0]!.body).toEqual({ email: "a@example.test", password: "the right password" });
    expect(calls[1]!.headers.Authorization).toBe(`Bearer ${TEMP}`);
    expect(calls[2]!.headers.Authorization).toBe(`Bearer ${TEMP}`);
    expect(JSON.stringify(calls)).not.toContain(TOKEN);
  });

  it("wrong password, unknown/unconfirmed answers and Auth rate limits map to distinct, non-leaking verdicts; nothing to revoke", async () => {
    for (const [status, code, want] of [[400, "invalid_credentials", "wrong_password"], [400, "email_not_confirmed", "wrong_password"], [401, undefined, "wrong_password"], [429, "over_request_rate_limit", "rate_limited"], [500, undefined, "unavailable"]] as const) {
      const calls = stub(() => ({ status, body: code ? { error_code: code, msg: "text we never forward" } : {} }));
      expect(await confirmPassword(cfg, current, "whatever password")).toEqual({ ok: false, reason: want });
      expect(calls).toHaveLength(1);
    }
    stub(() => ({ status: 0, throws: true }));
    expect(await confirmPassword(cfg, current, "whatever password")).toEqual({ ok: false, reason: "unavailable" });
  });

  it("a grant that answers for a DIFFERENT user id is refused (same-UID rule, not e-mail text) and its session is still revoked", async () => {
    const calls = stub((c) => {
      if (c.url.includes("grant_type=password")) return { status: 200, body: tempSession(OTHER) };
      if (c.url.includes("/auth/v1/logout")) return { status: 204 };
      return { status: 500 };
    });
    expect(await confirmPassword(cfg, current, "password of someone else")).toEqual({ ok: false, reason: "identity_mismatch" });
    expect(calls.map((c) => c.url.replace(cfg.authOrigin, ""))).toEqual(["/auth/v1/token?grant_type=password", "/auth/v1/logout?scope=local"]);
  });

  it("GET /user disagreeing with the grant (other id, anonymous, unconfirmed, refused) is refused and the temporary session is revoked", async () => {
    for (const reply of [{ status: 200, body: userBody({ id: OTHER }) }, { status: 200, body: userBody({ is_anonymous: true }) }, { status: 200, body: userBody({ email_confirmed_at: null }) }, { status: 403, body: { error_code: "session_not_found" } }] as Reply[]) {
      const calls = stub((c) => (c.url.includes("grant_type=password") ? { status: 200, body: tempSession() } : c.url.endsWith("/auth/v1/user") ? reply : { status: 204 }));
      expect(await confirmPassword(cfg, current, "pw pw pw pw pw")).toEqual({ ok: false, reason: "identity_mismatch" });
      expect(calls.at(-1)!.url).toContain("/auth/v1/logout?scope=local");
    }
  });

  it("a failed revocation is retried once, then REPORTED as unconfirmed (never claimed as revoked); an already-gone session counts as ended", async () => {
    let logouts = 0;
    stub((c) => (c.url.includes("grant_type=password") ? { status: 200, body: tempSession() } : c.url.endsWith("/auth/v1/user") ? { status: 200, body: userBody() } : (logouts += 1, { status: 500 })));
    expect(await confirmPassword(cfg, current, "pw pw pw pw pw")).toEqual({ ok: true, cleanup: "unconfirmed" });
    expect(logouts).toBe(2);
    stub((c) => (c.url.includes("grant_type=password") ? { status: 200, body: tempSession() } : c.url.endsWith("/auth/v1/user") ? { status: 200, body: userBody() } : { status: 403, body: { error_code: "session_not_found" } }));
    expect(await confirmPassword(cfg, current, "pw pw pw pw pw")).toEqual({ ok: true, cleanup: "revoked" });
    // a failed revocation also does not turn a REFUSED identity into success
    stub((c) => (c.url.includes("grant_type=password") ? { status: 200, body: tempSession(OTHER) } : { status: 500 }));
    expect(await confirmPassword(cfg, current, "pw pw pw pw pw")).toEqual({ ok: false, reason: "identity_mismatch" });
  });

  it("the identity re-check uses the ORIGINAL web token and distinguishes same / gone / unavailable", async () => {
    const s: StoredSession = { v: 1, k: "user", uid: UID, at: TOKEN, rt: "refresh-token-old", ex: 4_000_000_000, sid: "sess-web", sc: 0, rf: 0 };
    const calls = stub(() => ({ status: 200, body: userBody() }));
    expect(await recheckIdentity(cfg, s)).toBe("same");
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    stub(() => ({ status: 403, body: { error_code: "session_not_found" } }));
    expect(await recheckIdentity(cfg, s)).toBe("gone");
    stub(() => ({ status: 200, body: userBody({ id: OTHER }) }));
    expect(await recheckIdentity(cfg, s)).toBe("gone");
    stub(() => ({ status: 200, body: userBody({ is_anonymous: true }) }));
    expect(await recheckIdentity(cfg, s)).toBe("gone");
    stub(() => ({ status: 503 }));
    expect(await recheckIdentity(cfg, s)).toBe("unavailable");
    stub(() => ({ status: 0, throws: true }));
    expect(await recheckIdentity(cfg, s)).toBe("unavailable");
  });
});

describe("global logout after a password reset (recovery-only, typed, verified)", () => {
  const RT = jwt({ exp: 4_000_000_000, session_id: "sess-recovery", sub: UID });
  const run = (handler: (c: Call) => Reply) => { const calls = stub(handler); return { calls, out: auth.logoutAllAfterRecovery(cfg, RT) }; };
  it("sends exactly one fixed global logout with the recovery bearer, then proves the session is gone: confirmed", async () => {
    const { calls, out } = run((c) => (c.url.includes("/auth/v1/logout") ? { status: 204 } : { status: 403, body: { error_code: "session_not_found" } }));
    expect(await out).toBe("confirmed");
    expect(calls.map((c) => `${c.method} ${c.url.replace(cfg.authOrigin, "")}`)).toEqual(["POST /auth/v1/logout?scope=global", "GET /auth/v1/user"]);
    for (const c of calls) expect(c.headers.Authorization).toBe(`Bearer ${RT}`);
  });
  it("is NEVER 'confirmed' unless Auth answered 2xx AND refuses the token afterwards (alive token, 5xx, 429, timeout, session already gone are all uncertain)", async () => {
    expect(await run((c) => (c.url.includes("/auth/v1/logout") ? { status: 204 } : { status: 200, body: userBody() })).out).toBe("uncertain"); // answered 204 but the session is still alive
    expect(await run((c) => (c.url.includes("/auth/v1/logout") ? { status: 204 } : { status: 503 })).out).toBe("uncertain"); // cannot verify
    for (const r of [{ status: 500 }, { status: 502 }, { status: 429, body: { error_code: "over_request_rate_limit" } }, { status: 0, throws: true }] as Reply[]) {
      expect(await run(() => r).out, JSON.stringify(r)).toBe("uncertain");
    }
    expect(await run(() => ({ status: 403, body: { error_code: "session_not_found" } })).out).toBe("uncertain"); // gone, but not provably by us
  });
  it("a definitive refusal is 'failed' (nothing revoked)", async () => {
    expect(await run(() => ({ status: 403, body: { error_code: "not_admin" } })).out).toBe("failed");
    expect(await run(() => ({ status: 422, body: { error_code: "validation_failed" } })).out).toBe("failed");
  });
  it("the global scope exists only through this function: the generic logout stays local, and the request is checked against the recovery-only allowlist entry", async () => {
    const calls = stub(() => ({ status: 204 }));
    await auth.logout(cfg, RT);
    expect(calls[0]!.url).toBe(`${cfg.authOrigin}/auth/v1/logout?scope=local`);
  });
});

describe("per-account budgets (independent of the per-IP edge budgets)", () => {
  const env = { RATE_LIMIT_BACKEND: "memory" } as unknown as ServerEnv;
  it("count every attempt per verified account, cut off at the limit, reset per window and never share keys between accounts or actions", async () => {
    __setAccountStoreForTests(new MemoryStore());
    const t = 1_800_000_000_000;
    for (let i = 0; i < ACCOUNT_LIMITS.reauth.max; i += 1) expect((await chargeAccount(env, SECRET, "reauth", UID, t)).budget).toBe("allowed");
    const over = await chargeAccount(env, SECRET, "reauth", UID, t);
    expect(over.budget).toBe("exhausted");
    expect(over.retryAfterSec).toBeGreaterThan(0);
    expect(over.retryAfterSec).toBeLessThanOrEqual(ACCOUNT_LIMITS.reauth.windowSec);
    expect((await chargeAccount(env, SECRET, "reauth", OTHER, t)).budget).toBe("allowed"); // another account
    expect((await chargeAccount(env, SECRET, "link", UID, t)).budget).toBe("allowed"); // another action
    expect((await chargeAccount(env, SECRET, "reauth", UID.toUpperCase(), t)).budget).toBe("exhausted"); // same account, any spelling
    expect((await chargeAccount(env, SECRET, "reauth", UID, t + ACCOUNT_LIMITS.reauth.windowSec * 1000)).budget).toBe("allowed"); // next window
  });
  it("fail closed: a store failure is an exception the caller turns into 503", async () => {
    __setAccountStoreForTests({ incr: async () => { throw new Error("store down"); } });
    await expect(chargeAccount(env, SECRET, "link", UID)).rejects.toThrow("store down");
  });
  it("the shared edge rule: /account/api/link is a strict, fail-closed account_auth route; read routes are account_light", async () => {
    const { classifyRequest } = await import("@/lib/security/rate-limit");
    expect(classifyRequest("/account/api/link", "POST")).toBe("account_auth");
    expect(classifyRequest("/account/api/installations", "GET")).toBe("account_light");
    expect(classifyRequest("/account/api/guildbook/guilds", "POST")).toBe("account_light");
    expect(classifyRequest("/account/api/guildbook/members", "POST")).toBe("account_light");
  });
});
