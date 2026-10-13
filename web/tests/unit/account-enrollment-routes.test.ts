import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountAuthConfig } from "@/lib/account/config";
import { b64urlEncode } from "@/lib/account/crypto";
import { csrfBinding, mintCsrf } from "@/lib/account/csrf";
import { writeSession, jarFrom, type StoredSession } from "@/lib/account/session";

/**
 * Route behaviour of the zero-touch enrollment website routes, with a stubbed `fetch` standing in for Auth (GET /user) and
 * PostgREST, and the account runtime replaced by a fixed ready context. Unit evidence only (real GoTrue/PostgREST is not involved).
 */
const SECRET = "unit-test-secret-0123456789abcdefghijklmnopqrstuvwxyz";
const UID = "123e4567-e89b-42d3-a456-426614174000";
const ID = "223e4567-e89b-42d3-a456-426614174000";
const ORIGIN = "http://localhost:3000";
const TICKET = `fdba1_${"Qx9-_".repeat(8)}abc`; // 43 base64url characters
const TS = "2026-10-20T12:00:00.000000+00:00";
const cfg: AccountAuthConfig = { mode: "local", authOrigin: "http://127.0.0.1:54321", projectRef: null, publishableKey: "sb_publishable_unit_key_not_real", csrfSecret: SECRET };

const rt = vi.hoisted(() => ({ state: "ready" as "ready" | "disabled" }));
vi.mock("@/lib/account/runtime", () => ({
  accountRuntime: () =>
    rt.state === "disabled"
      ? { state: "disabled" }
      : { state: "ready", ctx: { cfg, env: {}, https: false, siteOrigin: "http://localhost:3000", callbackUrl: "http://localhost:3000/account/auth/confirm", cookies: { session: "fdb_acct", csrf: "fdb_csrf" }, turnstileSecret: null } },
}));

const jwt = (claims: Record<string, unknown>) => {
  const enc = (o: unknown) => b64urlEncode(new TextEncoder().encode(JSON.stringify(o)));
  return `${enc({ alg: "HS256" })}.${enc(claims)}.${"s".repeat(43)}`;
};
const nowSec = () => Math.floor(Date.now() / 1000);
const stored = (): StoredSession => ({ v: 1, k: "user", uid: UID, at: jwt({ exp: nowSec() + 3600, session_id: "sess-1", sub: UID }), rt: "refresh-token-old", ex: nowSec() + 3600, sid: "sess-1", sc: nowSec(), rf: nowSec() });
const AUTH_USER = { id: UID, email: "a@example.test", email_confirmed_at: "2026-01-01T00:00:00Z", created_at: "2026-01-01T00:00:00Z", is_anonymous: false };

async function sessionCookie(s = stored()): Promise<string> {
  const headers: string[] = [];
  await writeSession(SECRET, { append: (_: string, v: string) => headers.push(v) }, jarFrom(() => []), false, s);
  return headers.map((h) => h.split(";")[0]).join("; ");
}

interface Rpc { name: string; body: unknown; headers: Record<string, string> }
interface World { rpc: Rpc[]; auth: number; reply: (name: string) => Response | "throw"; user: Record<string, unknown> | null }
let world: World;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

beforeEach(() => {
  rt.state = "ready";
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  world = { rpc: [], auth: 0, reply: () => json({}), user: AUTH_USER };
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/auth/v1/user")) {
      world.auth += 1;
      return world.user ? json(world.user) : json({ code: "bad_jwt" }, 401);
    }
    const name = url.split("/rest/v1/rpc/")[1]!;
    world.rpc.push({ name, body: JSON.parse(String(init?.body)), headers: init?.headers as Record<string, string> });
    const r = world.reply(name);
    if (r === "throw") throw new DOMException("timed out", "TimeoutError");
    return r;
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const logs = () => vi.mocked(console.info);

async function formPost(path: string, over: { fields?: Record<string, string> | string; headers?: Record<string, string>; session?: StoredSession | null; token?: string | null; accept?: string; omitCsrf?: boolean } = {}) {
  const s = over.session === undefined ? stored() : over.session;
  const token = over.token === undefined ? await mintCsrf(SECRET, csrfBinding(s)) : over.token;
  const fields = typeof over.fields === "string" ? over.fields : new URLSearchParams({ ...(over.omitCsrf || token === null ? {} : { csrf: token }), ...(over.fields ?? {}) }).toString();
  return new NextRequest(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded", ...(s ? { cookie: await sessionCookie(s) } : {}), ...(over.accept ? { accept: over.accept } : {}), ...over.headers },
    body: fields,
  });
}

/** JSON POST with the signed double-submit token, like the browser helper (client.ts). */
async function jsonPost(path: string, body: unknown, over: { headers?: Record<string, string>; session?: StoredSession | null; csrf?: "ok" | "none" | "mismatch" | "other-session"; raw?: string } = {}) {
  const s = over.session === undefined ? stored() : over.session;
  const mode = over.csrf ?? "ok";
  const token = await mintCsrf(SECRET, mode === "other-session" ? "s:another" : csrfBinding(s));
  const cookies = [s ? await sessionCookie(s) : null, mode === "none" ? null : `fdb_csrf=${mode === "mismatch" ? "x".repeat(20) : token}`].filter(Boolean).join("; ");
  return new NextRequest(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json", ...(mode === "none" ? {} : { "x-fdb-csrf": token }), cookie: cookies, ...over.headers },
    body: over.raw ?? JSON.stringify(body),
  });
}
const get = async (path: string, headers: Record<string, string> = {}, session: StoredSession | null = stored()) =>
  new NextRequest(`${ORIGIN}${path}`, { method: "GET", headers: { "sec-fetch-site": "same-origin", ...(session ? { cookie: await sessionCookie(session) } : {}), ...headers } });

const ISSUE_OK = () => json({ ok: true, ticket_id: ID, ticket: TICKET, expires_at: TS });
const DOWNLOAD = "/account/api/enrollment/download";

describe("POST /account/api/enrollment/download", () => {
  it("answers a native form post with the activation file and exactly the required headers; the ticket is only in the body", async () => {
    const { POST } = await import("@/app/account/api/enrollment/download/route");
    world.reply = ISSUE_OK;
    const res = await POST(await formPost(DOWNLOAD));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="foreverdb-activation.fdbact"');
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("location")).toBeNull();
    for (const [k, v] of res.headers) if (k !== "content-disposition" && k !== "x-robots-tag") expect(v, k).not.toContain(TICKET);
    const text = await res.text();
    expect(Object.keys(JSON.parse(text))).toEqual(["format", "v", "ticket", "expiresAt", "createdAt"]);
    const file = JSON.parse(text) as Record<string, unknown>;
    expect(file).toMatchObject({ format: "foreverdb-activation", v: 1, ticket: TICKET, expiresAt: "2026-10-20T12:00:00.000Z" });
    expect(new Date(file.createdAt as string).toISOString()).toBe(file.createdAt);
    expect(text).not.toMatch(/a@example|123e4567|eyJ|refresh/); // no e-mail, no account id, no token
    expect(new TextEncoder().encode(text).length).toBeLessThan(1024);
    // exactly one database call, with the user's OWN token and an empty body
    expect(world.rpc).toHaveLength(1);
    expect(world.rpc[0]!.name).toBe("fdb_account_enrollment_ticket_issue");
    expect(world.rpc[0]!.body).toEqual({});
    expect(world.rpc[0]!.headers.Authorization).toMatch(/^Bearer eyJ/);
    expect(world.rpc[0]!.headers.apikey).toBe(cfg.publishableKey);
  });

  it("exports no GET (or any other method): a link, image, prefetch or crawler can never create a ticket", async () => {
    const mod = (await import("@/app/account/api/enrollment/download/route")) as Record<string, unknown>;
    expect(Object.keys(mod).filter((k) => /^(GET|HEAD|PUT|PATCH|DELETE|OPTIONS)$/.test(k))).toEqual([]);
    expect(typeof mod.POST).toBe("function");
  });

  it("never logs the ticket (or any request data), on success and on every failure", async () => {
    const { POST } = await import("@/app/account/api/enrollment/download/route");
    const info = logs();
    const others = (["log", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    world.reply = ISSUE_OK;
    await POST(await formPost(DOWNLOAD));
    world.reply = () => "throw";
    await POST(await formPost(DOWNLOAD));
    world.reply = () => json({ ok: false, error: "ticket_limit" });
    await POST(await formPost(DOWNLOAD));
    await POST(await formPost(DOWNLOAD, { omitCsrf: true }));
    const text = JSON.stringify(info.mock.calls) + JSON.stringify(others.map((s) => s.mock.calls));
    expect(text).not.toContain(TICKET);
    expect(text).not.toContain("fdba1_");
    expect(text).not.toMatch(/eyJ|csrf=|a@example/);
    expect(info.mock.calls.some((c) => String(c[0]).includes("account_ticket_issued"))).toBe(true);
  });

  it("refuses without calling the database: foreign Origin, cross-site Fetch Metadata, neither header, wrong content type, missing/invalid/other-session token", async () => {
    const { POST } = await import("@/app/account/api/enrollment/download/route");
    world.reply = ISSUE_OK;
    const cases: [string, Parameters<typeof formPost>[1], number, string][] = [
      ["foreign origin", { headers: { origin: "https://evil.example" } }, 403, "forbidden"],
      ["cross-site fetch metadata", { headers: { "sec-fetch-site": "cross-site" } }, 403, "forbidden"],
      ["same-site (sibling) fetch metadata", { headers: { "sec-fetch-site": "same-site" } }, 403, "forbidden"],
      ["json content type", { headers: { "content-type": "application/json" } }, 403, "forbidden"],
      ["multipart content type", { headers: { "content-type": "multipart/form-data; boundary=x" } }, 403, "forbidden"],
      ["text/plain content type", { headers: { "content-type": "text/plain" } }, 403, "forbidden"],
      ["missing token", { omitCsrf: true }, 403, "csrf"],
      ["garbage token", { token: "v1.abc.def.ghi" }, 403, "csrf"],
      ["empty token", { token: "" }, 403, "csrf"],
      ["token of another session", { token: await mintCsrf(SECRET, "s:another-session") }, 403, "csrf"],
      ["anonymous-binding token with a session", { token: await mintCsrf(SECRET, "anon") }, 403, "csrf"],
      ["token signed with another key", { token: await mintCsrf("another-secret-0123456789abcdefghijklmnopqrstuvwxyz", csrfBinding(stored())) }, 403, "csrf"],
      ["duplicate csrf field", { fields: `csrf=${await mintCsrf(SECRET, csrfBinding(stored()))}&csrf=x` }, 400, "invalid_body"],
      ["unknown extra field", { fields: { label: "x" } }, 400, "invalid_input"],
    ];
    for (const [name, over, status, error] of cases) {
      const res = await POST(await formPost(DOWNLOAD, over));
      expect(res.status, name).toBe(status);
      expect(((await res.json()) as { error: string }).error, name).toBe(error);
    }
    const noOrigin = await formPost(DOWNLOAD, { headers: {} });
    noOrigin.headers.delete("origin");
    noOrigin.headers.delete("sec-fetch-site");
    expect((await POST(noOrigin)).status).toBe(403);
    expect(world.rpc).toHaveLength(0);
  });

  it("anonymous, ended and unconfirmed sessions are refused (401) without a database call", async () => {
    const { POST } = await import("@/app/account/api/enrollment/download/route");
    world.reply = ISSUE_OK;
    const anon = await POST(await formPost(DOWNLOAD, { session: null }));
    expect(anon.status).toBe(401);
    expect(((await anon.json()) as { error: string }).error).toBe("unauthenticated");
    world.user = null; // Auth says the access token is dead and the refresh fails too
    const dead = await POST(await formPost(DOWNLOAD));
    expect([401, 503]).toContain(dead.status);
    world.user = { ...AUTH_USER, email_confirmed_at: null, confirmed_at: null };
    expect((await POST(await formPost(DOWNLOAD))).status).toBe(401);
    world.user = { ...AUTH_USER, is_anonymous: true };
    expect((await POST(await formPost(DOWNLOAD))).status).toBe(401);
    expect(world.rpc).toHaveLength(0);
  });

  it("maps ticket_limit to a clear 409 (JSON for programs; a redirect with a notice code for a browser) and never includes a ticket", async () => {
    const { POST } = await import("@/app/account/api/enrollment/download/route");
    world.reply = () => json({ ok: false, error: "ticket_limit" });
    const res = await POST(await formPost(DOWNLOAD, { accept: "application/json" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ ok: false, error: "ticket_limit" });
    expect(res.headers.get("content-disposition")).toBeNull();
    const nav = await POST(await formPost(DOWNLOAD, { accept: "text/html,application/xhtml+xml" }));
    expect(nav.status).toBe(303);
    expect(nav.headers.get("location")).toBe(`${ORIGIN}/account/devices?notice=ticket_limit`);
    expect(nav.headers.get("cache-control")).toBe("private, no-store");
  });

  it("maps 401 / 403 / 429 like the other routes (429 keeps Retry-After) and a validation 400 never reaches the user as database text", async () => {
    const { POST } = await import("@/app/account/api/enrollment/download/route");
    for (const [status, expected, retry] of [[401, 401, null], [403, 403, null], [429, 429, "42"], [400, 400, null]] as const) {
      world.reply = () => json({ message: "db text", code: "PT" }, status, retry ? { "retry-after": retry } : {});
      const res = await POST(await formPost(DOWNLOAD));
      expect(res.status).toBe(expected);
      expect(res.headers.get("retry-after")).toBe(retry);
      expect(JSON.stringify(await res.json())).not.toContain("db text");
    }
    world.reply = () => json({ message: "x" }, 429, { "retry-after": "42" });
    const nav = await POST(await formPost(DOWNLOAD, { accept: "text/html" }));
    expect(nav.status).toBe(303);
    expect(nav.headers.get("location")).toBe(`${ORIGIN}/account/devices?notice=rate_limited`);
    expect(nav.headers.get("retry-after")).toBe("42");
    world.reply = () => json({ message: "x" }, 401);
    const gone = await POST(await formPost(DOWNLOAD, { accept: "text/html" }));
    expect(gone.headers.get("location")).toBe(`${ORIGIN}/account/login?reason=expired&next=%2Faccount%2Fdevices`);
  });

  it("a lost reply is an unknown outcome (502, reconcile hint, never retried); an unexpected database shape is never passed on", async () => {
    const { POST } = await import("@/app/account/api/enrollment/download/route");
    world.reply = () => "throw";
    const lost = await POST(await formPost(DOWNLOAD));
    expect(lost.status).toBe(502);
    expect(await lost.json()).toEqual({ ok: false, error: "outcome_unknown", reconcile: "/account/devices" });
    expect(world.rpc).toHaveLength(1); // no automatic retry
    world.rpc.length = 0;
    world.reply = () => json({ ok: true, ticket_id: ID, ticket: TICKET, expires_at: TS, account_uid: UID });
    const odd = await POST(await formPost(DOWNLOAD));
    expect(odd.status).toBe(502);
    expect(await odd.text()).not.toContain(TICKET);
    expect(world.rpc).toHaveLength(1);
    const nav = await POST(await formPost(DOWNLOAD, { accept: "text/html" }));
    expect(nav.headers.get("location")).toBe(`${ORIGIN}/account/devices?notice=outcome_unknown`);
  });

  it("is inert when accounts are disabled (404, nothing contacted)", async () => {
    const { POST } = await import("@/app/account/api/enrollment/download/route");
    rt.state = "disabled";
    const res = await POST(await formPost(DOWNLOAD));
    expect(res.status).toBe(404);
    expect(world.rpc).toHaveLength(0);
    expect(world.auth).toBe(0);
  });
});

describe("POST revoke routes", () => {
  const cases = [
    { path: "/account/api/devices/revoke", mod: () => import("@/app/account/api/devices/revoke/route"), key: "deviceId", rpc: "fdb_account_device_revoke", arg: "p_device_id" },
    { path: "/account/api/enrollment/revoke", mod: () => import("@/app/account/api/enrollment/revoke/route"), key: "ticketId", rpc: "fdb_account_enrollment_ticket_revoke", arg: "p_ticket_id" },
  ] as const;
  for (const c of cases) {
    describe(c.path, () => {
      it("revokes with the user's own token and answers {ok:true}", async () => {
        const { POST } = await c.mod();
        world.reply = () => json({ ok: true });
        const res = await POST(await jsonPost(c.path, { [c.key]: ID }));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
        expect(res.headers.get("cache-control")).toBe("private, no-store");
        expect(world.rpc).toEqual([{ name: c.rpc, body: { [c.arg]: ID }, headers: expect.objectContaining({ apikey: cfg.publishableKey }) }]);
      });
      it("refuses a missing / mismatched / other-session CSRF token, a foreign origin and an anonymous caller without a database call", async () => {
        const { POST } = await c.mod();
        world.reply = () => json({ ok: true });
        for (const csrf of ["none", "mismatch", "other-session"] as const) expect((await POST(await jsonPost(c.path, { [c.key]: ID }, { csrf }))).status, csrf).toBe(403);
        expect((await POST(await jsonPost(c.path, { [c.key]: ID }, { headers: { origin: "https://evil.example" } }))).status).toBe(403);
        expect((await POST(await jsonPost(c.path, { [c.key]: ID }, { headers: { "sec-fetch-site": "cross-site" } }))).status).toBe(403);
        expect((await POST(await jsonPost(c.path, { [c.key]: ID }, { headers: { "content-type": "application/x-www-form-urlencoded" } }))).status).toBe(403);
        const anon = await POST(await jsonPost(c.path, { [c.key]: ID }, { session: null }));
        expect(anon.status).toBe(401);
        expect(world.rpc).toHaveLength(0);
      });
      it("validates the id strictly (non-uuid, wrong type, extra field, empty/invalid body) and sends nothing", async () => {
        const { POST } = await c.mod();
        world.reply = () => json({ ok: true });
        for (const bad of [{}, { [c.key]: "not-a-uuid" }, { [c.key]: `${ID}x` }, { [c.key]: 7 }, { [c.key]: null }, { [c.key]: [ID] }, { [c.key]: ID, extra: 1 }, { [c.arg]: ID }, [], "x", null]) {
          const res = await POST(await jsonPost(c.path, bad));
          expect(res.status, JSON.stringify(bad)).toBe(400);
          expect(((await res.json()) as { error: string }).error).toBe("invalid_input");
        }
        expect((await POST(await jsonPost(c.path, null, { raw: "{not json" }))).status).toBe(400);
        expect(world.rpc).toHaveLength(0);
      });
      it("maps not_available to 409 and 401 / 403 / 429 / 400 like the other routes", async () => {
        const { POST } = await c.mod();
        world.reply = () => json({ ok: false, error: "not_available" });
        const na = await POST(await jsonPost(c.path, { [c.key]: ID }));
        expect(na.status).toBe(409);
        expect(await na.json()).toEqual({ ok: false, error: "not_available" });
        for (const [status, expected, error] of [[401, 401, "unauthenticated"], [403, 403, "forbidden"], [429, 429, "rate_limited"], [400, 400, "invalid_input"]] as const) {
          world.reply = () => json({ message: "db text" }, status, status === 429 ? { "retry-after": "9" } : {});
          const res = await POST(await jsonPost(c.path, { [c.key]: ID }));
          expect(res.status).toBe(expected);
          expect(((await res.json()) as { error: string }).error).toBe(error);
          if (status === 429) expect(res.headers.get("retry-after")).toBe("9");
        }
      });
      it("a lost reply is an unknown outcome (502, no retry)", async () => {
        const { POST } = await c.mod();
        world.reply = () => "throw";
        const res = await POST(await jsonPost(c.path, { [c.key]: ID }));
        expect(res.status).toBe(502);
        expect(await res.json()).toEqual({ ok: false, error: "outcome_unknown", reconcile: "/account/devices" });
        expect(world.rpc).toHaveLength(1);
      });
      it("is inert when accounts are disabled", async () => {
        const { POST } = await c.mod();
        rt.state = "disabled";
        expect((await POST(await jsonPost(c.path, { [c.key]: ID }))).status).toBe(404);
        expect(world.rpc).toHaveLength(0);
      });
      it("exports POST only", async () => {
        const mod = (await c.mod()) as Record<string, unknown>;
        expect(Object.keys(mod).filter((k) => /^[A-Z]+$/.test(k))).toEqual(["POST"]);
      });
    });
  }
});

describe("GET /account/api/devices", () => {
  const ROW = { device_id: ID, installation_id: "inst-0123456789abcdef", label: "PC", status: "active", created_at: TS, last_seen_at: null, revoked_at: null, revoked_reason: null };
  it("lists the caller's devices (camelCase, no secrets) from the database, reading nothing from the request", async () => {
    const { GET } = await import("@/app/account/api/devices/route");
    world.reply = () => json([ROW]);
    const res = await GET(await get("/account/api/devices?userId=evil"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, devices: [{ deviceId: ID, installationId: "inst-0123456789abcdef", label: "PC", status: "active", createdAt: TS, lastSeenAt: null, revokedAt: null, revokedReason: null }] });
    expect(world.rpc).toEqual([{ name: "fdb_account_devices", body: {}, headers: expect.anything() }]);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });
  it("refuses anonymous and cross-site callers; maps 401/403/429; an unexpected shape is 503; never contains a ticket", async () => {
    const { GET } = await import("@/app/account/api/devices/route");
    world.reply = () => json([ROW]);
    expect((await GET(await get("/account/api/devices", {}, null))).status).toBe(401);
    expect((await GET(await get("/account/api/devices", { "sec-fetch-site": "cross-site" }))).status).toBe(403);
    expect(world.rpc).toHaveLength(0);
    for (const [status, expected] of [[401, 401], [403, 403], [429, 429]] as const) {
      world.reply = () => json({}, status, status === 429 ? { "retry-after": "5" } : {});
      expect((await GET(await get("/account/api/devices"))).status).toBe(expected);
    }
    world.reply = () => json([{ ...ROW, device_secret: "fdbd1_x" }]);
    expect((await GET(await get("/account/api/devices"))).status).toBe(503);
    world.reply = () => json([ROW]);
    expect(await (await GET(await get("/account/api/devices"))).text()).not.toMatch(/fdba1_|ticket/i);
  });
  it("exports GET only and is inert when disabled", async () => {
    const mod = (await import("@/app/account/api/devices/route")) as Record<string, unknown>;
    expect(Object.keys(mod).filter((k) => /^[A-Z]+$/.test(k))).toEqual(["GET"]);
    rt.state = "disabled";
    const res = await (mod.GET as (r: NextRequest) => Promise<Response>)(await get("/account/api/devices"));
    expect(res.status).toBe(404);
  });
});
