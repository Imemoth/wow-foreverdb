import "server-only";
import pg from "pg";
import {
  InvalidQueryError,
  type DatasetMeta,
  type ItemDetail,
  type Page,
  type PublicDataAdapter,
  type RecentRow,
  type SearchQuery,
  type SearchRow,
  type SitemapRow,
  type SourceDetail,
  type SourceType,
  type ZoneDetail,
  type ZoneEntityQuery,
  type ZoneSummary,
} from "./types";

/**
 * Live adapter for the ISOLATED PUBLIC READ DATABASE.
 *
 * Connects as `foreverdb_web_reader`, which can only EXECUTE the bounded
 * web_api.* functions (no table access, read-only, 2-3 s timeouts). Every
 * statement below is a fixed, parameterized function call — there is no code
 * path that accepts SQL, table names or column names from a request.
 *
 * MUST NEVER be pointed at the private production database: the startup check
 * in env.ts rejects the known production project ref.
 */

type Row = Record<string, unknown>;
const num = (v: unknown) => (v == null ? null : Number(v));

function toSearchRow(r: Row): SearchRow {
  return {
    entityKind: r.entity_kind as SearchRow["entityKind"],
    displayKind: r.display_kind as SearchRow["displayKind"],
    itemId: num(r.item_id), sourceType: (r.source_type as SourceType) ?? null, sourceId: num(r.source_id),
    sourceLevel: num(r.source_level), name: String(r.name),
    lootKinds: (r.loot_kinds as SearchRow["lootKinds"]) ?? [],
    mapIds: ((r.map_ids as unknown[]) ?? []).map(Number),
    observations: Number(r.observations),
  };
}

export class PostgresAdapter implements PublicDataAdapter {
  readonly mode = "published" as const;
  private pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({
      connectionString,
      max: 5,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 3_000,
      statement_timeout: 3_000,
      query_timeout: 4_000,
      application_name: "foreverdb-web",
      ssl: /@(localhost|127\.0\.0\.1)[:/]/.test(connectionString) ? undefined : { rejectUnauthorized: true },
    });
    this.pool.on("error", () => {
      /* idle client errors are logged by the caller path; never crash the process */
    });
  }

  private async q(sql: string, params: unknown[]): Promise<Row[]> {
    try {
      return (await this.pool.query(sql, params)).rows as Row[];
    } catch (e) {
      // 22023 = invalid_parameter_value raised by web_api bounds checks.
      if ((e as { code?: string }).code === "22023") throw new InvalidQueryError((e as Error).message);
      throw new Error("public_data_unavailable");
    }
  }

  async meta(): Promise<DatasetMeta> {
    const [r] = await this.q("select web_api.meta() as m", []);
    const m = (r?.m ?? {}) as Record<string, unknown>;
    return {
      mode: this.mode,
      publicationId: num(m.publicationId),
      publishedAt: (m.publishedAt as string) ?? null,
      dataUpdatedAt: (m.dataUpdatedAt as string) ?? null,
      counts: (m.counts as Record<string, number>) ?? null,
      thresholds: (m.thresholds as DatasetMeta["thresholds"]) ?? null,
    };
  }

  async search(s: SearchQuery): Promise<Page<SearchRow>> {
    const rows = await this.q(
      "select * from web_api.search($1, $2, $3, $4, $5, $6, $7)",
      [s.q, s.category, s.zone, s.kind, s.sort, s.pageSize, (s.page - 1) * s.pageSize],
    );
    return { rows: rows.map(toSearchRow), total: rows.length ? Number(rows[0]!.total_count) : 0 };
  }

  async item(id: number): Promise<ItemDetail | null> {
    const [r] = await this.q("select web_api.item($1) as d", [id]);
    return (r?.d as ItemDetail) ?? null;
  }

  async source(type: SourceType, id: number): Promise<SourceDetail | null> {
    const [r] = await this.q("select web_api.source($1, $2) as d", [type, id]);
    return (r?.d as SourceDetail) ?? null;
  }

  async zones(): Promise<ZoneSummary[]> {
    const rows = await this.q("select * from web_api.zones()", []);
    return rows.map((r) => ({
      mapId: Number(r.map_id), zoneName: String(r.zone_name), observations: Number(r.observations),
      sourceCount: Number(r.source_count), itemCount: Number(r.item_count),
    }));
  }

  async zone(mapId: number): Promise<ZoneDetail | null> {
    const [r] = await this.q("select web_api.zone($1) as d", [mapId]);
    return (r?.d as ZoneDetail) ?? null;
  }

  async zoneEntities(z: ZoneEntityQuery): Promise<Page<SearchRow>> {
    const rows = await this.q(
      "select * from web_api.zone_entities($1, $2, $3, $4, $5, $6)",
      [z.mapId, z.displayKind, z.lootKind, z.q, z.pageSize, (z.page - 1) * z.pageSize],
    );
    return {
      rows: rows.map((r) => toSearchRow({ ...r, map_ids: [r.map_id ?? z.mapId] })),
      total: rows.length ? Number(rows[0]!.total_count) : 0,
    };
  }

  async recent(limit: number): Promise<RecentRow[]> {
    const rows = await this.q("select * from web_api.recent($1)", [limit]);
    return rows.map((r) => ({ ...toSearchRow({ ...r, observations: 0 }), lastObservedAt: r.last_observed_at ? new Date(r.last_observed_at as string).toISOString() : null }));
  }

  async sitemap(entity: "item" | "source" | "zone", offset: number, limit: number): Promise<SitemapRow[]> {
    const rows = await this.q("select * from web_api.sitemap($1, $2, $3)", [entity, offset, limit]);
    return rows.map((r) => ({
      itemId: num(r.item_id), sourceType: (r.source_type as SourceType) ?? null, sourceId: num(r.source_id),
      mapId: num(r.map_id), updatedAt: r.updated_at ? new Date(r.updated_at as string).toISOString() : null,
    }));
  }
}
