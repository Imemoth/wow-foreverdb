/**
 * Portable database I/O for the publication pipeline (no driver imports).
 *
 * The same code runs in the Node CLI (node-postgres adapter) and in the Supabase Edge Function
 * (postgres.js adapter): both hand it an object with `query(text, params)`. Everything here is
 * parameterized SQL with identifiers taken only from the static TABLES map below.
 *
 * Private side : publication_export.* (EXECUTE only, read-only snapshot).
 * Public side  : staging INSERT + pub_admin.* only (role foreverdb_publisher; the Edge Function
 *                assumes it with SET LOCAL ROLE inside each transaction).
 */
import type { PublicationConfig } from "./contract.ts";
import { countsOf, type Projection } from "./project.ts";

export interface SqlClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
export interface ClosableSqlClient extends SqlClient {
  close(): Promise<void>;
}

/** Wraps a client and counts statements (the "total database operations" metric). */
export function counting(client: SqlClient): SqlClient & { ops: () => number } {
  let n = 0;
  return {
    query: (text, params) => {
      n += 1;
      return client.query(text, params);
    },
    ops: () => n,
  };
}

/** Read the whole export in ONE repeatable-read, read-only snapshot. */
export async function readPrivateExport(c: SqlClient, grid: number): Promise<unknown> {
  await c.query("begin isolation level repeatable read read only");
  try {
    const q = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows;
    const [meta] = await q("select * from publication_export.export_meta_v1()");
    const out = {
      meta,
      sources: await q("select * from publication_export.export_sources_v1()"),
      items: await q("select * from publication_export.export_items_v1()"),
      buckets: await q("select * from publication_export.export_buckets_v1()"),
      drops: await q("select * from publication_export.export_drops_v1()"),
      locations: await q("select * from publication_export.export_locations_v1($1::numeric)", [grid]),
    };
    await c.query("commit");
    return out;
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    throw e;
  }
}

type Col = { name: string; type: string };
const cols = (spec: string): Col[] =>
  spec.split(" ").map((s) => {
    const [name, type] = s.split(":") as [string, string];
    return { name, type };
  });

type TableName = keyof Omit<Projection, "contractVersion" | "sourceDataUpdatedAt">;
const TABLES: Record<TableName, Col[]> = {
  items: cols("item_id:bigint name:text name_norm:text source_count:integer total_drops:bigint last_observed_at:timestamptz indexable:boolean"),
  sources: cols("source_type:text source_id:bigint source_level:integer name:text name_norm:text display_kind:text total_observations:bigint last_observed_at:timestamptz indexable:boolean"),
  buckets: cols("source_type:text source_id:bigint source_level:integer loot_kind:text observations:bigint confidence:text"),
  drops: cols("source_type:text source_id:bigint source_level:integer loot_kind:text item_id:bigint drops:bigint quantity:bigint observations:bigint rate:numeric rate_lower:numeric rate_upper:numeric confidence:text dominated:boolean"),
  zones: cols("map_id:bigint zone_name:text observations:bigint source_count:integer item_count:integer"),
  zone_entities: cols("map_id:bigint entity_kind:text item_id:bigint source_type:text source_id:bigint source_level:integer display_kind:text name:text name_norm:text loot_kinds:text[] observations:bigint association:text associated_source_count:integer"),
  locations: cols("source_type:text source_id:bigint source_level:integer loot_kind:text map_id:bigint subzone_name:text x:numeric y:numeric observations:bigint"),
  search_index: cols("entity_kind:text display_kind:text item_id:bigint source_type:text source_id:bigint source_level:integer name:text name_norm:text loot_kinds:text[] map_ids:bigint[] observations:bigint"),
};
// FK-safe insert order.
export const TABLE_ORDER: readonly TableName[] = ["items", "sources", "buckets", "drops", "zones", "zone_entities", "locations", "search_index"];

export const INSERT_CHUNK = 2000;

/**
 * One parameterized insert per chunk. The whole chunk travels as ONE JSON document (a text parameter cast with
 * `$2::text::jsonb`) and is expanded server-side with jsonb_to_recordset: two parameters per statement, no
 * string-built SQL values, identifiers only from the static TABLES map. Passing JSON as text (instead of typed array
 * parameters) keeps node-postgres and postgres.js byte-for-byte equivalent: postgres.js infers a parameter type from the
 * JS value and, for example, would type a boolean[] parameter as boolean.
 */
export function buildInsert(table: TableName, publicationId: number, chunk: Record<string, unknown>[]): { sql: string; params: unknown[] } {
  const columns = TABLES[table];
  const rows = chunk.map((r) => {
    const o: Record<string, unknown> = {};
    for (const col of columns) o[col.name] = r[col.name] ?? (col.type.endsWith("[]") ? [] : null);
    return o;
  });
  const names = columns.map((c) => c.name);
  const sql = `insert into pub.${table} (publication_id, ${names.join(", ")})
          select $1::bigint, ${names.map((n) => `u.${n}`).join(", ")}
          from jsonb_to_recordset($2::text::jsonb) as u(${columns.map((c) => `${c.name} ${c.type}`).join(", ")})`;
  return { sql, params: [publicationId, JSON.stringify(rows)] };
}

export type WriteOutcome = "activated" | "duplicate" | "busy";

export interface WriteMeta {
  workerVersion: string;
  exportedAt: string | null;
  sha256: string;
  config: PublicationConfig;
  allowShrink: boolean;
  /** Role assumed with SET LOCAL ROLE in every transaction (Edge Function). Null = the login role itself (CLI). */
  setRole: string | null;
  /** Run everything, including finalize/activation, then ROLLBACK: a full rehearsal that persists nothing. */
  rollback: boolean;
  /** Abort (and roll back) when the run has used this many ms since `startedAt`. */
  wallBudgetMs: number;
  startedAt: number;
  now: () => number;
  chunkSize?: number;
}

export interface WriteResult {
  outcome: WriteOutcome;
  /** Rehearsal only: what a real run would have done. */
  wouldBe?: "activated" | "duplicate";
  publicationId: number | null;
  rows: number;
  /** ms spent in staging inserts (the "public database write" phase) and in finalize+activation. */
  writeMs: number;
  activateMs: number;
  /** True when the publication was recognised as unchanged before any row was written. */
  precheckDuplicate: boolean;
}

const ROLE_RE = /^[a-z_][a-z0-9_]{0,62}$/;

async function enterRole(c: SqlClient, role: string | null) {
  if (!role) return;
  if (!ROLE_RE.test(role)) throw new Error("invalid role name");
  await c.query(`set local role ${role}`);
}

/**
 * Write the projection and finalize it in ONE transaction. Any error rolls the whole publication
 * back; readers keep seeing the previous active version. Overlapping runs are refused (try-lock),
 * never queued.
 */
export async function writePublication(c: SqlClient, projection: Projection, meta: WriteMeta): Promise<WriteResult> {
  const chunkSize = meta.chunkSize ?? INSERT_CHUNK;
  await c.query("begin");
  try {
    await enterRole(c, meta.setRole);
    await c.query("set local statement_timeout = '120s'");
    const lock = await c.query("select pg_try_advisory_xact_lock(hashtext('foreverdb_publication')) as ok");
    if (lock.rows[0]?.ok !== true) {
      await c.query("rollback");
      return { outcome: "busy", publicationId: null, rows: 0, writeMs: 0, activateMs: 0, precheckDuplicate: false };
    }

    // Unchanged content is recognised BEFORE anything is written (a no-change run is a handful of statements).
    const status = (await c.query("select pub_admin.status() as s")).rows[0]?.s as
      | { active: number | null; publications: { id: number; sha: string | null }[] }
      | undefined;
    const activeSha = status?.active != null ? status.publications.find((p) => p.id === status.active)?.sha ?? null : null;
    if (activeSha && activeSha === meta.sha256) {
      await c.query("rollback");
      return { outcome: "duplicate", wouldBe: "duplicate", publicationId: status?.active ?? null, rows: 0, writeMs: 0, activateMs: 0, precheckDuplicate: true };
    }

    const { rows } = await c.query("select pub_admin.begin_publication($1, $2, $3, $4::text::jsonb) as id", [
      meta.workerVersion,
      meta.exportedAt ?? new Date().toISOString(),
      projection.sourceDataUpdatedAt,
      JSON.stringify({ thresholds: meta.config.thresholds, locationGrid: meta.config.locationGrid }),
    ]);
    const publicationId = Number(rows[0]?.id);

    const t0 = meta.now();
    let total = 0;
    for (const table of TABLE_ORDER) {
      const data = projection[table] as unknown as Record<string, unknown>[];
      for (let i = 0; i < data.length; i += chunkSize) {
        if (meta.now() - meta.startedAt > meta.wallBudgetMs) throw new Error("wall_budget_exceeded");
        const { sql, params } = buildInsert(table, publicationId, data.slice(i, i + chunkSize));
        await c.query(sql, params);
      }
      total += data.length;
    }
    const writeMs = meta.now() - t0;

    const t1 = meta.now();
    const fin = await c.query("select pub_admin.finalize_publication($1, $2, $3::text::jsonb, $4, $5) as outcome", [
      publicationId,
      meta.sha256,
      JSON.stringify(countsOf(projection)),
      meta.allowShrink,
      meta.config.retainPublications,
    ]);
    const outcome = fin.rows[0]?.outcome as "activated" | "duplicate";
    const activateMs = meta.now() - t1;

    if (meta.rollback) {
      await c.query("rollback");
      return { outcome: outcome === "duplicate" ? "duplicate" : "activated", wouldBe: outcome, publicationId, rows: total, writeMs, activateMs, precheckDuplicate: false };
    }
    await c.query("commit");
    return { outcome, publicationId, rows: total, writeMs, activateMs, precheckDuplicate: false };
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    throw e;
  }
}

// ---- run log + lease (pub_admin, migration 0003) ------------------------------------------------

async function inRole<T>(c: SqlClient, role: string | null, fn: () => Promise<T>): Promise<T> {
  await c.query("begin");
  try {
    await enterRole(c, role);
    const v = await fn();
    await c.query("commit");
    return v;
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    throw e;
  }
}

export function acquireLease(c: SqlClient, role: string | null, holder: string, ttlSeconds: number): Promise<boolean> {
  return inRole(c, role, async () => (await c.query("select pub_admin.acquire_lease($1, $2) as ok", [holder, ttlSeconds])).rows[0]?.ok === true);
}

export function releaseLease(c: SqlClient, role: string | null, holder: string): Promise<void> {
  return inRole(c, role, async () => void (await c.query("select pub_admin.release_lease($1)", [holder])));
}

export interface RunRecord {
  trigger: string;
  mode: string;
  outcome: string;
  publicationId: number | null;
  errorClass: string | null;
  errorDetail: Record<string, unknown> | null;
  workerVersion: string;
  startedAt: string;
  sourceDataUpdatedAt: string | null;
  contentSha256: string | null;
  metrics: Record<string, unknown>;
}

export function recordRun(c: SqlClient, role: string | null, r: RunRecord): Promise<number> {
  return inRole(c, role, async () =>
    Number(
      (
        await c.query("select pub_admin.record_run($1,$2,$3,$4,$5,$6::text::jsonb,$7,$8::timestamptz,$9::timestamptz,$10,$11::text::jsonb) as id", [
          r.trigger, r.mode, r.outcome, r.publicationId, r.errorClass,
          r.errorDetail ? JSON.stringify(r.errorDetail) : null,
          r.workerVersion, r.startedAt, r.sourceDataUpdatedAt, r.contentSha256, JSON.stringify(r.metrics),
        ])
      ).rows[0]?.id,
    ),
  );
}

export function verifyInvokeToken(c: SqlClient, role: string | null, token: string): Promise<boolean> {
  return inRole(c, role, async () => (await c.query("select pub_ops.verify_invoke_token($1) as ok", [token])).rows[0]?.ok === true);
}
