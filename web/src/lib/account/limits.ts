import "server-only";
import { MemoryStore, UpstashStore, type CounterStore } from "@/lib/security/rate-limit";
import type { ServerEnv } from "@/lib/env";
import { hmacB64 } from "./crypto";

/**
 * Per-address throttles for the account routes (the per-IP edge budget lives in proxy.ts).
 *
 * The counter key is an HMAC of the normalised e-mail address (key derived from ACCOUNT_CSRF_SECRET), so the shared
 * store never holds an address. Every attempt counts the same whether or not the address has an account, and an
 * exhausted budget is answered exactly like a normal success (sign-up, recovery, resend) or like any other login
 * failure (login), so a throttle can never become an existence oracle. A throttle that cannot be evaluated (store
 * outage) refuses the request (fail closed).
 */
export type EmailAction = "register" | "resend" | "recover" | "login";

export const EMAIL_LIMITS: Record<EmailAction, { windowSec: number; max: number }> = {
  register: { windowSec: 3600, max: 5 },
  resend: { windowSec: 3600, max: 3 },
  recover: { windowSec: 3600, max: 3 },
  login: { windowSec: 900, max: 10 },
};

let store: CounterStore | null = null;
function counters(env: ServerEnv): CounterStore {
  if (!store) {
    store = env.RATE_LIMIT_BACKEND === "upstash" ? new UpstashStore(env.UPSTASH_REDIS_REST_URL!, env.UPSTASH_REDIS_REST_TOKEN!) : new MemoryStore();
  }
  return store;
}

/** Test seam: the rate-limit store the handlers use. */
export function __setAccountStoreForTests(s: CounterStore | null) {
  store = s;
}

export type EmailBudget = "allowed" | "exhausted";

export async function chargeEmail(env: ServerEnv, secret: string, action: EmailAction, email: string, nowMs = Date.now()): Promise<EmailBudget> {
  const { windowSec, max } = EMAIL_LIMITS[action];
  const window = Math.floor(nowMs / 1000 / windowSec);
  const key = `rl:acct:${action}:em:${await hmacB64(secret, "throttle-hash", email)}:${window}`;
  const [n] = await counters(env).incr([key], windowSec * 2); // throws on a store failure: the caller fails closed
  if (n === undefined) throw new Error("rate_limit_store_bad_reply");
  return n > max ? "exhausted" : "allowed";
}

/**
 * Budgets keyed by the VERIFIED account (server-confirmed user id), independent of the per-IP edge budgets and of the
 * database's own budgets (which keep counting wrong codes inside SQL). They bound what one signed-in browser session, or a
 * stolen copy of its cookie, can do from any number of addresses:
 *   - `reauth`: fresh-password confirmations for the installation link (every attempt counts, right or wrong);
 *   - `link`:   claim-code redemptions forwarded to the database (counted only after the password was confirmed).
 */
export type AccountAction = "reauth" | "link";

export const ACCOUNT_LIMITS: Record<AccountAction, { windowSec: number; max: number }> = {
  reauth: { windowSec: 900, max: 5 },
  link: { windowSec: 3600, max: 10 },
};

/** Fixed-window counter per (action, account). Throws on a store failure: the caller fails closed. */
export async function chargeAccount(
  env: ServerEnv,
  secret: string,
  action: AccountAction,
  userId: string,
  nowMs = Date.now(),
): Promise<{ budget: EmailBudget; retryAfterSec: number }> {
  const { windowSec, max } = ACCOUNT_LIMITS[action];
  const nowSec = Math.floor(nowMs / 1000);
  const window = Math.floor(nowSec / windowSec);
  const key = `rl:acct:${action}:uid:${await hmacB64(secret, "throttle-hash", userId.toLowerCase())}:${window}`;
  const [n] = await counters(env).incr([key], windowSec * 2);
  if (n === undefined) throw new Error("rate_limit_store_bad_reply");
  return { budget: n > max ? "exhausted" : "allowed", retryAfterSec: Math.max(1, (window + 1) * windowSec - nowSec) };
}
