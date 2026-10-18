/** User-facing texts for the machine error codes the account API returns. Isomorphic; no Auth text is ever shown. */
export const ERROR_MESSAGES: Record<string, string> = {
  invalid_credentials: "The email or password is incorrect, or the email address has not been confirmed yet.",
  too_many_attempts: "Too many sign-in attempts for this address. Please wait a few minutes and try again.",
  rate_limited: "Too many requests. Please wait a minute and try again.",
  weak_password: "That password is not accepted. Choose a longer, less common password.",
  same_password: "Choose a password that is different from your current one (a reset must change it).",
  invalid_input: "Please check the highlighted fields and try again.",
  already_signed_in: "You are already signed in on this browser. Sign out first, then open the link again.",
  invalid_or_expired: "This link is invalid or has expired. Links work once; request a new one.",
  recovery_required: "Your password-reset link has expired. Request a new one.",
  challenge_required: "Please complete the human check and try again.",
  challenge_failed: "The human check failed. Please try again.",
  challenge_unavailable: "The human check is temporarily unavailable. Please try again shortly.",
  csrf: "Your page was open too long. Please reload it and try again.",
  forbidden: "This request was refused. Reload the page and try again.",
  account_unavailable: "Accounts are temporarily unavailable.",
  temporarily_unavailable: "The sign-in service is temporarily unavailable. Please try again shortly.",
  network: "Could not reach the server. Check your connection and try again.",
  revocation_incomplete: "Your password was changed, but we could not confirm that all other sessions were signed out. Your account is not fully secured yet: press \"Finish securing my account\".",
  unauthenticated: "Your session has ended. Please sign in again.",
  no_pending_reset: "There is nothing to finish in this browser. Set a new password instead.",
};

/** Installation-linking answers (kept apart from the sign-in texts: the same code can mean something else there). */
export const LINK_MESSAGES: Record<string, string> = {
  invalid_code_format: "That is not a valid linking code. It has 32 letters and digits (0-9, A-F); copy it again from the Companion's ACCOUNT tab.",
  reauth_failed: "The password is incorrect. Enter the password of the account shown above.",
  invalid_claim: "This code could not be used. It may be wrong, expired, already used, or replaced by a newer one. Generate a new code in the Companion and try again.",
  account_limit: "This account already has the maximum number of linked installations (50). The code was not used.",
  too_many_attempts: "Too many attempts for this account. Please wait a while and try again.",
  rate_limited: "Too many requests. Please wait a while and try again.",
  outcome_unknown: "We could not confirm whether the installation was linked. Do not retry the same code: check your installations to see the result.",
  unauthenticated: "Your session has ended. Please sign in again.",
  revocation_incomplete: "Your password was changed, but we could not confirm that all other sessions were signed out. Your account is not fully secured yet: press \"Finish securing my account\".",
  account_changed: "Your session changed while this page was open. Reload the page and check which account is shown.",
  forbidden: "This request was refused. Reload the page and try again.",
  csrf: "Your page was open too long. Please reload it and try again.",
  invalid_input: "Please check the fields and try again.",
  temporarily_unavailable: "The service is temporarily unavailable. Please try again shortly.",
  network: "Could not reach the server. Check your connection, then check your installations before trying again.",
};

export function linkMessageFor(code: unknown): string {
  return (typeof code === "string" && LINK_MESSAGES[code]) || "Something went wrong. Please try again.";
}

export const PAIRING_MESSAGES: Record<string, string> = {
  expired: "This pairing request has expired. Start a new pairing request in the Companion.",
  already_decided: "This pairing request was already approved or denied. Reload to see its current state.",
  cannot_connect_to_this_account: "This computer cannot be connected to the account shown on this page.",
  pairing_not_available: "This pairing request is no longer available. Start a new request in the Companion.",
  account_changed: "Your session changed while this page was open. Reload the page and check which account is shown.",
  csrf: "Your session changed while this page was open. Reload the page and check which account is shown.",
  unauthenticated: "Your session has ended. Sign in again, then restart pairing from the Companion.",
  forbidden: "This request was refused. Reload the page before trying again.",
  rate_limited: "Too many pairing attempts. Wait a minute before trying again.",
  temporarily_unavailable: "Pairing is temporarily unavailable. Reload in a moment.",
  outcome_unknown: "We could not confirm the result. Do not repeat the action; reload this page to check the pairing state.",
  network: "We could not confirm the result. Check your connection, then reload this page before taking another action.",
};

export function pairingMessageFor(code: unknown): string {
  return (typeof code === "string" && PAIRING_MESSAGES[code]) || "The pairing request could not be completed. Reload the page and try again.";
}

export function messageFor(code: unknown): string {
  return (typeof code === "string" && ERROR_MESSAGES[code]) || "Something went wrong. Please try again.";
}

export const LOGIN_REASONS: Record<string, { text: string; tone: "info" | "warn" }> = {
  expired: { text: "Your session has expired. Please sign in again.", tone: "warn" },
  signed_out: { text: "You have been signed out.", tone: "info" },
  password_reset: { text: "Your password was changed and every other session was signed out, including the Companion (sign in there again). Sign in here with the new password.", tone: "info" },
  unavailable: { text: "Sign-in is temporarily unavailable. Please try again shortly.", tone: "warn" },
};

/**
 * Device registry / activation-file answers (zero-touch enrollment). The keys are also the ONLY notice codes the page accepts from
 * `?notice=` (a closed list: arbitrary text in the URL is never shown).
 */
export const DEVICE_MESSAGES: Record<string, string> = {
  ticket_limit: "You already have 5 unused activation files (or created 10 in the last hour). Revoke one you no longer need, or wait until one expires, then try again.",
  outcome_unknown: "We could not confirm whether the activation file was created, and its content did not reach you. Check the list below, then simply download a new file (an unused one can be revoked).",
  not_available: "This item could not be revoked. It may already be used, revoked or expired. Reload the list to see its current state.",
  rate_limited: "Too many requests. Please wait a minute and try again.",
  unauthenticated: "Your session has ended. Please sign in again.",
  forbidden: "This request was refused. Reload the page and try again.",
  csrf: "Your page was open too long. Please reload it and try again.",
  invalid_input: "That request was not valid. Reload the page and try again.",
  temporarily_unavailable: "The service is temporarily unavailable. Please try again shortly.",
  account_unavailable: "Accounts are temporarily unavailable.",
  network: "Could not reach the server. Check your connection, then check the list before trying again.",
  error: "Something went wrong. Please try again.",
};

export function deviceMessageFor(code: unknown): string {
  return (typeof code === "string" && Object.hasOwn(DEVICE_MESSAGES, code) && DEVICE_MESSAGES[code]) || DEVICE_MESSAGES.error!;
}
