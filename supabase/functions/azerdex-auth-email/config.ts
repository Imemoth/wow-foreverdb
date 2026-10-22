// Configuration of the Auth e-mail hook. Read once per request from the Edge Function secrets; nothing is logged.
export interface HookConfig {
  hookSecret: string;
  resendApiKey: string;
  /** Origin of the public confirmation page. Fixed by configuration; the link target is NEVER taken from the Auth payload (`redirect_to`). */
  linkBase: string;
  from: string;
  replyTo: string;
  sendTimeoutMs: number;
}

export const DEFAULTS = {
  linkBase: "https://beta.azerdex.com",
  from: "AzerDex <noreply@azerdex.com>",
  replyTo: "support@azerdex.com",
  sendTimeoutMs: 10_000,
} as const;

/** Only these origins may ever appear in a confirmation link (exact match, https). */
export const ALLOWED_LINK_ORIGINS = ["https://beta.azerdex.com", "https://azerdex.com", "https://www.azerdex.com"] as const;

type Env = { get(name: string): string | undefined };

export function loadConfig(env: Env): HookConfig {
  const get = (n: string) => (env.get(n) ?? "").trim();
  const base = (get("AZERDEX_AUTH_LINK_BASE") || DEFAULTS.linkBase).replace(/\/+$/, "");
  return {
    hookSecret: get("SEND_EMAIL_HOOK_SECRET"),
    resendApiKey: get("RESEND_API_KEY"),
    linkBase: (ALLOWED_LINK_ORIGINS as readonly string[]).includes(base) ? base : "",
    from: DEFAULTS.from,
    replyTo: DEFAULTS.replyTo,
    sendTimeoutMs: DEFAULTS.sendTimeoutMs,
  };
}

/** Names of required settings that are missing or invalid (names only, never values). */
export function missingSettings(c: HookConfig): string[] {
  const m: string[] = [];
  if (!c.hookSecret) m.push("SEND_EMAIL_HOOK_SECRET");
  if (!c.resendApiKey) m.push("RESEND_API_KEY");
  if (!c.linkBase) m.push("AZERDEX_AUTH_LINK_BASE");
  return m;
}
