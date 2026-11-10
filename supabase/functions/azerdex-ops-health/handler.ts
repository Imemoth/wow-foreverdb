/**
 * Protected, READ-ONLY health reporting endpoint for the AzerDex Operations Bot (Gate C). Runtime-agnostic: Web APIs only (Request, Response,
 * crypto.subtle, TextEncoder), so the same code is unit-tested in Node and type-checked with Deno. `index.ts` is the thin Deno wiring.
 *
 * Request: `GET`, headers `x-azerdex-ops-timestamp` (epoch seconds) and `x-azerdex-ops-signature` = hex(HMAC-SHA256(secret, "<ts>\nGET\n<path>")).
 * The secret never travels. `<path>` is the CONFIGURED signed path (default `/functions/v1/azerdex-ops-health`), not whatever path the platform
 * shows the function: the bot signs the path of the URL it was given, and binding to a configured constant keeps the check independent of how
 * the hosting layer rewrites paths while still tying the signature to this endpoint.
 *
 * Every authentication failure is the same answer (401, no detail): missing/malformed headers, clock skew beyond 120 s, wrong signature and
 * an unset secret (fail closed). Replay inside the 120 s window can only repeat a read-only report, which is accepted (see the reporting contract).
 *
 * After authentication the report is read through `readReport` (the database role that can run exactly one function), rebuilt from an
 * allow-list of contract v1 fields (anything else is dropped; anything malformed is refused with 502), and returned with `cache-control: no-store`.
 * A database failure or timeout is 503 `unavailable`: the bot then shows UNKNOWN and never reads silence as health. The last good report is
 * reused for 10 seconds so authenticated bursts cannot load the database more than a few times a minute. Nothing is logged: no value, header or error text.
 */
const encoder = new TextEncoder();

export const DEFAULT_SIGNED_PATH = "/functions/v1/azerdex-ops-health";
export const WINDOW_SECONDS = 120;
export const CACHE_MS = 10_000;
export const READ_TIMEOUT_MS = 8_000;

const CODE = /^[a-z0-9][a-z0-9_:.-]{0,79}$/;
const SOURCE_KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const SEVERITIES = ["ok", "info", "warning", "critical"] as const;
const RUN_STATUSES = ["succeeded", "failed", "running", "unknown"] as const;

export interface HandlerDeps {
  /** The shared secret; unset or empty means every request is refused (fail closed). */
  secret: string | undefined;
  signedPath: string;
  now: () => number;
  /** Returns the JSON produced by the database projection. May throw. */
  readReport: () => Promise<unknown>;
  /** Upper bound for one database read; defaults to READ_TIMEOUT_MS. Injectable for tests only. */
  readTimeoutMs?: number;
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let difference = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return difference === 0;
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sign(secret: string, method: string, path: string, timestampSec: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestampSec}\n${method}\n${path}`)));
}

function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra },
  });
}

async function authorised(request: Request, deps: HandlerDeps): Promise<boolean> {
  const secret = deps.secret;
  if (!secret) return false;
  const ts = request.headers.get("x-azerdex-ops-timestamp") ?? "";
  const provided = request.headers.get("x-azerdex-ops-signature") ?? "";
  if (!/^\d{10}$/.test(ts) || !/^[0-9a-f]{64}$/.test(provided)) return false;
  const skew = Math.abs(Math.floor(deps.now() / 1000) - Number(ts));
  if (skew > WINDOW_SECONDS) return false;
  return constantTimeEqual(provided, await sign(secret, "GET", deps.signedPath, Number(ts)));
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isIso = (v: unknown): v is string => typeof v === "string" && ISO.test(v) && !Number.isNaN(Date.parse(v));
const isIsoOrNull = (v: unknown): v is string | null => v === null || isIso(v);
const isIntIn = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

export interface SourceReport {
  sourceKey: string; state: string; severity: (typeof SEVERITIES)[number]; causes: string[];
  lastAttemptAt: string | null; lastFetchOkAt: string | null; minutesSinceAttempt: number | null; consecutiveFailures: number; overdueTopics: number;
}
export interface HealthReport {
  schemaVersion: 1; generatedAt: string; overall: (typeof SEVERITIES)[number]; sources: SourceReport[];
  g6: { jobName: "azerdex-news-health"; present: boolean; active: boolean; schedule: string | null; lastRunAt: string | null; lastRunStatus: (typeof RUN_STATUSES)[number] | null; lastSucceededAt: string | null };
}

/** Rebuilds the report from the contract v1 allow-list. Returns null if anything required is missing or out of range. Extra fields are dropped. */
export function projectReport(raw: unknown): HealthReport | null {
  if (!isRecord(raw) || raw.schemaVersion !== 1 || !isIso(raw.generatedAt)) return null;
  if (!SEVERITIES.includes(raw.overall as never)) return null;
  if (!Array.isArray(raw.sources) || raw.sources.length < 1 || raw.sources.length > 16) return null;
  const sources: SourceReport[] = [];
  for (const s of raw.sources) {
    if (!isRecord(s)) return null;
    if (typeof s.sourceKey !== "string" || !SOURCE_KEY.test(s.sourceKey)) return null;
    if (typeof s.state !== "string" || !CODE.test(s.state)) return null;
    if (!SEVERITIES.includes(s.severity as never)) return null;
    if (!Array.isArray(s.causes) || s.causes.length > 8 || !s.causes.every((c) => typeof c === "string" && CODE.test(c))) return null;
    if (!isIsoOrNull(s.lastAttemptAt) || !isIsoOrNull(s.lastFetchOkAt)) return null;
    if (!(s.minutesSinceAttempt === null || isIntIn(s.minutesSinceAttempt, 0, 10_000_000))) return null;
    if (!isIntIn(s.consecutiveFailures, 0, 1_000_000) || !isIntIn(s.overdueTopics, 0, 1_000_000)) return null;
    sources.push({
      sourceKey: s.sourceKey, state: s.state, severity: s.severity as SourceReport["severity"], causes: [...s.causes] as string[],
      lastAttemptAt: s.lastAttemptAt, lastFetchOkAt: s.lastFetchOkAt, minutesSinceAttempt: s.minutesSinceAttempt as number | null,
      consecutiveFailures: s.consecutiveFailures, overdueTopics: s.overdueTopics,
    });
  }
  const g = raw.g6;
  if (!isRecord(g) || g.jobName !== "azerdex-news-health" || typeof g.present !== "boolean" || typeof g.active !== "boolean") return null;
  if (!(g.schedule === null || (typeof g.schedule === "string" && g.schedule.length <= 40))) return null;
  if (!isIsoOrNull(g.lastRunAt) || !isIsoOrNull(g.lastSucceededAt)) return null;
  if (!(g.lastRunStatus === null || RUN_STATUSES.includes(g.lastRunStatus as never))) return null;
  return {
    schemaVersion: 1, generatedAt: raw.generatedAt, overall: raw.overall as HealthReport["overall"], sources,
    g6: { jobName: "azerdex-news-health", present: g.present, active: g.active, schedule: g.schedule as string | null, lastRunAt: g.lastRunAt, lastRunStatus: g.lastRunStatus as HealthReport["g6"]["lastRunStatus"], lastSucceededAt: g.lastSucceededAt },
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), ms); })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createHandler(deps: HandlerDeps): (request: Request) => Promise<Response> {
  let cached: { at: number; body: string } | null = null;
  let inflight: Promise<{ ok: true; body: string } | { ok: false; status: 502 | 503 }> | null = null;

  const load = async (): Promise<{ ok: true; body: string } | { ok: false; status: 502 | 503 }> => {
    let raw: unknown;
    try { raw = await withTimeout(deps.readReport(), deps.readTimeoutMs ?? READ_TIMEOUT_MS); } catch { return { ok: false, status: 503 }; }
    const report = projectReport(raw);
    if (!report) return { ok: false, status: 502 };
    const body = JSON.stringify(report);
    cached = { at: deps.now(), body };
    return { ok: true, body };
  };

  return async (request: Request): Promise<Response> => {
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405, { allow: "GET" });
    if (!(await authorised(request, deps))) return json({ error: "unauthorized" }, 401);

    if (cached && deps.now() - cached.at < CACHE_MS) return new Response(cached.body, { status: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
    inflight ??= load().finally(() => { inflight = null; });
    const result = await inflight;
    if (!result.ok) return json({ error: result.status === 503 ? "unavailable" : "invalid_report" }, result.status);
    return new Response(result.body, { status: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  };
}
