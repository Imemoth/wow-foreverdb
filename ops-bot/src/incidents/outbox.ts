import { changes, type Db } from "../db";
import type { Config } from "../config";
import type { DiscordClient } from "../discord/client";
import { renderIncidentMessage, type MessageKind, type OriginalAlert } from "../discord/messages";
import { getIncident, addEvent } from "./engine";
import type { Logger } from "../util/log";

export interface OutboxStats { sent: number; retried: number; rateLimited: number; dead: number; deadIds: string[]; backlog: number }
interface Row { id: string; incident_id: string; kind: MessageKind; attempts: number }

const LEASE_MS = 90_000;
const backoffMs = (attempt: number) => Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 15 * 60_000);

/**
 * Delivery guarantees (honest version): AT-LEAST-ONCE with idempotent enqueueing. The outbox id makes enqueueing idempotent;
 * Discord `nonce`/`enforce_nonce` suppresses most duplicates when an attempt times out after Discord accepted it. A timeout that
 * outlives that window can still produce a duplicate message. Exactly-once delivery is NOT claimed.
 */
export async function processOutbox(db: Db, discord: DiscordClient, cfg: Config, now: number, log: Logger): Promise<OutboxStats> {
  const stats: OutboxStats = { sent: 0, retried: 0, rateLimited: 0, dead: 0, deadIds: [], backlog: 0 };
  const due = await db.prepare(
    "select id, incident_id, kind, attempts from outbox where (status = 'PENDING' and next_attempt_at <= ?) or (status = 'SENDING' and lease_until < ?) order by created_at, id limit ?")
    .bind(now, now, cfg.tuning.outboxBatch).all<Row>();

  for (const row of due.results) {
    const claim = await db.prepare("update outbox set status = 'SENDING', lease_until = ?, attempts = attempts + 1 where id = ? and (status = 'PENDING' or (status = 'SENDING' and lease_until < ?))")
      .bind(now + LEASE_MS, row.id, now).run();
    if (changes(claim) !== 1) continue; // another invocation owns it

    const attempt = row.attempts + 1;
    const inc = await getIncident(db, row.incident_id);
    if (!inc) { await db.prepare("update outbox set status = 'DEAD', last_error_class = 'incident_gone' where id = ?").bind(row.id).run(); continue; }
    if (row.kind === "EDIT_ALERT" && !inc.alert_message_id) { await db.prepare("update outbox set status = 'SENT', sent_at = ? where id = ?").bind(now, row.id).run(); continue; }

    const body = renderIncidentMessage(inc, row.kind, cfg.env, row.kind === "RECOVERED" ? await originalAlertState(db, inc.id, inc.alert_message_id) : "delivered");
    const channel = inc.alert_channel_id ?? cfg.discord.alertChannelId;
    const res = row.kind === "EDIT_ALERT"
      ? await discord.editMessage(channel, inc.alert_message_id!, body)
      : await discord.createMessage(channel, body, row.id.replace(/[^A-Za-z0-9]/g, "").slice(-25));

    if (res.ok) {
      await db.prepare("update outbox set status = 'SENT', sent_at = ?, discord_message_id = ?, lease_until = null where id = ?").bind(now, res.messageId, row.id).run();
      if (row.kind === "OPEN" && res.messageId) {
        await db.prepare("update incidents set alert_message_id = ?, alert_channel_id = ? where id = ? and alert_message_id is null").bind(res.messageId, channel, inc.id).run();
      }
      await addEvent(db, inc.id, now, "NOTIFIED", "system", `${row.kind} delivered (attempt ${attempt})`);
      stats.sent++;
      continue;
    }
    if (res.class === "rate_limited") {
      // A 429 is not a failed attempt: honour Retry-After, give the attempt back, and stop this batch (shared rate limit).
      await db.prepare("update outbox set status = 'PENDING', lease_until = null, attempts = attempts - 1, next_attempt_at = ?, last_error_class = 'rate_limited' where id = ?")
        .bind(now + (res.retryAfterMs ?? 5000), row.id).run();
      stats.rateLimited++; stats.retried++;
      log.warn("discord_rate_limited", { outboxId: row.id, retryAfterMs: res.retryAfterMs ?? null });
      break;
    }
    const permanent = res.class === "client" || res.class === "auth";
    if (permanent || attempt >= cfg.tuning.outboxMaxAttempts) {
      await db.prepare("update outbox set status = 'DEAD', lease_until = null, last_error_class = ? where id = ?").bind(res.class, row.id).run();
      await addEvent(db, inc.id, now, "NOTIFY_DEAD", "system", `${row.kind}: ${res.class}${res.status ? ` ${res.status}` : ""}`);
      stats.dead++; stats.deadIds.push(row.id);
      log.error("discord_delivery_dead", { outboxId: row.id, class: res.class, status: res.status ?? null, attempts: attempt });
    } else {
      await db.prepare("update outbox set status = 'PENDING', lease_until = null, next_attempt_at = ?, last_error_class = ? where id = ?").bind(now + backoffMs(attempt), res.class, row.id).run();
      stats.retried++;
      log.warn("discord_delivery_retry", { outboxId: row.id, class: res.class, status: res.status ?? null, attempt });
    }
  }
  const backlog = await db.prepare("select count(*) as n from outbox where status in ('PENDING','SENDING')").first<{ n: number }>();
  stats.backlog = backlog?.n ?? 0;
  return stats;
}

/** DEAD rows whose fallback notice was not sent yet (each is announced at most once on the independent fallback route). */
export async function pendingFallbacks(db: Db): Promise<Array<{ id: string; incident_id: string; kind: string; last_error_class: string | null }>> {
  const r = await db.prepare("select id, incident_id, kind, last_error_class from outbox where status = 'DEAD' and fallback_sent_at is null and kind <> 'EDIT_ALERT' order by created_at limit 5")
    .all<{ id: string; incident_id: string; kind: string; last_error_class: string | null }>();
  return r.results;
}
export async function markFallbackSent(db: Db, id: string, now: number): Promise<void> {
  await db.prepare("update outbox set fallback_sent_at = ? where id = ? and fallback_sent_at is null").bind(now, id).run();
}

/** DEAD alerts stay terminal (they are not retried; the fallback route announces them once). A later RECOVERED message says so. */
async function originalAlertState(db: Db, incidentId: string, alertMessageId: string | null): Promise<OriginalAlert> {
  if (alertMessageId) return "delivered";
  const open = await db.prepare("select status from outbox where incident_id = ? and kind = 'OPEN' order by created_at desc limit 1").bind(incidentId).first<{ status: string }>();
  return open?.status === "DEAD" ? "failed" : "not_posted";
}
