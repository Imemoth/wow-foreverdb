import { beforeEach, describe, expect, it, vi } from "vitest";

const meta = vi.fn();
vi.mock("@/lib/data", () => ({ data: () => ({ meta }) }));

import { hasGenuinePublication, isIndexablePublicBetaHomepage, isIndexablePublicBetaHost, isPublicBetaHomepage, isPublicBetaHost, robotsFor } from "@/lib/seo";

/**
 * Pure allow-list logic for the narrowly-scoped public-beta homepage SEO exception (see
 * isPublicBetaHomepage in lib/seo.ts). Every condition is independently
 * required: flipping any single one to false must make the whole check false.
 */

const eligible = { FOREVERDB_DEPLOYMENT: "preview" as const, FOREVERDB_DATA_SOURCE: "postgres" as const, betaSeoBranchAuthorized: true };
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
  it("rejects the synthetic fixture data source", () => {
    expect(isPublicBetaHost({ ...eligible, FOREVERDB_DATA_SOURCE: "fixture" }, HOST)).toBe(false);
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

describe("genuine active publication requirement (async)", () => {
  beforeEach(() => { meta.mockReset(); });
  const published = { mode: "published", publicationId: 10, publishedAt: "2026-10-21T09:45:00Z" };

  it("is true only for a published dataset with an id and a publication time", async () => {
    meta.mockResolvedValue(published);
    expect(await hasGenuinePublication()).toBe(true);
  });
  it("is false for the synthetic sample, a missing publication id/time, and any database failure", async () => {
    meta.mockResolvedValue({ ...published, mode: "synthetic-sample" });
    expect(await hasGenuinePublication()).toBe(false);
    meta.mockResolvedValue({ ...published, publicationId: null });
    expect(await hasGenuinePublication()).toBe(false);
    meta.mockResolvedValue({ ...published, publishedAt: null });
    expect(await hasGenuinePublication()).toBe(false);
    meta.mockImplementation(async () => { throw new Error("public_data_unavailable"); });
    expect(await hasGenuinePublication()).toBe(false);
  });
  it("the indexable host/homepage checks need BOTH the static allow-list and the publication", async () => {
    meta.mockResolvedValue(published);
    expect(await isIndexablePublicBetaHost(eligible, HOST)).toBe(true);
    expect(await isIndexablePublicBetaHomepage(eligible, HOST, "/")).toBe(true);
    expect(await isIndexablePublicBetaHomepage(eligible, HOST, "/zones")).toBe(false);
    expect(await isIndexablePublicBetaHomepage(eligible, "x.vercel.app", "/")).toBe(false);
    meta.mockImplementation(async () => { throw new Error("down"); });
    expect(await isIndexablePublicBetaHost(eligible, HOST)).toBe(false);
    expect(await isIndexablePublicBetaHomepage(eligible, HOST, "/")).toBe(false);
  });
  it("does not even query the database when the static allow-list already fails", async () => {
    await isIndexablePublicBetaHomepage({ ...eligible, betaSeoBranchAuthorized: false }, HOST, "/");
    await isIndexablePublicBetaHost({ ...eligible, FOREVERDB_DATA_SOURCE: "fixture" }, HOST);
    expect(meta).not.toHaveBeenCalled();
  });
});
