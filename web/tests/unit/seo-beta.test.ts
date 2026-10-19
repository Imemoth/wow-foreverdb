import { describe, expect, it } from "vitest";
import { isPublicBetaHomepage, isPublicBetaHost, robotsFor } from "@/lib/seo";

/**
 * Pure allow-list logic for the narrowly-scoped public-beta homepage SEO exception (see
 * isPublicBetaHomepage in lib/seo.ts). Every one of the five conditions is independently
 * required: flipping any single one to false must make the whole check false.
 */

const eligible = { FOREVERDB_DEPLOYMENT: "preview" as const, FOREVERDB_DATA_SOURCE: "fixture" as const, betaSeoBranchAuthorized: true };
const HOST = "beta.azerdex.com";

describe("isPublicBetaHost: hostname/mode/data-source/branch, independently required", () => {
  it("is true only when every condition holds", () => {
    expect(isPublicBetaHost(eligible, HOST)).toBe(true);
  });
  it("is case-insensitive on the hostname", () => {
    expect(isPublicBetaHost(eligible, "BETA.AZERDEX.COM")).toBe(true);
  });
  it("rejects any other hostname, including generated Preview aliases", () => {
    expect(isPublicBetaHost(eligible, "wow-foreverdb-git-web-azerdex-beta-imemoths-projects.vercel.app")).toBe(false);
    expect(isPublicBetaHost(eligible, "wow-foreverdb.vercel.app")).toBe(false);
    expect(isPublicBetaHost(eligible, "azerdex.com")).toBe(false);
    expect(isPublicBetaHost(eligible, "")).toBe(false);
  });
  it("rejects production and local deployment modes even on the right host", () => {
    expect(isPublicBetaHost({ ...eligible, FOREVERDB_DEPLOYMENT: "production" }, HOST)).toBe(false);
    expect(isPublicBetaHost({ ...eligible, FOREVERDB_DEPLOYMENT: "local" }, HOST)).toBe(false);
  });
  it("rejects a non-fixture (postgres) data source", () => {
    expect(isPublicBetaHost({ ...eligible, FOREVERDB_DATA_SOURCE: "postgres" }, HOST)).toBe(false);
  });
  it("rejects an unauthorized (or wrong-branch) deployment", () => {
    expect(isPublicBetaHost({ ...eligible, betaSeoBranchAuthorized: false }, HOST)).toBe(false);
  });
});

describe("isPublicBetaHomepage: adds the exact path condition", () => {
  it("is true only for the exact root path", () => {
    expect(isPublicBetaHomepage(eligible, HOST, "/")).toBe(true);
  });
  it("rejects every other beta page: database, zones, entities, APIs, verify, account", () => {
    for (const p of ["/database", "/zones", "/zone/1420", "/item/2770", "/creature/1554", "/api/v1/meta", "/verify", "/account", "/about/data"]) {
      expect(isPublicBetaHomepage(eligible, HOST, p), p).toBe(false);
    }
  });
  it("still requires every isPublicBetaHost condition in addition to the path", () => {
    expect(isPublicBetaHomepage({ ...eligible, betaSeoBranchAuthorized: false }, HOST, "/")).toBe(false);
    expect(isPublicBetaHomepage(eligible, "wow-foreverdb-abc.vercel.app", "/")).toBe(false);
    expect(isPublicBetaHomepage({ ...eligible, FOREVERDB_DEPLOYMENT: "production" }, HOST, "/")).toBe(false);
  });
});

describe("robotsFor: the beta override short-circuits before the thin-content policy", () => {
  it("indexes whenever the betaHomepage flag is explicitly passed, regardless of the indexable arg", () => {
    expect(robotsFor(false, true)).toEqual({ index: true, follow: true });
    expect(robotsFor(true, true)).toEqual({ index: true, follow: true });
  });
});
