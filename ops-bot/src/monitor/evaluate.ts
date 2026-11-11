import type { Config, Tuning } from "../config";
import type { HealthSnapshot } from "../health/contract";
import type { ProviderFailureClass } from "../health/provider";

export type FindingState = "HEALTHY" | "WARNING" | "CRITICAL" | "UNKNOWN";
export type ContextValue = string | number | boolean | null;
export interface Finding { component: string; state: FindingState; reasonCode: string; summary: string; context: Record<string, ContextValue> }

export const COMPONENT_REPORTING = "supabase:reporting";
export const COMPONENT_G6 = "g6:job";
export const COMPONENT_SCHEDULE = "bot:schedule";
export const sourceComponent = (key: string) => `source:${key}`;

const minutesAgo = (iso: string | null, now: number): number | null => (iso ? Math.round((now - Date.parse(iso)) / 60_000) : null);

/**
 * Pure classification of a validated snapshot. The per-source `severity` computed by the existing G2 function is
 * authoritative; this layer adds what G2 cannot know about itself: a missing source, and the state of the G6 job.
 * `healthy_no_new_content` (severity ok) is NEVER a failure.
 */
export function evaluateSnapshot(s: HealthSnapshot, now: number, cfg: Pick<Config, "expectedSourceKeys"> & { tuning: Tuning }): Finding[] {
  const out: Finding[] = [];
  const t = cfg.tuning;
  let anyCriticalSource = false;

  for (const src of s.sources) {
    const component = sourceComponent(src.sourceKey);
    if (src.severity === "critical") {
      anyCriticalSource = true;
      out.push({ component, state: "CRITICAL", reasonCode: src.state, summary: `${src.sourceKey}: ${src.state}`,
        context: { cause: src.causes[0] ?? null, consecutiveFailures: src.consecutiveFailures, minutesSinceAttempt: src.minutesSinceAttempt, overdueTopics: src.overdueTopics, lastFetchOkAt: src.lastFetchOkAt } });
    } else if (src.severity === "warning") {
      out.push({ component, state: "WARNING", reasonCode: src.state, summary: `${src.sourceKey}: ${src.state}`, context: { cause: src.causes[0] ?? null, overdueTopics: src.overdueTopics } });
    } else {
      out.push({ component, state: "HEALTHY", reasonCode: src.state, summary: `${src.sourceKey}: ${src.state}`, context: {} });
    }
  }

  // A source that is expected but absent from the report is a blind spot, not a green light.
  const reported = new Set(s.sources.map((x) => x.sourceKey));
  for (const key of cfg.expectedSourceKeys) {
    if (!reported.has(key)) {
      anyCriticalSource = true;
      out.push({ component: sourceComponent(key), state: "CRITICAL", reasonCode: "source_missing_from_report", summary: `${key}: absent from the health report`, context: {} });
    }
  }

  // G6: the scheduled assertion job. It fails BY DESIGN while a source is critical; that is explained, not a second incident.
  const g = s.g6;
  const lastRunMin = minutesAgo(g.lastRunAt, now);
  const g6 = (state: FindingState, reasonCode: string, summary: string, context: Record<string, ContextValue> = {}): void => {
    out.push({ component: COMPONENT_G6, state, reasonCode, summary, context });
  };
  if (!g.present) g6("CRITICAL", "g6_job_missing", "Health-check job azerdex-news-health no longer exists");
  else if (!g.active) g6("CRITICAL", "g6_job_inactive", "Health-check job azerdex-news-health is inactive", { schedule: g.schedule });
  else if (g.lastRunAt === null) g6("WARNING", "g6_never_ran", "Health-check job has not run yet");
  else if (lastRunMin !== null && lastRunMin > t.g6StaleAfterMinutes) g6("CRITICAL", "g6_schedule_stalled", "Expected health-check executions stopped arriving", { minutesSinceLastRun: lastRunMin, expectedEveryMinutes: t.g6ExpectedIntervalMinutes });
  else if (g.lastRunStatus === "failed") {
    if (anyCriticalSource) g6("WARNING", "g6_run_failed_explained_by_source", "Latest health-check run failed because a source is critical (tracked in that source's incident)");
    else g6("CRITICAL", "g6_run_failed_unexplained", "Latest health-check run failed while no source is critical", { lastRunAt: g.lastRunAt });
  } else g6("HEALTHY", "g6_ok", "Health-check job is running on schedule", { minutesSinceLastRun: lastRunMin });

  return out;
}

/** Snapshot freshness: a stale or future-dated report is treated as a reporting failure, never as health. */
export function checkFreshness(s: HealthSnapshot, now: number, t: Tuning): "ok" | "stale" {
  const gen = Date.parse(s.generatedAt);
  if (Number.isNaN(gen)) return "stale";
  if (now - gen > t.snapshotMaxAgeSeconds * 1000) return "stale";
  if (gen - now > t.snapshotFutureSkewSeconds * 1000) return "stale";
  return "ok";
}

/**
 * Monitor-degraded policy: below the threshold the reporting component is UNKNOWN (visible in /status, no page and no
 * state change to real incidents); at/over it becomes CRITICAL ("the bot cannot see Supabase"), which is distinct from any source incident.
 */
export function evaluateReporting(failure: ProviderFailureClass | null, consecutiveFailures: number, t: Tuning, httpStatus?: number): Finding {
  if (failure === null) return { component: COMPONENT_REPORTING, state: "HEALTHY", reasonCode: "reporting_ok", summary: "Health reporting endpoint reachable and valid", context: {} };
  const threshold = failure === "auth" ? t.authFailureThreshold : t.providerFailureThreshold;
  const context: Record<string, ContextValue> = { failureClass: failure, httpStatus: httpStatus ?? null, consecutiveFailures };
  if (consecutiveFailures >= threshold) {
    return { component: COMPONENT_REPORTING, state: "CRITICAL", reasonCode: `reporting_unavailable_${failure}`, summary: `Health reporting unavailable (${failure}); AzerDex health is UNKNOWN`, context };
  }
  return { component: COMPONENT_REPORTING, state: "UNKNOWN", reasonCode: `reporting_failed_${failure}`, summary: `Health reporting failed (${failure}), retrying`, context };
}

export function evaluateSchedule(gapMinutes: number | null, t: Tuning): Finding {
  if (gapMinutes !== null && gapMinutes > t.cronGapMinutes) {
    return { component: COMPONENT_SCHEDULE, state: "CRITICAL", reasonCode: "cron_gap", summary: "The bot's own scheduled monitoring cycles were missed", context: { gapMinutes, thresholdMinutes: t.cronGapMinutes } };
  }
  return { component: COMPONENT_SCHEDULE, state: "HEALTHY", reasonCode: "cron_ok", summary: "Monitoring cycles on schedule", context: {} };
}
