import { describe, expect, it, vi } from "vitest";
import { buildPageCsp } from "@/lib/security/headers";
import { clientIp, hashIp, signPass, verifyPass } from "@/lib/security/identity";
import {
  DEFAULT_RULES, MemoryStore, UpstashStore, checkRateLimit, classify, loadRules, validSessionId,
} from "@/lib/security/rate-limit";

const id = (over: Partial<{ ipHash: string; sessionId: string | null; challengePassed: boolean }> = {}) =>
  ({ ipHash: "ip-a", sessionId: null, challengePassed: false, ...over });
const now = Date.UTC(2026, 9, 9, 12, 0, 5);

describe("rate limiting", () => {
  it("classifies only data routes", () => {
    expect(classify("/api/v1/search")).toBe("api_search");
    expect(classify("/api/v1/item/1")).toBe("api_detail");
    expect(classify("/api/v1/challenge")).toBeNull();
    expect(classify("/item/2770")).toBe("page_db");
    expect(classify("/database")).toBe("page_db");
    expect(classify("/news/hello")).toBeNull();
  });

  it("returns 429 semantics after the per-IP budget with a Retry-After inside the window", async () => {
    const store = new MemoryStore();
    const rule = { ...DEFAULT_RULES.api_search, challengeAt: undefined };
    for (let i = 0; i < rule.perIp; i++) {
      expect((await checkRateLimit(store, "api_search", rule, id(), { challengeEnabled: false, nowMs: now })).allowed).toBe(true);
    }
    const d = await checkRateLimit(store, "api_search", rule, id(), { challengeEnabled: false, nowMs: now });
    expect(d).toMatchObject({ allowed: false, reason: "rate_limited" });
    if (!d.allowed) {
      expect(d.retryAfterSec).toBeGreaterThan(0);
      expect(d.retryAfterSec).toBeLessThanOrEqual(60);
    }
    // A different client is unaffected; the next window resets.
    expect((await checkRateLimit(store, "api_search", rule, id({ ipHash: "ip-b" }), { challengeEnabled: false, nowMs: now })).allowed).toBe(true);
    expect((await checkRateLimit(store, "api_search", rule, id(), { challengeEnabled: false, nowMs: now + 60_000 })).allowed).toBe(true);
  });

  it("enforces the shared global budget across many clients (anti-rotation)", async () => {
    const store = new MemoryStore();
    const rule = { windowSec: 60, perIp: 100, perSession: 100, global: 5 };
    for (let i = 0; i < 5; i++) await checkRateLimit(store, "api_detail", rule, id({ ipHash: `ip-${i}` }), { challengeEnabled: false, nowMs: now });
    expect((await checkRateLimit(store, "api_detail", rule, id({ ipHash: "ip-new" }), { challengeEnabled: false, nowMs: now })).allowed).toBe(false);
  });

  it("enforces the session budget independently of IP", async () => {
    const store = new MemoryStore();
    const rule = { windowSec: 60, perIp: 100, perSession: 2, global: 1000 };
    const sid = "AAAAAAAAAAAAAAAAAAAAAA";
    await checkRateLimit(store, "page_db", rule, id({ ipHash: "a", sessionId: sid }), { challengeEnabled: false, nowMs: now });
    await checkRateLimit(store, "page_db", rule, id({ ipHash: "b", sessionId: sid }), { challengeEnabled: false, nowMs: now });
    expect((await checkRateLimit(store, "page_db", rule, id({ ipHash: "c", sessionId: sid }), { challengeEnabled: false, nowMs: now })).allowed).toBe(false);
  });

  it("requires a challenge past the soft threshold, unless a valid pass is presented", async () => {
    const store = new MemoryStore();
    const rule = { windowSec: 60, perIp: 10, perSession: 10, global: 1000, challengeAt: 3 };
    for (let i = 0; i < 3; i++) await checkRateLimit(store, "api_search", rule, id(), { challengeEnabled: true, nowMs: now });
    expect(await checkRateLimit(store, "api_search", rule, id(), { challengeEnabled: true, nowMs: now })).toMatchObject({ allowed: false, reason: "challenge_required" });
    expect((await checkRateLimit(store, "api_search", rule, id({ challengePassed: true }), { challengeEnabled: true, nowMs: now })).allowed).toBe(true);
  });

  it("validates rule overrides and session ids", () => {
    expect(loadRules('{"api_search":{"perIp":10}}').api_search.perIp).toBe(10);
    expect(() => loadRules('{"api_search":{"perIp":0}}')).toThrow();
    expect(() => loadRules('{"evil":{}}')).toThrow();
    expect(validSessionId("AAAAAAAAAAAAAAAAAAAAAA")).toBeTruthy();
    expect(validSessionId("x:rl:global:*")).toBeNull();
  });

  it("uses one Upstash pipeline round trip and fails on bad replies", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([{ result: 1 }, { result: 1 }, { result: 7 }, { result: 1 }])));
    vi.stubGlobal("fetch", fetchMock);
    const s = new UpstashStore("https://example.upstash.io", "token-token-token-token");
    expect(await s.incr(["a", "b"], 120)).toEqual([1, 7]);
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toEqual([["INCR", "a"], ["EXPIRE", "a", "120", "NX"], ["INCR", "b"], ["EXPIRE", "b", "120", "NX"]]);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify([{ error: "ERR" }])));
    await expect(s.incr(["a"], 120)).rejects.toThrow();
    vi.unstubAllGlobals();
  });
});

describe("client identity", () => {
  it("never uses raw IPs and validates header contents", () => {
    const h = new Headers({ "x-real-ip": "203.0.113.9", "x-forwarded-for": "203.0.113.9, 10.0.0.1" });
    expect(clientIp(h, "x-real-ip")).toBe("203.0.113.9");
    expect(clientIp(h, "x-forwarded-for")).toBe("203.0.113.9");
    expect(clientIp(new Headers({ "x-real-ip": "<script>" }), "x-real-ip")).toBe("invalid");
    expect(clientIp(h, "none")).toBe("local");
    const hashed = hashIp("203.0.113.9", "s".repeat(32));
    expect(hashed).not.toContain("203");
    expect(hashed).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("challenge pass is IP-bound, signed and expiring", () => {
    const secret = "c".repeat(40);
    const pass = signPass("ip-a", secret, 1800, now);
    expect(verifyPass(pass, "ip-a", secret, now)).toBe(true);
    expect(verifyPass(pass, "ip-b", secret, now)).toBe(false);
    expect(verifyPass(pass, "ip-a", "d".repeat(40), now)).toBe(false);
    expect(verifyPass(pass, "ip-a", secret, now + 1801_000)).toBe(false);
    expect(verifyPass(pass.replace(/\.\d+\./, ".9999999999."), "ip-a", secret, now)).toBe(false);
    expect(verifyPass(undefined, "ip-a", secret, now)).toBe(false);
  });
});

describe("content security policy", () => {
  it("production CSP is nonce-based with no unsafe-inline/eval scripts and no framing", () => {
    const csp = buildPageCsp("abc", { dev: false, turnstile: false, https: true });
    expect(csp).toContain("script-src 'self' 'nonce-abc' 'strict-dynamic'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("upgrade-insecure-requests");
  });
});
