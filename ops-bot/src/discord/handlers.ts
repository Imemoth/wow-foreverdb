import { changes, type Db } from "../db";
import type { Config } from "../config";
import { ackIncident, getIncident, type IncidentRow } from "../incidents/engine";
import { getState } from "../monitor/cycle";
import { formatAgo, formatUtc, sanitizeText } from "../util/text";
import { INCIDENT_ID_RE, MAINT_COMPONENT_RE } from "./commands";
import { ephemeral, ephemeralLines, renderIncidentMessage } from "./messages";

export interface HandlerCtx { db: Db; cfg: Config; now: number; actorId: string }
export type Json = Record<string, unknown>;
interface Option { name: string; type: number; value?: unknown; options?: Option[] }

const opt = (opts: Option[] | undefined, name: string): unknown => opts?.find((o) => o.name === name)?.value;
const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.length <= max ? v : null);

export type OverallState = "HEALTHY" | "WARNING" | "CRITICAL" | "UNKNOWN";
/** Never reports green without fresh evidence: no data or a stalled bot is UNKNOWN, not HEALTHY. */
export function overallState(states: string[], lastCycleAt: number | null, now: number, cronGapMinutes: number): OverallState {
  if (lastCycleAt === null || now - lastCycleAt > cronGapMinutes * 60_000 || states.length === 0) return states.includes("CRITICAL") ? "CRITICAL" : "UNKNOWN";
  if (states.includes("CRITICAL")) return "CRITICAL";
  if (states.includes("UNKNOWN")) return "UNKNOWN";
  if (states.includes("WARNING")) return "WARNING";
  return "HEALTHY";
}

export async function handleCommand(ctx: HandlerCtx, data: { name?: string; options?: Option[] }): Promise<Json> {
  if (data.name !== "azerdex") return ephemeral("Unknown command.");
  const sub = data.options?.[0];
  if (!sub || sub.type !== 1) return ephemeral("Choose a subcommand: status, incidents, incident, ack, maintenance.");
  switch (sub.name) {
    case "status": return status(ctx);
    case "incidents": return incidents(ctx, str(opt(sub.options, "filter"), 20) ?? "active");
    case "incident": return incident(ctx, str(opt(sub.options, "id"), 20));
    case "ack": return ack(ctx, str(opt(sub.options, "id"), 20), str(opt(sub.options, "note"), 200));
    case "maintenance": return maintenance(ctx, sub.options);
    default: return ephemeral("Unknown subcommand.");
  }
}

async function status(ctx: HandlerCtx): Promise<Json> {
  const { db, cfg, now } = ctx;
  const comps = await db.prepare("select component, state, reason_code, since from component_state order by component").all<{ component: string; state: string; reason_code: string; since: number }>();
  const last = await getState(db, "last_cycle_at");
  const lastCycle = last ? Number(last) : null;
  const open = await db.prepare("select status, count(*) as n from incidents where status <> 'RESOLVED' group by status").all<{ status: string; n: number }>();
  const hb = await getState(db, "last_heartbeat");
  const maint = await db.prepare("select component, ends_at from maintenance where ended_at is null and ends_at > ? order by ends_at").bind(now).all<{ component: string; ends_at: number }>();
  const overall = overallState(comps.results.map((c) => c.state), lastCycle, now, cfg.tuning.cronGapMinutes);
  const lines = [
    `**AzerDex ops status** (${cfg.env})`,
    `Overall: **${overall}**${lastCycle === null ? " (no monitoring cycle recorded yet)" : now - lastCycle > cfg.tuning.cronGapMinutes * 60_000 ? " (monitor stalled: last cycle too old)" : ""}`,
    `Last monitoring cycle: ${lastCycle ? `${formatUtc(lastCycle)} (${formatAgo(lastCycle, now)})` : "never"}`,
    `Open incidents: ${open.results.find((o) => o.status === "OPEN")?.n ?? 0} open, ${open.results.find((o) => o.status === "ACKNOWLEDGED")?.n ?? 0} acknowledged`,
    `Heartbeat: ${hb ? sanitizeText(hb.split("@")[0] ?? "", 30) : "none yet"}`,
    "",
    ...comps.results.map((c) => `• ${sanitizeText(c.component, 60)}: ${c.state} (${sanitizeText(c.reason_code, 60)}, since ${formatUtc(c.since)})`),
  ];
  if (maint.results.length) lines.push("", "Notification mutes: " + maint.results.map((m) => `${sanitizeText(m.component, 40)} until ${formatUtc(m.ends_at)}`).join("; "));
  return ephemeralLines(lines);
}

async function incidents(ctx: HandlerCtx, filter: string): Promise<Json> {
  const where = filter === "resolved" ? "status = 'RESOLVED'" : filter === "acknowledged" ? "status = 'ACKNOWLEDGED'" : "status <> 'RESOLVED'";
  const rows = await ctx.db.prepare(`select id, component, status, reason_code, first_seen_at from incidents where ${where} order by first_seen_at desc limit 10`).all<Pick<IncidentRow, "id" | "component" | "status" | "reason_code" | "first_seen_at">>();
  if (!rows.results.length) return ephemeral(`No ${filter === "active" ? "active" : filter} incidents.`);
  return ephemeralLines([`**Incidents (${filter})**`, ...rows.results.map((r) => `• \`${r.id}\` ${r.status} · ${sanitizeText(r.component, 50)} · ${sanitizeText(r.reason_code, 50)} · since ${formatUtc(r.first_seen_at)}`)]);
}

async function incident(ctx: HandlerCtx, id: string | null): Promise<Json> {
  if (!id || !INCIDENT_ID_RE.test(id)) return ephemeral("Invalid incident id.");
  const inc = await getIncident(ctx.db, id);
  if (!inc) return ephemeral("Incident not found.");
  const events = await ctx.db.prepare("select at, kind, actor from incident_events where incident_id = ? order by id desc limit 8").bind(id).all<{ at: number; kind: string; actor: string }>();
  return ephemeralLines([
    `**${inc.id}** ${inc.status}`,
    `Component: ${sanitizeText(inc.component, 60)} · Reason: ${sanitizeText(inc.reason_code, 60)}`,
    `First observed: ${formatUtc(inc.first_seen_at)} · Last seen: ${formatUtc(inc.last_seen_at)} · Occurrences: ${inc.occurrences}`,
    inc.ack_at ? `Acknowledged: ${formatUtc(inc.ack_at)}` : "Not acknowledged",
    "Recent events:",
    ...events.results.map((e) => `• ${formatUtc(e.at)} ${e.kind}${e.actor !== "system" ? " (operator)" : ""}`),
  ]);
}

async function ack(ctx: HandlerCtx, id: string | null, note: string | null): Promise<Json> {
  if (!id || !INCIDENT_ID_RE.test(id)) return ephemeral("Invalid incident id.");
  const r = await ackIncident(ctx.db, id, ctx.actorId, ctx.now, note ? sanitizeText(note, 200) : null);
  return ephemeral(ackMessage(r.result, r.incident));
}
export function ackMessage(result: "acked" | "already_acked" | "resolved" | "not_found", inc: IncidentRow | null): string {
  switch (result) {
    case "acked": return `Acknowledged ${inc?.id}. Health state is unchanged; the incident resolves only when the monitor confirms recovery.`;
    case "already_acked": return `${inc?.id} was already acknowledged${inc?.ack_at ? ` at ${formatUtc(inc.ack_at)}` : ""}. No change.`;
    case "resolved": return `${inc?.id} is already resolved.`;
    default: return "Incident not found.";
  }
}

async function maintenance(ctx: HandlerCtx, options: Option[] | undefined): Promise<Json> {
  const { db, cfg, now, actorId } = ctx;
  const action = str(opt(options, "action"), 10);
  if (action === "list") {
    const rows = await db.prepare("select id, component, ends_at, reason from maintenance where ended_at is null and ends_at > ? order by ends_at").bind(now).all<{ id: number; component: string; ends_at: number; reason: string }>();
    return rows.results.length ? ephemeralLines(["**Active notification mutes**", ...rows.results.map((m) => `• #${m.id} ${sanitizeText(m.component, 50)} until ${formatUtc(m.ends_at)} (${sanitizeText(m.reason, 80)})`)]) : ephemeral("No active mutes.");
  }
  const component = str(opt(options, "component"), 80);
  if (!component || !MAINT_COMPONENT_RE.test(component)) return ephemeral("Provide a valid component (for example source:blizzard-bluepost-us, g6:job, supabase:reporting, bot:schedule or *).");
  if (action === "end") {
    const r = await db.prepare("update maintenance set ended_at = ?, ended_by = ? where ended_at is null and ends_at > ? and component = ?").bind(now, actorId, now, component).run();
    await db.prepare("insert into audit_log (at, actor, action, target, detail) values (?, ?, 'maintenance_end', ?, ?)").bind(now, actorId, component, `ended=${changes(r)}`).run();
    return ephemeral(changes(r) ? `Mute for ${component} ended. Notifications resume on the next monitoring cycle.` : "No active mute for that component.");
  }
  if (action === "start") {
    const minutes = opt(options, "minutes");
    if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 5 || minutes > cfg.tuning.maintenanceMaxMinutes) return ephemeral(`Duration must be 5 to ${cfg.tuning.maintenanceMaxMinutes} minutes.`);
    const reason = sanitizeText(str(opt(options, "reason"), 200) ?? "unspecified", 200);
    await db.prepare("insert into maintenance (component, starts_at, ends_at, created_by, reason) values (?, ?, ?, ?, ?)").bind(component, now, now + minutes * 60_000, actorId, reason).run();
    await db.prepare("insert into audit_log (at, actor, action, target, detail) values (?, ?, 'maintenance_start', ?, ?)").bind(now, actorId, component, `minutes=${minutes}`).run();
    return ephemeral(`Notifications for ${component} muted for ${minutes} min. Monitoring and incident tracking continue; a still-critical component is announced when the mute ends.`);
  }
  return ephemeral("Action must be start, end or list.");
}

/** ACK button on an alert message: edits the message in place (type 7) so everyone sees who acknowledged. */
export async function handleAckButton(ctx: HandlerCtx, customId: string, envLabel: string): Promise<Json> {
  const id = customId.startsWith("ack:") ? customId.slice(4) : "";
  if (!INCIDENT_ID_RE.test(id)) return ephemeral("Invalid action.");
  const r = await ackIncident(ctx.db, id, ctx.actorId, ctx.now, null);
  if (r.result === "not_found" || !r.incident) return ephemeral("Incident not found.");
  const fresh = (await getIncident(ctx.db, id))!;
  if (r.result === "acked") return { type: 7, data: renderIncidentMessage(fresh, "OPEN", envLabel) }; // edited in place; no mentions are triggered
  return ephemeral(ackMessage(r.result, fresh));
}
