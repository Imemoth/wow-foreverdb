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
