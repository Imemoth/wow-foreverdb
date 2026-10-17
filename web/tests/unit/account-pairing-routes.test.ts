import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const SITE = "http://localhost:3000", AUTH = "http://127.0.0.1:54321";
const TOKEN = "eyJhbGciOiJIUzI1NiJ9.native-anonymous.signature";
const ID = "8f790272-8cb2-4c5a-a57d-83c7d3d618aa", DEVICE = "223e4567-e89b-42d3-a456-426614174000";
const SECRET = `fdbp1_${"s".repeat(43)}`, TS = "2026-10-16T12:05:00Z";
const START = { pairingId: ID, pollSecretHash: "a".repeat(64), deviceId: DEVICE, deviceCredentialHash: "b".repeat(64), installationId: "installation-0123456789", computerName: "Gaming PC" };
const PROOF = { pairingId: ID, pollSecret: SECRET };
const ENV = {
  FOREVERDB_DEPLOYMENT: "local", FOREVERDB_DATA_SOURCE: "fixture", SITE_URL: SITE,
  RATE_LIMIT_BACKEND: "memory", TRUSTED_IP_HEADER: "x-real-ip", RATE_LIMIT_SALT: "unit-test-salt-0123456789abcdef0123456789",
  ACCOUNT_AUTH_MODE: "local", ACCOUNT_AUTH_URL: AUTH, ACCOUNT_AUTH_PUBLISHABLE_KEY: "sb_publishable_native_test",
  ACCOUNT_CSRF_SECRET: "unit-test-csrf-secret-0123456789abcdef",
};
const operations = ["start", "poll", "cancel"] as const;
type Operation = typeof operations[number];
let calls: { url: string; init: RequestInit }[];
let reply: () => Response | Promise<Response>;
let logs: ReturnType<typeof vi.spyOn>[];
const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const success = (op: Operation) => op === "start" ? { ok: true, state: "pending", pairingId: ID, expiresAt: TS, intervalSeconds: 5 } : { ok: true, state: "connected", deviceId: DEVICE };
const path = (op: Operation) => `/account/api/device-pair/${op}`;
async function load(extra: Record<string, string> = {}) {
  vi.resetModules(); vi.unstubAllEnvs();
  for (const [k, v] of Object.entries({ ...ENV, ...extra })) vi.stubEnv(k, v);
  const [start, poll, cancel, edge, env] = await Promise.all([
    import("@/app/account/api/device-pair/start/route"), import("@/app/account/api/device-pair/poll/route"),
    import("@/app/account/api/device-pair/cancel/route"), import("@/proxy"), import("@/lib/env"),
  ]);
  return { start, poll, cancel, proxy: edge.proxy, env: env.serverEnv() };
}
type Handlers = Awaited<ReturnType<typeof load>>;
function request(op: Operation, over: { headers?: HeadersInit; raw?: BodyInit; body?: unknown; noAuth?: boolean } = {}) {
  const headers = new Headers({ "content-type": "application/json", "x-real-ip": "203.0.113.7", ...(over.noAuth ? {} : { authorization: `Bearer ${TOKEN}` }) });
  new Headers(over.headers).forEach((v, k) => headers.set(k, v));
  return new NextRequest(`${SITE}${path(op)}`, { method: "POST", headers, body: over.raw ?? JSON.stringify(over.body ?? (op === "start" ? START : PROOF)) });
}
async function hit(h: Handlers, op: Operation, over: Parameters<typeof request>[1] = {}) {
  const req = request(op, over), edge = await h.proxy(req);
  return edge.headers.get("x-middleware-next") === "1" ? h[op].POST(req) : edge;
}
beforeEach(() => {
  calls = []; reply = () => json(success("start"));
  // Only the closed PostgREST boundary is replaced; runtime, proxy, limiter, guards and RPC transport run for real.
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init: RequestInit) => {
    if (!String(url).startsWith(`${AUTH}/rest/v1/rpc/fdb_device_pair_`)) throw new Error("unexpected outbound call");
    calls.push({ url: String(url), init }); return reply();
  }));
  logs = (["info", "log", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("native pairing real handler/proxy boundary", () => {
  it.each(operations)("%s accepts native bearer-only JSON and calls exactly its RPC without cookies/CORS", async (op) => {
    const h = await load(); reply = () => json(success(op));
    const res = await hit(h, op, { headers: { cookie: "fdb_account=forged; fdb_csrf=forged" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(op === "start" ? { ...success(op), verificationUri: `${SITE}/account/device-pair?request=${ID}` } : success(op));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${AUTH}/rest/v1/rpc/fdb_device_pair_${op}`);
    expect(calls[0]!.init).toMatchObject({ method: "POST", redirect: "manual", cache: "no-store", credentials: "omit" });
    expect(calls[0]!.init.headers).toEqual({ Authorization: `Bearer ${TOKEN}`, apikey: ENV.ACCOUNT_AUTH_PUBLISHABLE_KEY, "Content-Type": "application/json", Accept: "application/json" });
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual(op === "start" ? { p_pairing_id: ID, p_poll_secret_hash: START.pollSecretHash, p_device_id: DEVICE, p_device_credential_hash: START.deviceCredentialHash, p_installation_id: START.installationId, p_computer_name: START.computerName } : { p_pairing_id: ID, p_poll_secret: SECRET });
    expect(res.headers.get("cache-control")).toBe("private, no-store"); expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-robots-tag")).toContain("noindex"); expect(res.headers.get("set-cookie")).toBeNull();
    expect([...res.headers.keys()].filter((k) => k.startsWith("access-control-"))).toEqual([]);
    expect(Object.keys(h[op]).filter((key) => /^[A-Z]+$/.test(key))).toEqual(["POST"]);
  });
  it.each(operations)("%s rejects absent/duplicate/malformed authorization; Account cookies are never identity", async (op) => {
    const h = await load();
    for (const authorization of ["", "Basic abc", "Bearer short", `Bearer ${TOKEN}, Bearer ${TOKEN}`, `Bearer  ${TOKEN}`, `Bearer ${TOKEN} extra`, `Bearer ${"a".repeat(8193)}`, "Bearer refresh_token=secret"]) {
      const res = await h[op].POST(request(op, { headers: { authorization, cookie: "fdb_account=session; fdb_csrf=token" } }));
      expect(res.status).toBe(401); expect(await res.json()).toEqual({ ok: false, error: "session_not_accepted" });
    }
    expect((await h[op].POST(request(op, { noAuth: true, headers: { cookie: "fdb_account=session" } }))).status).toBe(401);
    const duplicate = request(op); duplicate.headers.append("authorization", `Bearer ${TOKEN}`);
    expect((await h[op].POST(duplicate)).status).toBe(401); expect(calls).toHaveLength(0);
  });
  it.each(operations)("%s refuses foreign/null Origin and inconsistent browser metadata at handler and proxy", async (op) => {
    const h = await load();
    for (const headers of ([{ origin: "https://foreign.example" }, { origin: "null" }, { origin: `${SITE}/` }, { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }, { "sec-fetch-site": "none" }, { origin: SITE, "sec-fetch-site": "cross-site" }, { "sec-fetch-mode": "navigate" }, { "sec-fetch-dest": "document" }] satisfies Record<string, string>[])) {
      expect((await h[op].POST(request(op, { headers: new Headers(Object.entries(headers)) }))).status).toBe(403);
      expect((await h.proxy(request(op, { headers: new Headers(Object.entries(headers)) }))).status).toBe(403);
    }
    expect(calls).toHaveLength(0); reply = () => json(success(op));
    for (const headers of ([{ origin: SITE }, { "sec-fetch-site": "same-origin" }, { origin: SITE, "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" }] satisfies Record<string, string>[])) expect((await hit(h, op, { headers: new Headers(Object.entries(headers)) })).status).toBe(200);
  });
  it.each(operations)("%s strictly validates/bounds JSON before RPC", async (op) => {
    const h = await load(), cap = op === "start" ? 2048 : 512, valid = JSON.stringify(op === "start" ? START : PROOF);
    for (const raw of ["", "{", "null", "[]", valid.replace('"pairingId":', `"pairingId":"${ID}","pairingId":`), valid.replace('"pairingId":', `"pairingId":"${ID}","pairing\\u0049d":`), valid.slice(0, -1) + ',"extra":1}', valid.replace(ID, ID.toUpperCase()), new Uint8Array([0xff, 0xfe])]) {
      const res = await h[op].POST(request(op, { raw })); expect(res.status).toBe(400); expect(await res.json()).toEqual({ ok: false, error: "invalid_request" });
    }
    for (const contentType of ["text/plain", "application/jsonp", "application/x-www-form-urlencoded", "application/json; charset=latin1"]) expect((await h[op].POST(request(op, { headers: { "content-type": contentType } }))).status).toBe(400);
    const missing = request(op); missing.headers.delete("content-type"); expect((await h[op].POST(missing)).status).toBe(400);
    for (const headers of ([{}, { "content-length": "1" }, { "content-length": String(cap + 1) }] satisfies Record<string, string>[])) expect((await h[op].POST(request(op, { raw: valid.padEnd(cap + 1), headers: new Headers(Object.entries(headers)) }))).status).toBe(413);
    expect((await h[op].POST(request(op, { headers: { "content-length": "invalid" } }))).status).toBe(400);
    expect(calls).toHaveLength(0); reply = () => json(success(op));
    expect((await h[op].POST(request(op, { raw: valid.padEnd(cap), headers: { "content-type": "application/json; charset=utf-8" } }))).status).toBe(200);
  });
  it.each(operations)("%s refuses hosted staging/pilot/production before reading any request field", async (op) => {
    const h = await load();
    // Real validated env, altered downstream contexts: no runtime mocks and source approvals remain OFF.
    for (const mode of ["staging", "pilot", "production"] as const) {
      h.env.accountAuth!.mode = mode; h.env.hosted = true; h.env.FOREVERDB_DEPLOYMENT = mode === "production" ? "production" : "preview";
      h.env.SITE_URL = "https://foreverdb.example"; h.env.RATE_LIMIT_BACKEND = "upstash"; h.env.TURNSTILE_SECRET_KEY = "test-turnstile"; h.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY = "test-site-key";
      const unreadable = new Proxy(request(op), { get(target, prop, receiver) { if (["body", "headers", "cookies", "text", "json", "clone"].includes(String(prop))) throw new Error("request inspected before gate"); return Reflect.get(target, prop, receiver); } });
      const res = await h[op].POST(unreadable); expect(res.status, mode).toBe(404); expect(await res.json()).toEqual({ ok: false, error: "not_found" });
    }
    expect(calls).toHaveLength(0);
  });
  it("logs only fixed route/status classes for early refusal as well as RPC outcomes", async () => {
    const h = await load();
    await h.start.POST(request("start", { noAuth: true }));
    const events = logs.flatMap((log) => log.mock.calls).map((call) => JSON.parse(String(call[0])));
    expect(events).toContainEqual(expect.objectContaining({ event: "account_pairing_native", route: "start", status: 401, kind: "refused" }));
  });
  it("forwards a registered bearer unchanged and refuses the database's actor rejection without consulting Account cookies", async () => {
    const h = await load(), registered = "eyJhbGciOiJIUzI1NiJ9.registered.signature";
    reply = () => json({ message: "registered users cannot start" }, 403);
    const res = await h.start.POST(request("start", { headers: { authorization: `Bearer ${registered}`, cookie: "fdb_account=registered" } }));
    expect(res.status).toBe(401); expect(await res.json()).toEqual({ ok: false, error: "session_not_accepted" });
    expect(calls).toHaveLength(1); expect(calls[0]!.init.headers).toMatchObject({ Authorization: `Bearer ${registered}` });
  });
  it("returns every valid poll/cancel state without credential material", async () => {
    const h = await load();
    for (const op of ["poll", "cancel"] as const) for (const state of ["connected", "expired", "denied", "revoked"]) {
      const body = state === "connected" ? { ok: true, state, deviceId: DEVICE } : { ok: true, state };
      reply = () => json(body); const res = await h[op].POST(request(op)); expect(res.status).toBe(200); expect(await res.json()).toEqual(body);
    }
    for (const state of ["pending", "approved"]) {
      const body = { ok: true, state, expiresAt: TS, intervalSeconds: 5 }; reply = () => json(body);
      const res = await h.poll.POST(request("poll")); expect(res.status).toBe(200); expect(await res.json()).toEqual(body);
    }
  });
  it.each(operations)("%s cancels an oversized chunked request without an RPC", async (op) => {
    const h = await load(), cancel = vi.fn();
    let count = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new TextEncoder().encode(count++ === 0 ? "{\"pairingId\":\"" : "x".repeat(3000))); }, cancel });
    const req = new NextRequest(`${SITE}${path(op)}`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body, duplex: "half" } as ConstructorParameters<typeof NextRequest>[1]);
    expect((await h[op].POST(req)).status).toBe(413); expect(cancel).toHaveBeenCalled(); expect(calls).toHaveLength(0);
  });
  it("Account disabled returns 404 without RPC", async () => {
    const h = await load(); h.env.accountAuth = null;
    for (const op of operations) expect((await h[op].POST(request(op, { raw: "broken", noAuth: true }))).status).toBe(404);
    expect(calls).toHaveLength(0);
  });
  it("maps only fixed public errors/statuses and bounded Retry-After", async () => {
    const h = await load();
    for (const [op, error, status] of [["start", "pairing_conflict", 409], ["start", "pairing_pending", 409], ["start", "installation_conflict", 409], ["start", "device_bound", 409], ["poll", "device_limit", 409], ["poll", "account_limit", 409], ["poll", "pairing_not_available", 409], ["cancel", "session_not_accepted", 401], ["poll", "invalid_request", 400], ["start", "feature_disabled", 503], ["cancel", "temporarily_unavailable", 503], ["start", "rate_limited", 429]] as const) {
      reply = () => json({ ok: false, error }); const res = await h[op].POST(request(op));
      expect(res.status, error).toBe(status); expect(await res.json()).toEqual({ ok: false, error });
      if (status === 429) expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    }
    reply = () => json({ ok: false, error: "slow_down", intervalSeconds: 30 });
    const slow = await h.poll.POST(request("poll")); expect(slow.status).toBe(429); expect(slow.headers.get("retry-after")).toBe("30"); expect(await slow.json()).toEqual({ ok: false, error: "slow_down", intervalSeconds: 30 });
    for (const [status, error] of [[401, "session_not_accepted"], [403, "session_not_accepted"], [400, "invalid_request"], [429, "rate_limited"], [404, "temporarily_unavailable"]] as const) {
      reply = () => json({ message: "private database text" }, status, { "retry-after": "999999" }); const res = await h.start.POST(request("start"));
      expect(res.status).toBe(status === 403 ? 401 : status === 404 ? 503 : status); expect(await res.json()).toEqual({ ok: false, error }); if (status === 429) expect(res.headers.get("retry-after")).toBe("3600");
    }
  });
  it.each(operations)("%s never follows redirects/retries unknown outcomes or returns credentials from bad replies", async (op) => {
    const h = await load();
    for (const bad of [() => { throw new TypeError(`private ${SECRET}`); }, () => new Response(null, { status: 307, headers: { location: "https://foreign.example" } }), () => json({ ...success(op), deviceCredential: "fdbd1_secret", pollSecret: SECRET }), () => json({ ok: false, error: "private database text" })]) {
      calls.length = 0; reply = bad; const res = await h[op].POST(request(op));
      expect(res.status).toBe(op === "poll" ? 503 : 502); expect(await res.json()).toEqual({ ok: false, error: op === "poll" ? "temporarily_unavailable" : "unknown_outcome" }); expect(calls).toHaveLength(1); expect(calls[0]!.init.redirect).toBe("manual");
    }
    const text = JSON.stringify(logs.map((log) => log.mock.calls));
    for (const secret of [TOKEN, SECRET, ID, START.installationId, START.pollSecretHash, START.deviceCredentialHash, "private database text"]) expect(text).not.toContain(secret);
    expect(text).toContain("account_pairing_native");
  });
  it("only the exact three native POST paths waive mandatory browser-origin headers", async () => {
    const { classifyRequest, isStrictRule } = await import("@/lib/security/rate-limit");
    for (const op of operations) { expect(classifyRequest(path(op), "POST")).toBe("account_pairing_native"); expect(classifyRequest(path(op), "GET")).toBe("account_light"); }
    expect(isStrictRule(classifyRequest(path("start"), "POST"))).toBe(true);
    const h = await load();
    for (const other of ["/account/api/login", "/account/api/devices/revoke", "/account/api/device-pair/approve", "/account/api/device-pair/deny", "/account/api/device-pair/start/extra", "/account/api/device-pair/start/"]) {
      const req = new NextRequest(`${SITE}${other}`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
      expect((await h.proxy(req)).status, other).toBe(403); req.headers.set("origin", SITE); expect((await h.proxy(req)).headers.get("x-middleware-next"), other).toBe("1");
    }
  });
  it("strict IP/global budgets precede RPC; cookies cannot bypass and hostile origins do not burn budget", async () => {
    const h = await load({ RATE_LIMITS_JSON: JSON.stringify({ account_pairing_native: { perIp: 2, global: 3, perSession: 1 } }) });
    for (let i = 0; i < 5; i++) expect((await hit(h, "start", { headers: { origin: "null" } })).status).toBe(403);
    expect((await hit(h, "start")).status).toBe(200); expect((await hit(h, "start", { headers: { cookie: "fdb_sid=AAAAAAAAAAAAAAAAAAAAAA" } })).status).toBe(200);
    const limited = await hit(h, "start", { headers: { cookie: "fdb_sid=BBBBBBBBBBBBBBBBBBBBBB" } }); expect(limited.status).toBe(429); expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await hit(h, "start", { headers: { "x-real-ip": "203.0.113.8" } })).status).toBe(200); expect((await hit(h, "start", { headers: { "x-real-ip": "203.0.113.9" } })).status).toBe(429); expect(calls).toHaveLength(3);
  });
});
