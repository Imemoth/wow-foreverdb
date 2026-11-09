import { changes, type Db } from "../db";

/**
 * STAGING-ONLY fault injection for acceptance tests that must not hit the real Discord API (a real rate limit must never be provoked).
 * The owner or operator writes `<kind>:<count>` into the D1 `monitor_state` row `fault_discord`; the next `count` Discord message calls
 * (create or edit of a channel message, nothing else) receive a synthetic response INSTEAD of being sent, and the real client code parses it exactly
 * like a real one (Retry-After handling, retry/backoff, DEAD rows, fallback). Interaction replies are never touched, so operators keep control.
 *
 * Safety: the factory returns undefined for every environment except `staging` (production never builds it), a missing or malformed row injects
 * nothing, a database error injects nothing, and the count is consumed with a compare-and-set so overlapping invocations cannot over-inject.
 */
export const FAULT_KEY = "fault_discord";
export const FAULT_KINDS = ["rate_limited", "server_error", "forbidden"] as const;
export type FaultKind = (typeof FAULT_KINDS)[number];
const isKind = (s: string): s is FaultKind => (FAULT_KINDS as readonly string[]).includes(s);

const CHANNEL_MESSAGE = /^\/api\/v\d+\/channels\/\d{17,20}\/messages(\/\d{17,20})?$/;

export function parseFault(raw: string | null | undefined): { kind: FaultKind; remaining: number } | null {
  if (!raw) return null;
  const m = /^([a-z_]{1,20}):(\d{1,3})$/.exec(raw);
  if (!m || !isKind(m[1]!)) return null;
  const remaining = Number(m[2]);
  return remaining > 0 ? { kind: m[1], remaining } : null;
}

async function takeFault(db: Db): Promise<FaultKind | null> {
  try {
    const row = await db.prepare("select value from monitor_state where key = ?").bind(FAULT_KEY).first<{ value: string }>();
    const fault = parseFault(row?.value);
    if (!fault) return null;
    const r = await db.prepare("update monitor_state set value = ? where key = ? and value = ?").bind(`${fault.kind}:${fault.remaining - 1}`, FAULT_KEY, row!.value).run();
    return changes(r) === 1 ? fault.kind : null;
  } catch { return null; }
}

const synthetic = (kind: FaultKind): Response => {
  const json = { "content-type": "application/json" };
  if (kind === "rate_limited") return new Response(JSON.stringify({ message: "You are being rate limited.", retry_after: 20, global: false }), { status: 429, headers: { ...json, "retry-after": "20" } });
  if (kind === "server_error") return new Response(JSON.stringify({ message: "Service unavailable (injected)" }), { status: 503, headers: json });
  return new Response(JSON.stringify({ message: "Missing Access (injected)", code: 50001 }), { status: 403, headers: json });
};

export function createFaultFetch(botEnv: string, db: Db, realFetch: typeof fetch = (input, init) => fetch(input, init)): typeof fetch | undefined {
  if (botEnv !== "staging") return undefined;
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const method = (init?.method ?? "GET").toUpperCase();
    if (method === "POST" || method === "PATCH") {
      let target: URL | null = null;
      try { target = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url); } catch { /* not a URL: pass through */ }
      if (target && target.hostname === "discord.com" && CHANNEL_MESSAGE.test(target.pathname)) {
        const kind = await takeFault(db);
        if (kind) return synthetic(kind);
      }
    }
    return realFetch(input, init);
  }) as typeof fetch;
}
