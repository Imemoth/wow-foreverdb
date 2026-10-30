import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PrivacyContent } from "@/components/PrivacyContent";
import { CSRF_TTL_SEC } from "@/lib/account/csrf";
import { RECOVERY_SESSION_MAX_SEC, SESSION_ABSOLUTE_MAX_SEC, SESSION_COOKIE_MAX_AGE_SEC, cookieNames } from "@/lib/account/session";
import { filterAnalyticsEvent, isPublicAnalyticsHost } from "@/lib/analytics";
import { speedInsightsEnabled } from "@/lib/speed-insights";

const root = resolve(__dirname, "../..");
const src = (p: string) => readFileSync(resolve(root, p), "utf8");
const text = (speedInsights: boolean) =>
  renderToStaticMarkup(createElement(PrivacyContent, { speedInsights })).replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ");

describe("privacy page: the disclosure matches the implementation", () => {
  it("no longer claims there are no accounts, no analytics, or no personal data", () => {
    for (const on of [true, false]) {
      const t = text(on);
      expect(t).not.toMatch(/has no accounts/i);
      expect(t).not.toMatch(/no third-party analytics/i);
      expect(t).not.toMatch(/no personal data|does not process (any )?personal/i);
      expect(t).toMatch(/Accounts/);
      expect(t).toMatch(/Some personal data is processed/);
    }
  });

  it("names every cookie the code sets, with the lifetimes the code uses", () => {
    const t = text(false);
    // Account cookies: names and lifetimes come from the real constants.
    const { session, csrf } = cookieNames(true);
    expect(t).toContain(session);
    expect(t).toContain(csrf);
    expect(SESSION_COOKIE_MAX_AGE_SEC).toBe(14 * 86400);
    expect(SESSION_ABSOLUTE_MAX_SEC).toBe(30 * 86400);
    expect(RECOVERY_SESSION_MAX_SEC).toBe(15 * 60);
    expect(CSRF_TTL_SEC).toBe(3600);
    expect(t).toMatch(/14 days/);
    expect(t).toMatch(/30 days in total/);
    expect(t).toMatch(/recovery session lasts 15 minutes/);
    expect(t).toMatch(/expires after 1 hour/);
    // Anonymous rate-limit cookie and the human-verification pass: pinned to their source.
    expect(src("src/proxy.ts")).toContain('"__Host-fdb_sid"');
    expect(src("src/proxy.ts")).toMatch(/maxAge: 60 \* 60 \* 24 \* 30/);
    expect(t).toContain("__Host-fdb_sid");
    expect(src("src/app/api/v1/challenge/route.ts")).toMatch(/"fdb_pass"[\s\S]*maxAge: 1800/);
    expect(t).toContain("fdb_pass");
    expect(t).toMatch(/30 days/);
    expect(t).toMatch(/30 minutes/);
  });

  it("every cookie the application sets is listed (no undisclosed cookie)", () => {
    const setters = ["src/proxy.ts", "src/app/api/v1/challenge/route.ts", "src/lib/account/session.ts", "src/app/account/api/csrf/route.ts"];
    expect(setters.every((p) => /cookies\.set|setCookie|Set-Cookie/.test(src(p)))).toBe(true);
    // Anything else under src that sets a cookie would be a new, undisclosed one.
    const out = execFileSync("grep", ["-rlE", "cookies\\.set\\(|\\.cookies\\.set|setCookie\\(", "src"], { cwd: root, encoding: "utf8" });
    const files = out.split("\n").filter(Boolean).sort();
    expect(files).toEqual([
      "src/app/account/api/csrf/route.ts",
      "src/app/api/v1/challenge/route.ts",
      "src/lib/account/session.ts",
      "src/proxy.ts",
    ]);
  });

  it("describes browser storage and third-party services that the code uses", () => {
    const t = text(false);
    expect(t).toContain("azerdex-hero-theme");
    expect(src("src/components/hero/themes.ts")).toContain('"azerdex-hero-theme"');
    for (const name of ["Supabase", "Resend", "Cloudflare", "Vercel Web Analytics"]) expect(t).toContain(name);
    expect(src("src/lib/support-link.ts")).toContain("buymeacoffee.com");
    expect(t).toContain("Buy Me a Coffee");
  });

  it("keeps the existing abuse-protection and aggregated game-data explanations", () => {
    const t = text(false);
    expect(t).toContain("request counters are kept per network address and per session for a few minutes");
    expect(t).toContain("Addresses are stored only as keyed hashes in those short-lived counters, and are not written to our logs");
    expect(t).toContain("Published database statistics are aggregates");
    expect(t).toContain("installation identifiers, character names, Guildbook rosters or account information");
  });

  it("does not overstate retention: only the documented 7 and 180 day rules", () => {
    const t = text(false);
    expect(t).toMatch(/7 days/);
    expect(t).toMatch(/180 days/);
    expect(t).toMatch(/link itself is kept while the installation stays linked/);
  });
});

describe("privacy page: analytics disclosure matches the configuration", () => {
  it("states the public-route-only and URL-redaction behavior that filterAnalyticsEvent really enforces", () => {
    const t = text(false);
    expect(t).toMatch(/Account, sign-in, verification and test pages are excluded/);
    expect(t).toMatch(/query string and the fragment are removed/);
    const ev = (url: string) => ({ type: "pageview" as const, url });
    // exclusion of account/auth/verification/test pages
    for (const p of ["/account", "/account/login", "/auth/confirm?token=x", "/verify", "/test-fixtures/x"]) {
      expect(filterAnalyticsEvent(ev(`https://azerdex.com${p}`))).toBeNull();
    }
    // query + fragment removed
    expect(filterAnalyticsEvent(ev("https://azerdex.com/database?q=secret&token=t#frag"))?.url).toBe("https://azerdex.com/database");
    // public hosts only
    expect(isPublicAnalyticsHost("azerdex.com")).toBe(true);
    expect(isPublicAnalyticsHost("abc.vercel.app")).toBe(false);
    expect(filterAnalyticsEvent(ev("https://abc.vercel.app/"))).toBeNull();
  });

  it("both Vercel scripts use the same filter and only render on public hosts", () => {
    expect(src("src/components/TrafficAnalytics.tsx")).toContain("beforeSend={filterAnalyticsEvent}");
    expect(src("src/components/TrafficSpeedInsights.tsx")).toContain("beforeSend={filterAnalyticsEvent}");
    const layout = src("src/app/layout.tsx");
    expect(layout).toMatch(/env\.hosted && isPublicAnalyticsHost\(hostname\)/);
  });

  it("Speed Insights is described as enabled only when it is enabled, and disabled by default", () => {
    expect(text(true)).toContain("Vercel Speed Insights is enabled");
    expect(text(false)).toContain("Vercel Speed Insights performance measurement is not enabled on this site");
    expect(text(false)).not.toMatch(/Speed Insights is enabled/);
    expect(speedInsightsEnabled({})).toBe(false);
    expect(speedInsightsEnabled({ AZERDEX_SPEED_INSIGHTS: "1" })).toBe(true);
    // The page text follows the very same switch the layout uses.
    expect(src("src/app/about/privacy/page.tsx")).toContain("speedInsights={speedInsightsEnabled()}");
  });
});
