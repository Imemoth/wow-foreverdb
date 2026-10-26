// Supabase Auth "Send Email" hook (HTTPS) -> published Resend templates. Replaces the SMTP delivery path while the hook is enabled in the dashboard
// (Authentication -> Hooks); disabling the hook there returns Auth to its configured SMTP immediately (rollback). Supabase Auth remains responsible for
// accounts, identity and token validity: this function only renders and delivers what Auth asked it to send.
// verify_jwt = false is REQUIRED (the caller is Auth, not a user); authentication is the Standard Webhooks signature below, fail-closed.
import { loadConfig, missingSettings } from "./config.ts";
import { HookError, planEmails } from "./actions.ts";
import { LogoError, validateLogo, type Logo } from "./logo.ts";
import { LOGO_PNG_BASE64 } from "./logo-data.ts";
import { sendAuthEmail, type FetchLike } from "./send.ts";
import { verifyWebhook } from "./webhook.ts";

const MAX_BODY_BYTES = 64 * 1024;

type Log = (event: string, fields: Record<string, string | number>) => void;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
/** The error contract Supabase Auth expects from a hook. The text is fixed; payload data (addresses, tokens, URLs) never appears in it. */
const hookError = (status: number, message: string) => json(status, { error: { http_code: status, message } });

export function embeddedLogoBytes(): Uint8Array {
  const bin = atob(LOGO_PNG_BASE64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function handle(req: Request, env: { get(n: string): string | undefined }, io: FetchLike, log: Log, loadLogoBytes: () => Uint8Array | null = embeddedLogoBytes): Promise<Response> {
  const cfg = loadConfig(env);
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  const missing = missingSettings(cfg);
  if (missing.length > 0) {
    log("hook_misconfigured", { missing: missing.length });
    return hookError(500, "email_hook_not_configured");
  }
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return json(413, { error: "too_large" });
  // Authenticate BEFORE parsing or acting on anything.
  if (!(await verifyWebhook(raw, req.headers, cfg.hookSecret))) {
    log("hook_unauthorized", {});
    return json(401, { error: "unauthorized" });
  }
  let logo: Logo;
  try {
    logo = validateLogo(loadLogoBytes());
  } catch (e) {
    log("logo_invalid", { code: e instanceof LogoError ? e.code : "logo_unreadable" });
    return hookError(500, "email_hook_failed");
  }
  let action = "unknown";
  try {
    const ev = JSON.parse(raw);
    action = typeof ev?.email_data?.email_action_type === "string" ? String(ev.email_data.email_action_type).slice(0, 40) : "unknown";
    const messages = planEmails(ev, cfg);
    const webhookId = req.headers.get("webhook-id") ?? "";
    for (let i = 0; i < messages.length; i++) {
      // The webhook id is stable across Auth's retries of the same event, so a retry cannot deliver a second copy within Resend's window.
      const r = await sendAuthEmail({ fetch: io, cfg, message: messages[i], logo, idempotencyKey: `azerdex-auth:${webhookId}:${i}` });
      if (!r.ok) {
        log("send_failed", { action, code: r.code, sent_before: i });
        return hookError(r.transient ? 503 : 500, r.transient ? "email_temporarily_unavailable" : "email_hook_failed");
      }
    }
    log("sent", { action, count: messages.length });
    return json(200, {});
  } catch (e) {
    if (e instanceof HookError) {
      log("rejected", { action, status: e.status, reason: e.message });
      return hookError(e.status, e.message);
    }
    log("hook_failed", { action, code: String((e as Error)?.name ?? "error").slice(0, 40) });
    return hookError(500, "email_hook_failed");
  }
}

declare const Deno: { env: { get(n: string): string | undefined }; serve(h: (r: Request) => Promise<Response> | Response): void };

if (typeof Deno !== "undefined" && typeof Deno.serve === "function") {
  Deno.serve((req) =>
    handle(req, Deno.env, (u, i) => fetch(u, i), (event, fields) => console.log(JSON.stringify({ fn: "azerdex-auth-email", event, ...fields }))).catch(() => hookError(500, "email_hook_failed")),
  );
}
