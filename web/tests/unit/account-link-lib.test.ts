import { describe, expect, it, vi } from "vitest";
import { WEB_RPCS, callWebRpc } from "@/lib/account/rpc-client";
import { ACCOUNT_REDIRECT_ALLOWLIST } from "@/lib/account/contracts";

const cfg = {
  mode: "local" as const,
  authOrigin: "http://127.0.0.1:54321",
  projectRef: null,
  publishableKey: "sb_publishable_unit_key_not_real",
  csrfSecret: "unit-test-secret-0123456789abcdefghijklmnopqrstuvwxyz",
};
const token = `e30.${btoa(JSON.stringify({ exp: 4_000_000_000, session_id: "session", sub: "123e4567-e89b-42d3-a456-426614174000" }))}.signature`;

describe("website ownership boundary retirement", () => {
  it("does not expose owner claims or installation lists through the website RPC client", async () => {
    expect([...WEB_RPCS]).toEqual([]);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(callWebRpc(cfg, "fdb_account_claim_redeem" as never, { p_code: "0".repeat(32) } as never, token)).rejects.toThrow("rpc_not_allowed");
    await expect(callWebRpc(cfg, "fdb_account_installations" as never, {} as never, token)).rejects.toThrow("rpc_not_allowed");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("does not redirect website authentication back to retired ownership pages", () => {
    expect(ACCOUNT_REDIRECT_ALLOWLIST).not.toContain("/account/link");
    expect(ACCOUNT_REDIRECT_ALLOWLIST).not.toContain("/account/installations");
    expect(ACCOUNT_REDIRECT_ALLOWLIST).toContain("/account/devices");
  });
});
