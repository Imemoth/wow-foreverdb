import { RETRYABLE, type HealthProvider, type ProviderResult } from "./provider";

export interface RetryPolicy { maxAttempts: number; baseDelayMs: number; maxDelayMs: number; budgetMs: number }
export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 5000, budgetMs: 12_000 };

/**
 * Bounded retry: only transient classes are retried (never auth/contract), `Retry-After` is honoured but capped,
 * and the total time spent sleeping is limited so a cron invocation can never run away.
 */
export async function fetchWithRetry(
  provider: HealthProvider, policy: RetryPolicy = DEFAULT_RETRY,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<{ result: ProviderResult; attempts: number }> {
  let spent = 0;
  let attempts = 0;
  for (;;) {
    attempts++;
    const result = await provider.fetchSnapshot();
    if (result.ok || !RETRYABLE.has(result.failure) || attempts >= policy.maxAttempts) return { result, attempts };
    const backoff = Math.min(policy.baseDelayMs * 2 ** (attempts - 1), policy.maxDelayMs);
    const wait = Math.min(Math.max(backoff, result.retryAfterMs ?? 0), policy.maxDelayMs);
    if (spent + wait > policy.budgetMs) return { result, attempts };
    spent += wait;
    await sleep(wait);
  }
}
