import { z } from "zod";

/**
 * Health report contract v1: what the protected Supabase reporting endpoint returns.
 * Deliberately narrow: counts, stable codes and timestamps only. `.strict()` everywhere, so an unexpected field
 * (for example anything resembling player or account data) makes the whole report invalid instead of passing through.
 */
export const HEALTH_CONTRACT_VERSION = 1 as const;

const code = z.string().regex(/^[a-z0-9][a-z0-9_:.-]{0,79}$/);
const iso = z.iso.datetime({ offset: true });

export const SourceReportSchema = z.object({
  sourceKey: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  state: code,                                         // e.g. healthy_no_new_content, fetch_failing: free-form code, severity decides
  severity: z.enum(["ok", "info", "warning", "critical"]),
  causes: z.array(code).max(8),
  lastAttemptAt: iso.nullable(),
  lastFetchOkAt: iso.nullable(),
  minutesSinceAttempt: z.number().int().min(0).max(10_000_000).nullable(),
  consecutiveFailures: z.number().int().min(0).max(1_000_000),
  overdueTopics: z.number().int().min(0).max(1_000_000),
}).strict();

export const G6JobReportSchema = z.object({
  jobName: z.literal("azerdex-news-health"),
  present: z.boolean(),
  active: z.boolean(),
  schedule: z.string().max(40).nullable(),
  lastRunAt: iso.nullable(),
  lastRunStatus: z.enum(["succeeded", "failed", "running", "unknown"]).nullable(),
  lastSucceededAt: iso.nullable(),
}).strict();

export const HealthSnapshotSchema = z.object({
  schemaVersion: z.literal(HEALTH_CONTRACT_VERSION),
  generatedAt: iso,
  overall: z.enum(["ok", "info", "warning", "critical"]),   // informational only: decisions use per-source severity
  sources: z.array(SourceReportSchema).min(1).max(16),
  g6: G6JobReportSchema,
}).strict();

export type SourceReport = z.infer<typeof SourceReportSchema>;
export type G6JobReport = z.infer<typeof G6JobReportSchema>;
export type HealthSnapshot = z.infer<typeof HealthSnapshotSchema>;

export type ParseOutcome = { ok: true; snapshot: HealthSnapshot } | { ok: false; paths: string[] };

/** Never echoes values: only the JSON paths of the violations, so a malformed report cannot leak content into logs. */
export function parseHealthSnapshot(raw: unknown): ParseOutcome {
  const r = HealthSnapshotSchema.safeParse(raw);
  if (r.success) return { ok: true, snapshot: r.data };
  return { ok: false, paths: [...new Set(r.error.issues.map((i) => i.path.join(".") || "(root)"))].slice(0, 10) };
}
