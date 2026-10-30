import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { speedInsightsEnabled } from "@/lib/speed-insights";

const read = (p: string) => readFileSync(resolve(__dirname, "../..", p), "utf8");
const layout = read("src/app/layout.tsx");
const manager = read("src/components/consent/ConsentManager.tsx");

describe("Speed Insights opt-in (cost control and consent)", () => {
  it("is off unless AZERDEX_SPEED_INSIGHTS is exactly 1", () => {
    expect(speedInsightsEnabled({})).toBe(false);
    for (const v of ["", "0", "true", "yes", "on", "1 ", " 1", "2"]) expect(speedInsightsEnabled({ AZERDEX_SPEED_INSIGHTS: v })).toBe(false);
    expect(speedInsightsEnabled({ AZERDEX_SPEED_INSIGHTS: "1" })).toBe(true);
  });

  it("the layout only offers Speed Insights behind the switch (and the public-host rule), and never renders the script itself", () => {
    expect(layout).toContain("speedInsightsAvailable={analyticsAvailable && speedInsightsEnabled()}");
    expect(layout).not.toMatch(/<TrafficSpeedInsights/);
  });

  it("the script component exists only inside ConsentManager, behind the switch AND an affirmative analytics choice", () => {
    expect(manager.match(/<TrafficSpeedInsights/g)).toHaveLength(1);
    expect(manager).toContain("{granted && speedInsightsAvailable && <TrafficSpeedInsights />}");
  });

  it("Web Analytics is no longer unconditional: only ConsentManager renders it, after consent, on the public hosts", () => {
    expect(layout).not.toMatch(/<TrafficAnalytics/);
    expect(layout).toMatch(/const analyticsAvailable = \(env\.hosted && isPublicAnalyticsHost\(hostname\)\) \|\| e2eFixturesAllowed\(\);/);
    expect(manager.match(/<TrafficAnalytics/g)).toHaveLength(1);
    expect(manager).toContain("{granted && analyticsAvailable && <TrafficAnalytics />}");
  });
});
