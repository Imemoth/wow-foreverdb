// One bounded worker run: claim -> send -> finish. All effects are injected so the whole thing is testable with a mocked database and
// a mocked Resend. Logs contain counts and allowlisted codes only; never an address, a key, a payload or a provider body.
import { buildPayload } from "./email.ts";
import { missingSettings, type WorkerConfig } from "./config.ts";
import { LogoError, validateLogo, type Logo } from "./logo.ts";
import { sendEmail, type FetchLike, type SendOutcome } from "./resend.ts";

export interface ClaimedJob {
  user_id: string;
  recipient: string;
  lease_token: string;
  idempotency_key: string;
  attempt: number;
}

export interface FinishArgs {
  user_id: string;
  lease_token: string;
  outcome: "sent" | "retry" | "ambiguous" | "permanent";
  provider_id?: string;
  error_code?: string;
  retry_after_seconds?: number;
}

export interface Db {
  claim(limit: number): Promise<ClaimedJob[]>;
  finish(a: FinishArgs): Promise<boolean>;
}

export interface RunDeps {
  cfg: WorkerConfig;
  db: Db;
  fetch: FetchLike;
  loadLogoBytes: () => Promise<Uint8Array | null>;
  log: (event: string, fields: Record<string, string | number>) => void;
}

export interface RunSummary {
  state: "disabled" | "misconfigured" | "logo_invalid" | "ok" | "circuit_open" | "provider_auth_failed" | "claim_failed";
  claimed: number;
  sent: number;
  retry: number;
  ambiguous: number;
  permanent: number;
  finish_failed: number;
}

const CIRCUIT_BREAKER = 3; // consecutive provider-side failures that stop the run
// Lease is 180 s; every send is capped at sendTimeoutMs (10 s) and DB calls at 10 s. Stop starting new sends well inside the lease so a
// slow run releases the rest instead of letting their leases expire (which would turn them into "unknown outcome" jobs).
const RUN_BUDGET_MS = 90_000;

export async function runOnce(d: RunDeps): Promise<RunSummary> {
  const s: RunSummary = { state: "ok", claimed: 0, sent: 0, retry: 0, ambiguous: 0, permanent: 0, finish_failed: 0 };
  // Kill switch FIRST: when off, nothing is claimed, so no state changes and no attempts are consumed.
  if (!d.cfg.enabled) return { ...s, state: "disabled" };
  if (missingSettings(d.cfg).length > 0) {
    d.log("worker_misconfigured", { missing: missingSettings(d.cfg).length });
    return { ...s, state: "misconfigured" };
  }
  let logo: Logo;
  try {
    logo = validateLogo(await d.loadLogoBytes());
  } catch (e) {
    d.log("logo_invalid", { code: e instanceof LogoError ? e.code : "logo_unreadable" });
    return { ...s, state: "logo_invalid" };
  }

  let jobs: ClaimedJob[];
  try {
    jobs = await d.db.claim(d.cfg.maxPerRun);
  } catch (e) {
    d.log("claim_failed", { code: String((e as Error)?.message ?? "claim_failed").slice(0, 60) });
    return { ...s, state: "claim_failed" };
  }
  s.claimed = jobs.length;
  const started = Date.now();
  let streak = 0;
  let stopped: RunSummary["state"] | null = null;
  const release = (job: ClaimedJob) =>
    // Not attempted: the database gives the attempt back and looks again later.
    finish(d, s, { user_id: job.user_id, lease_token: job.lease_token, outcome: "retry", error_code: "circuit_open", retry_after_seconds: 300 });
  const mine = jobs.slice(0, d.cfg.maxPerRun);
  for (const extra of jobs.slice(d.cfg.maxPerRun)) await release(extra); // never keep a lease on a job we will not send
  for (const job of mine) {
    if (stopped || streak >= CIRCUIT_BREAKER || Date.now() - started > RUN_BUDGET_MS) {
      await release(job);
      stopped ??= streak >= CIRCUIT_BREAKER ? "circuit_open" : "ok";
      continue;
    }
    const out: SendOutcome = await sendEmail({
      fetch: d.fetch,
      apiKey: d.cfg.resendApiKey,
      payload: buildPayload(d.cfg, job.recipient, logo),
      idempotencyKey: job.idempotency_key,
      timeoutMs: d.cfg.sendTimeoutMs,
    });
    if (out.kind === "accepted") {
      streak = 0;
      s.sent++;
      await finish(d, s, { user_id: job.user_id, lease_token: job.lease_token, outcome: "sent", provider_id: out.providerId });
    } else if (out.kind === "permanent" && out.code === "provider_auth") {
      // A revoked key or unverified domain is an operator problem, not a per-user problem: give the attempt back, stop the run, alert.
      s.permanent++;
      stopped = "provider_auth_failed";
      d.log("provider_auth_failed", { claimed: s.claimed });
      await release(job);
    } else if (out.kind === "permanent") {
      s.permanent++;
      await finish(d, s, { user_id: job.user_id, lease_token: job.lease_token, outcome: "permanent", error_code: out.code });
    } else if (out.kind === "retry") {
      s.retry++;
      streak++;
      await finish(d, s, { user_id: job.user_id, lease_token: job.lease_token, outcome: "retry", error_code: out.code, retry_after_seconds: out.retryAfterSeconds });
    } else {
      s.ambiguous++;
      streak++;
      await finish(d, s, { user_id: job.user_id, lease_token: job.lease_token, outcome: "ambiguous", error_code: out.code });
    }
    if (streak >= CIRCUIT_BREAKER && !stopped) stopped = "circuit_open";
  }
  if (stopped && stopped !== "ok") s.state = stopped;
  d.log("run_complete", { claimed: s.claimed, sent: s.sent, retry: s.retry, ambiguous: s.ambiguous, permanent: s.permanent });
  return s;
}

async function finish(d: RunDeps, s: RunSummary, a: FinishArgs): Promise<void> {
  try {
    if (!(await d.db.finish(a))) s.finish_failed++;
  } catch {
    s.finish_failed++; // the lease will expire and the job is then treated as an ambiguous outcome by the database
  }
}
