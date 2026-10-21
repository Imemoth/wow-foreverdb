import { describe, expect, it } from "vitest";
import { describeDbError } from "@/lib/data/postgres-adapter";

describe("describeDbError (operator diagnostic, never a credential)", () => {
  it("keeps the error class and drops connection strings and quoted values", () => {
    const e = Object.assign(new Error('connect failed postgresql://foreverdb_web_reader.ref:SECRETPW@host:6543/postgres: password authentication failed for user "foreverdb_web_reader"'), { code: "28P01" });
    const d = describeDbError(e);
    expect(d.code).toBe("28P01");
    const text = JSON.stringify(d);
    expect(text).not.toMatch(/SECRETPW|foreverdb_web_reader|@host|6543/);
    expect(d.message).toContain("password authentication failed");
  });
  it("handles Node network/TLS errors and non-errors", () => {
    expect(describeDbError(Object.assign(new Error("getaddrinfo ENOTFOUND db.example"), { code: "ENOTFOUND", syscall: "getaddrinfo" }))).toMatchObject({ code: "ENOTFOUND", syscall: "getaddrinfo" });
    expect(describeDbError(Object.assign(new Error("self-signed certificate in certificate chain"), { code: "SELF_SIGNED_CERT_IN_CHAIN" })).code).toBe("SELF_SIGNED_CERT_IN_CHAIN");
    expect(describeDbError(undefined)).toEqual({ code: null, name: null, syscall: null, message: "" });
    expect(describeDbError("boom")).toEqual({ code: null, name: null, syscall: null, message: "" });
  });
  it("bounds the message length", () => {
    expect(String(describeDbError(new Error("x".repeat(5000))).message).length).toBeLessThanOrEqual(160);
  });
});
