import "server-only";
import tls from "node:tls";
import pg from "pg";
import { SUPABASE_ROOT_2021_CA } from "./supabase-ca";
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
  type ZoneEntityRow,
  type SourceMapPoints,
  type SourceMapPointsQuery,
  type ZoneMapPoints,
  type LootKind,
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

/**
 * Operator diagnostic for a failed database call. It logs ONLY values proven safe by construction: a SQLSTATE / Node error code
 * that matches a strict token pattern, an allow-listed syscall, a bounded error-class name, and a category from a fixed vocabulary
 * derived by pattern-matching the driver message. The driver message itself is never logged (it can embed hosts, role names,
 * parameters or server hints). Visitors only ever see the generic "public_data_unavailable".
 */
const SYSCALLS = new Set(["getaddrinfo", "connect", "read", "write", "secureConnect", "socket", "lookup"]);
const CATEGORY_PATTERNS: [string, RegExp][] = [
  ["tenant_not_found", /tenant\/user|tenant or user not found/i],
  ["auth_failed", /password authentication failed|authentication failed|no pg_hba|SASL|SCRAM/i],
  ["startup_parameter", /unsupported startup parameter|startup parameter/i],
  ["tls_verification", /certificate|self[- ]signed|unable to verify|hostname\/ip does not match|altnames/i],
  ["tls_protocol", /ssl|tls|handshake/i],
  ["dns", /getaddrinfo|ENOTFOUND|EAI_AGAIN/i],
  ["network_unreachable", /ENETUNREACH|EHOSTUNREACH|network is unreachable/i],
  ["timeout", /timeout|timed out|ETIMEDOUT/i],
  ["connection_refused", /ECONNREFUSED|refused/i],
  ["connection_reset", /ECONNRESET|terminated|ended unexpectedly|EPIPE/i],
  ["privilege", /permission denied/i],
  ["pool_exhausted", /too many clients|remaining connection slots|max client|pool/i],
  ["invalid_url", /invalid url|invalid connection|ERR_INVALID_URL/i],
];

export function describeDbError(e: unknown): Record<string, string | null> {
  const x = (e ?? {}) as { code?: unknown; syscall?: unknown; name?: unknown; message?: unknown };
  const token = (v: unknown, re: RegExp) => (typeof v === "string" && re.test(v) ? v : null);
  const raw = typeof x.message === "string" ? x.message : "";
  const hit = CATEGORY_PATTERNS.find(([, re]) => re.test(raw));
  return {
    category: hit ? hit[0] : "other",
    code: token(x.code, /^[A-Za-z0-9_]{2,40}$/),
    syscall: typeof x.syscall === "string" && SYSCALLS.has(x.syscall) ? x.syscall : null,
    name: token(x.name, /^[A-Za-z]{2,40}$/),
  };
}

/**
 * Non-secret shape of the configured connection, for diagnosing a mis-set variable without ever revealing it: host kind (exact host
 * only when it is a public Supabase pooler name), port, user pattern, and whether a conflicting `sslmode`/`options` parameter or a
 * password is present. No credential, path or query value is returned.
 */
export function describeConnectionTarget(connectionString: string): Record<string, string | number | boolean | null> {
  try {
    const u = new URL(connectionString);
    const host = u.hostname.toLowerCase();
    const pooler = /^aws-\d{1,2}-[a-z0-9-]{3,30}\.pooler\.supabase\.com$/.test(host);
    const direct = /^db\.[a-z0-9]{20}\.supabase\.co$/.test(host);
    const user = decodeURIComponent(u.username);
    return {
      protocol: u.protocol.replace(":", ""),
      hostKind: pooler ? "supabase_pooler" : direct ? "supabase_direct_ipv6_only" : "other",
      host: pooler ? host : null,
      port: u.port ? Number(u.port) : null,
      userPattern: user === "foreverdb_web_reader" ? "role" : /^foreverdb_web_reader\.[a-z0-9]{20}$/.test(user) ? "role.projectref" : "other",
      database: /^\/(postgres)?$/.test(u.pathname) ? "postgres" : "other",
      hasPassword: u.password.length > 0,
      hasQuery: u.search.length > 0,
      sslmodeParam: u.searchParams.has("sslmode"),
    };
  } catch {
    return { parse: "invalid_url" };
  }
}

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

/** Hostnames of the Supabase connection pooler (Supavisor), e.g. aws-0-eu-west-1.pooler.supabase.com. Nothing else gets the extra CA. */
const SUPABASE_POOLER_HOST = /^aws-\d{1,2}-[a-z0-9-]{3,30}\.pooler\.supabase\.com$/;

function hostnameOf(connectionString: string): string | null {
  try {
    return new URL(connectionString).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

/**
 * TLS options for the pool. Remote connections ALWAYS verify the server certificate and host name (rejectUnauthorized stays true, no
 * checkServerIdentity override). Only a connection to a Supabase pooler host additionally trusts the Supabase Root 2021 CA (that pooler's
 * chain ends in this private root, see supabase-ca.ts), added to Node's built-in roots; every other remote database uses Node's default
 * trust store unchanged. A localhost URL (developer machine / CI) is plain TCP.
 */
export function buildSslOptions(connectionString: string): pg.ClientConfig["ssl"] {
  if (/@(localhost|127\.0\.0\.1)[:/]/.test(connectionString)) return undefined;
  const host = hostnameOf(connectionString);
  if (host !== null && SUPABASE_POOLER_HOST.test(host)) {
    return { rejectUnauthorized: true, ca: [...tls.rootCertificates, SUPABASE_ROOT_2021_CA] };
  }
  return { rejectUnauthorized: true };
}

export class PostgresAdapter implements PublicDataAdapter {
  readonly mode = "published" as const;
  private pool: pg.Pool;
  private target: Record<string, string | number | boolean | null>;

  constructor(connectionString: string) {
    this.target = describeConnectionTarget(connectionString);
    this.pool = new pg.Pool({
      connectionString,
      max: 5,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 3_000,
      statement_timeout: 3_000,
      query_timeout: 4_000,
      application_name: "foreverdb-web",
      ssl: buildSslOptions(connectionString),
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
      const op = /web_api\.([a-z_]{1,40})/.exec(sql)?.[1] ?? null;
      console.error(JSON.stringify({ at: new Date().toISOString(), event: "public_db_error", op, ...describeDbError(e), target: this.target }));
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

  async zoneEntities(z: ZoneEntityQuery): Promise<Page<ZoneEntityRow>> {
    const rows = await this.q(
      "select * from web_api.zone_entities($1, $2, $3, $4, $5, $6)",
      [z.mapId, z.displayKind, z.lootKind, z.q, z.pageSize, (z.page - 1) * z.pageSize],
    );
    return {
      rows: rows.map((r) => ({
        ...toSearchRow({ ...r, observations: 0, map_ids: [r.map_id ?? z.mapId] }),
        observations: num(r.observations),
        association: r.association as ZoneEntityRow["association"],
        associatedSourceCount: num(r.associated_source_count),
      })),
      total: rows.length ? Number(rows[0]!.total_count) : 0,
    };
  }

  async zoneMapPoints(mapId: number, lootKind: LootKind | null, limit: number): Promise<ZoneMapPoints> {
    const rows = await this.q("select * from web_api.zone_map_points($1, $2, $3)", [mapId, lootKind, limit]);
    return {
      mapId,
      points: rows.map((r) => ({
        sourceType: r.source_type as SourceType, sourceId: Number(r.source_id), sourceLevel: Number(r.source_level), name: String(r.name),
        lootKind: r.loot_kind as LootKind, subzone: String(r.subzone_name ?? ""), x: Number(r.x), y: Number(r.y), observations: Number(r.observations),
      })),
      totalCells: rows.length ? Number(rows[0]!.total_count) : 0,
      truncated: rows.length ? Number(rows[0]!.total_count) > rows.length : false,
    };
  }

  async sourceMapPoints(q: SourceMapPointsQuery): Promise<SourceMapPoints> {
    const rows = await this.q("select * from web_api.source_map_points($1, $2, $3, $4, $5, $6)",
      [q.sourceType, q.sourceId, q.mapId, q.lootKind, q.sourceLevel, q.limit]);
    return {
      sourceType: q.sourceType, sourceId: q.sourceId,
      points: rows.map((r) => ({
        sourceType: r.source_type as SourceType, sourceId: Number(r.source_id), sourceLevel: Number(r.source_level), name: String(r.name),
        lootKind: r.loot_kind as LootKind, mapId: Number(r.map_id), subzone: String(r.subzone_name ?? ""), x: Number(r.x), y: Number(r.y),
        observations: Number(r.observations),
      })),
      totalCells: rows.length ? Number(rows[0]!.total_count) : 0,
      truncated: rows.length ? Number(rows[0]!.total_count) > rows.length : false,
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
