import "server-only";
import { serverEnv, type ServerEnv } from "@/lib/env";
import type { AccountAuthConfig } from "./config";
import { callbackUrlFor } from "./auth-client";
import { cookieNames } from "./session";

/**
 * Per-request account runtime state. Accounts are DISABLED by default (ACCOUNT_AUTH_MODE unset): every /account page and
 * API answers 404 and nothing else runs. When enabled on a hosted deployment the website refuses to serve the account
 * routes (503) unless the protections the specification requires are configured: the distributed rate limiter and a
 * server-side Turnstile secret with its site key. A local developer machine may run without them.
 */
export interface AccountContext {
  cfg: AccountAuthConfig;
  env: ServerEnv;
  https: boolean;
  siteOrigin: string;
  callbackUrl: string;
  cookies: ReturnType<typeof cookieNames>;
  /** Present when Turnstile must be verified on sign-up, resend and recovery. */
  turnstileSecret: string | null;
}

export type AccountRuntime =
  | { state: "disabled" }
  | { state: "unavailable"; reason: "rate_limiter" | "turnstile" | "https" }
  | { state: "ready"; ctx: AccountContext };

export function accountRuntime(): AccountRuntime {
  const env = serverEnv();
  const cfg = env.accountAuth;
  if (!cfg) return { state: "disabled" };
  // Protections are required on EVERY non-local deployment (not only Vercel): a preview on another host is just as public.
  if (env.hosted || env.FOREVERDB_DEPLOYMENT !== "local") {
    if (!env.SITE_URL.startsWith("https://")) return { state: "unavailable", reason: "https" };
    if (env.RATE_LIMIT_BACKEND !== "upstash") return { state: "unavailable", reason: "rate_limiter" };
    if (!env.TURNSTILE_SECRET_KEY || !env.NEXT_PUBLIC_TURNSTILE_SITE_KEY) return { state: "unavailable", reason: "turnstile" };
  }
  const https = env.SITE_URL.startsWith("https://");
  return {
    state: "ready",
    ctx: {
      cfg,
      env,
      https,
      siteOrigin: new URL(env.SITE_URL).origin,
      callbackUrl: callbackUrlFor(env.SITE_URL),
      cookies: cookieNames(https),
      turnstileSecret: env.TURNSTILE_SECRET_KEY ?? null,
    },
  };
}
