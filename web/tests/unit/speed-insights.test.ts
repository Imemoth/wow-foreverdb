import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { speedInsightsEnabled } from "@/lib/speed-insights";

const layout = readFileSync(resolve(__dirname, "../../src/app/layout.tsx"), "utf8");

describe("Speed Insights opt-in (cost control)", () => {
  it("is off unless AZERDEX_SPEED_INSIGHTS is exactly 1", () => {
    expect(speedInsightsEnabled({})).toBe(false);
    for (const v of ["", "0", "true", "yes", "on", "1 ", " 1", "2"]) expect(speedInsightsEnabled({ AZERDEX_SPEED_INSIGHTS: v })).toBe(false);
    expect(speedInsightsEnabled({ AZERDEX_SPEED_INSIGHTS: "1" })).toBe(true);
  });

  it("the layout renders the script only behind the switch, so a disabled service is never requested", () => {
    expect(layout).toContain("{speedInsightsEnabled() && <TrafficSpeedInsights />}");
    // exactly one reference to the component outside the import: nothing renders it unconditionally
    expect(layout.match(/<TrafficSpeedInsights/g)).toHaveLength(1);
  });

  it("Web Analytics stays unconditional on the public hosts", () => {
    expect(layout).toMatch(/env\.hosted && isPublicAnalyticsHost\(hostname\) && \(\s*<>\s*<TrafficAnalytics \/>/);
  });
});
