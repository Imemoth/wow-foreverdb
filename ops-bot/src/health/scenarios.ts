import { healthySnapshot, ok, withSource } from "./mock-provider";
import type { ProviderResult } from "./provider";

/**
 * Synthetic scenarios for STAGING (HEALTH_PROVIDER=mock, which production refuses). Selected at runtime through the
 * `mock_scenario` row of D1 `monitor_state` (see docs/ops-bot/staging-runbook.md), so no redeploy and no Supabase access is needed.
 * These produce SIMULATED data only; they prove the bot's monitoring, incident and delivery logic, never real Supabase health.
 */
export const SCENARIOS = ["healthy", "source_critical", "g6_stalled", "g6_missing", "g6_inactive", "reporting_down", "stale_snapshot"] as const;
export type Scenario = (typeof SCENARIOS)[number];
export const isScenario = (s: string | null | undefined): s is Scenario => !!s && (SCENARIOS as readonly string[]).includes(s);

export function scenarioResult(name: string | null | undefined, now: number): ProviderResult {
  const base = healthySnapshot(now);
  switch (isScenario(name) ? name : "healthy") {
    case "source_critical": return ok({ ...withSource(base, "blizzard-bluepost-us", { state: "fetch_failing", severity: "critical", causes: ["http_503"], consecutiveFailures: 3 }), g6: { ...base.g6, lastRunStatus: "failed" } });
    case "g6_stalled": { const old = new Date(now - 90 * 60_000).toISOString(); return ok({ ...base, g6: { ...base.g6, lastRunAt: old, lastSucceededAt: old } }); }
    case "g6_missing": return ok({ ...base, g6: { ...base.g6, present: false, active: false } });
    case "g6_inactive": return ok({ ...base, g6: { ...base.g6, active: false } });
    case "reporting_down": return { ok: false, failure: "server", httpStatus: 500 };
    case "stale_snapshot": return ok({ ...base, generatedAt: new Date(now - 45 * 60_000).toISOString() });
    default: return ok(base);
  }
}
