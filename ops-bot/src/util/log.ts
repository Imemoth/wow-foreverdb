/**
 * Structured logging with mandatory redaction. Nothing is logged by free-form string interpolation of external data:
 * callers pass event names (fixed vocabulary) and small field objects, which are redacted before they reach the sink.
 */
export type LogLevel = "info" | "warn" | "error";
export type LogSink = (line: string) => void;

const SENSITIVE_KEY = /(token|secret|authorization|password|passwd|signature|webhook|url|key|cookie|credential|bearer)/i;
const PSEUDONYMIZED_KEY = /^(actor|userId|user|operatorId|ackBy|createdBy|endedBy)$/;

/** Short, stable, NON-secret pseudonym so log lines can be correlated without exposing a Discord user id. */
export function pseudonym(id: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `u_${h.toString(16).padStart(8, "0")}`;
}

const VALUE_PATTERNS: Array<[RegExp, string]> = [
  [/https?:\/\/(?:[a-z0-9-]+\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/[^\s"']+/gi, "[REDACTED_WEBHOOK]"],
  [/\bBot\s+[A-Za-z0-9._-]{20,}/g, "Bot [REDACTED]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]"],
  [/https?:\/\/hc-ping\.com\/[^\s"']+/gi, "[REDACTED_HEARTBEAT]"],
  [/<@[!&]?\d{5,}>/g, "[REDACTED_MENTION]"],
  [/\b[A-Fa-f0-9]{40,}\b/g, "[REDACTED_HEX]"],
  [/\b[A-Za-z0-9_-]{48,}\b/g, "[REDACTED_TOKEN]"],
];

export function redactString(s: string): string {
  let out = s;
  for (const [re, rep] of VALUE_PATTERNS) out = out.replace(re, rep);
  return out.length > 300 ? `${out.slice(0, 300)}…` : out;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[TRUNCATED]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 30)) {
      if (SENSITIVE_KEY.test(k)) out[k] = "[REDACTED]";
      else if (PSEUDONYMIZED_KEY.test(k) && typeof v === "string") out[k] = pseudonym(v);
      else out[k] = redact(v, depth + 1);
    }
    return out;
  }
  return String(typeof value);
}

export interface Logger { info(event: string, fields?: Record<string, unknown>): void; warn(event: string, fields?: Record<string, unknown>): void; error(event: string, fields?: Record<string, unknown>): void }

export function createLogger(sink: LogSink = (l) => console.log(l), now: () => number = Date.now): Logger {
  const emit = (level: LogLevel, event: string, fields?: Record<string, unknown>) => {
    sink(JSON.stringify({ t: new Date(now()).toISOString(), level, event: redactString(event), ...(fields ? { f: redact(fields) } : {}) }));
  };
  return { info: (e, f) => emit("info", e, f), warn: (e, f) => emit("warn", e, f), error: (e, f) => emit("error", e, f) };
}
