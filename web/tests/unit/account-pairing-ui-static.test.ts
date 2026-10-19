import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = resolve(__dirname, "../../src");
const read = (path: string) => readFileSync(resolve(SRC, path), "utf8");

describe("browser pairing approval UI (static)", () => {
  it("has one server page, one client confirmation component and POST-only decision routes", () => {
    for (const path of [
      "app/account/device-pair/page.tsx",
      "app/account/_components/DevicePairApproval.tsx",
      "app/account/api/device-pair/approve/route.ts",
      "app/account/api/device-pair/deny/route.ts",
    ]) expect(existsSync(resolve(SRC, path)), path).toBe(true);

    const page = read("app/account/device-pair/page.tsx");
    expect(page).toMatch(/requirePageUser\("\/account\/device-pair"\)/);
    expect(page).toMatch(/readPairingCookie/);
    expect(page).toMatch(/fdb_account_device_pair_preview/);
    expect(page).not.toMatch(/export const (GET|POST)/);

    for (const action of ["approve", "deny"] as const) {
      const route = read(`app/account/api/device-pair/${action}/route.ts`);
      expect(route).toMatch(/export const POST = accountApi\(/);
      expect(route).not.toMatch(/export const (GET|HEAD|PUT|PATCH|DELETE|OPTIONS)/);
      expect(route).toContain(`decidePairing(c, body, "${action}")`);
    }
    const boundary = read("lib/account/pairing-browser.ts");
    expect(boundary).toMatch(/readPairingCookie/);
    expect(boundary).toMatch(/locator\.id !== body\.pairingId/);
    expect(boundary).toMatch(/fdb_account_device_pair_approve/);
    expect(boundary).toMatch(/fdb_account_device_pair_deny/);
  });

  it("pins account switching, accessible status and deliberate one-shot actions", () => {
    const ui = read("app/account/_components/DevicePairApproval.tsx");
    expect(ui).toMatch(/^\s*["']use client["']/);
    expect(ui).toMatch(/postPairingDecision\(action, props\.pairingId, props\.pageBinding\)/);
    const client = read("lib/account/client.ts");
    expect(client).toMatch(/postPairingDecision[\s\S]*x-fdb-pairing-page/);
    expect(ui).toMatch(/aria-busy=\{busy !== null\}/);
    expect(ui).toMatch(/disabled=\{busy/);
    expect(ui).toMatch(/role="(?:status|alert)"/);
    expect(ui).toMatch(/tabIndex=\{-1\}/);
    expect(ui).toMatch(/Approve/);
    expect(ui).toMatch(/Deny/);
    expect(ui).toMatch(/state === "approved"[\s\S]*Deny this approved request/);
    expect(ui).toMatch(/state === "approved" && !decidedHere/);
    expect(ui).toMatch(/outcome_unknown[\s\S]*setUncertain\(true\)/);
    expect(ui).toMatch(/disabled=\{busy !== null \|\| uncertain\}/);
    expect(ui).toMatch(/expired[\s\S]*already_decided[\s\S]*cannot_connect_to_this_account[\s\S]*setClosed\(true\)/);
    expect(ui).toMatch(/props\.canApprove && !closed/);
    expect(read("lib/account/messages.ts")).toMatch(/Your session changed while this page was open/);
    expect(ui).not.toMatch(/localStorage|sessionStorage|document\.cookie|console\./);
  });

  it("shows explicit account, computer and expiry labels without passing private credentials", () => {
    const page = read("app/account/device-pair/page.tsx");
    const ui = read("app/account/_components/DevicePairApproval.tsx");
    expect(ui).toMatch(/Account/);
    expect(ui).toMatch(/Computer/);
    expect(ui).toMatch(/Expires/);
    expect(page).not.toMatch(/pollSecret|deviceCredential|refreshToken|accessToken/);
  });
});
