/**
 * Database I/O for the publication worker.
 *
 * Credentials (two SEPARATE secrets, never shared with the website runtime):
 *   PRIVATE_EXPORT_DATABASE_URL  role foreverdb_projection_reader (EXECUTE on
 *                                publication_export.* only, read-only)
 *   PUBLIC_PUBLISHER_DATABASE_URL role foreverdb_publisher (staging INSERT +
 *                                pub_admin.begin/finalize only)
 */
import pg from "pg";
import type { PublicationConfig } from "./contract.js";
import { countsOf, type Projection } from "./project.js";

export function requireUrl(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  if (!/^postgres(ql)?:\/\//.test(v)) throw new Error(`${name} must be a postgres:// URL`);
  return v;
}

function client(url: string, appName: string): pg.Client {
  const local = /@(localhost|127\.0\.0\.1|\/tmp|%2Ftmp)/.test(url) || url.includes("host=/");
  return new pg.Client({
    connectionString: url,
    application_name: appName,
    // Remote databases MUST use TLS. Local ephemeral test databases may not.
    ssl: local ? undefined : { rejectUnauthorized: true },
    statement_timeout: 120_000,
  });
}

/** Read the whole export in ONE repeatable-read, read-only snapshot. */
export async function readPrivateExport(url: string, grid: number): Promise<unknown> {
  const c = client(url, "foreverdb-publisher-export");
  await c.connect();
  try {
    await c.query("begin isolation level repeatable read read only");
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
  } finally {
    await c.end();
  }
}

type Col = { name: string; type: string };
const TABLES: Record<keyof Omit<Projection, "contractVersion" | "sourceDataUpdatedAt">, Col[]> = {
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
const ORDER = ["items", "sources", "buckets", "drops", "zones", "zone_entities", "locations", "search_index"] as const;

function cols(spec: string): Col[] {
  return spec.split(" ").map((s) => {
    const [name, type] = s.split(":") as [string, string];
    return { name, type };
  });
}

export interface PublishResult { outcome: "activated" | "duplicate"; publicationId: number }

/**
 * Write the projection and finalize it in ONE transaction. Any error rolls the
 * whole publication back; readers keep seeing the previous active version.
 */
export async function writePublication(
  url: string,
  projection: Projection,
  meta: { workerVersion: string; exportedAt: string | null; sha256: string; config: PublicationConfig; allowShrink: boolean },
): Promise<PublishResult> {
  const c = client(url, "foreverdb-publisher-write");
  await c.connect();
  try {
    await c.query("begin");
    await c.query("select pg_advisory_xact_lock(hashtext('foreverdb_publication'))");
    const { rows } = await c.query(
      "select pub_admin.begin_publication($1, $2, $3, $4::jsonb) as id",
      [meta.workerVersion, meta.exportedAt ?? new Date().toISOString(), projection.sourceDataUpdatedAt,
        JSON.stringify({ thresholds: meta.config.thresholds, locationGrid: meta.config.locationGrid })],
    );
    const publicationId = Number(rows[0].id);
    for (const table of ORDER) {
      const columns = TABLES[table];
      const data = projection[table] as unknown as Record<string, unknown>[];
      for (let i = 0; i < data.length; i += 2000) {
        const chunk = data.slice(i, i + 2000);
        // Parameterized unnest() insert. Array-typed columns are passed as one
        // JSON document per chunk and expanded server-side (no string-built SQL
        // values; identifiers come only from the static TABLES map above).
        const arrayCols = columns.filter((c2) => c2.type.endsWith("[]"));
        const scalarCols = columns.filter((c2) => !c2.type.endsWith("[]"));
        const scalarParams = scalarCols.map((col) => chunk.map((r) => r[col.name] ?? null));
        const arrayParams = arrayCols.map((col) => JSON.stringify(chunk.map((r) => r[col.name] ?? [])));
        const p2: unknown[] = [publicationId, ...scalarParams, ...arrayParams];
        const unnestArgs = scalarCols.map((col, i2) => `$${i2 + 2}::${col.type}[]`).join(", ");
        const scalarNames = scalarCols.map((col) => col.name);
        const arraySel = arrayCols.map((col, i2) => {
          const p = scalarCols.length + 2 + i2;
          return `(select coalesce(array_agg(e::${col.type.slice(0, -2)} order by o), '{}') from jsonb_array_elements_text(($${p}::jsonb)->(u.ord::int - 1)) with ordinality as x(e, o)) as ${col.name}`;
        });
        const sql = `insert into pub.${table} (publication_id, ${[...scalarNames, ...arrayCols.map((c2) => c2.name)].join(", ")})
          select $1::bigint, ${[...scalarNames.map((n) => `u.${n}`), ...arraySel].join(", ")}
          from unnest(${unnestArgs}) with ordinality as u(${scalarNames.join(", ")}, ord)`;
        await c.query(sql, p2);
      }
    }
    const expected = countsOf(projection);
    const fin = await c.query(
      "select pub_admin.finalize_publication($1, $2, $3::jsonb, $4, $5) as outcome",
      [publicationId, meta.sha256, JSON.stringify(expected), meta.allowShrink, meta.config.retainPublications],
    );
    await c.query("commit");
    return { outcome: fin.rows[0].outcome, publicationId };
  } catch (e) {
    await c.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    await c.end();
  }
}
