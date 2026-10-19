import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountAuthConfig } from "@/lib/account/config";
import { b64urlEncode } from "@/lib/account/crypto";
import { csrfBinding, mintCsrf } from "@/lib/account/csrf";
import { mintPairingCookie, pairingCookieName, readPairingCookie } from "@/lib/account/pairing-cookie";
import { jarFrom, writeSession, type StoredSession } from "@/lib/account/session";

const SECRET = "unit-test-secret-0123456789abcdefghijklmnopqrstuvwxyz";
const UID = "123e4567-e89b-42d3-a456-426614174000";
const OTHER_UID = "323e4567-e89b-42d3-a456-426614174000";
const ID = "8f790272-8cb2-4c5a-a57d-83c7d3d618aa";
const OTHER_ID = "9f790272-8cb2-4c5a-a57d-83c7d3d618aa";
const ORIGIN = "http://localhost:3000";
const cfg: AccountAuthConfig = { mode: "local", authOrigin: "http://127.0.0.1:54321", projectRef: null, publishableKey: "sb_publishable_unit_key_not_real", csrfSecret: SECRET };
const rt = vi.hoisted(() => ({ state: "ready" as "ready" | "disabled" }));
const nav = vi.hoisted(() => ({ redirect: vi.fn((path: string) => { throw new Error(`redirect:${path}`); }), notFound: vi.fn(() => { throw new Error("not-found"); }) }));
let pageCookies: { name: string; value: string }[] = [];

vi.mock("@/lib/account/runtime", () => ({
  accountRuntime: () => rt.state === "disabled" ? { state: "disabled" } : { state: "ready", ctx: {
    cfg, env: { hosted: false, FOREVERDB_DEPLOYMENT: "local" }, https: false, siteOrigin: ORIGIN,
    callbackUrl: `${ORIGIN}/account/auth/confirm`, cookies: { session: "fdb_acct", csrf: "fdb_csrf" }, turnstileSecret: null,
  } },
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: () => pageCookies, get: (name: string) => pageCookies.find((c) => c.name === name) }) }));
vi.mock("next/navigation", () => nav);

const jwt = (claims: Record<string, unknown>) => {
  const enc = (o: unknown) => b64urlEncode(new TextEncoder().encode(JSON.stringify(o)));
  return `${enc({ alg: "HS256" })}.${enc(claims)}.${"s".repeat(43)}`;
};
const nowSec = () => Math.floor(Date.now() / 1000);
const stored = (uid = UID, sid = "sess-1"): StoredSession => ({ v: 1, k: "user", uid, at: jwt({ exp: nowSec() + 3600, session_id: sid, sub: uid }), rt: `refresh-${sid}`, ex: nowSec() + 3600, sid, sc: nowSec(), rf: nowSec() });
const user = (uid = UID) => ({ id: uid, email: uid === UID ? "owner@example.test" : "other@example.test", email_confirmed_at: "2026-01-01T00:00:00Z", created_at: "2026-01-01T00:00:00Z", is_anonymous: false });
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

let authUser = user();
let rpcCalls: { name: string; body: unknown; authorization: string }[] = [];
let rpcReply: (name: string) => Response | "throw";
beforeEach(() => {
  rt.state = "ready"; authUser = user(); rpcCalls = []; pageCookies = []; nav.redirect.mockClear(); nav.notFound.mockClear();
  rpcReply = (name) => json(name.endsWith("preview")
    ? { state: "pending", computerName: "Gaming PC", installationSuffix: "…ABC123", requestedAt: "2026-10-16T12:00:00Z", expiresAt: "2026-10-16T12:05:00Z", canApprove: true }
    : { ok: true, state: name.endsWith("approve") ? "approved" : "denied" });
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/auth/v1/user")) return json(authUser);
    const name = url.split("/rest/v1/rpc/")[1];
    if (!name) throw new Error("unexpected fetch target");
    rpcCalls.push({ name, body: JSON.parse(String(init?.body)), authorization: String((init?.headers as Record<string, string>).Authorization) });
    const out = rpcReply(name);
    if (out === "throw") throw new DOMException("timed out", "TimeoutError");
    return out;
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function cookieParts(session = stored(), pairingId = ID) {
  const sessionHeaders: string[] = [];
  await writeSession(SECRET, { append: (_n, value) => sessionHeaders.push(value) }, jarFrom(() => []), false, session);
  const pair = await mintPairingCookie(SECRET, pairingId);
  const payload = (await readPairingCookie(SECRET, pair))!;
  return { session, pair, payload, sessionCookie: sessionHeaders.map((h) => h.split(";")[0]).join("; ") };
}

async function post(action: "approve" | "deny", over: { session?: StoredSession; pairingId?: string; bodyId?: string; pair?: string | null; origin?: string; fetchSite?: string; csrf?: "ok" | "bad"; csrfSession?: StoredSession } = {}) {
  const c = await cookieParts(over.session, over.pairingId);
  const token = await mintCsrf(SECRET, csrfBinding(over.csrfSession ?? c.session));
  const cookies = [c.sessionCookie, `fdb_csrf=${over.csrf === "bad" ? "x".repeat(20) : token}`, over.pair === null ? null : `${pairingCookieName(false)}=${over.pair ?? c.pair}`].filter(Boolean).join("; ");
  const req = new NextRequest(`${ORIGIN}/account/api/device-pair/${action}`, { method: "POST", headers: {
    origin: over.origin ?? ORIGIN, "sec-fetch-site": over.fetchSite ?? "same-origin", "content-type": "application/json",
    "x-fdb-csrf": token, cookie: cookies,
  }, body: JSON.stringify({ pairingId: over.bodyId ?? over.pairingId ?? ID }) });
  const mod = action === "approve" ? await import("@/app/account/api/device-pair/approve/route") : await import("@/app/account/api/device-pair/deny/route");
  return { response: await mod.POST(req), ...c };
}

describe("browser pairing decision routes", () => {
  it.each(["approve", "deny"] as const)("%s uses the exact verified account RPC once and clears the locator", async (action) => {
    const { response, session } = await post(action);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, state: action === "approve" ? "approved" : "denied" });
    expect(rpcCalls).toEqual([{ name: `fdb_account_device_pair_${action}`, body: { p_pairing_id: ID }, authorization: `Bearer ${session.at}` }]);
    expect(response.headers.get("set-cookie")).toContain("fdb_pair=; Path=/account; Max-Age=0");
  });

  it("rejects cross-site/CSRF, missing/replaced locator, body mismatch and account switch before any RPC", async () => {
    const cases = [
      () => post("approve", { origin: "https://evil.example" }),
      () => post("approve", { fetchSite: "cross-site" }),
      () => post("approve", { csrf: "bad" }),
      () => post("approve", { pair: null }),
      () => post("approve", { pairingId: OTHER_ID, bodyId: ID }),
      () => post("approve", { bodyId: OTHER_ID }),
    ];
    for (const run of cases) expect((await run()).response.status).toBeGreaterThanOrEqual(400);
    expect(rpcCalls).toHaveLength(0);
  });

  it("rejects a live switch to another account through the old page's session-bound CSRF", async () => {
    const oldSession = stored();
    authUser = user(OTHER_UID);
    const { response } = await post("approve", { session: stored(OTHER_UID, "sess-2"), csrfSession: oldSession });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ ok: false, error: "csrf" });
    expect(rpcCalls).toHaveLength(0);
  });

  it("a stale tab mismatch cannot clear the newer tab's signed locator", async () => {
    const { response } = await post("approve", { pairingId: OTHER_ID, bodyId: ID });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ ok: false, error: "pairing_not_available" });
    expect(response.headers.get("set-cookie") ?? "").not.toContain("fdb_pair=");
    expect(rpcCalls).toHaveLength(0);
  });

  it("never retries an unknown mutation outcome and retains the cookie for reconciliation", async () => {
    rpcReply = () => "throw";
    const { response } = await post("approve");
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ ok: false, error: "outcome_unknown", reconcile: "/account/device-pair" });
    expect(rpcCalls).toHaveLength(1);
    expect(response.headers.get("set-cookie") ?? "").not.toContain("fdb_pair=");
  });

  it("strictly validates the body before authentication or RPC", async () => {
    const c = await cookieParts();
    const token = await mintCsrf(SECRET, csrfBinding(c.session));
    const req = new NextRequest(`${ORIGIN}/account/api/device-pair/approve`, { method: "POST", headers: { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json", "x-fdb-csrf": token, cookie: `${c.sessionCookie}; fdb_csrf=${token}; fdb_pair=${c.pair}` }, body: JSON.stringify({ pairingId: ID, extra: true }) });
    const { POST } = await import("@/app/account/api/device-pair/approve/route");
    const res = await POST(req);
    expect(res.status).toBe(400); expect(rpcCalls).toHaveLength(0);
  });
});

describe("browser pairing page", () => {
  async function render(pair = true) {
    const c = await cookieParts();
    pageCookies = c.sessionCookie.split("; ").map((part) => { const i = part.indexOf("="); return { name: part.slice(0, i), value: part.slice(i + 1) }; });
    if (pair) pageCookies.push({ name: "fdb_pair", value: c.pair });
    const { default: Page } = await import("@/app/account/device-pair/page");
    return renderToStaticMarkup(await Page());
  }

  it("renders only the sanitized pending preview with the named current account", async () => {
    const html = await render();
    expect(html).toContain("owner@example.test"); expect(html).toContain("Gaming PC"); expect(html).toContain("…ABC123"); expect(html).toContain("Expires");
    for (const secret of [UID, ID, "sess-1", "refresh-sess-1"]) expect(html).not.toContain(secret);
    expect(rpcCalls.map((c) => c.name)).toEqual(["fdb_account_device_pair_preview"]);
  });

  it("makes no preview call without a valid locator and never mutates on GET", async () => {
    const html = await render(false);
    expect(html).toContain("No valid pairing request"); expect(rpcCalls).toHaveLength(0);
    const page = await import("@/app/account/device-pair/page");
    expect(Object.keys(page).filter((k) => /^(GET|POST|PUT|PATCH|DELETE)$/.test(k))).toEqual([]);
  });

  it("renders terminal and conflict states without account-winner or device identity", async () => {
    rpcReply = () => json({ state: "denied" });
    expect(await render()).toContain("was denied");
    rpcCalls = [];
    rpcReply = () => json({ ok: false, error: "cannot_connect_to_this_account" });
    const html = await render();
    expect(html).toContain("cannot be connected"); expect(html).not.toContain(OTHER_UID); expect(rpcCalls).toHaveLength(1);
  });

  it("lets the same displayed account deny an approved request before redemption", async () => {
    rpcReply = () => json({ state: "approved", computerName: "Gaming PC", installationSuffix: "…ABC123", requestedAt: "2026-10-16T12:00:00Z", expiresAt: "2026-10-16T12:05:00Z", canApprove: false });
    const html = await render();
    expect(html).toContain("Approved. Return to the Companion");
    expect(html).toContain("Deny this approved request");
    expect(html).not.toContain("Approve this computer");
  });
});
