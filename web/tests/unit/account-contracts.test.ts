import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";
import { buildSync } from "esbuild";
import { describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_RPCS,
  AUTH_BODIES,
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

describe("contracts.ts is browser-safe (no Node globals or built-ins)", () => {
  const entry = resolve(__dirname, "../../src/lib/account/contracts.ts");
  const source = readFileSync(entry, "utf8");
  const signup = (password: string) => AUTH_BODIES.signup.safeParse({ email: "a@b.example", password }).success;

  it("does not reference Buffer, process or node: built-ins", () => {
    expect(source).not.toMatch(/\bBuffer\b|\bprocess\.|from\s+["']node:|require\(/);
  });

  it("ASCII passwords: 12..72 bytes accepted, 11 and 73 refused", () => {
    expect(signup("a".repeat(11))).toBe(false);
    expect(signup("a".repeat(12))).toBe(true);
    expect(signup("a".repeat(72))).toBe(true);
    expect(signup("a".repeat(73))).toBe(false);
  });

  it("multibyte UTF-8 passwords are limited by BYTES (72), not characters", () => {
    expect(signup("é".repeat(36))).toBe(true); // 2 bytes each = 72
    expect(signup("é".repeat(37))).toBe(false); // 74
    expect(signup("€".repeat(24))).toBe(true); // 3 bytes each = 72
    expect(signup("€".repeat(25))).toBe(false); // 75
    expect(signup("😀".repeat(18))).toBe(true); // 4 bytes each = 72
    expect(signup("😀".repeat(19))).toBe(false); // 76
    expect(signup("a".repeat(70) + "é")).toBe(true); // 72 mixed
    expect(signup("a".repeat(71) + "é")).toBe(false); // 73 mixed
  });

  it("the 12-character minimum counts code POINTS while the 72 limit counts bytes", () => {
    expect(signup("é".repeat(11))).toBe(false); // 11 characters
    expect(signup("é".repeat(12))).toBe(true); // 12 characters, 24 bytes
    expect(signup("😀".repeat(6))).toBe(false); // 6 characters (12 UTF-16 code units must not count as 12)
    expect(signup("😀".repeat(11))).toBe(false); // 11 characters, 44 bytes
    expect(signup("😀".repeat(12))).toBe(true); // 12 characters, 48 bytes
    expect(signup("a".repeat(10) + "😀")).toBe(false); // 11 characters
    expect(signup("a".repeat(11) + "😀")).toBe(true); // 12 characters
  });

  it("sign-in bounds the password but never applies the sign-up minimum", () => {
    const login = (password: string) => AUTH_BODIES.password_grant.safeParse({ email: "a@b.example", password }).success;
    expect(login("short")).toBe(true);
    expect(login("")).toBe(false);
    expect(login("a".repeat(72))).toBe(true);
    expect(login("a".repeat(73))).toBe(false);
    expect(login("😀".repeat(19))).toBe(false); // 76 bytes
  });

  it("the same results hold with Buffer removed from the global scope", () => {
    vi.stubGlobal("Buffer", undefined);
    try {
      expect(typeof Buffer).toBe("undefined");
      expect(signup("é".repeat(36))).toBe(true);
      expect(signup("é".repeat(37))).toBe(false);
      expect(signup("😀".repeat(19))).toBe(false);
      expect(signup("a".repeat(72))).toBe(true);
      expect(signup("a".repeat(73))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("the module bundled for the BROWSER executes in a context with only web-platform globals", () => {
    const out = buildSync({
      entryPoints: [entry],
      bundle: true,
      platform: "browser",
      format: "iife",
      globalName: "Contracts",
      write: false,
      logLevel: "silent",
      define: { "process.env.NODE_ENV": '"production"' },
    });
    const code = out.outputFiles[0]?.text ?? "";
    expect(code).not.toMatch(/node:|require\("/);
    // A bare context: standard JavaScript intrinsics plus the web-platform classes the module uses. No Buffer, no process.
    const sandbox: Record<string, unknown> = { TextEncoder, TextDecoder, URL, URLSearchParams };
    const ctx = vm.createContext(sandbox);
    expect(vm.runInContext("typeof Buffer + typeof process + typeof require + typeof module", ctx)).toBe("undefinedundefinedundefinedundefined");
    const C = vm.runInContext(`${code}\nContracts`, ctx) as {
      AUTH_BODIES: typeof AUTH_BODIES;
      normalizeClaimCode: typeof normalizeClaimCode;
      isAllowedAuthRequest: typeof isAllowedAuthRequest;
      safeNext: typeof safeNext;
    };
    const ok = (pw: string) => C.AUTH_BODIES.signup.safeParse({ email: "a@b.example", password: pw }).success;
    expect(ok("a".repeat(72))).toBe(true);
    expect(ok("a".repeat(73))).toBe(false);
    expect(ok("é".repeat(36))).toBe(true);
    expect(ok("é".repeat(37))).toBe(false);
    expect(ok("😀".repeat(19))).toBe(false);
    expect(C.normalizeClaimCode("0123456789abcdef0123456789abcdef")).toBe("0123456789ABCDEF0123456789ABCDEF");
    expect(C.isAllowedAuthRequest("POST", "/auth/v1/logout?scope=local")).toBe(true);
    expect(C.isAllowedAuthRequest("POST", "/auth/v1/logout?scope=global")).toBe(false); // never without the recovery-only flag
    expect(C.safeNext("//evil.example")).toBe("/account");
  });
});

describe("auth endpoint allowlist", () => {
  it("allows exactly the listed endpoints", () => {
    expect(isAllowedAuthRequest("POST", "/auth/v1/signup")).toBe(true);
    expect(isAllowedAuthRequest("POST", "/auth/v1/token?grant_type=password")).toBe(true);
    expect(isAllowedAuthRequest("POST", "/auth/v1/token?grant_type=refresh_token")).toBe(true);
    expect(isAllowedAuthRequest("GET", "/auth/v1/user")).toBe(true);
    expect(isAllowedAuthRequest("GET", "/auth/v1/.well-known/jwks.json")).toBe(true);
    expect(AUTH_ENDPOINTS.length).toBe(10);
  });
  it("pins query parameters: logout is always scope=local (never global, so the Companion session survives)", () => {
    expect(isAllowedAuthRequest("POST", "/auth/v1/logout?scope=local")).toBe(true);
    for (const p of ["/auth/v1/logout", "/auth/v1/logout?scope=global", "/auth/v1/logout?scope=others", "/auth/v1/logout?scope=local&scope=global", "/auth/v1/logout?scope=local&x=1"]) {
      expect(isAllowedAuthRequest("POST", p), p).toBe(false);
    }
  });
  it("the global logout exists only as a fixed, recovery-only entry: no caller can choose a scope", () => {
    const g = "/auth/v1/logout?scope=global";
    expect(isAllowedAuthRequest("POST", g)).toBe(false);
    expect(isAllowedAuthRequest("POST", g, { recovery: false })).toBe(false);
    expect(isAllowedAuthRequest("POST", g, { recovery: true })).toBe(true);
    for (const p of ["/auth/v1/logout?scope=others", "/auth/v1/logout", "/auth/v1/logout?scope=global&scope=local", "/auth/v1/logout?scope=global&x=1", "/auth/v1/logout?scope=GLOBAL", "/auth/v1/logout?scope="]) {
      expect(isAllowedAuthRequest("POST", p, { recovery: true }), p).toBe(false);
    }
    expect(isAllowedAuthRequest("GET", g, { recovery: true })).toBe(false);
    expect(isAllowedAuthRequest("POST", "/auth/v1/logout?scope=local", { recovery: true })).toBe(true);
    expect(AUTH_ENDPOINTS.filter((e) => e.recoveryOnly).map((e) => `${e.method} ${e.path} ${JSON.stringify(e.fixedQuery)}`)).toEqual(['POST /auth/v1/logout {"scope":"global"}']);
  });
  it("accepts redirect_to only when it equals the server-computed callback URL", () => {
    const cb = "https://app.example/account/auth/confirm";
    const enc = encodeURIComponent(cb);
    expect(isAllowedAuthRequest("POST", `/auth/v1/signup?redirect_to=${enc}`, { callbackUrl: cb })).toBe(true);
    expect(isAllowedAuthRequest("POST", `/auth/v1/recover?redirect_to=${enc}`, { callbackUrl: cb })).toBe(true);
    expect(isAllowedAuthRequest("POST", `/auth/v1/signup?redirect_to=${enc}`)).toBe(false);
    expect(isAllowedAuthRequest("POST", `/auth/v1/signup?redirect_to=${encodeURIComponent("https://evil.example/")}`, { callbackUrl: cb })).toBe(false);
    expect(isAllowedAuthRequest("POST", `/auth/v1/signup?redirect_to=${enc}&redirect_to=${enc}`, { callbackUrl: cb })).toBe(false);
    expect(isAllowedAuthRequest("POST", `/auth/v1/verify?redirect_to=${enc}`, { callbackUrl: cb })).toBe(false);
    expect(isAllowedAuthRequest("POST", "/auth/v1/signup?anything=1")).toBe(false);
    expect(isAllowedAuthRequest("GET", "/auth/v1/user?x=1")).toBe(false);
    expect(isAllowedAuthRequest("POST", "/auth/v1/token?grant_type=password&redirect_to=x")).toBe(false);
  });
  it("freezes strict request bodies: no user_metadata, no extra fields, bounded password", () => {
    const ok = { email: "  User@Example.COM ", password: "correct horse battery" };
    expect(AUTH_BODIES.signup.parse(ok)).toEqual({ email: "user@example.com", password: "correct horse battery" });
    expect(AUTH_BODIES.signup.safeParse({ ...ok, data: { role: "admin" } }).success).toBe(false);
    expect(AUTH_BODIES.signup.safeParse({ ...ok, password: "short" }).success).toBe(false);
    expect(AUTH_BODIES.signup.safeParse({ ...ok, password: "x".repeat(73) }).success).toBe(false);
    expect(AUTH_BODIES.signup.safeParse({ ...ok, password: "é".repeat(40) }).success).toBe(false); // 80 bytes
    expect(AUTH_BODIES.signup.safeParse({ email: "not-an-email", password: ok.password }).success).toBe(false);
    expect(AUTH_BODIES.signup.safeParse({ password: ok.password }).success).toBe(false); // bodyless/anonymous signup is not possible
    expect(AUTH_BODIES.update_password.safeParse({ password: ok.password, email: "x@y.example" }).success).toBe(false); // no email change in V1
    expect(AUTH_BODIES.verify.safeParse({ type: "magiclink", token_hash: "x".repeat(20) }).success).toBe(false);
    expect(AUTH_BODIES.recover.safeParse({ email: ok.email, gotrue_meta_security: {} }).success).toBe(false);
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
      "fdb_account_guildbook_guilds_scoped",
      "fdb_account_guildbook_ingest",
      "fdb_account_guildbook_members",
      "fdb_account_guildbook_members_scoped",
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
    expect(redeem.safeParse({ ok: false, error: "account_limit" }).success).toBe(true);
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
    const inst = { installation_id: "i1", linked_at: "2026-10-11T10:00:00Z", last_seen_at: null, guild_count: 0 };
    expect(ACCOUNT_RPCS.fdb_account_installations.output.safeParse(Array(50).fill(inst)).success).toBe(true);
    expect(ACCOUNT_RPCS.fdb_account_installations.output.safeParse(Array(51).fill(inst)).success).toBe(false);
  });
});

describe("redirect allowlist", () => {
  it("returns allowlisted pathnames only and drops query and fragment", () => {
    expect(safeNext("/account/link")).toBe("/account/link");
    expect(safeNext("/account/link?x=1#y")).toBe("/account/link");
    expect(safeNext("/account/guildbook/")).toBe("/account");
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
