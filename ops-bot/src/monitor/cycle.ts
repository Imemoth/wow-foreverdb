import { changes, type Clock, type Db } from "../db";
import type { Config } from "../config";
import type { DiscordClient } from "../discord/client";
import type { FallbackNotifier, HeartbeatProvider, HeartbeatSignal } from "../heartbeat/heartbeat";
import type { HealthProvider, ProviderFailureClass } from "../health/provider";
import { DEFAULT_RETRY, fetchWithRetry, type RetryPolicy } from "../health/retry";
import { applyFinding, ensureOpenNotifications, purgeExpired, type Transition } from "../incidents/engine";
import { markFallbackSent, pendingFallbacks, processOutbox, type OutboxStats } from "../incidents/outbox";
import type { Logger } from "../util/log";
import { randomId } from "../util/text";
import { checkFreshness, COMPONENT_G6, evaluateReporting, evaluateSchedule, evaluateSnapshot, type Finding } from "./evaluate";

export interface CycleDeps {
  db: Db; cfg: Config; clock: Clock; provider: HealthProvider; discord: DiscordClient;
  heartbeat: HeartbeatProvider; fallback: FallbackNotifier; log: Logger;
  sleep?: (ms: number) => Promise<void>; retry?: RetryPolicy;
}
export type CycleResult =
  | { status: "skipped_locked" }
  | { status: "completed"; reporting: "ok" | "degraded"; failure: ProviderFailureClass | null; transitions: Transition[]; outbox: OutboxStats; heartbeat: HeartbeatSignal; gapMinutes: number | null };

const LEASE_MS = 4 * 60_000;
const CYCLE_LOCK = "cycle";

export async function getState(db: Db, key: string): Promise<string | null> {
  const r = await db.prepare("select value from monitor_state where key = ?").bind(key).first<{ value: string }>();
  return r?.value ?? null;
}
export async function setState(db: Db, key: string, value: string, now: number): Promise<void> {
  await db.prepare("insert into monitor_state (key, value, updated_at) values (?, ?, ?) on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at").bind(key, value, now).run();
}

async function acquireLease(db: Db, holder: string, now: number): Promise<boolean> {
  const ins = await db.prepare("insert or ignore into locks (name, holder, lease_until) values (?, ?, ?)").bind(CYCLE_LOCK, holder, now + LEASE_MS).run();
  if (changes(ins) === 1) return true;
  const take = await db.prepare("update locks set holder = ?, lease_until = ? where name = ? and lease_until < ?").bind(holder, now + LEASE_MS, CYCLE_LOCK, now).run();
  return changes(take) === 1;
}
async function releaseLease(db: Db, holder: string): Promise<void> {
  await db.prepare("update locks set lease_until = 0 where name = ? and holder = ?").bind(CYCLE_LOCK, holder).run();
}

async function persistComponent(db: Db, f: Pick<Finding, "component" | "state" | "reasonCode">, now: number): Promise<void> {
  await db.prepare(
    "insert into component_state (component, state, reason_code, since, updated_at) values (?, ?, ?, ?, ?) " +
    "on conflict(component) do update set since = case when component_state.state <> excluded.state then excluded.since else component_state.since end, " +
    "state = excluded.state, reason_code = excluded.reason_code, updated_at = excluded.updated_at").bind(f.component, f.state, f.reasonCode, now, now).run();
}

/**
 * One scheduled monitoring cycle. Order matters: (1) lease, (2) read health (failure is data, not an exception),
 * (3) classify, (4) persist incident transitions, (5) deliver, (6) heartbeat. A Supabase outage reaches step 4 and 5 normally:
 * the bot records the "reporting unavailable" incident and attempts Discord delivery without any Supabase access.
 */
export async function runCycle(d: CycleDeps): Promise<CycleResult> {
  const { db, cfg, clock, log } = d;
  const t = cfg.tuning;
  const holder = randomId(12);
  const startedAt = clock.now();
  if (!(await acquireLease(db, holder, startedAt))) { log.info("cycle_skipped_locked"); return { status: "skipped_locked" }; }

  try {
    const now = clock.now();
    const lastCycleRaw = await getState(db, "last_cycle_at");
    const gapMinutes = lastCycleRaw ? Math.round((now - Number(lastCycleRaw)) / 60_000) : null;

    const { result, attempts } = await fetchWithRetry(d.provider, d.retry ?? DEFAULT_RETRY, d.sleep);
    let failure: ProviderFailureClass | null = null;
    let status: number | undefined;
    if (result.ok) { if (checkFreshness(result.snapshot, now, t) === "stale") failure = "stale"; }
    else { failure = result.failure; status = result.httpStatus; }

    const prevFailures = Number((await getState(db, "reporting_failures")) ?? "0") || 0;
    const failures = failure ? prevFailures + 1 : 0;
    await setState(db, "reporting_failures", String(failures), now);

    const findings: Finding[] = [evaluateSchedule(gapMinutes, t), evaluateReporting(failure, failures, t, status)];
    if (!failure && result.ok) findings.push(...evaluateSnapshot(result.snapshot, now, cfg));
    else {
      // Fail closed: previously known source/G6 components become UNKNOWN; nothing is reported healthy, nothing is resolved.
      const known = await db.prepare("select component from component_state where component like 'source:%' or component = ?").bind(COMPONENT_G6).all<{ component: string }>();
      for (const k of known.results) findings.push({ component: k.component, state: "UNKNOWN", reasonCode: "reporting_unavailable", summary: "No fresh health report", context: {} });
    }

    const transitions: Transition[] = [];
    for (const f of findings) {
      await persistComponent(db, f, now);
      transitions.push(...(await applyFinding(db, f, now, t)));
    }
    await ensureOpenNotifications(db, now);
    const outbox = await processOutbox(db, d.discord, cfg, clock.now(), log);

    for (const row of await pendingFallbacks(db)) {
      const delivered = await d.fallback.notify(`AzerDex ops bot: Discord delivery failed for incident ${row.incident_id} (${row.kind}, ${row.last_error_class ?? "unknown"}). Check the staging/production runbook.`);
      if (delivered) await markFallbackSent(db, row.id, clock.now());
    }

    const lastRetention = Number((await getState(db, "retention_ran_at")) ?? "0") || 0;
    if (now - lastRetention > 86_400_000) { await purgeExpired(db, now, t); await setState(db, "retention_ran_at", String(now), now); }

    await setState(db, "last_cycle_at", String(clock.now()), clock.now());
    const oldest = await db.prepare("select min(created_at) as c from outbox where status in ('PENDING','SENDING')").first<{ c: number | null }>();
    const deliveryFailing = outbox.dead > 0 || (oldest?.c != null && clock.now() - oldest.c > 30 * 60_000);

    let signal: HeartbeatSignal = "ok";
    if (deliveryFailing) { signal = "delivery_failing"; await d.heartbeat.fail(signal); }
    else {
      if (failure) { signal = "supabase_degraded"; await d.heartbeat.log(signal); }
      else if (gapMinutes !== null && gapMinutes > t.cronGapMinutes) { signal = "schedule_gap"; await d.heartbeat.log(signal); }
      await d.heartbeat.success(signal);
    }
    await setState(db, "last_heartbeat", `${signal}@${clock.now()}`, clock.now());
    log.info("cycle_completed", { reporting: failure ? "degraded" : "ok", failureClass: failure, attempts, transitions: transitions.length, sent: outbox.sent, dead: outbox.dead, signal });
    return { status: "completed", reporting: failure ? "degraded" : "ok", failure, transitions, outbox, heartbeat: signal, gapMinutes };
  } catch (e) {
    log.error("cycle_failed", { errorName: (e as Error).name });
    await d.heartbeat.fail("cycle_error"); // the BOT failed: tell the independent monitor now, do not wait for the missed-ping grace period
    throw e;
  } finally {
    await releaseLease(db, holder).catch(() => undefined);
  }
}
