import { describe, expect, it } from "vitest";
import { e2eFixturesAllowed } from "@/lib/e2e-fixtures";

const LOCAL = { E2E_FIXTURES_ENABLED: "1", FOREVERDB_DEPLOYMENT: "local", FOREVERDB_DATA_SOURCE: "fixture", SITE_URL: "http://localhost:3310", AZERDEX_READ_DB_URL: "", RATE_LIMIT_BACKEND: "memory" };
const gate = (over: Record<string, string | undefined>) => e2eFixturesAllowed({ ...LOCAL, ...over });

describe("e2eFixturesAllowed: the synthetic /test-fixtures harness needs more than the flag", () => {
  it("is allowed only for the explicit local fixture configuration with the flag", () => {
    expect(gate({})).toBe(true);
  });

  it("is refused without the exact flag", () => {
    for (const v of [undefined, "", "0", "true", "yes", " 1"]) expect(gate({ E2E_FIXTURES_ENABLED: v }), String(v)).toBe(false);
  });

  it("is refused on every hosted/Vercel configuration even with the flag (beta, preview, production)", () => {
    const beta = {
      VERCEL: "1", VERCEL_ENV: "preview", VERCEL_URL: "wow-foreverdb-git-web-azerdex-beta.vercel.app", VERCEL_GIT_COMMIT_REF: "web/azerdex-beta",
      FOREVERDB_DEPLOYMENT: "preview", FOREVERDB_DATA_SOURCE: "postgres", SITE_URL: "https://beta.azerdex.com", AZERDEX_READ_DB_URL: "postgresql://u:p@aws-0-eu-west-1.pooler.supabase.com:6543/postgres",
      BETA_SEO_AUTHORIZED_BRANCH: "web/azerdex-beta",
    };
    expect(gate(beta)).toBe(false);
    expect(gate({ ...beta, VERCEL_ENV: "production", FOREVERDB_DEPLOYMENT: "production", SITE_URL: "https://azerdex.com" })).toBe(false);
    // any single signal is enough to refuse
    for (const k of ["VERCEL", "VERCEL_ENV", "VERCEL_URL", "VERCEL_GIT_COMMIT_REF", "NEXT_PUBLIC_VERCEL_ENV"]) expect(gate({ [k]: "1" }), k).toBe(false);
  });

  it("is refused for anything but an explicit local deployment on fixture data", () => {
    expect(gate({ FOREVERDB_DEPLOYMENT: undefined })).toBe(false); // implicit local is not enough
    expect(gate({ FOREVERDB_DEPLOYMENT: "preview", SITE_URL: "https://preview.example.test" })).toBe(false);
    expect(gate({ FOREVERDB_DEPLOYMENT: "production", FOREVERDB_DATA_SOURCE: "postgres" })).toBe(false);
    expect(gate({ FOREVERDB_DATA_SOURCE: "postgres" })).toBe(false);
    expect(gate({ FOREVERDB_DATA_SOURCE: undefined })).toBe(false);
  });

  it("is refused when a database URL, beta SEO authorization or a non-local site URL is present, and on invalid configuration", () => {
    expect(gate({ AZERDEX_READ_DB_URL: "postgresql://u:p@db.example.com:5432/postgres" })).toBe(false);
    expect(gate({ BETA_SEO_AUTHORIZED_BRANCH: "web/azerdex-beta" })).toBe(false);
    expect(gate({ SITE_URL: "https://beta.azerdex.com" })).toBe(false);
    expect(gate({ SITE_URL: "http://localhost.evil.test" })).toBe(false);
    expect(gate({ SITE_URL: "not a url" })).toBe(false);
  });
});
