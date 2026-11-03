/**
 * node-postgres adapter for the portable SqlClient (Node CLI and local diagnostics/recovery).
 *
 * Credentials (two SEPARATE secrets, never shared with the website runtime):
 *   PRIVATE_EXPORT_DATABASE_URL   role foreverdb_projection_reader (EXECUTE on publication_export.* only, read-only)
 *   PUBLIC_PUBLISHER_DATABASE_URL role foreverdb_publisher (staging INSERT + pub_admin.* only)
 */
import pg from "pg";
import type { ClosableSqlClient } from "./core/sql.ts";

export function requireUrl(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  if (!/^postgres(ql)?:\/\//.test(v)) throw new Error(`${name} must be a postgres:// URL`);
  return v;
}

export async function openPg(url: string, appName: string): Promise<ClosableSqlClient> {
  const local = /@(localhost|127\.0\.0\.1|\/tmp|%2Ftmp)/.test(url) || url.includes("host=/");
  const c = new pg.Client({
    connectionString: url,
    application_name: appName,
    // Remote databases MUST use TLS. Local ephemeral test databases may not.
    ssl: local ? undefined : { rejectUnauthorized: true },
    statement_timeout: 120_000,
  });
  await c.connect();
  return {
    query: async (text, params) => ({ rows: (await c.query(text, params as unknown[] | undefined)).rows as Record<string, unknown>[] }),
    close: () => c.end(),
  };
}
