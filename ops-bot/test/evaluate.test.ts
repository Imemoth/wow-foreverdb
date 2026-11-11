import { describe, expect, it } from "vitest";
import { DEFAULT_TUNING } from "../src/config";
import { checkFreshness, COMPONENT_G6, evaluateReporting, evaluateSchedule, evaluateSnapshot } from "../src/monitor/evaluate";
import { healthySnapshot, withSource } from "../src/health/mock-provider";
import { T0, testConfig } from "./helpers/fakes";

const cfg = testConfig();
const find = (fs: ReturnType<typeof evaluateSnapshot>, c: string) => fs.find((f) => f.component === c)!;
const g6 = (over: object) => ({ ...healthySnapshot(T0).g6, ...over });

describe("snapshot evaluation", () => {
  it("healthy_no_new_content is HEALTHY for every source and never a failure", () => {
    const fs = evaluateSnapshot(healthySnapshot(T0), T0, cfg);
    expect(fs.filter((f) => f.state !== "HEALTHY")).toEqual([]);
    expect(find(fs, "source:blizzard-bluepost-us").reasonCode).toBe("healthy_no_new_content");
  });

  it("info severity (all_rejected) is HEALTHY; warning is WARNING (logged, never an incident)", () => {
    const base = healthySnapshot(T0);
    expect(find(evaluateSnapshot(withSource(base, "blizzard-bluepost-eu", { state: "all_rejected", severity: "info" }), T0, cfg), "source:blizzard-bluepost-eu").state).toBe("HEALTHY");
    expect(find(evaluateSnapshot(withSource(base, "blizzard-bluepost-eu", { state: "display_gap", severity: "warning" }), T0, cfg), "source:blizzard-bluepost-eu").state).toBe("WARNING");
  });

  it("a G2 critical source is CRITICAL with a stable reason code", () => {
    const s = withSource(healthySnapshot(T0), "blizzard-bluepost-us", { state: "fetch_failing", severity: "critical", causes: ["http_503"], consecutiveFailures: 3 });
    const f = find(evaluateSnapshot(s, T0, cfg), "source:blizzard-bluepost-us");
    expect(f).toMatchObject({ state: "CRITICAL", reasonCode: "fetch_failing" });
    expect(f.context.cause).toBe("http_503");
  });

  it("an expected source missing from the report is CRITICAL (blind spot, not green)", () => {
    const s = healthySnapshot(T0);
    const f = find(evaluateSnapshot({ ...s, sources: s.sources.filter((x) => x.sourceKey !== "blizzard-news-us") }, T0, cfg), "source:blizzard-news-us");
    expect(f).toMatchObject({ state: "CRITICAL", reasonCode: "source_missing_from_report" });
  });

  it("the report's own `overall` field is informational only", () => {
    const fs = evaluateSnapshot({ ...healthySnapshot(T0), overall: "critical" }, T0, cfg);
    expect(fs.every((f) => f.state === "HEALTHY")).toBe(true);
  });
});

describe("G6 job evaluation", () => {
  it("healthy job on schedule", () => expect(find(evaluateSnapshot(healthySnapshot(T0), T0, cfg), COMPONENT_G6).state).toBe("HEALTHY"));
  it("job missing -> CRITICAL", () => expect(find(evaluateSnapshot(healthySnapshot(T0, { g6: g6({ present: false, active: false }) }), T0, cfg), COMPONENT_G6)).toMatchObject({ state: "CRITICAL", reasonCode: "g6_job_missing" }));
  it("job inactive -> CRITICAL", () => expect(find(evaluateSnapshot(healthySnapshot(T0, { g6: g6({ active: false }) }), T0, cfg), COMPONENT_G6)).toMatchObject({ state: "CRITICAL", reasonCode: "g6_job_inactive" }));
  it("expected executions stopped arriving -> CRITICAL", () => {
    const old = new Date(T0 - 60 * 60_000).toISOString();
    expect(find(evaluateSnapshot(healthySnapshot(T0, { g6: g6({ lastRunAt: old, lastSucceededAt: old }) }), T0, cfg), COMPONENT_G6)).toMatchObject({ state: "CRITICAL", reasonCode: "g6_schedule_stalled" });
  });
  it("one slow run inside the tolerance is NOT a stall", () => {
    const t = new Date(T0 - 30 * 60_000).toISOString();
    expect(find(evaluateSnapshot(healthySnapshot(T0, { g6: g6({ lastRunAt: t }) }), T0, cfg), COMPONENT_G6).state).toBe("HEALTHY");
  });
  it("failed run while a source is critical is EXPLAINED (WARNING), not a second incident", () => {
    const s = withSource(healthySnapshot(T0, { g6: g6({ lastRunStatus: "failed" }) }), "blizzard-bluepost-us", { state: "collector_stopped", severity: "critical", causes: ["scheduler_not_running"] });
    expect(find(evaluateSnapshot(s, T0, cfg), COMPONENT_G6)).toMatchObject({ state: "WARNING", reasonCode: "g6_run_failed_explained_by_source" });
  });
  it("failed run while every source is healthy is CRITICAL (unexplained)", () => {
    expect(find(evaluateSnapshot(healthySnapshot(T0, { g6: g6({ lastRunStatus: "failed" }) }), T0, cfg), COMPONENT_G6)).toMatchObject({ state: "CRITICAL", reasonCode: "g6_run_failed_unexplained" });
  });
  it("never-ran job is only a WARNING", () => expect(find(evaluateSnapshot(healthySnapshot(T0, { g6: g6({ lastRunAt: null, lastRunStatus: null, lastSucceededAt: null }) }), T0, cfg), COMPONENT_G6).state).toBe("WARNING"));
});

describe("freshness and reporting policy", () => {
  it("stale or future-dated snapshots are rejected, fresh ones accepted", () => {
    const t = DEFAULT_TUNING;
    expect(checkFreshness(healthySnapshot(T0), T0, t)).toBe("ok");
    expect(checkFreshness(healthySnapshot(T0, { generatedAt: new Date(T0 - 11 * 60_000).toISOString() }), T0, t)).toBe("stale");
    expect(checkFreshness(healthySnapshot(T0, { generatedAt: new Date(T0 + 10 * 60_000).toISOString() }), T0, t)).toBe("stale");
  });
  it("reporting failure is UNKNOWN below the threshold and CRITICAL at it; auth escalates sooner", () => {
    const t = DEFAULT_TUNING;
    expect(evaluateReporting("server", 1, t).state).toBe("UNKNOWN");
    expect(evaluateReporting("server", 2, t).state).toBe("UNKNOWN");
    expect(evaluateReporting("server", 3, t)).toMatchObject({ state: "CRITICAL", reasonCode: "reporting_unavailable_server" });
    expect(evaluateReporting("auth", 1, t, 401).state).toBe("UNKNOWN");
    expect(evaluateReporting("auth", 2, t, 401).state).toBe("CRITICAL");
    expect(evaluateReporting(null, 0, t).state).toBe("HEALTHY");
  });
  it("schedule gap beyond the threshold is CRITICAL; a null (first run) gap is healthy", () => {
    expect(evaluateSchedule(null, DEFAULT_TUNING).state).toBe("HEALTHY");
    expect(evaluateSchedule(5, DEFAULT_TUNING).state).toBe("HEALTHY");
    expect(evaluateSchedule(45, DEFAULT_TUNING)).toMatchObject({ state: "CRITICAL", reasonCode: "cron_gap" });
  });
});
