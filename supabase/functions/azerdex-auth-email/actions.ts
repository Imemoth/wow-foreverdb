// Maps one Supabase Auth Send Email Hook event to the e-mails that must go out. Pure: no I/O, no clock, no secrets.
// Supabase Auth stays the identity authority: the link carries ONLY the one-time `token_hash` Auth itself generated and the action type; the
// website/Edge Function hands them back to Auth's /verify. No token is generated, stored or interpreted here.
import type { HookConfig } from "./config.ts";

/** Failure that maps to the hook error contract `{ error: { http_code, message } }` (message is fixed text, never payload data). */
export class HookError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface PlannedEmail {
  to: string;
  template: string;
  subject: string;
  variables: Record<string, string>;
}

/** Link types the public confirmation page and Auth's /verify accept. */
export const LINK_TYPES = ["signup", "recovery", "invite", "magiclink", "email", "email_change"] as const;
export type LinkType = (typeof LINK_TYPES)[number];

const NOTICE: Record<string, { title: string; message: string }> = {
  password_changed_notification: { title: "Your password was changed.", message: "The password of your AzerDex account was just changed." },
  email_changed_notification: { title: "Your email address was changed.", message: "The email address of your AzerDex account was just changed." },
  phone_changed_notification: { title: "Your phone number was changed.", message: "The phone number of your AzerDex account was just changed." },
  identity_linked_notification: { title: "A sign-in method was linked.", message: "A new sign-in method was just linked to your AzerDex account." },
  identity_unlinked_notification: { title: "A sign-in method was removed.", message: "A sign-in method was just removed from your AzerDex account." },
  mfa_factor_enrolled_notification: { title: "Two-factor sign-in was added.", message: "A new two-factor method was just added to your AzerDex account." },
  mfa_factor_unenrolled_notification: { title: "Two-factor sign-in was removed.", message: "A two-factor method was just removed from your AzerDex account." },
};

/** Every email_action_type Supabase documents. Anything else is refused loudly (never silently dropped, never sent half-built). */
export const HANDLED_ACTIONS = ["signup", "recovery", "invite", "magiclink", "email", "email_change", "reauthentication", ...Object.keys(NOTICE)] as const;

const TOKEN_HASH = /^[A-Za-z0-9_-]{8,128}$/;
const CODE = /^[A-Za-z0-9]{4,12}$/;

/** A recipient Auth already validated; here only the characters that could split a header or an address list are refused. */
export function safeRecipient(a: unknown): a is string {
  return typeof a === "string" && a.length >= 3 && a.length <= 254 && /^[^\s,;<>()"'\\@\u0000-\u001f\u007f]+@[^\s,;<>()"'\\@\u0000-\u001f\u007f]+$/.test(a);
}

export function confirmUrl(cfg: HookConfig, type: LinkType, tokenHash: string): string {
  if (!TOKEN_HASH.test(tokenHash)) throw new HookError(400, "invalid_token_data");
  return `${cfg.linkBase}/auth/confirm?type=${type}&token_hash=${tokenHash}`;
}

interface HookEvent {
  user?: { email?: unknown; new_email?: unknown };
  email_data?: Record<string, unknown>;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

export function planEmails(ev: HookEvent, cfg: HookConfig): PlannedEmail[] {
  const d = ev.email_data ?? {};
  const action = str(d.email_action_type);
  const email = ev.user?.email;
  const newEmail = ev.user?.new_email;
  const need = (a: unknown): string => {
    if (!safeRecipient(a)) throw new HookError(400, "invalid_recipient");
    return a;
  };

  switch (action) {
    case "signup":
      return [{ to: need(email), template: "azerdex-confirm-signup-v1", subject: "Confirm Your Email — Welcome to AzerDex", variables: { CONFIRM_URL: confirmUrl(cfg, "signup", str(d.token_hash)) } }];
    case "recovery":
      return [{ to: need(email), template: "azerdex-reset-password-v1", subject: "Reset Your Password — AzerDex", variables: { RESET_URL: confirmUrl(cfg, "recovery", str(d.token_hash)) } }];
    case "invite":
      return [{ to: need(email), template: "azerdex-auth-link-v1", subject: "You're Invited to AzerDex", variables: { TITLE: "You're invited.", MESSAGE: "You have been invited to create an AzerDex account.", BUTTON_LABEL: "Accept Invitation", CONFIRM_URL: confirmUrl(cfg, "invite", str(d.token_hash)) } }];
    case "magiclink":
    case "email": // Auth's one-time e-mail sign-in
      return [{ to: need(email), template: "azerdex-auth-link-v1", subject: "Your AzerDex Sign-in Link", variables: { TITLE: "Sign in to AzerDex.", MESSAGE: "Use the button below to sign in to your AzerDex account.", BUTTON_LABEL: "Sign In", CONFIRM_URL: confirmUrl(cfg, action, str(d.token_hash)) } }];
    case "reauthentication": {
      const code = str(d.token);
      if (!CODE.test(code)) throw new HookError(400, "invalid_token_data");
      return [{ to: need(email), template: "azerdex-auth-code-v1", subject: "Your AzerDex Verification Code", variables: { CODE: code } }];
    }
    case "email_change": {
      // The field names are reversed for backward compatibility (Supabase docs): `token_hash_new` pairs with the CURRENT address, `token_hash` with the NEW one.
      // With secure e-mail change both pairs exist and BOTH addresses must confirm; otherwise a single message goes to the new address.
      const hashNew = str(d.token_hash_new);
      const hashMain = str(d.token_hash);
      const to = need(newEmail);
      const mk = (recipient: string, hash: string): PlannedEmail => ({
        to: recipient,
        template: "azerdex-email-change-v1",
        subject: "Confirm Your Email Change — AzerDex",
        variables: { CONFIRM_URL: confirmUrl(cfg, "email_change", hash), NEW_EMAIL: to },
      });
      if (hashNew && hashMain) return [mk(need(email), hashNew), mk(to, hashMain)];
      return [mk(to, hashMain || hashNew)];
    }
    default: {
      const n = NOTICE[action];
      if (!n) throw new HookError(400, "unsupported_email_action");
      return [{ to: need(email), template: "azerdex-auth-notice-v1", subject: "Account Notice — AzerDex", variables: { TITLE: n.title, MESSAGE: n.message } }];
    }
  }
}
