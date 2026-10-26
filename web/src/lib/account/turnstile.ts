import "server-only";
import { z } from "@/lib/zod";

/**
 * Server-side Cloudflare Turnstile verification for the sign-up, resend and recovery routes.
 *
 * WHAT THIS IS: bot protection for requests that go through THE WEBSITE. WHAT IT IS NOT: protection for Supabase Auth.
 * The Companion ships the project URL and publishable key, so anyone can call GoTrue directly and never meet this
 * check (threat A24, open; docs/account-v1/security.md section 3.1). Never describe this as protecting Auth.
 */
export const turnstileToken = z.string().min(10).max(2048);

export type TurnstileVerdict = "passed" | "failed" | "unavailable";

export async function verifyTurnstile(secret: string, token: string, fetchImpl: typeof fetch = fetch): Promise<TurnstileVerdict> {
  const form = new URLSearchParams({ secret, response: token });
  try {
    const r = await fetchImpl("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(5000),
      cache: "no-store",
    });
    if (!r.ok) return "unavailable";
    const body = (await r.json()) as { success?: unknown };
    return body.success === true ? "passed" : "failed";
  } catch {
    return "unavailable"; // fail closed: an unreachable verifier never waves a request through
  }
}
