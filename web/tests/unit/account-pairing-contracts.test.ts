import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountAuthConfig } from "@/lib/account/config";
import type { AccountContext } from "@/lib/account/runtime";
import { ACCOUNT_PAIRING_RPCS, NATIVE_PAIRING_RPCS, PAIRING_INPUTS, PAIRING_RPCS } from "@/lib/account/contracts-pairing";
import { BROWSER_PAIRING_WEB_APPROVED, browserPairingWebAvailable } from "@/lib/account/pairing-gate";
import { callAccountPairingRpc, callNativePairingRpc, callWebRpc } from "@/lib/account/rpc-client";

const ID = "8f790272-8cb2-4c5a-a57d-83c7d3d618aa";
const DEVICE = "223e4567-e89b-42d3-a456-426614174000";
const TS = "2026-10-16T12:05:00Z";
const HASH = "a".repeat(64);
const SECRET = `fdbp1_${"A".repeat(43)}`;
const TOKEN = "test-caller-access-token-never-expose";
const cfg: AccountAuthConfig = { mode: "local", authOrigin: "http://127.0.0.1:54321", projectRef: null, publishableKey: "sb_publishable_test", csrfSecret: "x".repeat(40) };
const start = { p_pairing_id: ID, p_poll_secret_hash: HASH, p_device_id: DEVICE, p_device_credential_hash: HASH, p_installation_id: "installation-identifier", p_computer_name: "Gaming PC" };
const proof = { p_pairing_id: ID, p_poll_secret: SECRET };
const pending = { ok: true, state: "pending", pairingId: ID, expiresAt: TS, intervalSeconds: 5 };
const preview = { state: "pending", computerName: "Gaming PC", installationSuffix: "…174000", requestedAt: TS, expiresAt: TS, canApprove: true };
const json = (value: unknown, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("browser pairing strict contracts", () => {
  it("freezes six exact signatures and separates the two actors", () => {
    expect(NATIVE_PAIRING_RPCS).toEqual(["fdb_device_pair_start", "fdb_device_pair_poll", "fdb_device_pair_cancel"]);
    expect(ACCOUNT_PAIRING_RPCS).toEqual(["fdb_account_device_pair_preview", "fdb_account_device_pair_approve", "fdb_account_device_pair_deny"]);
    expect(Object.keys(PAIRING_RPCS).sort()).toEqual([...NATIVE_PAIRING_RPCS, ...ACCOUNT_PAIRING_RPCS].sort());
    expect(NATIVE_PAIRING_RPCS.filter((n) => (ACCOUNT_PAIRING_RPCS as readonly string[]).includes(n))).toEqual([]);
    expect(Object.keys(PAIRING_RPCS.fdb_device_pair_start.input.parse(start))).toEqual(Object.keys(start));
    for (const name of NATIVE_PAIRING_RPCS.slice(1)) expect(PAIRING_RPCS[name].input.parse(proof)).toEqual(proof);
    for (const name of ACCOUNT_PAIRING_RPCS) {
      expect(PAIRING_RPCS[name].input.parse({ p_pairing_id: ID })).toEqual({ p_pairing_id: ID });
      for (const extra of ["p_account_uid", "p_session_id", "p_poll_secret"]) expect(PAIRING_RPCS[name].input.safeParse({ p_pairing_id: ID, [extra]: ID }).success).toBe(false);
    }
  });

  it("rejects noncanonical UUIDv4, wrong hash casing, invalid installation IDs, and unknown inputs", () => {
    const input = PAIRING_RPCS.fdb_device_pair_start.input;
    for (const field of ["p_pairing_id", "p_device_id"]) for (const bad of [ID.toUpperCase(), ID.replace("-4c5a-", "-1c5a-"), ID.replace("-a57d-", "-757d-"), `{${ID}}`, "nope"]) {
      expect(input.safeParse({ ...start, [field]: bad }).success, `${field}: ${bad}`).toBe(false);
    }
    for (const field of ["p_poll_secret_hash", "p_device_credential_hash"]) for (const bad of [HASH.toUpperCase(), "a".repeat(63), "g".repeat(64), SECRET]) expect(input.safeParse({ ...start, [field]: bad }).success).toBe(false);
    for (const bad of ["a".repeat(15), "a".repeat(129), "installation/id", " installation-identifier"]) expect(input.safeParse({ ...start, p_installation_id: bad }).success).toBe(false);
    for (const bad of [{ ...start, token: TOKEN }, { ...start, pairingId: ID }, { ...start, p_account_uid: ID }]) expect(input.safeParse(bad).success).toBe(false);
  });

  it("requires already sanitized, trimmed labels bounded in Unicode scalar values", () => {
    const input = PAIRING_RPCS.fdb_device_pair_start.input;
    expect(input.safeParse({ ...start, p_computer_name: "😀".repeat(60) }).success).toBe(true);
    const withoutLabel = Object.fromEntries(Object.entries(start).filter(([key]) => key !== "p_computer_name"));
    expect(input.safeParse(withoutLabel).success).toBe(true);
    for (const bad of ["😀".repeat(61), "x".repeat(61), " PC ", "PC\n", "PC\u007f", "\ud800"]) expect(input.safeParse({ ...start, p_computer_name: bad }).success, JSON.stringify(bad)).toBe(false);
  });

  it("keeps exact public JSON inputs separate from SQL parameters", () => {
    const native = { pairingId: ID, pollSecretHash: HASH, deviceId: DEVICE, deviceCredentialHash: HASH, installationId: "installation-identifier", computerName: "PC" };
    expect(PAIRING_INPUTS.start.parse(native)).toEqual(native);
    expect(PAIRING_INPUTS.poll.parse({ pairingId: ID, pollSecret: SECRET })).toEqual({ pairingId: ID, pollSecret: SECRET });
    expect(PAIRING_INPUTS.cancel.parse({ pairingId: ID, pollSecret: SECRET })).toEqual({ pairingId: ID, pollSecret: SECRET });
    for (const name of ["approve", "deny"] as const) {
      expect(PAIRING_INPUTS[name].parse({ pairingId: ID })).toEqual({ pairingId: ID });
      expect(PAIRING_INPUTS[name].safeParse({ pairingId: ID, accountId: ID }).success).toBe(false);
    }
    expect(PAIRING_INPUTS.start.safeParse(start).success).toBe(false);
    for (const bad of ["fdbp1_a", `fdbp1_${"A".repeat(42)}=`, `fdbp1_${"A".repeat(44)}`, `fdbd1_${"A".repeat(43)}`]) expect(PAIRING_INPUTS.poll.safeParse({ pairingId: ID, pollSecret: bad }).success).toBe(false);
  });

  it("accepts only known native states and bounded RFC3339 UTC metadata", () => {
    const startOutput = PAIRING_RPCS.fdb_device_pair_start.output;
    expect(startOutput.safeParse(pending).success).toBe(true);
    const poll = PAIRING_RPCS.fdb_device_pair_poll.output;
    for (const state of ["pending", "approved"]) expect(poll.safeParse({ ok: true, state, expiresAt: TS, intervalSeconds: 5 }).success).toBe(true);
    expect(poll.safeParse({ ok: true, state: "connected", deviceId: DEVICE }).success).toBe(true);
    for (const state of ["expired", "denied", "revoked"]) {
      expect(poll.safeParse({ ok: true, state }).success).toBe(true);
      expect(PAIRING_RPCS.fdb_device_pair_cancel.output.safeParse({ ok: true, state }).success).toBe(true);
    }
    for (const extra of [{ state: "PENDING" }, { state: "unknown" }, { expiresAt: "yesterday" }, { expiresAt: "2026-10-16T12:05:00+01:00" }, { intervalSeconds: 4 }, { intervalSeconds: 31 }, { intervalSeconds: 5.5 }, { pairing_id: ID }]) expect(startOutput.safeParse({ ...pending, ...extra }).success).toBe(false);
  });

  it("freezes fixed public errors without database diagnostics or arbitrary error codes", () => {
    const cases = {
      fdb_device_pair_start: ["pairing_conflict", "pairing_pending", "feature_disabled", "invalid_request", "installation_conflict", "device_bound", "rate_limited", "session_not_accepted", "temporarily_unavailable"],
      fdb_device_pair_poll: ["pairing_not_available", "feature_disabled", "invalid_request", "device_limit", "account_limit", "rate_limited", "session_not_accepted", "temporarily_unavailable"],
      fdb_device_pair_cancel: ["pairing_not_available", "feature_disabled", "invalid_request", "rate_limited", "session_not_accepted", "temporarily_unavailable"],
      fdb_account_device_pair_preview: ["feature_disabled", "pairing_not_available", "cannot_connect_to_this_account", "rate_limited", "unauthenticated", "forbidden", "temporarily_unavailable"],
      fdb_account_device_pair_approve: ["feature_disabled", "expired", "already_decided", "cannot_connect_to_this_account", "rate_limited", "unauthenticated", "forbidden", "temporarily_unavailable"],
      fdb_account_device_pair_deny: ["feature_disabled", "expired", "already_decided", "cannot_connect_to_this_account", "rate_limited", "unauthenticated", "forbidden", "temporarily_unavailable"],
    } as const;
    for (const [name, errors] of Object.entries(cases)) {
      const output = PAIRING_RPCS[name as keyof typeof PAIRING_RPCS].output;
      for (const error of errors) expect(output.safeParse({ ok: false, error }).success, `${name}: ${error}`).toBe(true);
      for (const error of ["P0001", "arbitrary", "SLOW_DOWN"]) expect(output.safeParse({ ok: false, error }).success).toBe(false);
      expect(output.safeParse({ ok: false, error: errors[0], message: "database secret" }).success).toBe(false);
    }
    expect(PAIRING_RPCS.fdb_device_pair_poll.output.safeParse({ ok: false, error: "slow_down", intervalSeconds: 10 }).success).toBe(true);
    expect(PAIRING_RPCS.fdb_device_pair_poll.output.safeParse({ ok: false, error: "slow_down" }).success).toBe(false);
  });

  it("browser outputs reveal only the sanitized preview or action state", () => {
    const output = PAIRING_RPCS.fdb_account_device_pair_preview.output;
    expect(output.safeParse(preview).success).toBe(true);
    expect(output.safeParse({ ...preview, state: "approved", canApprove: false }).success).toBe(true);
    for (const state of ["connected", "expired", "denied", "revoked"]) expect(output.safeParse({ state }).success).toBe(true);
    for (const key of ["pairingId", "deviceId", "installationId", "initiatorUid", "sessionId", "accountUid", "pollSecret", "pollSecretHash", "deviceCredentialHash", "accessToken"]) {
      expect(output.safeParse({ ...preview, [key]: SECRET }).success, key).toBe(false);
      for (const action of ["approve", "deny"] as const) expect(PAIRING_RPCS[`fdb_account_device_pair_${action}`].output.safeParse({ ok: true, state: action === "approve" ? "approved" : "denied", [key]: SECRET }).success).toBe(false);
    }
    expect(output.safeParse({ ...preview, installationSuffix: "full-installation-identifier" }).success).toBe(false);
  });
});

describe("closed pairing RPC clients", () => {
  it("rejects cross-actor and inherited/unlisted names before sending", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    for (const name of [...ACCOUNT_PAIRING_RPCS, "constructor", "__proto__", "fdb_device_ingest", ""]) await expect(callNativePairingRpc(cfg, name as never, {} as never, TOKEN)).rejects.toThrow("rpc_not_allowed");
    for (const name of [...NATIVE_PAIRING_RPCS, "toString", "fdb_account_devices"]) await expect(callAccountPairingRpc(cfg, name as never, {} as never, TOKEN)).rejects.toThrow("rpc_not_allowed");
    for (const name of [...NATIVE_PAIRING_RPCS, ...ACCOUNT_PAIRING_RPCS]) await expect(callWebRpc(cfg, name as never, {} as never, TOKEN)).rejects.toThrow("rpc_not_allowed");
    expect(fetcher).not.toHaveBeenCalled();
    // The same separation must hold for TypeScript callers, including parameter shapes.
    if (false) {
      // @ts-expect-error registered browser calls cannot name a native function
      await callAccountPairingRpc(cfg, "fdb_device_pair_poll", proof, TOKEN);
      // @ts-expect-error native calls cannot name registered browser functions
      await callNativePairingRpc(cfg, "fdb_account_device_pair_approve", { p_pairing_id: ID }, TOKEN);
      // @ts-expect-error browser cannot provide the approving account
      await callAccountPairingRpc(cfg, "fdb_account_device_pair_approve", { p_pairing_id: ID, p_account_uid: ID }, TOKEN);
    }
  });

  it("posts a bounded, noncached fixed RPC with only the publishable key and caller bearer", async () => {
    const fetcher = vi.fn(async () => json(pending)); vi.stubGlobal("fetch", fetcher);
    expect(await callNativePairingRpc(cfg, "fdb_device_pair_start", start, TOKEN)).toEqual({ ok: true, data: pending });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${cfg.authOrigin}/rest/v1/rpc/fdb_device_pair_start`);
    expect(init).toMatchObject({ method: "POST", redirect: "manual", cache: "no-store", credentials: "omit", body: JSON.stringify(start), headers: { apikey: cfg.publishableKey, Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", Accept: "application/json" } });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    await expect(callNativePairingRpc(cfg, "fdb_device_pair_poll", { ...proof, p_poll_secret: "bad" }, TOKEN)).rejects.toThrow();
    await expect(callAccountPairingRpc(cfg, "fdb_account_device_pair_preview", { p_pairing_id: ID }, "bad")).rejects.toThrow("rpc_bad_token");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("fails closed on lost, redirected, malformed, secret-bearing and duplicate-key responses without logging", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((name) => vi.spyOn(console, name).mockImplementation(() => undefined));
    const replies = [() => { throw new Error(TOKEN); }, () => json({}, 500), () => new Response(null, { status: 307, headers: { location: "https://evil.invalid/" } }), () => new Response("{broken"), () => json({ ...preview, pollSecret: SECRET }), () => new Response('{"ok":true,"state":"approved","state":"approved"}')];
    for (const reply of replies) {
      const fetcher = vi.fn(async () => reply()); vi.stubGlobal("fetch", fetcher);
      expect(await callAccountPairingRpc(cfg, "fdb_account_device_pair_approve", { p_pairing_id: ID }, TOKEN)).toEqual({ ok: false, kind: "unknown_outcome" });
      expect(await callAccountPairingRpc(cfg, "fdb_account_device_pair_preview", { p_pairing_id: ID }, TOKEN)).toEqual({ ok: false, kind: "unavailable" });
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("rejects oversized valid success JSON while accepting the bounded control", async () => {
    const success = { ok: true, state: "approved" };
    for (const padding of [0, 600 * 1024]) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(" ".repeat(padding) + JSON.stringify(success))));
      expect(await callAccountPairingRpc(cfg, "fdb_account_device_pair_approve", { p_pairing_id: ID }, TOKEN)).toEqual(
        padding ? { ok: false, kind: "unknown_outcome" } : { ok: true, data: success },
      );
    }
  });

  it("rejects invalid UTF-8 within a valid preview label while accepting the UTF-8 control", async () => {
    const replacementPreview = { ...preview, computerName: "PC�" };
    const bytes = new TextEncoder().encode(JSON.stringify(replacementPreview));
    const invalid = new Uint8Array([...bytes.slice(0, bytes.indexOf(0xef)), 0xff, ...bytes.slice(bytes.indexOf(0xef) + 3)]);
    for (const [body, expected] of [
      [bytes, { ok: true, data: replacementPreview }],
      [invalid, { ok: false, kind: "unavailable" }],
    ] as const) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(body)));
      expect(await callAccountPairingRpc(cfg, "fdb_account_device_pair_preview", { p_pairing_id: ID }, TOKEN)).toEqual(expected);
    }
  });

  it("returns only fixed transport failures and preserves native slow_down data", async () => {
    for (const [status, failure] of [[401, { kind: "unauthenticated" }], [403, { kind: "forbidden" }], [400, { kind: "bad_request" }], [429, { kind: "rate_limited", retryAfterSec: 12 }], [404, { kind: "unavailable" }]] as const) {
      vi.stubGlobal("fetch", vi.fn(async () => json({ message: SECRET }, status, { "Retry-After": "12" })));
      expect(await callNativePairingRpc(cfg, "fdb_device_pair_poll", proof, TOKEN)).toEqual({ ok: false, ...failure });
    }
    const slow = { ok: false, error: "slow_down", intervalSeconds: 10 };
    vi.stubGlobal("fetch", vi.fn(async () => json(slow)));
    expect(await callNativePairingRpc(cfg, "fdb_device_pair_poll", proof, TOKEN)).toEqual({ ok: true, data: slow });
  });
});

describe("independent false web source gate", () => {
  const context = (mode: AccountAuthConfig["mode"], hosted: boolean, deployment: "local" | "preview" | "production") => ({ cfg: { ...cfg, mode }, env: { hosted, FOREVERDB_DEPLOYMENT: deployment } }) as Pick<AccountContext, "cfg" | "env">;
  it("allows only nonhosted validated local contexts while the compiled approval is false", () => {
    expect(BROWSER_PAIRING_WEB_APPROVED).toBe(false);
    expect(browserPairingWebAvailable(context("local", false, "local"))).toBe(true);
    for (const mode of ["staging", "pilot", "production"] as const) for (const hosted of [true, false]) {
      expect(browserPairingWebAvailable(context(mode, hosted, "preview"))).toBe(false);
      expect(browserPairingWebAvailable(context(mode, hosted, "production"))).toBe(false);
      expect(browserPairingWebAvailable(context(mode, hosted, "local"))).toBe(false);
      expect(browserPairingWebAvailable(context(mode, hosted, "preview"), true)).toBe(true);
    }
    expect(browserPairingWebAvailable(context("local", true, "local"))).toBe(false);
    expect(browserPairingWebAvailable(context("local", false, "preview"))).toBe(false);
  });
});
