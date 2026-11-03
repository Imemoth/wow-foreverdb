import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";
import { collectNews, type ApplySyncPayload } from "./collector.ts";

const encoder = new TextEncoder();

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

async function applySync(payload: ApplySyncPayload): Promise<{ inserted: number; updated: number }> {
  const databaseUrl = Deno.env.get("NEWS_DATABASE_URL");
  if (!databaseUrl) throw new Error("NEWS_DATABASE_URL is not configured");
  const client = new Client(databaseUrl);
  await client.connect();
  try {
    const result = await client.queryObject<{ result: { inserted: number; updated: number } }>(
      "select pub_admin.news_apply_sync($1::jsonb) as result",
      [payload],
    );
    return result.rows[0]?.result ?? { inserted: 0, updated: 0 };
  } finally {
    await client.end();
  }
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const expected = Deno.env.get("AZERDEX_NEWS_COLLECTOR_SECRET");
  const provided = request.headers.get("x-azerdex-news-secret");
  if (!expected || !provided || !constantTimeEqual(provided, expected)) return json({ error: "unauthorized" }, 401);

  let body: { mode?: "normal" | "revision"; sourceKeys?: string[] } = {};
  try { body = await request.json(); } catch { /* default to normal mode */ }
  const reports = await collectNews({
    sources: [],
    sourceKeys: Array.isArray(body.sourceKeys) ? body.sourceKeys : undefined,
    mode: body.mode === "revision" ? "revision" : "normal",
    apply: applySync,
  });
  const failed = reports.filter((report) => report.status === "failed");
  return json({ ok: failed.length === 0, reports }, failed.length ? 207 : 200);
});
