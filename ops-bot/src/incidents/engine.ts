import { changes, type Db } from "../db";
import type { Tuning } from "../config";
import type { Finding } from "../monitor/evaluate";
import { randomId } from "../util/text";

export type IncidentStatus = "OPEN" | "ACKNOWLEDGED" | "RESOLVED";
export interface IncidentRow {
  id: string; component: string; status: IncidentStatus; severity: "CRITICAL"; reason_code: string; summary: string; context: string;
  first_seen_at: number; last_seen_at: number; occurrences: number; healthy_streak: number; update_count: number;
  last_notified_at: number | null; reminder_count: number; ack_by: string | null; ack_at: number | null; ack_note: string | null;
  resolved_at: number | null; alert_message_id: string | null; alert_channel_id: string | null; updated_at: number;
}
export type Transition =
  | { kind: "opened"; incidentId: string; component: string }
  | { kind: "updated"; incidentId: string; component: string }
  | { kind: "reminder"; incidentId: string; component: string }
  | { kind: "recovered"; incidentId: string; component: string }
  | { kind: "streak"; incidentId: string; component: string; streak: number };

export async function getIncident(db: Db, id: string): Promise<IncidentRow | null> {
  return db.prepare("select * from incidents where id = ?").bind(id).first<IncidentRow>();
}
export async function getActiveIncident(db: Db, component: string): Promise<IncidentRow | null> {
  return db.prepare("select * from incidents where component = ? and status <> 'RESOLVED'").bind(component).first<IncidentRow>();
}

function newIncidentId(now: number): string {
  const d = new Date(now);
  const yymmdd = `${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  return `INC-${yymmdd}-${randomId(4)}`;
}

export async function addEvent(db: Db, incidentId: string, at: number, kind: string, actor: string, detail = ""): Promise<void> {
  await db.prepare("insert into incident_events (incident_id, at, kind, actor, detail) values (?, ?, ?, ?, ?)").bind(incidentId, at, kind, actor, detail.slice(0, 300)).run();
}

/** Idempotent: the outbox id is the idempotency key, so racing writers cannot enqueue the same notification twice. */
export async function enqueue(db: Db, incidentId: string, kind: "OPEN" | "UPDATE" | "REMINDER" | "RECOVERED" | "EDIT_ALERT", seq: number | string, now: number): Promise<boolean> {
  const r = await db.prepare("insert or ignore into outbox (id, incident_id, kind, status, next_attempt_at, created_at) values (?, ?, ?, 'PENDING', ?, ?)")
    .bind(`${incidentId}:${kind}:${seq}`, incidentId, kind, now, now).run();
  return changes(r) === 1;
}

export async function isMuted(db: Db, component: string, now: number): Promise<boolean> {
  const r = await db.prepare("select 1 as x from maintenance where ended_at is null and starts_at <= ? and ends_at > ? and (component = '*' or component = ?) limit 1").bind(now, now, component).first();
  return r !== null;
}

/**
 * Applies ONE finding to the incident state. Every transition is a compare-and-set (UPDATE ... WHERE status/value = expected)
 * checked through `changes`, and the one-active-incident-per-component rule is a unique index, so concurrent or repeated
 * invocations converge on the same state with no duplicate incident and no duplicate notification.
 */
export async function applyFinding(db: Db, f: Finding, now: number, t: Tuning): Promise<Transition[]> {
  const out: Transition[] = [];
  const active = await getActiveIncident(db, f.component);

  if (f.state === "CRITICAL") {
    const ctx = JSON.stringify(f.context);
    if (!active) {
      const id = newIncidentId(now);
      const ins = await db.prepare(
        "insert into incidents (id, component, status, severity, reason_code, summary, context, first_seen_at, last_seen_at, updated_at) values (?, ?, 'OPEN', 'CRITICAL', ?, ?, ?, ?, ?, ?) on conflict do nothing")
        .bind(id, f.component, f.reasonCode, f.summary, ctx, now, now, now).run();
      if (changes(ins) === 1) {
        await addEvent(db, id, now, "OPENED", "system", f.reasonCode);
        out.push({ kind: "opened", incidentId: id, component: f.component });
        return out; // notification is enqueued by ensureOpenNotifications (single place: also heals crashes and maintenance windows)
      }
      return out.concat(await applyFinding(db, f, now, t)); // lost the race: continue as an update of the winner's incident
    }
    // Existing incident: record the observation (never resets recovery for another reason).
    await db.prepare("update incidents set last_seen_at = ?, occurrences = occurrences + 1, healthy_streak = 0, context = ?, updated_at = ? where id = ? and status <> 'RESOLVED'")
      .bind(now, ctx, now, active.id).run();
    if (active.reason_code !== f.reasonCode) {
      const cas = await db.prepare("update incidents set reason_code = ?, summary = ?, update_count = update_count + 1 where id = ? and reason_code = ? and status <> 'RESOLVED'")
        .bind(f.reasonCode, f.summary, active.id, active.reason_code).run();
      if (changes(cas) === 1) {
        const fresh = (await getIncident(db, active.id))!;
        await addEvent(db, active.id, now, "UPDATED", "system", `${active.reason_code} -> ${f.reasonCode}`);
        if (await isMuted(db, f.component, now)) await addEvent(db, active.id, now, "NOTIFY_SUPPRESSED", "system", "maintenance:UPDATE");
        else {
          await enqueue(db, active.id, "UPDATE", fresh.update_count, now);
          await db.prepare("update incidents set last_notified_at = ? where id = ?").bind(now, active.id).run();
        }
        out.push({ kind: "updated", incidentId: active.id, component: f.component });
      }
    }
    // Reminder throttling: OPEN (not acknowledged) incidents only, bounded count, one CAS per reminder.
    const cur = (await getIncident(db, active.id))!;
    if (cur.status === "OPEN" && cur.last_notified_at !== null && cur.reminder_count < t.maxReminders
        && now - cur.last_notified_at >= t.reminderIntervalMinutes * 60_000 && !(await isMuted(db, f.component, now))) {
      const cas = await db.prepare("update incidents set reminder_count = reminder_count + 1, last_notified_at = ? where id = ? and status = 'OPEN' and reminder_count = ?")
        .bind(now, active.id, cur.reminder_count).run();
      if (changes(cas) === 1) {
        await enqueue(db, active.id, "REMINDER", cur.reminder_count + 1, now);
        await addEvent(db, active.id, now, "REMINDER", "system", `n=${cur.reminder_count + 1}`);
        out.push({ kind: "reminder", incidentId: active.id, component: f.component });
      }
    }
    return out;
  }

  if (!active) return out;

  if (f.state === "HEALTHY") {
    const bump = await db.prepare("update incidents set healthy_streak = healthy_streak + 1, last_seen_at = ?, updated_at = ? where id = ? and status <> 'RESOLVED'").bind(now, now, active.id).run();
    if (changes(bump) !== 1) return out;
    const cur = (await getIncident(db, active.id))!;
    if (cur.healthy_streak >= t.recoveryConfirmations) {
      const res = await db.prepare("update incidents set status = 'RESOLVED', resolved_at = ?, updated_at = ? where id = ? and status <> 'RESOLVED' and healthy_streak >= ?")
        .bind(now, now, active.id, t.recoveryConfirmations).run();
      if (changes(res) === 1) {
        await addEvent(db, active.id, now, "RECOVERED", "system", `after ${cur.healthy_streak} healthy checks`);
        // A recovery message only makes sense if the operators were actually told about the incident.
        const told = await db.prepare("select 1 as x from outbox where incident_id = ? and kind = 'OPEN'").bind(active.id).first();
        if (told) await enqueue(db, active.id, "RECOVERED", 0, now);
        else await addEvent(db, active.id, now, "NOTIFY_SUPPRESSED", "system", "recovery: open alert was never queued");
        out.push({ kind: "recovered", incidentId: active.id, component: f.component });
      }
    } else out.push({ kind: "streak", incidentId: active.id, component: f.component, streak: cur.healthy_streak });
    return out;
  }

  if (f.state === "WARNING") {
    // Improved but not healthy: do not count toward recovery.
    await db.prepare("update incidents set healthy_streak = 0, last_seen_at = ?, updated_at = ? where id = ? and status <> 'RESOLVED'").bind(now, now, active.id).run();
  }
  // UNKNOWN: fail closed. An unknown reading neither resolves nor escalates an existing incident.
  return out;
}

/**
 * Enqueues the OPEN notification for every unresolved incident that has none yet and whose component is not in a maintenance window.
 * Single place for first notifications: it self-heals a crash between "incident inserted" and "outbox row inserted",
 * and delivers a deferred alert when maintenance ends while the component is still critical.
 */
export async function ensureOpenNotifications(db: Db, now: number): Promise<string[]> {
  const rows = await db.prepare("select id, component from incidents where status <> 'RESOLVED' and not exists (select 1 from outbox where outbox.incident_id = incidents.id and outbox.kind = 'OPEN')").all<{ id: string; component: string }>();
  const queued: string[] = [];
  for (const r of rows.results) {
    if (await isMuted(db, r.component, now)) {
      const seen = await db.prepare("select 1 as x from incident_events where incident_id = ? and kind = 'NOTIFY_SUPPRESSED' and detail = 'maintenance:OPEN'").bind(r.id).first();
      if (!seen) await addEvent(db, r.id, now, "NOTIFY_SUPPRESSED", "system", "maintenance:OPEN");
      continue;
    }
    if (await enqueue(db, r.id, "OPEN", 0, now)) {
      await db.prepare("update incidents set last_notified_at = ? where id = ? and last_notified_at is null").bind(now, r.id).run();
      queued.push(r.id);
    }
  }
  return queued;
}

export type AckResult = { result: "acked" | "already_acked" | "resolved" | "not_found"; incident: IncidentRow | null };

/**
 * Operator acknowledgement. Changes ONLY the incident row (and enqueues an edit of the alert message): it cannot change
 * any health state, and the first acknowledgement wins (repeats never overwrite actor/time).
 */
export async function ackIncident(db: Db, id: string, actor: string, now: number, note: string | null): Promise<AckResult> {
  const cas = await db.prepare("update incidents set status = 'ACKNOWLEDGED', ack_by = ?, ack_at = ?, ack_note = ?, updated_at = ? where id = ? and status = 'OPEN'")
    .bind(actor, now, note, now, id).run();
  const inc = await getIncident(db, id);
  if (!inc) return { result: "not_found", incident: null };
  if (changes(cas) === 1) {
    await addEvent(db, id, now, "ACK", actor, note ?? "");
    if (inc.alert_message_id) await enqueue(db, id, "EDIT_ALERT", `ack`, now);
    return { result: "acked", incident: inc };
  }
  return { result: inc.status === "RESOLVED" ? "resolved" : "already_acked", incident: inc };
}

export async function purgeExpired(db: Db, now: number, t: Tuning): Promise<{ incidents: number }> {
  const cutoff = now - t.retentionResolvedDays * 86_400_000;
  const r = await db.prepare("delete from incidents where status = 'RESOLVED' and resolved_at < ?").bind(cutoff).run(); // events and outbox cascade
  await db.prepare("delete from seen_interactions where seen_at < ?").bind(now - 86_400_000).run();
  await db.prepare("delete from rate_limits where window_start < ?").bind(now - 3_600_000).run();
  await db.prepare("delete from maintenance where ends_at < ?").bind(now - 7 * 86_400_000).run();
  await db.prepare("delete from audit_log where at < ?").bind(cutoff).run();
  return { incidents: changes(r) };
}
