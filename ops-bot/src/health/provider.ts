import { type HealthSnapshot } from "./contract";

export type ProviderFailureClass = "auth" | "rate_limited" | "server" | "timeout" | "network" | "contract" | "stale" | "bad_response";

export type ProviderResult =
  | { ok: true; snapshot: HealthSnapshot }
  | { ok: false; failure: ProviderFailureClass; httpStatus?: number; retryAfterMs?: number };

/**
 * The ONLY capability the bot has toward Supabase: fetch one read-only snapshot. There is intentionally no
 * write, no SQL and no credential for the database. A Supabase outage is a ProviderResult failure, never an exception.
 */
export interface HealthProvider { fetchSnapshot(): Promise<ProviderResult> }

export const RETRYABLE: ReadonlySet<ProviderFailureClass> = new Set(["rate_limited", "server", "timeout", "network"]);
