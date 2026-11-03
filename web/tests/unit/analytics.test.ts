import { describe, expect, it } from "vitest";
import { filterAnalyticsEvent, isPublicAnalyticsHost } from "@/lib/analytics";

const event = (url: string) => ({ type: "pageview" as const, url });

describe("Vercel Analytics traffic policy", () => {
  it("only enables the script on public AzerDex hosts", () => {
    expect(isPublicAnalyticsHost("BETA.AZERDEX.COM")).toBe(true);
    expect(isPublicAnalyticsHost("azerdex.com")).toBe(true);
    expect(isPublicAnalyticsHost("www.azerdex.com")).toBe(true);
    expect(isPublicAnalyticsHost("wow-foreverdb-abc.vercel.app")).toBe(false);
  });

  it("counts public beta and production pageviews", () => {
    expect(filterAnalyticsEvent(event("https://beta.azerdex.com/zone/1420"))).toEqual(event("https://beta.azerdex.com/zone/1420"));
    expect(filterAnalyticsEvent(event("https://azerdex.com/database"))).toEqual(event("https://azerdex.com/database"));
    expect(filterAnalyticsEvent(event("https://www.azerdex.com/news"))).toEqual(event("https://www.azerdex.com/news"));
  });

  it("strips search parameters, fragments, and possible tokens", () => {
    const input = { ...event("https://beta.azerdex.com/database?q=secret&token=abc#result"), source: "client" };
    expect(filterAnalyticsEvent(input)).toEqual({ ...input, url: "https://beta.azerdex.com/database" });
  });

  it("does not count generated previews, development, or unrelated hosts", () => {
    for (const host of ["localhost:3000", "wow-foreverdb-abc.vercel.app", "other.azerdex.com", "notazerdex.com"]) {
      expect(filterAnalyticsEvent(event(`https://${host}/database`))).toBeNull();
    }
    expect(filterAnalyticsEvent(event("http://beta.azerdex.com/"))).toBeNull();
  });

  it("excludes account/auth/verification and test harness URLs", () => {
    for (const path of ["/account", "/account/dashboard", "/auth/confirm?token=secret", "/verify", "/test-fixtures/creature-map"]) {
      expect(filterAnalyticsEvent(event(`https://beta.azerdex.com${path}`))).toBeNull();
    }
  });

  it("applies the same privacy rules to Speed Insights Web Vitals", () => {
    const vital = {
      type: "vital" as const,
      url: "https://beta.azerdex.com/database?q=private&token=abc#search",
      route: "/database",
    };
    expect(filterAnalyticsEvent(vital)).toEqual({
      ...vital,
      url: "https://beta.azerdex.com/database",
    });
    expect(filterAnalyticsEvent({ ...vital, url: "https://beta.azerdex.com/account" })).toBeNull();
    expect(filterAnalyticsEvent({ ...vital, url: "https://wow-foreverdb-abc.vercel.app/database" })).toBeNull();
  });

  it("rejects malformed event URLs", () => {
    for (const url of ["/database", "", "javascript:alert(1)", "not a url"]) {
      expect(filterAnalyticsEvent(event(url))).toBeNull();
    }
  });
});
