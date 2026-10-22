// Sends one planned e-mail through Resend using a published template plus the inline CID emblem. Outcomes only: no body, address or token is kept.
import type { HookConfig } from "./config.ts";
import type { Logo } from "./logo.ts";
import { LOGO_CONTENT_ID, LOGO_FILENAME } from "./logo.ts";
import type { PlannedEmail } from "./actions.ts";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export const RESEND_ENDPOINT = "https://api.resend.com/emails";

export type SendResult = { ok: true } | { ok: false; transient: boolean; code: string };

export function buildBody(cfg: HookConfig, m: PlannedEmail, logo: Logo) {
  return {
    from: cfg.from,
    to: [m.to],
    reply_to: cfg.replyTo,
    subject: m.subject,
    template: { id: m.template, variables: m.variables },
    attachments: [{ filename: LOGO_FILENAME, content: logo.base64, content_type: "image/png", content_id: LOGO_CONTENT_ID }],
  };
}

export async function sendAuthEmail(args: { fetch: FetchLike; cfg: HookConfig; message: PlannedEmail; logo: Logo; idempotencyKey: string }): Promise<SendResult> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), args.cfg.sendTimeoutMs);
  try {
    const res = await args.fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${args.cfg.resendApiKey}`, "content-type": "application/json", "idempotency-key": args.idempotencyKey },
      body: JSON.stringify(buildBody(args.cfg, args.message, args.logo)),
      signal: ctl.signal,
      redirect: "error",
    });
    if (res.status === 200 || res.status === 201) {
      try {
        const j = (await res.json()) as { id?: unknown };
        if (typeof j?.id === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(j.id)) return { ok: true };
      } catch (e) {
        if ((e as Error)?.name === "AbortError") return { ok: false, transient: true, code: "provider_timeout" };
      }
      return { ok: false, transient: true, code: "provider_malformed_response" };
    }
    await res.body?.cancel().catch(() => {});
    if (res.status === 429) return { ok: false, transient: true, code: "provider_rate_limited" };
    if (res.status >= 500 || res.status === 408 || res.status === 409 || res.status === 423 || res.status === 425) return { ok: false, transient: true, code: "provider_5xx" };
    if (res.status === 401 || res.status === 403) return { ok: false, transient: false, code: "provider_auth" };
    return { ok: false, transient: false, code: "provider_rejected" };
  } catch (e) {
    return { ok: false, transient: true, code: (e as Error)?.name === "AbortError" ? "provider_timeout" : "provider_transport" };
  } finally {
    clearTimeout(timer);
  }
}
