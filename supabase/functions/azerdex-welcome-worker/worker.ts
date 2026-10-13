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
  state: "disabled" | "misconfigured" | "logo_invalid" | "ok" | "circuit_open";
  claimed: number;
  sent: number;
  retry: number;
  ambiguous: number;
  permanent: number;
  finish_failed: number;
}

const CIRCUIT_BREAKER = 3; // consecutive provider-side failures that stop the run

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

  const jobs = await d.db.claim(d.cfg.maxPerRun);
  s.claimed = jobs.length;
  let streak = 0;
  for (const job of jobs.slice(0, d.cfg.maxPerRun)) {
    if (streak >= CIRCUIT_BREAKER) {
      // Not sent, not attempted: release as a retry that does not count as a provider failure.
      await finish(d, s, { user_id: job.user_id, lease_token: job.lease_token, outcome: "retry", error_code: "circuit_open", retry_after_seconds: 300 });
      s.state = "circuit_open";
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
    } else if (out.kind === "permanent") {
      s.permanent++;
      streak = out.code === "provider_auth" ? CIRCUIT_BREAKER : streak; // a bad key must stop the run at once
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
  }
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
