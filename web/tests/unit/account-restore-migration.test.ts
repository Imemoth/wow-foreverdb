import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { lintAccountMigration, scanSql } from "@/lib/account/migration-conformance";

/**
 * The ledger-consistent restoration migration (database/restore/0013_*.sql) redefines the same account functions as 0012 on purpose
 * (0012 cannot be re-run once its ledger entry exists). The conformance gate lints database/migrations as ONE unit, where a second
 * definition would be a duplicate, so the restore file lives outside that directory and is linted here on its own. A drift test
 * keeps its object definitions byte-identical to 0012.
 */
const root = resolve(__dirname, "../../../database");
const m0012 = readFileSync(resolve(root, "migrations/0012_account_ownership_claims.sql"), "utf8");
const m0013 = readFileSync(resolve(root, "restore/0013_account_ownership_claims_restore.sql"), "utf8");

const shared = (sql: string): string => {
  const start = sql.indexOf("-- 2. Private schema objects");
  const end = sql.indexOf("notify pgrst, 'reload schema';");
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end);
};

describe("0013 restoration migration", () => {
  it("passes the account conformance linter on its own (every guard, RPC, revoke and grant in canonical form)", () => {
    expect(lintAccountMigration(m0013)).toEqual([]);
  });

  it("defines exactly the 0012 objects: sections 2-6 are byte-identical to 0012", () => {
    expect(shared(m0013)).toBe(shared(m0012));
  });

  it("lives outside database/migrations so the combined conformance gate never sees a duplicate definition", () => {
    const files = readdirSync(resolve(root, "migrations")).filter((f) => f.startsWith("0013"));
    expect(files).toEqual([]);
  });

  it("the WHOLE file equals 0012 apart from its header comments and the pre-flight block (no DML hides outside sections 2-6)", () => {
    const stripped = (sql: string): string => {
      const a = sql.indexOf("do $preflight$");
      const b = sql.indexOf("end $preflight$;");
      expect(a).toBeGreaterThan(0);
      expect(b).toBeGreaterThan(a);
      return scanSql(sql.slice(0, a) + sql.slice(b + "end $preflight$;".length)).code.replace(/\s+/g, " ").trim();
    };
    expect(stripped(m0013)).toBe(stripped(m0012));
  });

  it("the 0013 pre-flight block is read-only: no DML/DDL, no dynamic SQL, no ledger write (denylist over its code, strings masked)", () => {
    const a = m0013.indexOf("do $preflight$");
    const b = m0013.indexOf("end $preflight$;");
    const code = scanSql(m0013.slice(a, b)).bodies.join("\n");
    const masked = scanSql(code).code.toLowerCase();
    expect(masked).not.toMatch(/\b(insert|update|delete|truncate|drop|alter|create|grant|revoke|copy|execute|set)\b/);
    expect(masked).not.toMatch(/supabase_migrations\.schema_migrations\s+(set|values)/);
  });

  it("every file in database/restore that mentions an account function is linted on its own", () => {
    const dir = resolve(root, "restore");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql") && /fdb_account_|fdb_installation_link_status|fdb_caller|fdb_anonymous_caller|fdb_registered_caller/.test(readFileSync(resolve(dir, f), "utf8")));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(lintAccountMigration(readFileSync(resolve(dir, f), "utf8")), f).toEqual([]);
  });

  it("only reads the migration ledger (never writes, updates or deletes it) and checks the recorded rollback first", () => {
    expect(/\b(insert|update|delete)\b[^;]*supabase_migrations/i.test(m0013.replace(/--.*$/gm, ""))).toBe(false);
    expect(m0013).toContain("rollback_account_ownership_claims");
    expect(m0013).toContain("account_ownership_claims_restore");
  });

  it("0012's pre-flight still refuses a recorded account_ownership_claims (not weakened)", () => {
    expect(m0012).toContain("ledger already shows account_ownership_claims");
  });
});
