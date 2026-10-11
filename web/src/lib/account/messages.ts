/** User-facing texts for the machine error codes the account API returns. Isomorphic; no Auth text is ever shown. */
export const ERROR_MESSAGES: Record<string, string> = {
  invalid_credentials: "The email or password is incorrect, or the email address has not been confirmed yet.",
  too_many_attempts: "Too many sign-in attempts for this address. Please wait a few minutes and try again.",
  rate_limited: "Too many requests. Please wait a minute and try again.",
  weak_password: "That password is not accepted. Choose a longer, less common password.",
  same_password: "Choose a password that is different from your current one.",
  invalid_input: "Please check the highlighted fields and try again.",
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
};

export function messageFor(code: unknown): string {
  return (typeof code === "string" && ERROR_MESSAGES[code]) || "Something went wrong. Please try again.";
}

export const LOGIN_REASONS: Record<string, { text: string; tone: "info" | "warn" }> = {
  expired: { text: "Your session has expired. Please sign in again.", tone: "warn" },
  signed_out: { text: "You have been signed out.", tone: "info" },
  password_reset: { text: "Your password was changed. Sign in with the new password.", tone: "info" },
  unavailable: { text: "Sign-in is temporarily unavailable. Please try again shortly.", tone: "warn" },
};
