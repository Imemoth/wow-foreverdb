import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountAuthConfig } from "@/lib/account/config";
import { ACCOUNT_RPCS, ACCOUNT_RPC_GUARDS, ACCOUNT_REDIRECT_ALLOWLIST, safeNext } from "@/lib/account/contracts";
import {
  ACTIVATION_FILE_NAME, ENROLLMENT_RPCS, ENROLLMENT_RPC_GUARDS, TICKET_PATTERN, buildActivationFile, isEnrollmentRpc,
} from "@/lib/account/contracts-enrollment";
import { INPUTS } from "@/lib/account/inputs";
import { WEB_ENROLLMENT_RPCS, WEB_RPCS, callWebRpc } from "@/lib/account/rpc-client";

/** Zero-touch enrollment: the closed contract registry (migration 0014) and the closed PostgREST client for it. Stubbed `fetch`: not evidence of real PostgREST behaviour. */
const SECRET = "unit-test-secret-0123456789abcdefghijklmnopqrstuvwxyz";
const cfg: AccountAuthConfig = { mode: "local", authOrigin: "http://127.0.0.1:54321", projectRef: null, publishableKey: "sb_publishable_unit_key_not_real", csrfSecret: SECRET };
const TOKEN = `eyJhbGciOiJIUzI1NiJ9.${"a".repeat(40)}.${"s".repeat(43)}`;
const ID = "123e4567-e89b-42d3-a456-426614174000";
const TICKET = `fdba1_${"A".repeat(43)}`;
const TS = "2026-10-13T12:00:00+00:00";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("enrollment registry", () => {
  it("lists exactly the five website functions; no device_* function exists in it", () => {
    expect(Object.keys(ENROLLMENT_RPCS).sort()).toEqual([
      "fdb_account_device_revoke", "fdb_account_devices", "fdb_account_enrollment_ticket_issue", "fdb_account_enrollment_ticket_revoke", "fdb_account_enrollment_tickets",
    ]);
    expect(Object.keys(ENROLLMENT_RPC_GUARDS).sort()).toEqual(Object.keys(ENROLLMENT_RPCS).sort());
    expect(Object.values(ENROLLMENT_RPC_GUARDS).every((g) => g === "registered_live_session")).toBe(true);
    expect(Object.keys(ENROLLMENT_RPCS).filter((n) => /fdb_device_/.test(n))).toEqual([]);
    expect([...WEB_ENROLLMENT_RPCS].sort()).toEqual(Object.keys(ENROLLMENT_RPCS).sort());
    expect(isEnrollmentRpc("fdb_device_enroll")).toBe(false);
    expect(isEnrollmentRpc("constructor")).toBe(false);
  });
  it("leaves the 0012-pinned registry untouched", () => {
    expect(Object.keys(ACCOUNT_RPCS).sort()).toEqual(Object.keys(ACCOUNT_RPC_GUARDS).sort());
    expect(Object.keys(ACCOUNT_RPCS).filter((n) => /enrollment|device/.test(n))).toEqual([]);
  });

  it("issue: input is {p_label?<=60}, strict", () => {
    const i = ENROLLMENT_RPCS.fdb_account_enrollment_ticket_issue.input;
    expect(i.safeParse({}).success).toBe(true);
    expect(i.safeParse({ p_label: "x".repeat(60) }).success).toBe(true);
    for (const bad of [{ p_label: "x".repeat(61) }, { p_label: 5 }, { p_label: null }, { p_account: ID }, { p_label: "a", extra: 1 }, null, [], "x"]) expect(i.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });
  it("issue: output accepts the two documented shapes only", () => {
    const o = ENROLLMENT_RPCS.fdb_account_enrollment_ticket_issue.output;
    expect(o.safeParse({ ok: true, ticket_id: ID, ticket: TICKET, expires_at: TS }).success).toBe(true);
    expect(o.safeParse({ ok: false, error: "ticket_limit" }).success).toBe(true);
    for (const bad of [
      { ok: true, ticket_id: ID, ticket: TICKET }, // missing expires_at
      { ok: true, ticket_id: ID, ticket: TICKET, expires_at: TS, device_id: ID }, // extra field
      { ok: true, ticket_id: "nope", ticket: TICKET, expires_at: TS },
      { ok: true, ticket_id: ID, ticket: `fdba1_${"A".repeat(42)}`, expires_at: TS },
      { ok: true, ticket_id: ID, ticket: `fdba1_${"A".repeat(44)}`, expires_at: TS },
      { ok: true, ticket_id: ID, ticket: `fdbd1_${"A".repeat(43)}`, expires_at: TS },
      { ok: true, ticket_id: ID, ticket: `fdba1_${"A".repeat(42)}+`, expires_at: TS },
      { ok: true, ticket_id: ID, ticket: TICKET, expires_at: "x" },
      { ok: false, error: "other" }, { ok: false, error: "ticket_limit", ticket: TICKET }, { ok: false }, { ok: "true" }, {}, null, [],
    ]) expect(o.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    expect(TICKET_PATTERN.test(TICKET)).toBe(true);
  });

  const ticketRow = { ticket_id: ID, label: null, status: "pending", created_at: TS, expires_at: TS, consumed_at: null, device_id: null };
  it("tickets list: strict rows, status enum, at most 20", () => {
    const o = ENROLLMENT_RPCS.fdb_account_enrollment_tickets.output;
    expect(o.safeParse([]).success).toBe(true);
    for (const status of ["pending", "consumed", "revoked", "expired"]) expect(o.safeParse([{ ...ticketRow, status }]).success).toBe(true);
    expect(o.safeParse([{ ...ticketRow, label: "Gaming PC", consumed_at: TS, device_id: ID }]).success).toBe(true);
    expect(o.safeParse(Array(20).fill(ticketRow)).success).toBe(true);
    for (const bad of [
      Array(21).fill(ticketRow), [{ ...ticketRow, status: "active" }], [{ ...ticketRow, ticket: TICKET }], [{ ...ticketRow, ticket_hash: "x" }], [{ ...ticketRow, account_uid: ID }],
      [{ ...ticketRow, ticket_id: "x" }], [{ ...ticketRow, label: "x".repeat(61) }], [{ ...ticketRow, device_id: "x" }], [{ ticket_id: ID }], { ...ticketRow }, null,
    ]) expect(o.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    expect(ENROLLMENT_RPCS.fdb_account_enrollment_tickets.input.safeParse({ x: 1 }).success).toBe(false);
  });

  const devRow = { device_id: ID, installation_id: "inst-0123456789abcdef", label: null, status: "active", created_at: TS, last_seen_at: null, revoked_at: null, revoked_reason: null };
  it("devices list: strict rows, status enum, at most 50", () => {
    const o = ENROLLMENT_RPCS.fdb_account_devices.output;
    expect(o.safeParse([]).success).toBe(true);
    for (const status of ["active", "revoked", "pending_approval"]) expect(o.safeParse([{ ...devRow, status }]).success).toBe(true);
    expect(o.safeParse([{ ...devRow, status: "revoked", revoked_at: TS, revoked_reason: "owner_revoked", last_seen_at: TS, label: "PC" }]).success).toBe(true);
    expect(o.safeParse(Array(50).fill(devRow)).success).toBe(true);
    for (const bad of [
      Array(51).fill(devRow), [{ ...devRow, status: "gone" }], [{ ...devRow, device_secret: "fdbd1_x" }], [{ ...devRow, auth_uid: ID }], [{ ...devRow, credential_hash: "x" }],
      [{ ...devRow, installation_id: "bad id" }], [{ ...devRow, installation_id: "" }], [{ ...devRow, device_id: "x" }], [{ ...devRow, revoked_reason: "x".repeat(61) }],
      [{ ...devRow, last_seen_at: 5 }], [{ device_id: ID }], null,
    ]) expect(o.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    expect(ENROLLMENT_RPCS.fdb_account_devices.input.safeParse({ p_account: ID }).success).toBe(false);
  });

  it("revoke functions: uuid input only, strict; the two output shapes only", () => {
    for (const [name, key] of [["fdb_account_enrollment_ticket_revoke", "p_ticket_id"], ["fdb_account_device_revoke", "p_device_id"]] as const) {
      const spec = ENROLLMENT_RPCS[name];
      expect(spec.input.safeParse({ [key]: ID }).success).toBe(true);
      for (const bad of [{}, { [key]: "x" }, { [key]: ID.slice(1) }, { [key]: `${ID} ` }, { [key]: 5 }, { [key]: null }, { [key]: ID, extra: 1 }, { p_label: "x" }, null])
        expect(spec.input.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
      expect(spec.output.safeParse({ ok: true }).success).toBe(true);
      expect(spec.output.safeParse({ ok: false, error: "not_available" }).success).toBe(true);
      for (const bad of [{ ok: true, extra: 1 }, { ok: false, error: "nope" }, { ok: false }, { ok: false, error: "not_available", x: 1 }, {}, null, []]) expect(spec.output.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it("website request bodies: ids must be uuids, nothing else is accepted", () => {
    expect(INPUTS.deviceRevoke.safeParse({ deviceId: ID }).success).toBe(true);
    expect(INPUTS.enrollmentRevoke.safeParse({ ticketId: ID }).success).toBe(true);
    for (const bad of [{}, { deviceId: "not-a-uuid" }, { deviceId: ID, extra: 1 }, { ticketId: ID }, { deviceId: [ID] }, { deviceId: 1 }]) expect(INPUTS.deviceRevoke.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    for (const bad of [{}, { ticketId: "../x" }, { ticketId: ID, p_ticket_id: ID }, { deviceId: ID }, { ticketId: null }]) expect(INPUTS.enrollmentRevoke.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    expect(INPUTS.enrollmentDownload.safeParse({}).success).toBe(true);
    expect(INPUTS.enrollmentDownload.safeParse({ label: "x" }).success).toBe(false);
  });

  it("the activation file has exactly the documented fields and no account data", () => {
    const text = buildActivationFile(TICKET, "2026-10-20T12:00:00.000Z", "2026-10-13T12:00:00.000Z");
    expect(JSON.parse(text)).toEqual({ format: "foreverdb-activation", v: 1, ticket: TICKET, expiresAt: "2026-10-20T12:00:00.000Z", createdAt: "2026-10-13T12:00:00.000Z" });
    expect(Object.keys(JSON.parse(text))).toEqual(["format", "v", "ticket", "expiresAt", "createdAt"]);
    expect(new TextEncoder().encode(text).length).toBeLessThan(1024);
    expect(ACTIVATION_FILE_NAME).toBe("foreverdb-activation.fdbact");
  });

  it("the redirect allowlist contains /account/devices (query dropped) and still refuses look-alikes", () => {
    expect(ACCOUNT_REDIRECT_ALLOWLIST).toContain("/account/devices");
    expect(safeNext("/account/devices")).toBe("/account/devices");
    expect(safeNext("/account/devices?notice=x#y")).toBe("/account/devices");
    expect(safeNext("/account/devices/")).toBe("/account/devices");
    for (const bad of ["/account/devices/extra", "/account/device", "/account/devices/../x", "//account/devices", "/%2Faccount/devices"]) expect(safeNext(bad), bad).toBe("/account");
  });
});

interface Call { url: string; init: RequestInit }
function stub(reply: (c: Call) => Response | Promise<Response> | "throw") {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    const r = await reply(call);
    if (r === "throw") throw new DOMException("timed out", "TimeoutError");
    return r;
  }));
  return calls;
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("closed client for the enrollment functions", () => {
  it("refuses every device_* function and every unlisted name before anything is sent", async () => {
    const calls = stub(() => json({}));
    for (const bad of ["fdb_device_enroll", "fdb_device_status", "fdb_device_ingest", "fdb_device_rotate_credential", "fdb_account_claim_start", "fdb_installation_link_status", "ingest_foreverdb_snapshot_auth", "constructor", "__proto__", "toString", ""]) {
      await expect(callWebRpc(cfg, bad as never, {} as never, TOKEN), bad).rejects.toThrow("rpc_not_allowed");
    }
    expect(calls).toHaveLength(0);
    expect(WEB_RPCS).not.toContain("fdb_account_devices" as never);
  });

  it("sends one fixed request for a ticket issue: POST, fixed path, publishable key + the user's token, nothing else, no redirects, no cache", async () => {
    const calls = stub(() => json({ ok: true, ticket_id: ID, ticket: TICKET, expires_at: TS }));
    const out = await callWebRpc(cfg, "fdb_account_enrollment_ticket_issue", {}, TOKEN);
    expect(out).toEqual({ ok: true, data: { ok: true, ticket_id: ID, ticket: TICKET, expires_at: TS } });
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0]!;
    expect(url).toBe("http://127.0.0.1:54321/rest/v1/rpc/fdb_account_enrollment_ticket_issue");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ apikey: cfg.publishableKey, Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", Accept: "application/json" });
    expect(init.body).toBe("{}");
    expect(init.redirect).toBe("manual");
    expect(init.cache).toBe("no-store");
    expect(init.credentials).toBe("omit");
    expect(init.signal).toBeDefined();
  });

  it("validates input before sending (non-uuid, extra fields) and never sends them", async () => {
    const calls = stub(() => json({ ok: true }));
    await expect(callWebRpc(cfg, "fdb_account_device_revoke", { p_device_id: "nope" }, TOKEN)).rejects.toThrow();
    await expect(callWebRpc(cfg, "fdb_account_enrollment_ticket_revoke", { p_ticket_id: ID, p_account: ID } as never, TOKEN)).rejects.toThrow();
    await expect(callWebRpc(cfg, "fdb_account_devices", { p_x: 1 } as never, TOKEN)).rejects.toThrow();
    await expect(callWebRpc(cfg, "fdb_account_devices", {}, "short")).rejects.toThrow("rpc_bad_token");
    expect(calls).toHaveLength(0);
  });

  it("maps 401 / 403 / 429 / 400 and 'definitely not run' statuses, and never returns database text", async () => {
    for (const [status, expected] of [[401, { kind: "unauthenticated" }], [403, { kind: "forbidden" }], [429, { kind: "rate_limited", retryAfterSec: 17 }], [400, { kind: "bad_request" }], [404, { kind: "unavailable" }], [415, { kind: "unavailable" }]] as const) {
      stub(() => json({ message: "secret database text", code: "PT123" }, status, status === 429 ? { "retry-after": "17" } : {}));
      const out = await callWebRpc(cfg, "fdb_account_enrollment_ticket_issue", {}, TOKEN);
      expect(out).toEqual({ ok: false, ...expected });
      expect(JSON.stringify(out)).not.toContain("secret database text");
    }
  });

  it("a lost reply of a MUTATING call is an unknown outcome (timeout, 5xx, redirect, oversized, bad JSON, extra field); a read is just unavailable", async () => {
    const mutating = [
      ["fdb_account_enrollment_ticket_issue", {}], ["fdb_account_enrollment_ticket_revoke", { p_ticket_id: ID }], ["fdb_account_device_revoke", { p_device_id: ID }],
    ] as const;
    const replies: (() => Response | "throw")[] = [
      () => "throw",
      () => json({}, 500),
      () => json({}, 502),
      () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } }),
      () => new Response("x".repeat(600 * 1024), { status: 200 }),
      () => new Response("{not json", { status: 200 }),
      () => json({ ok: true, ticket_id: ID, ticket: TICKET, expires_at: TS, extra: 1 }),
    ];
    for (const [name, input] of mutating) for (const r of replies) {
      stub(() => r());
      expect(await callWebRpc(cfg, name, input as never, TOKEN), name).toEqual({ ok: false, kind: "unknown_outcome" });
    }
    for (const name of ["fdb_account_devices", "fdb_account_enrollment_tickets"] as const) for (const r of replies) {
      stub(() => r());
      expect(await callWebRpc(cfg, name, {}, TOKEN), name).toEqual({ ok: false, kind: "unavailable" });
    }
  });

  it("never follows a redirect (a 3xx is not fetched again) and issues exactly one request, with no retry", async () => {
    const calls = stub(() => new Response(null, { status: 307, headers: { location: "https://evil.example/steal" } }));
    await callWebRpc(cfg, "fdb_account_enrollment_ticket_issue", {}, TOKEN);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.redirect).toBe("manual");
    const timeouts = stub(() => "throw");
    await callWebRpc(cfg, "fdb_account_device_revoke", { p_device_id: ID }, TOKEN);
    expect(timeouts).toHaveLength(1);
  });

  it("does not log anything, including the ticket", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    stub(() => json({ ok: true, ticket_id: ID, ticket: TICKET, expires_at: TS }));
    await callWebRpc(cfg, "fdb_account_enrollment_ticket_issue", {}, TOKEN);
    stub(() => "throw");
    await callWebRpc(cfg, "fdb_account_enrollment_ticket_issue", {}, TOKEN);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });

  it("passes the reads through the strict output schema", async () => {
    stub(() => json([{ device_id: ID, installation_id: "inst-0123456789abcdef", label: null, status: "active", created_at: TS, last_seen_at: null, revoked_at: null, revoked_reason: null }]));
    const out = await callWebRpc(cfg, "fdb_account_devices", {}, TOKEN);
    expect(out.ok && out.data[0]?.device_id).toBe(ID);
    stub(() => json([{ device_id: ID, installation_id: "inst-0123456789abcdef", label: null, status: "active", created_at: TS, last_seen_at: null, revoked_at: null, revoked_reason: null, credential_hash: "x" }]));
    expect(await callWebRpc(cfg, "fdb_account_devices", {}, TOKEN)).toEqual({ ok: false, kind: "unavailable" });
  });
});
