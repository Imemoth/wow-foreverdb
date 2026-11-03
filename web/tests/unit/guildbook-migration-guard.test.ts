import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { KILL_SWITCH_MIGRATION, REVIEWED_MIGRATIONS, policyViolations } from "./support/guildbook-policy";

/**
 * Regression guard for the Guildbook server-side kill switch (migration 0018).
 *
 * Owner policy: Guildbook data stays on the user's computer; the cloud must never store or serve it. 0018 puts an observation-only projection
 * in front of the private ingest implementation and revokes every Guildbook RPC. A later migration could undo that by replacing the wrapper,
 * writing to the guild tables, adding Guildbook storage/RPCs (the sibling branch's 0016 does exactly that and is permanently retired), or
 * re-granting. The rules are CONTENT-based (tests/unit/support/guildbook-policy.ts): they do not look at a migration's number or name, so
 * renaming 0016 does not bypass them, and 0017 (independent collectors) is not blocked merely for being 0017.
 *
 * What this cannot do (see docs/guildbook-local-only/migration-policy-enforcement.md): it is a review-time check; it cannot stop someone who
 * edits or deletes THIS test, or a migration applied by hand. That needs a branch ruleset with required checks and code-owner review.
 */
const root = resolve(__dirname, "../../..");
const dirs = ["database/migrations", "supabase/migrations"].map((d) => resolve(root, d)).filter(existsSync);
const files = dirs.flatMap((d) => readdirSync(d).filter((n) => n.endsWith(".sql")).map((n) => ({ dir: d, name: n })));
const read = (f: { dir: string; name: string }) => readFileSync(resolve(f.dir, f.name), "utf8");
const sha = (text: string) => createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");

describe("no migration can re-enable Guildbook cloud storage or access (content-based, name-independent)", () => {
  it("every migration that is not a reviewed, hash-pinned file is free of Guildbook structures, the ingest implementation, the projection and catalog-driven grants", () => {
    const offenders = files
      .filter((f) => !(f.name in REVIEWED_MIGRATIONS) && f.name !== KILL_SWITCH_MIGRATION)
      .map((f) => ({ file: f.name, violations: policyViolations(read(f)).map((v) => `${v.rule}: ${v.detail}`) }))
      .filter((o) => o.violations.length > 0);
    expect(offenders, "a migration touches Guildbook cloud structures: read docs/guildbook-local-only/db-changes.md section 4 first").toEqual([]);
  });

  it("every previously reviewed migration still has exactly the reviewed content (editing an applied or allowlisted migration needs a visible manifest change)", () => {
    const present = new Map(files.map((f) => [f.name, f]));
    for (const [name, hash] of Object.entries(REVIEWED_MIGRATIONS)) {
      const f = present.get(name);
      expect(f, `${name} is missing: a reviewed migration was renamed or removed`).toBeDefined();
      expect(sha(read(f!)), `${name} was edited after review: update REVIEWED_MIGRATIONS in tests/unit/support/guildbook-policy.ts in the same reviewed diff`).toBe(hash);
    }
  });

  it("the kill switch itself is present", () => {
    expect(files.some((f) => f.name === KILL_SWITCH_MIGRATION)).toBe(true);
  });
});

describe("the policy is behaviour-based: renaming cannot bypass it, and unrelated migrations are not blocked by their number", () => {
  // Stand-ins for what a landing 0016 would contain: the shapes that matter, not the sibling branch's exact text.
  const account0016Like = `
    create table private.account_guildbook_guilds (account_uid uuid, installation_id text, guild_key text);
    create or replace function public.fdb_account_guildbook_guilds(p_installation_id text) returns jsonb language sql as $$ select '[]'::jsonb $$;
    grant execute on function public.fdb_account_guildbook_guilds(text) to authenticated;
    create or replace function private.foreverdb_ingest_snapshot_impl_v1(p_snapshot jsonb) returns jsonb language plpgsql as $$ begin return p_snapshot; end $$;
  `;
  // A collector migration in the style of 0017: changes enrollment, no Guildbook anywhere.
  const collector0017Like = `
    create or replace function public.fdb_device_enroll(p_activation text, p_installation_id text, p_label text) returns jsonb language plpgsql security definer set search_path = '' as $$
    begin return jsonb_build_object('ok', true); end $$;
    drop index if exists private.devices_one_live_per_identity;
    revoke all on function public.fdb_device_enroll(text, text, text) from public, anon, authenticated, service_role;
  `;

  it("a 0016-like migration is flagged under ANY file name (the policy never sees the name)", () => {
    const v = policyViolations(account0016Like);
    expect(v.map((x) => x.rule)).toEqual(expect.arrayContaining(["guild-structure", "private-ingest-implementation"]));
    // The function has no name parameter by construction. Prove the point on the real files too: a verbatim copy of 0005 (guild tables) or of
    // the 0018 wrapper is flagged identically, whatever it is called.
    for (const real of ["0005_guildbook_v1.sql", KILL_SWITCH_MIGRATION]) {
      const f = files.find((x) => x.name === real)!;
      expect(policyViolations(read(f)).length, `${real} content, if re-landed under a new name, must be flagged`).toBeGreaterThan(0);
    }
  });

  it("a collector-credentials (0017-like) migration is NOT blocked: it is judged by what it does", () => {
    expect(policyViolations(collector0017Like)).toEqual([]);
  });

  it("the policy has no notion of a migration number: it takes SQL text only, so 0016/0017 are neither banned nor allowed by name", () => {
    expect(policyViolations.length).toBe(1); // (sql) => violations: there is no file-name parameter to branch on
    expect(policyViolations("create index if not exists devices_last_seen_idx on private.devices (last_seen_at);")).toEqual([]);
  });

  it("catalog-driven grants and assembled identifiers (ways to avoid spelling the names) are flagged", () => {
    expect(policyViolations(`do $$ declare r record; begin for r in select oid::regprocedure::text s from pg_proc loop execute format('grant execute on function %s to authenticated', r.s); end loop; end $$;`).map((x) => x.rule)).toContain("dynamic-grant");
    expect(policyViolations(`select 'gui' || 'ldbook_x'`).map((x) => x.rule)).toContain("split-identifier");
    expect(policyViolations(`execute format('select * from installation_%s', 'guil' || 'ds')`).length).toBeGreaterThan(0);
    expect(policyViolations(`select convert_from(decode('Z3VpbGQ=', 'base64'), 'utf8')`).map((x) => x.rule)).toContain("char-assembled");
  });

  it("tampering with a reviewed file is detected: the pin changes with the content, line endings aside", () => {
    const sample = read(files.find((f) => f.name === "0012_account_ownership_claims.sql")!);
    const lf = sample.replace(/\r\n/g, "\n"); // the working copy may already be CRLF (Windows autocrlf)
    expect(sha(lf.replace(/\n/g, "\r\n"))).toBe(sha(lf));
    expect(sha(`${sample}\ngrant execute on function public.fdb_account_guildbook_guilds(text) to authenticated;`)).not.toBe(sha(sample));
  });

  it("comments are documentation, not behaviour: a comment that mentions the policy does not trip it", () => {
    expect(policyViolations("-- note: the guildbook is local-only\n/* guild data never lives here */\nselect 1;")).toEqual([]);
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
