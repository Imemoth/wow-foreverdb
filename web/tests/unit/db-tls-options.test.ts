import tls from "node:tls";
import { describe, expect, it } from "vitest";
import { buildSslOptions } from "@/lib/data/postgres-adapter";
import { SUPABASE_ROOT_2021_CA } from "@/lib/data/supabase-ca";

const POOLER = "postgresql://foreverdb_web_reader.ref:pw@aws-0-eu-west-1.pooler.supabase.com:6543/postgres";

describe("database TLS options", () => {
  it("verifies remote servers: never relaxed, trusts Node's roots plus the Supabase Root 2021 CA", () => {
    const ssl = buildSslOptions(POOLER) as { rejectUnauthorized: boolean; ca: string[] };
    expect(ssl.rejectUnauthorized).toBe(true);
    expect(ssl.ca).toContain(SUPABASE_ROOT_2021_CA);
    expect(ssl.ca.length).toBe(tls.rootCertificates.length + 1);
    expect(ssl).not.toHaveProperty("checkServerIdentity");
  });
  it("uses plain TCP only for localhost URLs", () => {
    expect(buildSslOptions("postgresql://foreverdb_web_reader:pw@localhost:5432/db")).toBeUndefined();
    expect(buildSslOptions("postgresql://foreverdb_web_reader:pw@127.0.0.1:5432/db")).toBeUndefined();
    expect(buildSslOptions("postgresql://foreverdb_web_reader:pw@db.example.com:5432/db")).toMatchObject({ rejectUnauthorized: true });
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
