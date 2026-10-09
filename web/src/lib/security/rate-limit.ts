import { z } from "zod";

/**
 * Layered, distributed fixed-window rate limiting.
 *
 * Every limited request increments up to three counters in ONE round trip:
 * per-IP (hashed), per-session (if a valid session cookie exists) and a
 * per-route global budget. The request is rejected if ANY counter exceeds its
 * limit. Counters live in a shared store (Upstash Redis REST) so limits hold
 * across serverless instances; the in-memory store exists only for local
 * development and tests and is refused in production by env.ts.
 *
 * These budgets are entirely separate from the Companion's Supabase budgets:
 * website traffic never reaches the production database at all.
 */

export const RULE_NAMES = ["api_search", "api_detail", "page_db"] as const;
export type RuleName = (typeof RULE_NAMES)[number];

const Rule = z.object({
  windowSec: z.number().int().min(10).max(3600),
  perIp: z.number().int().min(1).max(100_000),
  perSession: z.number().int().min(1).max(100_000),
  global: z.number().int().min(1).max(10_000_000),
  /** Soft threshold: above this, an unverified client must pass a challenge (if configured). */
  challengeAt: z.number().int().min(1).optional(),
}).strict();
export type Rule = z.infer<typeof Rule>;

/** Conservative defaults; capacity assumptions are documented in docs/web/api-contract.md. */
export const DEFAULT_RULES: Record<RuleName, Rule> = {
  api_search: { windowSec: 60, perIp: 30, perSession: 30, global: 3_000, challengeAt: 20 },
  api_detail: { windowSec: 60, perIp: 120, perSession: 120, global: 10_000 },
  page_db: { windowSec: 60, perIp: 90, perSession: 90, global: 15_000, challengeAt: 60 },
};

export function loadRules(json: string | undefined): Record<RuleName, Rule> {
  if (!json) return DEFAULT_RULES;
  const parsed = z.record(z.enum(RULE_NAMES), Rule.partial()).parse(JSON.parse(json));
  const out = { ...DEFAULT_RULES };
  for (const name of RULE_NAMES) out[name] = Rule.parse({ ...DEFAULT_RULES[name], ...(parsed[name] ?? {}) });
  return out;
}

/** Map a request path to the rule that protects it (null = not app-limited). */
export function classify(pathname: string): RuleName | null {
  if (pathname === "/api/v1/search") return "api_search";
  if (pathname.startsWith("/api/v1/")) return pathname === "/api/v1/challenge" ? null : "api_detail";
  if (pathname === "/database" || /^\/(item|creature|object|fishing|zone)\//.test(pathname)) return "page_db";
  return null;
}

export interface Counter { key: string; limit: number }

export interface CounterStore {
  /** Atomically increments every key, returning the new counts in order. */
  incr(keys: string[], ttlSec: number): Promise<number[]>;
}

export class MemoryStore implements CounterStore {
  private counts = new Map<string, { n: number; exp: number }>();
  async incr(keys: string[], ttlSec: number): Promise<number[]> {
    const now = Date.now();
    if (this.counts.size > 50_000) for (const [k, v] of this.counts) if (v.exp < now) this.counts.delete(k);
    return keys.map((k) => {
      const cur = this.counts.get(k);
      const next = cur && cur.exp > now ? { n: cur.n + 1, exp: cur.exp } : { n: 1, exp: now + ttlSec * 1000 };
      this.counts.set(k, next);
      return next.n;
    });
  }
}

export class UpstashStore implements CounterStore {
  constructor(private url: string, private token: string, private timeoutMs = 800) {}
  async incr(keys: string[], ttlSec: number): Promise<number[]> {
    const commands = keys.flatMap((k) => [["INCR", k], ["EXPIRE", k, String(ttlSec), "NX"]]);
    const res = await fetch(`${this.url.replace(/\/$/, "")}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(this.timeoutMs),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`rate_limit_store_http_${res.status}`);
    const body = (await res.json()) as { result?: unknown; error?: string }[];
    return keys.map((_, i) => {
      const r = body[i * 2];
      if (!r || r.error || typeof r.result !== "number") throw new Error("rate_limit_store_bad_reply");
      return r.result;
    });
  }
}

export interface Identity { ipHash: string; sessionId: string | null; challengePassed: boolean }

export type Decision =
  | { allowed: true; remaining: number; limit: number; resetSec: number }
  | { allowed: false; reason: "rate_limited" | "challenge_required"; retryAfterSec: number; limit: number };

export async function checkRateLimit(
  store: CounterStore,
  ruleName: RuleName,
  rule: Rule,
  id: Identity,
  opts: { challengeEnabled: boolean; nowMs?: number },
): Promise<Decision> {
  const now = opts.nowMs ?? Date.now();
  const window = Math.floor(now / 1000 / rule.windowSec);
  const resetSec = Math.max(1, Math.ceil((window + 1) * rule.windowSec - now / 1000));
  const counters: Counter[] = [
    { key: `rl:${ruleName}:ip:${id.ipHash}:${window}`, limit: rule.perIp },
    { key: `rl:${ruleName}:global:${window}`, limit: rule.global },
  ];
  if (id.sessionId) counters.push({ key: `rl:${ruleName}:sid:${id.sessionId}:${window}`, limit: rule.perSession });
  const counts = await store.incr(counters.map((c) => c.key), rule.windowSec * 2);
  const exceeded = counters.some((c, i) => (counts[i] ?? Infinity) > c.limit);
  if (exceeded) return { allowed: false, reason: "rate_limited", retryAfterSec: resetSec, limit: rule.perIp };
  const ipCount = counts[0] ?? 0;
  if (opts.challengeEnabled && rule.challengeAt && !id.challengePassed && ipCount > rule.challengeAt) {
    return { allowed: false, reason: "challenge_required", retryAfterSec: resetSec, limit: rule.challengeAt };
  }
  return { allowed: true, remaining: Math.max(0, rule.perIp - ipCount), limit: rule.perIp, resetSec };
}

const SESSION_RE = /^[A-Za-z0-9_-]{22}$/;
export function validSessionId(v: string | undefined | null): string | null {
  return v && SESSION_RE.test(v) ? v : null;
}
