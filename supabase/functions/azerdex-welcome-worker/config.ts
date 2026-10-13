// Worker configuration. Everything is read once per invocation from the Edge Function secrets; nothing is logged.
// Fail closed: any value other than the exact string "true" leaves sending OFF.

export type WelcomeMode = "html" | "template";

export interface WorkerConfig {
  enabled: boolean;
  mode: WelcomeMode;
  resendApiKey: string;
  workerSecret: string;
  supabaseUrl: string;
  dbKey: string;
  from: string;
  replyTo: string;
  subject: string;
  ctaUrl: string;
  templateId: string;
  maxPerRun: number;
  sendTimeoutMs: number;
}

export const DEFAULTS = {
  from: "AzerDex <welcome@azerdex.com>",
  replyTo: "support@azerdex.com",
  subject: "Welcome to AzerDex — Know Your World",
  ctaUrl: "https://azerdex.com/",
  templateId: "azerdex-welcome-v1",
  // Hard ceilings: configuration can lower these, never raise them.
  maxPerRunCeiling: 10,
  sendTimeoutMs: 10_000,
} as const;

type Env = { get(name: string): string | undefined };

export function loadConfig(env: Env): WorkerConfig {
  const get = (n: string) => (env.get(n) ?? "").trim();
  const requested = Number.parseInt(get("AZERDEX_WELCOME_MAX_PER_RUN") || String(DEFAULTS.maxPerRunCeiling), 10);
  // A throttle that is 0, negative or unparsable means the SMALLEST run (1), never the largest.
  const maxPerRun = Number.isInteger(requested) ? Math.min(Math.max(requested, 1), DEFAULTS.maxPerRunCeiling) : 1;
  return {
    enabled: get("AZERDEX_WELCOME_ENABLED") === "true",
    // Rendered HTML + CID is the proven path; the hosted-template path stays opt-in until the owner-run provider test passes.
    mode: get("AZERDEX_WELCOME_MODE") === "template" ? "template" : "html",
    resendApiKey: get("RESEND_API_KEY"),
    workerSecret: get("AZERDEX_WORKER_SECRET"),
    supabaseUrl: get("SUPABASE_URL").replace(/\/+$/, ""),
    dbKey: get("AZERDEX_WORKER_DB_KEY") || get("SUPABASE_SERVICE_ROLE_KEY"),
    // The sender, reply-to, subject and destination are fixed in code/secrets, never taken from a request or a database row.
    from: DEFAULTS.from,
    replyTo: DEFAULTS.replyTo,
    subject: DEFAULTS.subject,
    ctaUrl: DEFAULTS.ctaUrl,
    templateId: DEFAULTS.templateId,
    maxPerRun,
    sendTimeoutMs: DEFAULTS.sendTimeoutMs,
  };
}

/** Names of required settings that are missing (names only, never values). */
export function missingSettings(c: WorkerConfig): string[] {
  const m: string[] = [];
  if (!c.workerSecret || c.workerSecret.length < 32) m.push("AZERDEX_WORKER_SECRET");
  if (!c.resendApiKey) m.push("RESEND_API_KEY");
  if (!isAllowedDbUrl(c.supabaseUrl)) m.push("SUPABASE_URL");
  if (!c.dbKey) m.push("AZERDEX_WORKER_DB_KEY");
  return m;
}

/** https everywhere; plain http only for the loopback addresses of a local test stack (exact host match, not a prefix). */
export function isAllowedDbUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.username || u.password) return false;
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost");
  } catch {
    return false;
  }
}
