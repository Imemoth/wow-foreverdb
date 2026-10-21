import tls from "node:tls";
import { describe, expect, it } from "vitest";
import { buildSslOptions } from "@/lib/data/postgres-adapter";
import { SUPABASE_ROOT_2021_CA } from "@/lib/data/supabase-ca";

const POOLER = "postgresql://foreverdb_web_reader.ref:pw@aws-0-eu-west-1.pooler.supabase.com:6543/postgres";

describe("database TLS options", () => {
  it("pooler: verification never relaxed; trusts Node's roots plus the Supabase Root 2021 CA", () => {
    const ssl = buildSslOptions(POOLER) as { rejectUnauthorized: boolean; ca: string[] };
    expect(ssl.rejectUnauthorized).toBe(true);
    expect(ssl.ca).toContain(SUPABASE_ROOT_2021_CA);
    expect(ssl.ca.length).toBe(tls.rootCertificates.length + 1);
    expect(ssl).not.toHaveProperty("checkServerIdentity");
  });
  it("adds the extra CA only for Supabase pooler hosts", () => {
    for (const host of ["aws-0-eu-west-1.pooler.supabase.com", "aws-1-us-east-2.pooler.supabase.com", "AWS-0-EU-WEST-1.POOLER.SUPABASE.COM"]) {
      expect(buildSslOptions(`postgresql://u:pw@${host}:6543/postgres`), host).toHaveProperty("ca");
    }
  });
  it("leaves every other remote database on Node's default trust store, still verified", () => {
    for (const url of [
      "postgresql://u:pw@db.example.com:5432/db",
      "postgresql://u:pw@db.chcoypkjzxfznsqmmbrq.supabase.co:5432/postgres", // direct host: not a pooler
      "postgresql://u:pw@aws-0-eu-west-1.pooler.supabase.com.evil.example:6543/postgres", // look-alike suffix
      "postgresql://u:pw@evil-aws-0-eu-west-1.pooler.supabase.com:6543/postgres",
      "postgresql://u:pw@pooler.supabase.com:6543/postgres",
      "postgresql://pooler.supabase.com@db.example.com:5432/db", // pooler name only in the userinfo
    ]) {
      expect(buildSslOptions(url), url).toEqual({ rejectUnauthorized: true });
    }
  });
  it("uses plain TCP only for localhost URLs", () => {
    expect(buildSslOptions("postgresql://foreverdb_web_reader:pw@localhost:5432/db")).toBeUndefined();
    expect(buildSslOptions("postgresql://foreverdb_web_reader:pw@127.0.0.1:5432/db")).toBeUndefined();
  });
  it("bundles exactly the Supabase Root 2021 CA (pinned fingerprint, one self-signed CA certificate)", async () => {
    const { X509Certificate, createHash } = await import("node:crypto");
    const x = new X509Certificate(SUPABASE_ROOT_2021_CA);
    expect(x.subject).toContain("CN=Supabase Root 2021 CA");
    expect(x.subject).toBe(x.issuer);
    expect(x.ca).toBe(true);
    expect(createHash("sha256").update(x.raw).digest("hex")).toBe("807025ad50d4ed219d2c9c7d299c004f824eb00cf7f65afef607d07b72e6cafa");
    expect(new Date(x.validTo).getFullYear()).toBe(2031);
    expect((SUPABASE_ROOT_2021_CA.match(/BEGIN CERTIFICATE/g) ?? []).length).toBe(1);
  });
});
