// Builds the Resend request body. Pure functions: no I/O, no clock, no secrets.
// Dark Arcane Fantasy palette (canonical): #07091C outer, #0D0F33 body, #191A47 panels, #6C41C7 primary CTA, #D9B978 gold.
import type { WorkerConfig } from "./config.ts";
import { LOGO_CONTENT_ID, LOGO_FILENAME, type Logo } from "./logo.ts";

const ALT = "AzerDex rune emblem";

export function renderText(ctaUrl: string): string {
  return [
    "Welcome to AzerDex — Know Your World",
    "",
    "Your AzerDex account is verified and ready.",
    "AzerDex helps you explore the world of WoW: Forever with a searchable, community-built database.",
    "",
    `Explore AzerDex: ${ctaUrl}`,
    "",
    "AzerDex will never ask for your password, a verification code or installation credentials by email.",
    "Questions? Reply to this message or write to support@azerdex.com.",
    "",
    "This is a one-time transactional message about your new account, not a newsletter.",
    "AzerDex is an independent fan project and is not affiliated with Blizzard Entertainment.",
  ].join("\n");
}

export function renderHtml(ctaUrl: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"><title>Welcome to AzerDex</title></head>
<body style="margin:0;padding:0;background-color:#07091C;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#07091C" style="background-color:#07091C;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#0D0F33" style="max-width:560px;background-color:#0D0F33;border:1px solid #D9B978;border-radius:12px;">
<tr><td align="center" style="padding:32px 24px 8px 24px;"><img src="cid:${LOGO_CONTENT_ID}" width="64" height="64" alt="${ALT}" style="display:block;border:0;width:64px;height:64px;color:#D9B978;font-family:Georgia,serif;font-size:16px;"></td></tr>
<tr><td align="center" style="padding:8px 24px 0 24px;font-family:Georgia,'Times New Roman',serif;font-size:14px;letter-spacing:3px;color:#D9B978;">AZERDEX</td></tr>
<tr><td align="center" style="padding:16px 24px 8px 24px;font-family:Georgia,'Times New Roman',serif;font-size:26px;line-height:32px;color:#F4F1FF;">Welcome — Know Your World</td></tr>
<tr><td align="center" style="padding:0 28px 20px 28px;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:24px;color:#D8D4F0;">Your AzerDex account is verified and ready. Explore a searchable, community-built database of the world of WoW: Forever.</td></tr>
<tr><td align="center" style="padding:0 24px 24px 24px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td align="center" bgcolor="#6C41C7" style="background-color:#6C41C7;border-radius:8px;"><a href="${ctaUrl}" style="display:inline-block;padding:14px 28px;min-height:20px;font-family:Arial,Helvetica,sans-serif;font-size:16px;font-weight:bold;color:#FFFFFF;text-decoration:none;">Explore AzerDex</a></td></tr></table></td></tr>
<tr><td style="padding:0 24px 24px 24px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#191A47" style="background-color:#191A47;border-radius:8px;"><tr><td style="padding:16px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:21px;color:#D8D4F0;">AzerDex will never ask for your password, a verification code or installation credentials by email. Questions? Reply to this message or write to <a href="mailto:support@azerdex.com" style="color:#D9B978;">support@azerdex.com</a>.</td></tr></table></td></tr>
<tr><td align="center" style="padding:0 24px 28px 24px;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#A9A4CC;">This is a one-time message about your new account, not a newsletter. AzerDex is an independent fan project and is not affiliated with Blizzard Entertainment.<br>Button not working? Open ${ctaUrl}</td></tr>
</table></td></tr></table></body></html>`;
}

/** Plain ASCII addr-spec only: no quoted local parts, display names, commas, angle brackets, whitespace or non-ASCII (IDN users are not welcomed in V1). */
export function isPlainAddress(a: string): boolean {
  return a.length <= 254 && /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/.test(a);
}

export interface ResendPayload {
  [k: string]: unknown;
}

/** `to` is ALWAYS the single recipient the database returned for this claim (re-verified there); it is never taken from a request. */
export function buildPayload(cfg: WorkerConfig, to: string, logo: Logo): ResendPayload {
  const attachments = [{ filename: LOGO_FILENAME, content: logo.base64, content_type: "image/png", content_id: LOGO_CONTENT_ID }];
  const base = { from: cfg.from, to: [to], reply_to: cfg.replyTo, subject: cfg.subject, attachments };
  if (cfg.mode === "template") {
    return { ...base, template: { id: cfg.templateId, variables: { CTA_URL: cfg.ctaUrl } } };
  }
  return { ...base, html: renderHtml(cfg.ctaUrl), text: renderText(cfg.ctaUrl) };
}
