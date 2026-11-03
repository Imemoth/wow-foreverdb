import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";
import {
  collectNews,
  type ApplyResult,
  type ApplySyncPayload,
  type CollectorMode,
  type RevisionContext,
} from "./collector.ts";

const encoder = new TextEncoder();
/** Backfill may only WRITE when the owner has set this server-side variable to "true". Dry-run is always allowed. */
const BACKFILL_APPLY_ENV = "AZERDEX_NEWS_BACKFILL_ENABLED";
const MAX_BACKFILL_DAYS = 31;

function constantTimeEqual(left: string, right: string): boolean {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  let difference = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) difference |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return difference === 0;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

async function withClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const databaseUrl = Deno.env.get("NEWS_DATABASE_URL");
  if (!databaseUrl) throw new Error("NEWS_DATABASE_URL is not configured");
  const client = new Client(databaseUrl);
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

async function applySync(payload: ApplySyncPayload): Promise<ApplyResult> {
  return await withClient(async (client) => {
    const result = await client.queryObject<{ result: ApplyResult }>("select pub_admin.news_apply_sync($1::jsonb) as result", [payload]);
    return result.rows[0]?.result ?? { inserted: 0, updated: 0 };
  });
}

async function loadContext(sourceKey: string): Promise<RevisionContext> {
  return await withClient(async (client) => {
    const result = await client.queryObject<{ result: RevisionContext }>("select pub_admin.news_revision_batch($1, $2) as result", [sourceKey, 40]);
    const raw = result.rows[0]?.result;
    return {
      verifiedStaff: raw?.verifiedStaff ?? [],
      dueTopics: (raw?.dueTopics ?? []).map((topic) => ({ ...topic, officialPostIds: (topic.officialPostIds ?? []).map(String) })),
      knownOrigins: raw?.knownOrigins ?? [],
    };
  });
}

interface RequestBody {
  mode?: string;
  sourceKeys?: string[];
  since?: string;
  until?: string;
  dryRun?: boolean;
}

function backfillWindow(body: RequestBody): { since: string; until: string } | null {
  const since = new Date(body.since ?? "");
  const until = new Date(body.until ?? "");
  if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime()) || since >= until) return null;
  if (until.getTime() - since.getTime() > MAX_BACKFILL_DAYS * 86_400_000) return null;
  return { since: since.toISOString(), until: until.toISOString() };
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const expected = Deno.env.get("AZERDEX_NEWS_COLLECTOR_SECRET");
  const provided = request.headers.get("x-azerdex-news-secret");
  if (!expected || !provided || !constantTimeEqual(provided, expected)) return json({ error: "unauthorized" }, 401);

  let body: RequestBody = {};
  try { body = await request.json(); } catch { /* default to normal mode */ }
  const mode: CollectorMode = body.mode === "revision" ? "revision" : body.mode === "backfill" ? "backfill" : "normal";

  let backfill: { since: string; until: string; dryRun: boolean } | undefined;
  if (mode === "backfill") {
    const window = backfillWindow(body);
    if (!window) return json({ error: "invalid_backfill_window", maxDays: MAX_BACKFILL_DAYS }, 400);
    // Fail safe: anything other than an explicit dryRun:false is a read-only preview.
    const wantsWrite = body.dryRun === false;
    if (wantsWrite && Deno.env.get(BACKFILL_APPLY_ENV) !== "true") return json({ error: "backfill_apply_disabled" }, 403);
    backfill = { ...window, dryRun: !wantsWrite };
  }

  const reports = await collectNews({
    sources: [],
    sourceKeys: Array.isArray(body.sourceKeys) ? body.sourceKeys.filter((key) => typeof key === "string").slice(0, 8) : undefined,
    mode,
    backfill,
    apply: applySync,
    loadContext,
  });
  const failed = reports.filter((report) => report.status === "failed");
  return json({ ok: failed.length === 0, mode, reports }, failed.length ? 207 : 200);
});
