import type { IncidentRow } from "../incidents/engine";
import { formatUtc, sanitizeText } from "../util/text";
import { NO_MENTIONS } from "./client";

export const COLOR = { critical: 0xd33a2c, ack: 0xe0a526, recovered: 0x2f9e5a, info: 0x4f6bd8 } as const;
const EPHEMERAL = 64;

export type MessageKind = "OPEN" | "UPDATE" | "REMINDER" | "RECOVERED" | "EDIT_ALERT";

function contextLines(raw: string): string {
  let ctx: Record<string, unknown> = {};
  try { ctx = JSON.parse(raw) as Record<string, unknown>; } catch { /* ignore */ }
  const parts = Object.entries(ctx).filter(([, v]) => v !== null && v !== undefined && v !== "").slice(0, 6)
    .map(([k, v]) => `${sanitizeText(k, 30)}: ${sanitizeText(String(v), 60)}`);
  return parts.length ? parts.join("\n") : "none";
}

const statusLabel = (i: IncidentRow): string =>
  i.status === "OPEN" ? "OPEN" : i.status === "ACKNOWLEDGED" ? `ACKNOWLEDGED (${i.ack_at ? formatUtc(i.ack_at) : "?"})` : `RESOLVED (${i.resolved_at ? formatUtc(i.resolved_at) : "?"})`;

export function ackButton(incidentId: string, disabled = false) {
  return [{ type: 1, components: [{ type: 2, style: 1, label: "Acknowledge", custom_id: `ack:${incidentId}`, disabled }] }];
}

/** Renders the incident message from CURRENT incident state, so a late delivery or an edit is never stale. */
export function renderIncidentMessage(i: IncidentRow, kind: MessageKind, envLabel: string) {
  const resolved = i.status === "RESOLVED" || kind === "RECOVERED";
  const title = kind === "RECOVERED" ? `RECOVERED: ${sanitizeText(i.component, 60)}`
    : kind === "REMINDER" ? `STILL CRITICAL: ${sanitizeText(i.component, 60)}`
    : kind === "UPDATE" ? `CRITICAL (updated): ${sanitizeText(i.component, 60)}`
    : `CRITICAL: ${sanitizeText(i.component, 60)}`;
  const embed = {
    title,
    description: sanitizeText(i.summary, 300),
    color: resolved ? COLOR.recovered : i.status === "ACKNOWLEDGED" ? COLOR.ack : COLOR.critical,
    fields: [
      { name: "Component", value: sanitizeText(i.component, 80), inline: true },
      { name: "Reason", value: sanitizeText(i.reason_code, 80), inline: true },
      { name: "Status", value: statusLabel(i), inline: true },
      { name: "First observed", value: formatUtc(i.first_seen_at), inline: true },
      { name: "Occurrences", value: String(i.occurrences), inline: true },
      ...(i.ack_by && i.status === "ACKNOWLEDGED" ? [{ name: "Acknowledged by", value: `<@${/^\d{5,25}$/.test(i.ack_by) ? i.ack_by : "0"}>`, inline: true }] : []),
      { name: "Context", value: contextLines(i.context), inline: false },
    ],
    footer: { text: `${i.id} · ${envLabel}` },
  };
  const components = i.status === "OPEN" && kind !== "RECOVERED" ? ackButton(i.id) : [];
  return { embeds: [embed], components, allowed_mentions: NO_MENTIONS };
}

export function ephemeral(content: string, extra: object = {}) {
  return { type: 4, data: { content: sanitizeText(content, 1900).replace(/​/g, ""), flags: EPHEMERAL, allowed_mentions: NO_MENTIONS, ...extra } };
}
export function ephemeralLines(lines: string[], extra: object = {}) {
  // trimEnd is linear. A trailing-whitespace regex is quadratic on a long whitespace run followed by text (CodeQL js/polynomial-redos).
  const body = lines.map((l) => l.trimEnd()).join("\n").slice(0, 1900);
  return { type: 4, data: { content: body, flags: EPHEMERAL, allowed_mentions: NO_MENTIONS, ...extra } };
}
