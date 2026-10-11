import { describe, expect, it } from "vitest";
import {
  ACCOUNT_RPCS,
  AUTH_ENDPOINTS,
  classifyClaims,
  formatClaimCode,
  isAccountRpc,
  isAllowedAuthRequest,
  normalizeClaimCode,
  safeNext,
} from "@/lib/account/contracts";

const UID = "123e4567-e89b-42d3-a456-426614174000";

describe("claim code format", () => {
  const canonical = "0123456789ABCDEF0123456789ABCDEF";
  it("round-trips and tolerates casing, spacing, hyphens and the FDB prefix", () => {
    expect(formatClaimCode(canonical)).toBe("FDB-0123-4567-89AB-CDEF-0123-4567-89AB-CDEF");
    for (const typed of [canonical, canonical.toLowerCase(), formatClaimCode(canonical), formatClaimCode(canonical).toLowerCase(), ` ${formatClaimCode(canonical)}\n`, "FDB 0123 4567 89AB CDEF 0123 4567 89AB CDEF"]) {
      expect(normalizeClaimCode(typed), typed).toBe(canonical);
    }
  });
  it("is not confused by a code that itself starts with F, D, B", () => {
    const c = "FDB0123456789ABCDEF0123456789ABCD"; // 33 characters: neither a bare (32) nor a prefixed (35) code
    expect(normalizeClaimCode(c)).toBeNull();
    const own = "FDBA23456789ABCDEF0123456789ABCD"; // 32 hex chars that start with F D B
    expect(normalizeClaimCode(own)).toBe(own);
    expect(normalizeClaimCode(`FDB-${own.match(/.{4}/g)!.join("-")}`)).toBe(own);
  });
  it("rejects anything that is not exactly 128 hex bits", () => {
    for (const bad of [undefined, null, 42, "", "abc", canonical.slice(1), canonical + "0", "G".repeat(32), "0123456789ABCDEF0123456789ABCDE!", "x".repeat(81), { toString: () => canonical }]) {
      expect(normalizeClaimCode(bad), String(bad)).toBeNull();
    }
    expect(() => formatClaimCode("nope")).toThrow();
  });
});

describe("auth endpoint allowlist", () => {
  it("allows exactly the listed endpoints", () => {
    expect(isAllowedAuthRequest("POST", "/auth/v1/signup")).toBe(true);
    expect(isAllowedAuthRequest("POST", "/auth/v1/token?grant_type=password")).toBe(true);
    expect(isAllowedAuthRequest("POST", "/auth/v1/token?grant_type=refresh_token")).toBe(true);
    expect(isAllowedAuthRequest("GET", "/auth/v1/user")).toBe(true);
    expect(isAllowedAuthRequest("GET", "/auth/v1/.well-known/jwks.json")).toBe(true);
    expect(AUTH_ENDPOINTS.length).toBe(9);
  });
  it("refuses everything else: admin API, other grants, wrong method, other paths, absolute URLs", () => {
    for (const [m, p] of [
      ["POST", "/auth/v1/admin/users"],
      ["GET", "/auth/v1/admin/users"],
      ["POST", "/auth/v1/token"],
      ["POST", "/auth/v1/token?grant_type=id_token"],
      ["POST", "/auth/v1/token?grant_type=client_credentials"],
      ["DELETE", "/auth/v1/user"],
      ["GET", "/auth/v1/signup"],
      ["POST", "/rest/v1/rpc/anything"],
      ["POST", "/auth/v1/signup/../admin/users"],
      ["POST", "https://evil.example/auth/v1/signup"],
      ["POST", "//evil.example/auth/v1/signup"],
      ["POST", "/auth/v1/sso"],
      ["POST", "/auth/v1/factors"],
    ] as const) {
      expect(isAllowedAuthRequest(m, p), `${m} ${p}`).toBe(false);
    }
  });
});

describe("RPC contract registry", () => {
  it("is a closed set; unlisted names are not account RPCs", () => {
    expect(Object.keys(ACCOUNT_RPCS).sort()).toEqual([
      "fdb_account_claim_redeem",
      "fdb_account_claim_start",
      "fdb_account_guildbook_guilds",
      "fdb_account_guildbook_members",
      "fdb_account_installations",
      "fdb_installation_link_status",
    ]);
    for (const n of ["ingest_foreverdb_snapshot_auth", "get_foreverdb_search_global", "constructor", "__proto__", "toString", "fdb_account_claim_start ", "FDB_ACCOUNT_CLAIM_START"]) {
      expect(isAccountRpc(n), n).toBe(false);
    }
    expect(isAccountRpc("fdb_account_installations")).toBe(true);
  });
  it("validates inputs strictly: no extra fields, bounded identifiers and pages", () => {
    const start = ACCOUNT_RPCS.fdb_account_claim_start.input;
    expect(start.safeParse({ p_installation_id: "abc-123" }).success).toBe(true);
    expect(start.safeParse({ p_installation_id: "abc", p_extra: 1 }).success).toBe(false);
    expect(start.safeParse({ p_installation_id: "" }).success).toBe(false);
    expect(start.safeParse({ p_installation_id: "a".repeat(129) }).success).toBe(false);
    expect(start.safeParse({ p_installation_id: "a b" }).success).toBe(false);
    expect(start.safeParse({ p_installation_id: "../etc" }).success).toBe(false);
    expect(start.safeParse({ p_installation_id: "a'; drop table x;--" }).success).toBe(false);
    const members = ACCOUNT_RPCS.fdb_account_guildbook_members.input;
    expect(members.parse({ p_installation_id: "i1", p_guild_key: "g" })).toMatchObject({ p_limit: 100, p_offset: 0 });
    expect(members.safeParse({ p_installation_id: "i1", p_guild_key: "g", p_limit: 201 }).success).toBe(false);
    expect(members.safeParse({ p_installation_id: "i1", p_guild_key: "g", p_limit: 0 }).success).toBe(false);
    expect(members.safeParse({ p_installation_id: "i1", p_guild_key: "g", p_offset: -1 }).success).toBe(false);
    expect(ACCOUNT_RPCS.fdb_account_claim_redeem.input.safeParse({ p_code: "abc" }).success).toBe(false);
    expect(ACCOUNT_RPCS.fdb_account_installations.input.safeParse({ p_user_id: UID }).success).toBe(false);
  });
  it("models claim failures as one indistinguishable result, never as distinct reasons", () => {
    const start = ACCOUNT_RPCS.fdb_account_claim_start.output;
    const redeem = ACCOUNT_RPCS.fdb_account_claim_redeem.output;
    expect(start.safeParse({ ok: true, code: "0123456789ABCDEF0123456789ABCDEF", expires_at: "2026-10-11T10:00:00Z" }).success).toBe(true);
    expect(start.safeParse({ ok: false, error: "not_available" }).success).toBe(true);
    expect(start.safeParse({ ok: false, error: "not_owner" }).success).toBe(false);
    expect(redeem.safeParse({ ok: false, error: "invalid_claim" }).success).toBe(true);
    for (const reason of ["expired", "consumed", "wrong_owner", "not_found", "revoked"]) {
      expect(redeem.safeParse({ ok: false, error: reason }).success, reason).toBe(false);
    }
    expect(redeem.safeParse({ ok: true, installation_id: "i1", linked_at: "2026-10-11T10:00:00Z", previous_owner: UID }).success).toBe(false);
    expect(ACCOUNT_RPCS.fdb_installation_link_status.output.safeParse({ state: "owner_is_someone_else" }).success).toBe(false);
  });
  it("validates outputs strictly so unexpected private fields are not passed through", () => {
    const out = ACCOUNT_RPCS.fdb_account_guildbook_members.output;
    const row = { member_name: "A", class_name: "Mage", class_file: "MAGE", level: 60, rank_name: "R", rank_index: 1, online: true, zone_name: "Z", last_online_hours: 0 };
    expect(out.safeParse([row]).success).toBe(true);
    expect(out.safeParse([{ ...row, member_guid: "Player-1-ABC" }]).success).toBe(false);
    expect(out.safeParse(Array(201).fill(row)).success).toBe(false);
  });
});

describe("redirect allowlist", () => {
  it("returns allowlisted pathnames only and drops query and fragment", () => {
    expect(safeNext("/account/link")).toBe("/account/link");
    expect(safeNext("/account/link?x=1#y")).toBe("/account/link");
    expect(safeNext("/account/guildbook/")).toBe("/account/guildbook");
    expect(safeNext("/account")).toBe("/account");
  });
  it("falls back to /account for open-redirect attempts and encodings of them", () => {
    for (const bad of [
      undefined, null, 5, "", "account", "https://evil.example", "http://evil.example/account", "//evil.example", "///evil.example",
      "/\\evil.example", "\\\\evil.example", "/%5Cevil.example", "/%2F%2Fevil.example", "/%252F%252Fevil.example", "%2F%2Fevil.example",
      "/account\r\nSet-Cookie: x=1", "/account%0d%0aX: y", "javascript:alert(1)", "/account/../admin", "/account/%2e%2e/admin", "/other", "/", "/api/v1/meta",
      "/account/unknown", "/accounts", "/account%00", "/" + "a".repeat(300),
    ]) {
      expect(safeNext(bad), String(bad)).toBe("/account");
    }
  });
});

describe("claim classification", () => {
  const base = { sub: UID, role: "authenticated" };
  it("separates anonymous from registered identities", () => {
    expect(classifyClaims({ ...base, is_anonymous: true })).toBe("anonymous");
    expect(classifyClaims({ ...base, is_anonymous: false, email: "a@b.example" })).toBe("registered");
  });
  it("fails closed on anything ambiguous", () => {
    for (const c of [
      null, undefined, "x", [], {}, { ...base }, { ...base, is_anonymous: false }, { ...base, is_anonymous: false, email: "" },
      { ...base, is_anonymous: "false", email: "a@b.example" }, { ...base, role: "anon", is_anonymous: false, email: "a@b.example" },
      { ...base, role: "service_role", is_anonymous: false, email: "a@b.example" }, { sub: "not-a-uuid", role: "authenticated", is_anonymous: true },
      { role: "authenticated", is_anonymous: true },
    ]) {
      expect(classifyClaims(c), JSON.stringify(c)).toBe("invalid");
    }
  });
});
