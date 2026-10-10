import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { clientIp, ipv6Prefix64 } from "@/lib/security/identity";
import { MAX_CHALLENGE_BODY_BYTES, readBoundedJson } from "@/lib/security/challenge";
import {
  DEFAULT_RULES, MemoryStore, checkStrictLimit, classify, classifyRequest, loadRules,
} from "@/lib/security/rate-limit";

const SITE = "https://foreverdb.example";
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const UPSTASH = "https://fake-upstash.example.io";
const TOKEN = "valid-turnstile-token-123";

type Handlers = {
  proxy: (r: NextRequest) => Promise<Response>;
  POST: (r: Request) => Promise<Response>;
};

const baseEnv: Record<string, string> = {
  FOREVERDB_DEPLOYMENT: "local",
  FOREVERDB_DATA_SOURCE: "fixture",
  SITE_URL: SITE,
  RATE_LIMIT_BACKEND: "memory",
  TRUSTED_IP_HEADER: "x-real-ip",
  RATE_LIMIT_SALT: "unit-test-salt-0123456789abcdef0123456789",
  TURNSTILE_SECRET_KEY: "SECRET-turnstile-key-do-not-leak",
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: "site-key-1234567890",
  CHALLENGE_COOKIE_SECRET: "unit-test-cookie-secret-0123456789abcdef",
};

let siteverify: ReturnType<typeof vi.fn>;
let upstashCalls: unknown[][];
let upstashMode: "ok" | "http500" | "network" | "garbage";
let upstashCounts: Map<string, number>;

/** Mocks BOTH outbound services. Nothing here ever touches the network. */
function installFetch(verdict: (token: string) => Response | Promise<Response> = () =>
  new Response(JSON.stringify({ success: true }), { status: 200 })) {
  siteverify = vi.fn(async (_url: string, init?: RequestInit) => verdict(new URLSearchParams(init?.body as URLSearchParams).get("response") ?? ""));
  upstashCalls = [];
  upstashCounts = new Map();
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u === SITEVERIFY) return siteverify(u, init);
    if (new URL(u).origin === UPSTASH) {
      const commands = JSON.parse(init!.body as string) as string[][];
      upstashCalls.push(commands);
      if (upstashMode === "network") throw new TypeError("fetch failed");
      if (upstashMode === "http500") return new Response("boom", { status: 500 });
      if (upstashMode === "garbage") return new Response(JSON.stringify([{ error: "ERR" }]), { status: 200 });
      return new Response(JSON.stringify(commands.map(([cmd, key]) => {
        if (cmd !== "INCR") return { result: 1 };
        const n = (upstashCounts.get(key!) ?? 0) + 1;
        upstashCounts.set(key!, n);
        return { result: n };
      })));
    }
    throw new Error(`unexpected outbound fetch to ${u}`);
  }));
}

async function load(env: Record<string, string | null> = {}): Promise<Handlers> {
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const [k, v] of Object.entries({ ...baseEnv, ...env })) if (v !== null) vi.stubEnv(k, v);
  const { proxy } = await import("@/proxy");
  const { POST } = await import("@/app/api/v1/challenge/route");
  return { proxy, POST };
}

const passedProxy = (r: Response) => r.headers.get("x-middleware-next") === "1";

/** The real request chain: proxy first, route only if the proxy lets it through. */
async function hit(h: Handlers, init: {
  body?: BodyInit | null; headers?: Record<string, string>; ip?: string | null; origin?: string | null; contentType?: string | null;
} = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.origin !== null) headers.set("origin", init.origin ?? SITE);
  if (init.contentType !== null) headers.set("content-type", init.contentType ?? "application/json");
  if (init.ip !== null) headers.set("x-real-ip", init.ip ?? "203.0.113.7");
  const body = init.body === undefined ? JSON.stringify({ token: TOKEN }) : init.body;
  const req = new NextRequest(`${SITE}/api/v1/challenge`, { method: "POST", headers, body, ...(typeof body === "object" && body ? { duplex: "half" } : {}) } as ConstructorParameters<typeof NextRequest>[1]);
  const pre = await h.proxy(req);
  if (!passedProxy(pre)) return pre;
  return h.POST(req);
}

const streamOf = (...chunks: Uint8Array[]) => {
  let i = 0;
  const cancel = vi.fn();
  return { cancel, stream: new ReadableStream<Uint8Array>({ pull(c) { if (i < chunks.length) c.enqueue(chunks[i++]); else c.close(); }, cancel }) };
};

beforeEach(() => { upstashMode = "ok"; installFetch(); vi.spyOn(console, "info").mockImplementation(() => undefined); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("challenge endpoint: rate limiting (P1)", () => {
  it("a legitimate challenge still succeeds and issues the signed pass cookie", async () => {
    const h = await load();
    const res = await hit(h);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get("set-cookie")).toMatch(/^fdb_pass=[^;]+\..+; .*HttpOnly/i);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(siteverify).toHaveBeenCalledTimes(1);
    const sent = (siteverify.mock.calls[0] as unknown as [string, RequestInit])[1].body as URLSearchParams;
    expect(sent.get("response")).toBe(TOKEN);
    expect(sent.get("remoteip")).toBe("203.0.113.7");
  });

  it("repeated POSTs eventually return 429 (Retry-After, no-store) and Siteverify is NOT called afterwards", async () => {
    const h = await load();
    const budget = DEFAULT_RULES.api_challenge.perIp;
    for (let i = 0; i < budget; i++) expect((await hit(h)).status).toBe(200);
    expect(siteverify).toHaveBeenCalledTimes(budget);
    for (let i = 0; i < 25; i++) {
      const res = await hit(h);
      expect(res.status).toBe(429);
      expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(Number(res.headers.get("retry-after"))).toBeLessThanOrEqual(DEFAULT_RULES.api_challenge.windowSec);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toMatchObject({ error: "rate_limited" });
    }
    expect(siteverify).toHaveBeenCalledTimes(budget); // unchanged: no outbound call after the limit
  });

  it("rejected-by-validation requests (bad token, bad JSON) also consume the per-IP budget", async () => {
    const h = await load();
    for (let i = 0; i < DEFAULT_RULES.api_challenge.perIp; i++) {
      expect((await hit(h, { body: "{not json" })).status).toBe(400);
    }
    expect((await hit(h)).status).toBe(429);
    expect(siteverify).not.toHaveBeenCalled();
  });

  it("untrusted headers and a rotating session cookie cannot bypass the limiter", async () => {
    const h = await load(); // trusted header = x-real-ip
    for (let i = 0; i < DEFAULT_RULES.api_challenge.perIp; i++) await hit(h);
    siteverify.mockClear();
    const spoofs: Record<string, string>[] = [
      { "x-forwarded-for": "198.51.100.1" }, { "cf-connecting-ip": "198.51.100.2" }, { "x-client-ip": "198.51.100.3" },
      { forwarded: "for=198.51.100.4" }, { "true-client-ip": "198.51.100.5" }, { "x-real-ip-extra": "1" },
      { cookie: "fdb_sid=AAAAAAAAAAAAAAAAAAAAAA" }, { cookie: "fdb_sid=BBBBBBBBBBBBBBBBBBBBBB; fdb_pass=forged.9999999999.sig" },
      { "x-ratelimit-bypass": "1", "x-vercel-forwarded-for": "198.51.100.6" },
    ];
    for (const headers of spoofs) expect((await hit(h, { headers })).status).toBe(429);
    expect(siteverify).not.toHaveBeenCalled();
    // A genuinely different trusted-header client is unaffected.
    expect((await hit(h, { ip: "203.0.113.99" })).status).toBe(200);
  });

  it("requests without the trusted header share one bucket (omitting it is not a bypass)", async () => {
    const h = await load();
    for (let i = 0; i < DEFAULT_RULES.api_challenge.perIp; i++) await hit(h, { ip: null, headers: { "x-forwarded-for": `198.51.100.${i}` } });
    expect((await hit(h, { ip: null, headers: { "x-forwarded-for": "198.51.100.200" } })).status).toBe(429);
  });

  it("enforces the global safety ceiling across many IPs", async () => {
    const h = await load({ RATE_LIMITS_JSON: JSON.stringify({ api_challenge: { perIp: 5, global: 4 } }) });
    for (let i = 0; i < 4; i++) expect((await hit(h, { ip: `203.0.113.${i + 1}` })).status).toBe(200);
    expect((await hit(h, { ip: "203.0.113.50" })).status).toBe(429);
    expect(siteverify).toHaveBeenCalledTimes(4);
  });

  it("an IP that is over its own budget does not burn the shared global ceiling", async () => {
    const h = await load({ RATE_LIMITS_JSON: JSON.stringify({ api_challenge: { perIp: 2, global: 4 } }) });
    for (let i = 0; i < 40; i++) await hit(h, { ip: "203.0.113.1" }); // 2 allowed, 38 refused
    expect((await hit(h, { ip: "203.0.113.2" })).status).toBe(200);
    expect((await hit(h, { ip: "203.0.113.3" })).status).toBe(200);
    // Global ceiling (4) = 2 (A) + 1 (B) + 1 (C). Had A's 38 refused requests
    // counted, B and C would already have been refused above.
    expect((await hit(h, { ip: "203.0.113.4" })).status).toBe(429);
  });

  it("does nothing (404, no counters, no outbound calls) when Turnstile is not configured", async () => {
    const h2 = await load({ TURNSTILE_SECRET_KEY: null, NEXT_PUBLIC_TURNSTILE_SITE_KEY: null, CHALLENGE_COOKIE_SECRET: null });
    for (let i = 0; i < 20; i++) expect((await hit(h2)).status).toBe(404);
    expect(siteverify).not.toHaveBeenCalled();
  });
});

describe("challenge endpoint: Upstash failure policy (fail closed)", () => {
  const upstashEnv = { RATE_LIMIT_BACKEND: "upstash", UPSTASH_REDIS_REST_URL: UPSTASH, UPSTASH_REDIS_REST_TOKEN: "upstash-token-0123456789abcdef" };

  it.each(["http500", "network", "garbage"] as const)("Upstash %s -> 503 Retry-After/no-store and NO Siteverify call", async (mode) => {
    const h = await load(upstashEnv);
    upstashMode = mode;
    const res = await hit(h);
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "temporarily_unavailable" });
    expect(siteverify).not.toHaveBeenCalled();
    expect(JSON.stringify(res.headers)).not.toContain("upstash-token");
  });

  it("with a healthy Upstash the flow works end to end and uses per-IP + global keys only (no session key)", async () => {
    const h = await load(upstashEnv);
    expect((await hit(h, { headers: { cookie: "fdb_sid=AAAAAAAAAAAAAAAAAAAAAA" } })).status).toBe(200);
    const keys = [...upstashCounts.keys()];
    expect(keys.some((k) => k.startsWith("rl:api_challenge:ip:"))).toBe(true);
    expect(keys.some((k) => k.startsWith("rl:api_challenge:global:"))).toBe(true);
    expect(keys.some((k) => k.includes(":sid:"))).toBe(false);
    expect(upstashCalls.length).toBe(2); // two-phase: ip, then global
    expect(siteverify).toHaveBeenCalledTimes(1);
  });
});

describe("challenge endpoint: origin, content-type and token validation", () => {
  it("rejects foreign / missing origins and non-JSON content types BEFORE counting or verifying", async () => {
    const h = await load();
    for (let i = 0; i < 30; i++) {
      expect((await hit(h, { origin: "https://evil.example" })).status).toBe(403);
      expect((await hit(h, { origin: null })).status).toBe(403);
      expect((await hit(h, { contentType: "text/plain" })).status).toBe(403);
      expect((await hit(h, { contentType: null })).status).toBe(403);
    }
    expect(siteverify).not.toHaveBeenCalled();
    // Hostile cross-site posts did not burn the legitimate user's budget.
    expect((await hit(h)).status).toBe(200);
  });

  it("route handler enforces origin on its own too (defence in depth)", async () => {
    const h = await load();
    const res = await h.POST(new Request(`${SITE}/api/v1/challenge`, {
      method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify({ token: TOKEN }),
    }));
    expect(res.status).toBe(403);
    expect(siteverify).not.toHaveBeenCalled();
  });

  it("invalid token: 403 verification_failed, no cookie, no raw third-party response or secret in the reply", async () => {
    installFetch(() => new Response(JSON.stringify({ success: false, "error-codes": ["raw-third-party-detail"], secret: "echoed" }), { status: 200 }));
    const h = await load();
    const res = await hit(h, { body: JSON.stringify({ token: "bad-token-0123456789" }) });
    expect(res.status).toBe(403);
    const text = await res.text();
    expect(text).toBe(JSON.stringify({ error: "verification_failed" }));
    expect(text).not.toContain("raw-third-party-detail");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("Siteverify outage -> 503 verification_unavailable with no internals", async () => {
    installFetch(() => { throw new TypeError("connect ECONNREFUSED 10.0.0.1:443 SECRET-turnstile-key-do-not-leak"); });
    const h = await load();
    const res = await hit(h);
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).toBe(JSON.stringify({ error: "verification_unavailable" }));
    expect(text).not.toMatch(/ECONNREFUSED|SECRET/);
  });

  it("Siteverify non-2xx or non-JSON reply fails closed", async () => {
    installFetch(() => new Response("<html>oops</html>", { status: 200 }));
    const h = await load();
    expect((await hit(h)).status).toBe(503);
    installFetch(() => new Response("{}", { status: 500 }));
    expect((await hit(await load(), { ip: "203.0.113.20" })).status).toBe(403);
  });

  it.each([
    ["too short token", { token: "short" }],
    ["too long token", { token: "x".repeat(2049) }],
    ["non-string token", { token: 12345678901 }],
    ["extra property", { token: TOKEN, extra: 1 }],
    ["missing token", {}],
    ["array", [TOKEN]],
    ["null", null],
  ])("rejects %s with 400 and never calls Siteverify", async (_n, payload) => {
    const h = await load();
    const res = await hit(h, { body: JSON.stringify(payload) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_body" });
    expect(siteverify).not.toHaveBeenCalled();
  });
});

describe("challenge endpoint: body-size enforcement (P1)", () => {
  const big = (n: number) => JSON.stringify({ token: "t".repeat(n) });

  it("malformed JSON, invalid UTF-8 and empty bodies -> 400, safely", async () => {
    const h = await load();
    for (const body of ["{not json", "", "\u0000", '{"token":'] as const) {
      const res = await hit(h, { body, ip: `203.0.113.${Math.floor(Math.random() * 200) + 20}` });
      expect([400]).toContain(res.status);
      expect(JSON.stringify(await res.json())).toMatch(/invalid_body/);
    }
    const res = await hit(h, { body: new Uint8Array([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]), ip: "203.0.113.230" });
    expect(res.status).toBe(400);
    expect(siteverify).not.toHaveBeenCalled();
  });

  it("missing Content-Length (no header) with an oversized body -> 413", async () => {
    const h = await load();
    const req = new Request(`${SITE}/api/v1/challenge`, { method: "POST", headers: { "content-type": "application/json" }, body: big(5000) });
    req.headers.delete("content-length");
    expect(req.headers.get("content-length")).toBeNull();
    const res = await h.POST(new Request(req, { headers: { origin: SITE, "content-type": "application/json" } }));
    expect(res.status).toBe(413);
    expect(siteverify).not.toHaveBeenCalled();
  });

  it("declared length over the cap -> 413 without reading the body", async () => {
    const h = await load();
    const res = await hit(h, { headers: { "content-length": "999999" } });
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "payload_too_large" });
    expect(siteverify).not.toHaveBeenCalled();
  });

  it.each(["abc", "-1", "1e3", "12.5", "0x10", " ", "99999999999999999999"])("invalid Content-Length %j -> 400/413, never accepted", async (cl) => {
    const h = await load();
    const res = await hit(h, { headers: { "content-length": cl }, ip: `203.0.113.${100 + Math.floor(Math.random() * 100)}` });
    expect([400, 413]).toContain(res.status);
    expect(siteverify).not.toHaveBeenCalled();
  });

  it("MISLEADING Content-Length (claims small, body is large) -> 413 on the bytes actually received", async () => {
    const h = await load();
    const res = await h.POST(new Request(`${SITE}/api/v1/challenge`, {
      method: "POST", headers: { origin: SITE, "content-type": "application/json", "content-length": "10" }, body: big(MAX_CHALLENGE_BODY_BYTES + 500),
    }));
    expect(res.status).toBe(413);
    expect(siteverify).not.toHaveBeenCalled();
  });

  it("understated Content-Length with a small valid body is accepted (header is only a hint)", async () => {
    const h = await load();
    expect((await hit(h, { headers: { "content-length": "5" } })).status).toBe(200);
  });

  it("chunked/unknown-length stream over the cap is cancelled mid-flight -> 413", async () => {
    const enc = new TextEncoder();
    const { stream, cancel } = streamOf(enc.encode('{"token":"'), enc.encode("a".repeat(3000)), enc.encode("a".repeat(3000)), enc.encode('"}'));
    const r = await readBoundedJson(new Request(`${SITE}/x`, { method: "POST", body: stream, duplex: "half" } as RequestInit));
    expect(r).toEqual({ ok: false, status: 413, error: "payload_too_large" });
    expect(cancel).toHaveBeenCalled();
  });

  it("exactly at the cap is accepted; one byte over is refused", async () => {
    const pad = (n: number) => JSON.stringify({ token: "t".repeat(n) });
    const overhead = pad(0).length;
    const at = pad(MAX_CHALLENGE_BODY_BYTES - overhead);
    expect(at.length).toBe(MAX_CHALLENGE_BODY_BYTES);
    expect((await readBoundedJson(new Request(`${SITE}/x`, { method: "POST", body: at }))).ok).toBe(true);
    expect(await readBoundedJson(new Request(`${SITE}/x`, { method: "POST", body: at + " " }))).toMatchObject({ ok: false, status: 413 });
  });

  it("a body between 4 KiB and the Zod token cap is refused by the byte ceiling, not parsed", async () => {
    const h = await load();
    expect((await hit(h, { body: big(4500) })).status).toBe(413);
    expect(siteverify).not.toHaveBeenCalled();
  });
});

describe("rate-limit unit helpers for the challenge rule", () => {
  it("classifies POST /api/v1/challenge as api_challenge and keeps GET behaviour unchanged", () => {
    expect(classifyRequest("/api/v1/challenge", "POST")).toBe("api_challenge");
    expect(classifyRequest("/api/v1/challenge", "GET")).toBeNull();
    expect(classify("/api/v1/challenge")).toBeNull();
    expect(classifyRequest("/api/v1/search", "GET")).toBe("api_search");
    expect(classifyRequest("/api/v1/search", "POST")).toBeNull();
  });

  it("default budget is conservative and overridable", () => {
    expect(DEFAULT_RULES.api_challenge.perIp).toBeLessThanOrEqual(10);
    expect(loadRules('{"api_challenge":{"perIp":2}}').api_challenge.perIp).toBe(2);
  });

  it("checkStrictLimit: per-IP first, resets next window, never touches the global key when the IP is over budget", async () => {
    const store = new MemoryStore();
    const incr = vi.spyOn(store, "incr");
    const rule = { windowSec: 600, perIp: 2, perSession: 2, global: 100 };
    const t = Date.UTC(2026, 9, 10, 12, 0, 5);
    expect((await checkStrictLimit(store, "api_challenge", rule, "ip", t)).allowed).toBe(true);
    expect((await checkStrictLimit(store, "api_challenge", rule, "ip", t)).allowed).toBe(true);
    incr.mockClear();
    const d = await checkStrictLimit(store, "api_challenge", rule, "ip", t);
    expect(d).toMatchObject({ allowed: false, reason: "rate_limited" });
    expect(incr).toHaveBeenCalledTimes(1);
    expect(incr.mock.calls[0]![0]).toHaveLength(1);
    expect((await checkStrictLimit(store, "api_challenge", rule, "ip", t + 600_000)).allowed).toBe(true);
  });
});

describe("review hardening", () => {
  it("the proxy matcher covers /api/v1/challenge (a matcher gap would remove the limiter entirely)", async () => {
    const { config } = await import("@/proxy");
    const re = new RegExp(`^${(config.matcher[0] as { source: string }).source}$`);
    for (const p of ["/api/v1/challenge", "/api/v1/search"]) expect(re.test(p)).toBe(true);
    expect(re.test("/_next/static/x.js")).toBe(false);
  });

  it("IPv6 clients are keyed by canonical /64, so address rotation inside a prefix does not mint new buckets", () => {
    expect(ipv6Prefix64("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:0db8:0001:0002::/64");
    expect(ipv6Prefix64("2001:DB8:1:2::1")).toBe(ipv6Prefix64("2001:db8:1:2:ffff::9"));
    expect(ipv6Prefix64("2001:db8:1:3::1")).not.toBe(ipv6Prefix64("2001:db8:1:2::1"));
    expect(ipv6Prefix64("::1")).toBe(ipv6Prefix64("0:0:0:0:0:0:0:1"));
    expect(ipv6Prefix64("::ffff:203.0.113.7")).toBe("203.0.113.7");
    const h = (v: string) => new Headers({ "x-real-ip": v });
    expect(clientIp(h("2001:db8:1:2::1"), "x-real-ip")).toBe(clientIp(h("2001:db8:1:2::2"), "x-real-ip"));
    expect(clientIp(h("203.0.113.7"), "x-real-ip")).toBe("203.0.113.7");
  });
});
