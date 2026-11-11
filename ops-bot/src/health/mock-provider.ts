import type { HealthSnapshot, SourceReport } from "./contract";
import type { HealthProvider, ProviderResult } from "./provider";

/** Scripted provider for tests and for staging without any Supabase access. */
export class MockHealthProvider implements HealthProvider {
  calls = 0;
  private queue: Array<ProviderResult | (() => ProviderResult | Promise<ProviderResult>)> = [];
  constructor(private fallback: ProviderResult | (() => ProviderResult | Promise<ProviderResult>)) {}
  enqueue(...r: Array<ProviderResult | (() => ProviderResult | Promise<ProviderResult>)>): this { this.queue.push(...r); return this; }
  setFallback(f: ProviderResult | (() => ProviderResult | Promise<ProviderResult>)): this { this.fallback = f; return this; }
  async fetchSnapshot(): Promise<ProviderResult> {
    this.calls++;
    const next = this.queue.shift() ?? this.fallback;
    return typeof next === "function" ? next() : next;
  }
}

export const SOURCE_KEYS = ["blizzard-bluepost-us", "blizzard-bluepost-eu", "blizzard-news-us"] as const;

export function healthySource(sourceKey: string, now: number): SourceReport {
  const t = new Date(now - 4 * 60_000).toISOString();
  return { sourceKey, state: "healthy_no_new_content", severity: "ok", causes: [], lastAttemptAt: t, lastFetchOkAt: t, minutesSinceAttempt: 4, consecutiveFailures: 0, overdueTopics: 0 };
}

export function healthySnapshot(now: number, over: Partial<HealthSnapshot> = {}): HealthSnapshot {
  return {
    schemaVersion: 1,
    generatedAt: new Date(now - 30_000).toISOString(),
    overall: "ok",
    sources: SOURCE_KEYS.map((k) => healthySource(k, now)),
    g6: { jobName: "azerdex-news-health", present: true, active: true, schedule: "*/15 * * * *", lastRunAt: new Date(now - 6 * 60_000).toISOString(), lastRunStatus: "succeeded", lastSucceededAt: new Date(now - 6 * 60_000).toISOString() },
    ...over,
  };
}

export function withSource(snapshot: HealthSnapshot, sourceKey: string, patch: Partial<SourceReport>): HealthSnapshot {
  return { ...snapshot, sources: snapshot.sources.map((s) => (s.sourceKey === sourceKey ? { ...s, ...patch } : s)) };
}

export const ok = (snapshot: HealthSnapshot): ProviderResult => ({ ok: true, snapshot });
