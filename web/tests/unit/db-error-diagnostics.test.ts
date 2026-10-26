import { describe, expect, it } from "vitest";
import { describeConnectionTarget, describeDbError } from "@/lib/data/postgres-adapter";

describe("describeDbError (operator diagnostic: fixed vocabulary only, never driver text)", () => {
  it("never echoes the driver message, URLs, role names or passwords", () => {
    const e = Object.assign(new Error('connect failed postgresql://foreverdb_web_reader.ref:SECRETPW@host:6543/postgres: password authentication failed for user "foreverdb_web_reader"'), { code: "28P01" });
    const d = describeDbError(e);
    expect(d).toEqual({ category: "auth_failed", code: "28P01", syscall: null, name: "Error" });
    expect(JSON.stringify(d)).not.toMatch(/SECRETPW|foreverdb|@host|6543|connect failed/);
  });
  it("classifies the failure modes the beta can hit", () => {
    const cat = (m: string, code?: string, syscall?: string) => describeDbError(Object.assign(new Error(m), { code, syscall })).category;
    expect(cat("getaddrinfo ENOTFOUND db.example", "ENOTFOUND", "getaddrinfo")).toBe("dns");
    expect(cat("connect ENETUNREACH 2a05:d018::1:5432", "ENETUNREACH", "connect")).toBe("network_unreachable");
    expect(cat("connect ETIMEDOUT", "ETIMEDOUT", "connect")).toBe("timeout");
    expect(cat("Connection terminated due to connection timeout")).toBe("timeout");
    expect(cat("connect ECONNREFUSED 10.0.0.1:6543", "ECONNREFUSED", "connect")).toBe("connection_refused");
    expect(cat("self-signed certificate in certificate chain", "SELF_SIGNED_CERT_IN_CHAIN")).toBe("tls_verification");
    expect(cat("Tenant or user not found")).toBe("tenant_not_found");
    expect(cat('password authentication failed for user "x"', "28P01")).toBe("auth_failed");
    expect(cat("permission denied for schema pub", "42501")).toBe("privilege");
    expect(cat("unsupported startup parameter: statement_timeout")).toBe("startup_parameter");
    expect(cat("something unexpected")).toBe("other");
  });
  it("only emits strict code tokens, allow-listed syscalls and bounded names", () => {
    const d = describeDbError(Object.assign(new Error("x"), { code: "bad code with spaces & secrets", syscall: "evil", name: "Bad Name!" }));
    expect(d).toEqual({ category: "other", code: null, syscall: null, name: null });
    expect(describeDbError(undefined)).toEqual({ category: "other", code: null, syscall: null, name: null });
    expect(describeDbError("boom")).toEqual({ category: "other", code: null, syscall: null, name: null });
  });
});

describe("describeConnectionTarget (non-secret shape of the configured URL)", () => {
  it("recognises the intended pooler configuration without returning any credential", () => {
    const t = describeConnectionTarget("postgresql://foreverdb_web_reader.chcoypkjzxfznsqmmbrq:s3cr3tPW@aws-0-eu-west-1.pooler.supabase.com:6543/postgres");
    expect(t).toEqual({ protocol: "postgresql", hostKind: "supabase_pooler", host: "aws-0-eu-west-1.pooler.supabase.com", port: 6543, userPattern: "role.projectref", database: "postgres", hasPassword: true, hasQuery: false, sslmodeParam: false });
    expect(JSON.stringify(t)).not.toMatch(/s3cr3tPW|chcoypkj/);
  });
  it("flags the direct IPv6-only host, a conflicting sslmode and an unexpected user", () => {
    const t = describeConnectionTarget("postgresql://postgres:pw@db.chcoypkjzxfznsqmmbrq.supabase.co:5432/postgres?sslmode=require");
    expect(t).toMatchObject({ hostKind: "supabase_direct_ipv6_only", host: null, port: 5432, userPattern: "other", sslmodeParam: true, hasQuery: true });
  });
  it("reports unparseable input without echoing it", () => {
    expect(describeConnectionTarget("not a url with SECRET")).toEqual({ parse: "invalid_url" });
  });
});
