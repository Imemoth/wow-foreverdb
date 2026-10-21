/**
 * One publication run, end to end (private export -> projection -> public write -> run log).
 *
 * Runtime-neutral: the Node CLI and the Supabase Edge Function both call `runPublication` with their own
 * connection openers. Nothing here logs row values; `log` receives counts, timings and reason codes only.
 *
 * Modes
 *   publish   build, write, validate, activate (commit)                       -> activated | duplicate | skipped_busy | failed
 *   dry_run   build + validate only; compares with the active publication; NOTHING is written to the public DB
 *   rehearse  the full write path including finalize/activation, then ROLLBACK -> rehearsal_ok | failed (persists nothing)
 */
import type { PublicationConfig } from "./contract.ts";
import { buildProjection, PublicationError } from "./project.ts";
import {
  acquireLease,
  counting,
  readPrivateExport,
  recordRun,
  releaseLease,
  writePublication,
  type ClosableSqlClient,
  type RunRecord,
} from "./sql.ts";
import { syntheticExport } from "./synthetic.ts";

export type RunMode = "publish" | "dry_run" | "rehearse";
export type RunTrigger = "cron" | "manual" | "cli" | "benchmark";

export interface RunRequest {
  mode: RunMode;
  trigger: RunTrigger;
  source: "private" | "synthetic";
  scale?: number;
  allowShrink?: boolean;
}

export interface RunDeps {
  config: PublicationConfig;
  workerVersion: string;
  /** Read-only export identity. Absent => `private_export_not_configured`. */
  openPrivate: (() => Promise<ClosableSqlClient>) | null;
  openPublic: () => Promise<ClosableSqlClient>;
  /** An already-parsed export (CLI --from-export). Takes the place of the private read. */
  fileExport?: unknown;
  /** SET LOCAL ROLE target for the public connection (Edge). Null for a dedicated login (CLI). */
  publicRole: string | null;
  log: (event: string, data?: Record<string, unknown>) => void;
  now?: () => number;
  /** Optional platform telemetry; return null when unavailable (never fabricate). */
  cpuMs?: () => number | null;
  memory?: () => { rssMB: number; heapUsedMB: number } | null;
  runtime: string;
  wallBudgetMs?: number;
  leaseTtlSeconds?: number;
}

export interface RunSummary {
  ok: boolean;
  outcome: "activated" | "duplicate" | "skipped_busy" | "failed" | "dry_run_ok" | "rehearsal_ok";
  mode: RunMode;
  trigger: RunTrigger;
  source: "private" | "synthetic";
  publicationId: number | null;
  wouldBe?: "activated" | "duplicate";
  errorClass: string | null;
  runId: number | null;
  sha256: string | null;
  input: Record<string, number>;
  output: Record<string, number>;
  metrics: Record<string, unknown>;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

function errorClassOf(e: unknown): { cls: string; detail: Record<string, unknown> } {
  if (e instanceof PublicationError) return { cls: e.message, detail: e.detail };
  const code = (e as { code?: string }).code;
  const raw = e instanceof Error ? e.message : "unknown";
  // Message class only: strip connection strings; PostgreSQL messages from pub_admin carry counts, not row values.
  const msg = raw.replace(/postgres(ql)?:\/\/\S+/g, "postgres://[redacted]").slice(0, 200);
  if (msg === "wall_budget_exceeded") return { cls: "wall_budget_exceeded", detail: {} };
  return { cls: code ? `db_error_${code}` : "error", detail: { message: msg } };
}

export async function runPublication(deps: RunDeps, req: RunRequest): Promise<RunSummary> {
  const now = deps.now ?? (() => performance.now());
  const startedAt = now();
  const startedIso = new Date().toISOString();
  const holder = `${deps.runtime}-${crypto.randomUUID()}`;
  const metrics: Record<string, unknown> = { runtime: deps.runtime, workerVersion: deps.workerVersion };
  const cpu0 = deps.cpuMs?.() ?? null;
  let peakRss = 0;
  let peakHeap = 0;
  const sample = () => {
    const m = deps.memory?.();
    if (m) {
      peakRss = Math.max(peakRss, m.rssMB);
      peakHeap = Math.max(peakHeap, m.heapUsedMB);
    }
  };
  const phase = async <T>(name: string, fn: () => Promise<T> | T): Promise<T> => {
    const t = now();
    try {
      return await fn();
    } finally {
      metrics[`${name}Ms`] = round1(now() - t);
      sample();
    }
  };

  const summary: RunSummary = {
    ok: false, outcome: "failed", mode: req.mode, trigger: req.trigger, source: req.source,
    publicationId: null, errorClass: null, runId: null, sha256: null, input: {}, output: {}, metrics,
  };

  // A synthetic export can never become public data.
  if (req.source === "synthetic" && req.mode === "publish") {
    summary.errorClass = "synthetic_publish_refused";
    deps.log("run_refused", { reason: summary.errorClass });
    return summary;
  }

  let pub: ClosableSqlClient | null = null;
  let priv: ClosableSqlClient | null = null;
  let leaseHeld = false;
  let pubC: ReturnType<typeof counting> | null = null;
  let recordedSha: string | null = null;
  let dataUpdatedAt: string | null = null;
  try {
    deps.log("run_started", { mode: req.mode, trigger: req.trigger, source: req.source, runtime: deps.runtime });
    const pubRaw = await phase("publicConnect", () => deps.openPublic());
    pub = pubRaw;
    const c = counting(pubRaw);
    pubC = c;

    if (req.mode !== "dry_run") {
      leaseHeld = await acquireLease(c, deps.publicRole, holder, deps.leaseTtlSeconds ?? 300);
      if (!leaseHeld) {
        summary.ok = true;
        summary.outcome = "skipped_busy";
        metrics.dbOperations = c.ops();
        metrics.totalMs = round1(now() - startedAt);
        deps.log("run_skipped_busy", {});
        summary.runId = await recordRun(c, deps.publicRole, toRecord(summary, deps, startedIso, null, null)).catch(() => null);
        return summary;
      }
    }

    // ---- 1. export -------------------------------------------------------------------------
    let rawExport: unknown;
    if (req.source === "synthetic") {
      rawExport = await phase("syntheticGenerate", () => syntheticExport(req.scale ?? 1));
    } else if (deps.fileExport !== undefined && deps.fileExport !== null) {
      rawExport = deps.fileExport;
    } else {
      if (!deps.openPrivate) throw new PublicationError("private_export_not_configured");
      const privRaw = await phase("privateConnect", () => deps.openPrivate!());
      priv = privRaw;
      const privC = counting(privRaw);
      rawExport = await phase("privateExportQuery", () => readPrivateExport(privC, deps.config.locationGrid));
      metrics.privateDbOperations = privC.ops();
      await priv.close().catch(() => undefined);
      priv = null;
    }

    // ---- 2. aggregate / validate -----------------------------------------------------------
    const built = await phase("projectBuild", () => buildProjection(rawExport, deps.config));
    rawExport = null;
    const { projection, report } = built;
    summary.input = report.input;
    summary.output = report.output;
    summary.sha256 = report.contentSha256;
    recordedSha = report.contentSha256;
    dataUpdatedAt = projection.sourceDataUpdatedAt;
    metrics.rejected = report.rejected;
    metrics.anomalies = report.anomalies;
    deps.log("projection_built", { input: report.input, output: report.output, rejected: report.rejected, anomalies: report.anomalies, sha256: report.contentSha256 });

    // ---- 3. public write -------------------------------------------------------------------
    if (req.mode === "dry_run") {
      const active = await phase("activeLookup", async () => {
        await c.query("begin");
        try {
          if (deps.publicRole) await c.query(`set local role ${deps.publicRole}`);
          const s = (await c.query("select pub_admin.status() as s")).rows[0]?.s as { active: number | null; publications: { id: number; sha: string | null }[] };
          await c.query("commit");
          return s;
        } catch (e) {
          await c.query("rollback").catch(() => undefined);
          throw e;
        }
      });
      const activeSha = active.active != null ? active.publications.find((p) => p.id === active.active)?.sha ?? null : null;
      summary.wouldBe = activeSha === report.contentSha256 ? "duplicate" : "activated";
      summary.outcome = "dry_run_ok";
      summary.ok = true;
    } else {
      const res = await phase("publicWriteTotal", () =>
        writePublication(c, projection, {
          workerVersion: deps.workerVersion,
          exportedAt: report.exportedAt,
          sha256: report.contentSha256,
          config: deps.config,
          allowShrink: req.allowShrink === true,
          setRole: deps.publicRole,
          rollback: req.mode === "rehearse",
          wallBudgetMs: deps.wallBudgetMs ?? 120_000,
          startedAt,
          now,
        }),
      );
      metrics.publicWriteMs = round1(res.writeMs);
      metrics.activationMs = round1(res.activateMs);
      metrics.rowsWritten = res.rows;
      metrics.precheckDuplicate = res.precheckDuplicate;
      summary.publicationId = res.publicationId;
      if (res.outcome === "busy") {
        summary.outcome = "skipped_busy";
      } else if (req.mode === "rehearse") {
        summary.outcome = "rehearsal_ok";
        summary.wouldBe = res.wouldBe;
        summary.publicationId = null; // rolled back: no such publication persists
      } else {
        summary.outcome = res.outcome;
      }
      summary.ok = true;
    }
  } catch (e) {
    const { cls, detail } = errorClassOf(e);
    summary.ok = false;
    summary.outcome = "failed";
    summary.errorClass = cls;
    metrics.errorDetail = detail;
    deps.log("run_failed", { errorClass: cls, detail });
  } finally {
    sample();
    metrics.totalMs = round1(now() - startedAt);
    const cpu1 = deps.cpuMs?.() ?? null;
    metrics.cpuMs = cpu0 != null && cpu1 != null ? round1(cpu1 - cpu0) : null;
    metrics.peakRssMB = peakRss || null;
    metrics.peakHeapMB = peakHeap || null;
    if (priv) await priv.close().catch(() => undefined);
    if (pub && pubC) {
      try {
        if (leaseHeld) await releaseLease(pubC, deps.publicRole, holder).catch(() => undefined);
        if (summary.runId == null) {
          metrics.dbOperations = pubC.ops(); // public-DB statements before the final lease release and run-log write
          summary.runId = await recordRun(pubC, deps.publicRole, toRecord(summary, deps, startedIso, recordedSha, dataUpdatedAt)).catch((err) => {
            deps.log("run_record_failed", { errorClass: errorClassOf(err).cls });
            return null;
          });
        }
      } finally {
        await pub.close().catch(() => undefined);
      }
    }
    deps.log("run_finished", { outcome: summary.outcome, errorClass: summary.errorClass, totalMs: metrics.totalMs, runId: summary.runId });
  }
  return summary;
}

function toRecord(s: RunSummary, deps: RunDeps, startedIso: string, sha: string | null, dataUpdatedAt: string | null): RunRecord {
  // `errorDetail` holds reason codes / paths only (PublicationError.detail), never row values.
  const detail = (s.metrics.errorDetail as Record<string, unknown> | undefined) ?? null;
  const metrics = { ...s.metrics };
  delete metrics.errorDetail;
  return {
    trigger: s.trigger,
    mode: s.mode,
    outcome: s.outcome,
    publicationId: s.publicationId,
    errorClass: s.errorClass,
    errorDetail: detail && Object.keys(detail).length ? detail : null,
    workerVersion: deps.workerVersion,
    startedAt: startedIso,
    sourceDataUpdatedAt: dataUpdatedAt,
    contentSha256: sha ?? s.sha256,
    metrics: { ...metrics, source: s.source, input: s.input, output: s.output, wouldBe: s.wouldBe ?? null },
  };
}
