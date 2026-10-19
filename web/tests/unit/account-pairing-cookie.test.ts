import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { b64urlDecode, b64urlEncode, hmacB64 } from "@/lib/account/crypto";
import {
  PAIRING_COOKIE_TTL_SEC,
  clearPairingCookie,
  mintPairingCookie,
  mintPairingPageBinding,
  readPairingCookie,
  setPairingCookie,
  verifyPairingPageBinding,
} from "@/lib/account/pairing-cookie";

const SITE = "http://localhost:3000";
const ID = "8f790272-8cb2-4c5a-a57d-83c7d3d618aa";
const OLD = "old-pairing-cookie";
const NOW = 1_797_000_000;
const COOKIE_SECRET = "pairing-cookie-secret-0123456789abcdef";
const PUBLIC_ENV = {
  FOREVERDB_DEPLOYMENT: "local",
  FOREVERDB_DATA_SOURCE: "fixture",
  SITE_URL: SITE,
  RATE_LIMIT_BACKEND: "memory",
  TRUSTED_IP_HEADER: "x-real-ip",
  RATE_LIMIT_SALT: "unit-test-salt-0123456789abcdef0123456789",
};
const ACCOUNT_ENV = {
  ACCOUNT_AUTH_MODE: "local",
  ACCOUNT_AUTH_URL: "http://127.0.0.1:54321",
  ACCOUNT_AUTH_PUBLISHABLE_KEY: "sb_publishable_pairing_cookie_test",
  ACCOUNT_CSRF_SECRET: "unit-test-csrf-secret-0123456789abcdef",
};

async function load(enabled = true) {
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const [key, value] of Object.entries({ ...PUBLIC_ENV, ...(enabled ? ACCOUNT_ENV : { ACCOUNT_AUTH_MODE: "disabled" }) })) vi.stubEnv(key, value);
  return import("@/proxy");
}

const request = (query = "", cookie = OLD) => new NextRequest(`${SITE}/account/device-pair${query}`, {
  method: "GET",
  headers: { "x-real-ip": "203.0.113.17", ...(cookie ? { cookie: `fdb_pair=${cookie}` } : {}) },
});

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("pairing intake must not make an outbound request"); }));
  for (const method of ["info", "log", "warn", "error", "debug"] as const) vi.spyOn(console, method).mockImplementation(() => undefined);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("signed pairing cookie", () => {
  const custom = async (payload: string, purpose: "pairing-cookie-mac" | "csrf-mac" = "pairing-cookie-mac") => {
    const encoded = b64urlEncode(new TextEncoder().encode(payload));
    const mac = await hmacB64(COOKIE_SECRET, purpose, `fdb-pairing-cookie-v1|${encoded}`);
    return `${encoded}.${mac}`;
  };

  it("round-trips only the canonical v1 payload with a fresh 128-bit nonce and at most five minutes of life", async () => {
    const first = await mintPairingCookie(COOKIE_SECRET, ID, NOW);
    const second = await mintPairingCookie(COOKIE_SECRET, ID, NOW);
    const decoded = await readPairingCookie(COOKIE_SECRET, first, NOW);
    expect(decoded).toEqual({ v: 1, id: ID, nonce: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/), exp: NOW + 300 });
    expect(PAIRING_COOKIE_TTL_SEC).toBe(300);
    expect((b64urlDecode(decoded!.nonce) ?? new Uint8Array()).byteLength).toBe(16);
    expect((await readPairingCookie(COOKIE_SECRET, second, NOW))!.nonce).not.toBe(decoded!.nonce);
    expect(first).not.toContain(ID);
  });

  it("rejects forged, truncated, expired, future-stretched and wrong-purpose values", async () => {
    const value = await mintPairingCookie(COOKIE_SECRET, ID, NOW);
    const parts = value.split(".");
    expect(parts).toHaveLength(2);
    const forged = `${parts[0]}.${parts[1]!.slice(0, -1)}${parts[1]!.endsWith("A") ? "B" : "A"}`;
    const wrongPurpose = await custom(new TextDecoder().decode(b64urlDecode(parts[0]!)!), "csrf-mac");
    for (const bad of [forged, value.slice(0, -1), wrongPurpose, `${value}.extra`, "", "a.b"]) {
      expect(await readPairingCookie(COOKIE_SECRET, bad, NOW), bad).toBeNull();
    }
    expect(await readPairingCookie(COOKIE_SECRET, value, NOW + 300)).toBeNull();
    expect(await readPairingCookie(COOKIE_SECRET, value, NOW - 1)).toBeNull();
  });

  it("strictly decodes canonical JSON, UUID, nonce and expiry fields even under a valid pairing-purpose MAC", async () => {
    const nonce = b64urlEncode(new Uint8Array(16).fill(7));
    const valid = JSON.stringify({ v: 1, id: ID, nonce, exp: NOW + 60 });
    expect(await readPairingCookie(COOKIE_SECRET, await custom(valid), NOW)).toEqual({ v: 1, id: ID, nonce, exp: NOW + 60 });
    for (const malformed of [
      ` {"v":1,"id":"${ID}","nonce":"${nonce}","exp":${NOW + 60}}`,
      JSON.stringify({ id: ID, v: 1, nonce, exp: NOW + 60 }),
      JSON.stringify({ v: 1, id: ID, nonce, exp: NOW + 60, extra: true }),
      JSON.stringify({ v: 1, id: ID.toUpperCase(), nonce, exp: NOW + 60 }),
      JSON.stringify({ v: 1, id: ID, nonce: `${nonce}A`, exp: NOW + 60 }),
      JSON.stringify({ v: 1, id: ID, nonce, exp: NOW + 60.5 }),
    ]) expect(await readPairingCookie(COOKIE_SECRET, await custom(malformed), NOW), malformed).toBeNull();
  });

  it("uses host-only scoped names and attributes for hosted and local cookies", async () => {
    const value = await mintPairingCookie(COOKIE_SECRET, ID, NOW);
    const hosted = new Headers();
    setPairingCookie(hosted, true, value, 123);
    expect(hosted.get("set-cookie")).toBe(`__Secure-fdb_pair=${value}; Path=/account; Max-Age=123; HttpOnly; Secure; SameSite=Lax`);
    expect(hosted.get("set-cookie")).not.toMatch(/Domain=/i);
    const local = new Headers();
    clearPairingCookie(local, false);
    expect(local.get("set-cookie")).toBe("fdb_pair=; Path=/account; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax");
  });

  it("binds a rendered page opaquely to the exact locator, account and logical session", async () => {
    const value = await mintPairingCookie(COOKIE_SECRET, ID, NOW);
    const payload = (await readPairingCookie(COOKIE_SECRET, value, NOW))!;
    const uid = "123e4567-e89b-42d3-a456-426614174000";
    const binding = await mintPairingPageBinding(COOKIE_SECRET, payload, uid, "session-a");
    expect(binding).toMatch(/^fdbpg1_[A-Za-z0-9_-]{43}$/);
    expect(binding).not.toContain(ID); expect(binding).not.toContain(uid); expect(binding).not.toContain("session-a");
    expect(await verifyPairingPageBinding(COOKIE_SECRET, payload, uid, "session-a", binding)).toBe(true);
    expect(await verifyPairingPageBinding(COOKIE_SECRET, payload, "223e4567-e89b-42d3-a456-426614174000", "session-a", binding)).toBe(false);
    expect(await verifyPairingPageBinding(COOKIE_SECRET, payload, uid, "session-b", binding)).toBe(false);
    expect(await verifyPairingPageBinding(COOKIE_SECRET, { ...payload, id: "9f790272-8cb2-4c5a-a57d-83c7d3d618aa" }, uid, "session-a", binding)).toBe(false);
    const forged = `${binding.slice(0, -1)}${binding.endsWith("A") ? "B" : "A"}`;
    expect(await verifyPairingPageBinding(COOKIE_SECRET, payload, uid, "session-a", forged)).toBe(false);
  });
});

describe("pairing locator intake", () => {
  it("stores one canonical locator in a signed local cookie and redirects to the clean path", async () => {
    const { proxy } = await load();
    const res = await proxy(request(`?request=${ID}`, ""));

    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${SITE}/account/device-pair`);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/^fdb_pair=[A-Za-z0-9_.-]+; Path=\/account; Max-Age=(?:[1-9]\d?|[12]\d\d|300); HttpOnly; SameSite=Lax$/);
    expect(cookie).not.toContain("Secure");
    expect(cookie).not.toMatch(/Domain=/i);
    expect(await res.text()).not.toContain(ID);
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify([console.info, console.log, console.warn, console.error, console.debug].flatMap((m) => vi.mocked(m).mock.calls))).not.toContain(ID);
  });

  it.each([
    ["noncanonical UUID", `?request=${ID.toUpperCase()}`],
    ["wrong UUID version", "?request=8f790272-8cb2-1c5a-a57d-83c7d3d618aa"],
    ["trailing data", `?request=${ID}%20`],
    ["duplicate locator", `?request=${ID}&request=${ID}`],
    ["empty locator", "?request="],
  ])("clears the old cookie and redirects cleanly for %s", async (_name, query) => {
    const { proxy } = await load();
    const res = await proxy(request(query));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${SITE}/account/device-pair`);
    expect(res.headers.get("set-cookie")).toMatch(/^fdb_pair=; Path=\/account; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax$/);
    expect(await res.text()).not.toContain(ID);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("lets the clean page request proceed without replacing or clearing its pairing cookie", async () => {
    const { proxy } = await load();
    const res = await proxy(request());
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns 404 at ingress without touching cookies or outbound services while the source gate is disabled", async () => {
    const { proxy } = await load(false);
    const res = await proxy(request(`?request=${ID}`, ""));
    expect(res.status).toBe(404);
    expect(res.headers.get("set-cookie")).toBeNull();
    for (const path of ["/account/api/device-pair/approve", "/account/api/device-pair/deny"]) {
      const decision = await proxy(new NextRequest(`${SITE}${path}`, { method: "POST", headers: { "content-type": "text/plain", origin: "null", cookie: "fdb_acct=hostile" }, body: "unreadable" }));
      expect(decision.status).toBe(404);
      expect(await decision.json()).toEqual({ ok: false, error: "not_found" });
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
