import { describe, expect, it } from "vitest";
import { SCENARIOS, isScenario, scenarioResult } from "../src/health/scenarios";
import { evaluateSnapshot } from "../src/monitor/evaluate";
import { harness } from "./helpers/harness";
import { T0, testConfig } from "./helpers/fakes";
import { MockHealthProvider } from "../src/health/mock-provider";
import { setState } from "../src/monitor/cycle";

describe("staging synthetic scenarios (SIMULATED data, not Supabase evidence)", () => {
  it("every scenario is a valid contract snapshot or a classified reporting failure", () => {
    for (const s of SCENARIOS) {
      const r = scenarioResult(s, T0);
      expect(r.ok || ["server"].includes(r.failure)).toBe(true);
    }
    expect(isScenario("nope")).toBe(false); expect(isScenario(null)).toBe(false);
  });
  it.each([
    ["healthy", []],
    ["source_critical", ["source:blizzard-bluepost-us"]],
    ["g6_stalled", ["g6:job"]],
    ["g6_missing", ["g6:job"]],
    ["g6_inactive", ["g6:job"]],
  ] as const)("%s produces exactly the expected CRITICAL components", (name, expected) => {
    const r = scenarioResult(name, T0);
    if (!r.ok) throw new Error("unexpected failure");
    expect(evaluateSnapshot(r.snapshot, T0, testConfig()).filter((f) => f.state === "CRITICAL").map((f) => f.component)).toEqual(expected);
  });
  it("an unknown scenario name falls back to healthy (never to a fault)", () => {
    expect(scenarioResult("garbage", T0).ok).toBe(true);
  });
  it("the D1-selected scenario drives a full cycle: set -> alert once; clear -> recovery", async () => {
    const h = await harness();
    h.deps.provider = new MockHealthProvider(async () => scenarioResult((await (await import("../src/monitor/cycle")).getState(h.db, "mock_scenario")), h.clock.now()));
    await setState(h.db, "mock_scenario", "source_critical", h.clock.now());
    await h.cycle(); h.clock.minutes(5); await h.cycle();
    expect(h.discord.creates).toHaveLength(1);
    await setState(h.db, "mock_scenario", "healthy", h.clock.now());
    h.clock.minutes(5); await h.cycle(); h.clock.minutes(5); await h.cycle();
    expect(h.discord.creates).toHaveLength(2);
    expect(h.db.rows<{ status: string }>("select status from incidents")[0]!.status).toBe("RESOLVED");
  });
});
