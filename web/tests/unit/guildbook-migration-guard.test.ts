import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Regression guard for the Guildbook server-side kill switch (migration 0018).
 *
 * Owner policy: Guildbook data stays on the user's computer; the cloud must never store or serve it. Migration 0018 puts an observation-only
 * projection in front of the private ingest implementation and revokes every Guildbook RPC. A LATER migration could silently undo that by
 * (a) redefining private.foreverdb_ingest_snapshot_impl_v1 (replacing the 0018 wrapper), (b) writing to the installation_guild* tables,
 * (c) creating new Guildbook storage or RPCs (the sibling branch's 0016 does exactly these things and must not land as-is), or (d) re-granting
 * a Guildbook function. This test fails in CI the moment any migration file outside the REVIEWED set mentions any of that, so such a change
 * cannot merge unnoticed. To land a migration that legitimately must touch them, add its file name to REVIEWED below IN THE SAME PR, after
 * reading docs/guildbook-local-only/db-changes.md section 4 (what must be true), and extend the SQL tests.
 */
const root = resolve(__dirname, "../../..");
const dirs = ["database/migrations", "supabase/migrations"].map((d) => resolve(root, d)).filter(existsSync);

// Files that exist in the release candidate and were reviewed with the kill switch in mind (0005 and 0009 define the original ingest
// implementation and the guild tables; 0012 the legacy read RPCs; 0018 is the kill switch itself).
const REVIEWED = new Set([
  "0001_initial_schema.sql", "0002_sync_safety.sql", "0003_companion_auth.sql", "0004_remove_legacy_ingest.sql", "0005_guildbook_v1.sql",
  "0006_companion_search_zone.sql", "0007_restrict_legacy_public_stats.sql", "0008_zone_catalog_browse.sql", "0008a_close_unused_private_rpcs.sql",
  "0008b_prepare_authenticated_global_search.sql", "0009_api_security_rate_limits.sql", "0011_fix_observed_drop_rate_denominator.sql",
  "0012_account_ownership_claims.sql", "0014_zero_touch_enrollment.sql", "0015_azerdex_welcome_outbox.sql", "0018_disable_guildbook_cloud_sync.sql",
]);

const GUILDBOOK_CLOUD = /foreverdb_ingest_snapshot_impl_v1|installation_guild|guildbook|fdb_public_snapshot|account_guildbook/i;

const files = dirs.flatMap((d) => readdirSync(d).filter((n) => n.endsWith(".sql")).map((n) => ({ dir: d, name: n })));
const text = (f: { dir: string; name: string }) => readFileSync(resolve(f.dir, f.name), "utf8");

describe("no later migration can silently re-enable Guildbook cloud storage or access", () => {
  it("every migration outside the reviewed set stays clear of the ingest implementation, the guild tables and any Guildbook function", () => {
    const offenders = files
      .filter((f) => !REVIEWED.has(f.name))
      .filter((f) => GUILDBOOK_CLOUD.test(text(f)))
      .map((f) => f.name);
    expect(offenders, "a migration touches Guildbook cloud structures: read docs/guildbook-local-only/db-changes.md section 4 first").toEqual([]);
  });

  it("the reviewed set only lists files that exist (a rename cannot hide a migration from the guard)", () => {
    const present = new Set(files.map((f) => f.name));
    for (const name of REVIEWED) expect(present.has(name), name).toBe(true);
  });

  it("the sibling branch's account-scoped Guildbook migrations (0016) and collector rework (0017) are not part of this release candidate", () => {
    const names = files.map((f) => f.name);
    expect(names.filter((n) => /^0016_|^0017_/.test(n))).toEqual([]);
  });
});

describe("migration 0018 keeps the properties the policy depends on", () => {
  const m = readFileSync(resolve(root, "database/migrations/0018_disable_guildbook_cloud_sync.sql"), "utf8");
  const sql = m.replace(/^\s*--.*$/gm, ""); // code only, comments excluded

  it("strips Guildbook before the legacy body sees the payload, and wraps the same implementation both public ingest paths call", () => {
    expect(sql).toMatch(/foreverdb_ingest_snapshot_impl_v1_legacy\(private\.fdb_public_snapshot\(p_snapshot\)\)/);
    for (const key of ["guilds", "guildbook", "guildbookCaptureId", "guildbookCapturedAt", "guildbookSourceCharacter"]) expect(sql).toContain(`- '${key}'`);
    expect(sql).not.toMatch(/create or replace function public\.(ingest_foreverdb_snapshot_auth|fdb_device_ingest)/i);
  });

  it("revokes every Guildbook RPC by catalog sweep and asserts it, from all four API roles", () => {
    expect(sql).toMatch(/p\.proname ~\* 'guildbook'/);
    expect(sql).toMatch(/revoke all on function %s from public, anon, authenticated, service_role/);
    expect(sql).toMatch(/remains callable by an API role/);
  });

  it("deletes nothing: no delete, truncate or drop of any non-temporary object, and the row fingerprints are asserted unchanged", () => {
    expect(sql).not.toMatch(/\bdelete\s+from\b/i);
    expect(sql).not.toMatch(/\btruncate\s+(table\s+)?[a-z_]/i);
    expect((sql.match(/\bdrop\s+table\b/gi) ?? []).length).toBe(3); // the three pg_temp copies, nothing persistent
    expect(sql.match(/drop\s+table\s+if\s+exists\s+(\S+)/gi)!.every((s) => /pg_temp\._fdb0018_/.test(s))).toBe(true);
    expect(sql).toMatch(/Guildbook % rows changed/);
  });

  it("refuses unexpected states: ledger, missing objects, a foreign ingest body and a foreign owner", () => {
    for (const msg of ["ledger already shows", "schema private is missing", "legacy private ingest implementation is missing", "Guildbook tables are missing",
      "legacy ingest implementation is not the expected one", "is not owned by the migration role"]) expect(m).toContain(msg);
  });

  it("leaves a durable private marker that restore and cleanup read", () => {
    expect(sql).toMatch(/create table if not exists private\.guildbook_cloud_sync_guard/);
    expect(sql).toMatch(/enable row level security/);
    for (const f of ["database/ops/guildbook_historical_cleanup.sql", "database/ops/guildbook_local_only_reassert.sql", "database/rollback/0018_restore.sql"]) {
      expect(readFileSync(resolve(root, f), "utf8"), f).toContain("guildbook_cloud_sync_guard");
    }
  });
});

describe("recovery scripts fail closed", () => {
  it("restore, reassert and cleanup check the guard table with two statements, never `to_regclass(...) is null or <query on that table>`", () => {
    for (const f of ["database/ops/guildbook_historical_cleanup.sql", "database/ops/guildbook_local_only_reassert.sql", "database/rollback/0018_restore.sql"]) {
      const s = readFileSync(resolve(root, f), "utf8").replace(/^\s*--.*$/gm, "");
      expect(s, f).not.toMatch(/to_regclass\('private\.guildbook_cloud_sync_guard'\)\s+is\s+null\s+or\s+not\s+exists/i);
    }
  });

  it("restore deletes no Guildbook or observation row (only the kill-switch marker, when the ingest projection is removed) and demands an explicit confirmation, scope, operator and approval reference", () => {
    const s = readFileSync(resolve(root, "database/rollback/0018_restore.sql"), "utf8").replace(/^\s*--.*$/gm, "");
    const deletes = [...s.matchAll(/\bdelete\s+from\s+(\S+)/gi)].map((x) => x[1]);
    expect(deletes).toEqual(["private.guildbook_cloud_sync_guard"]);
    expect(s).not.toMatch(/\btruncate\b/i);
    for (const part of ["REOPEN-GUILDBOOK-CLOUD-PATHS", "restore_scope", "restore_operator", "restore_approval"]) expect(s).toContain(part);
  });
});
