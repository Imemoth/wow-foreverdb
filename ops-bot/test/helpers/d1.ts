import { DatabaseSync, type StatementSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Db, DbRunResult, DbStatement } from "../../src/db";

const MIGRATION = fileURLToPath(new URL("../../migrations/0001_ops_bot_init.sql", import.meta.url) as never);
const ROLLBACK = fileURLToPath(new URL("../../rollback/0001_ops_bot_init.down.sql", import.meta.url) as never);

class Stmt implements DbStatement {
  constructor(private readonly s: StatementSync, private readonly params: unknown[] = []) {}
  bind(...values: unknown[]): DbStatement { return new Stmt(this.s, values); }
  async first<T>(): Promise<T | null> { await Promise.resolve(); return ((this.s.get(...(this.params as never[])) as unknown) as T | undefined) ?? null; }
  async all<T>(): Promise<{ results: T[] }> { await Promise.resolve(); return { results: this.s.all(...(this.params as never[])) as unknown as T[] }; }
  async run(): Promise<DbRunResult> {
    await Promise.resolve(); // yield: lets parallel invocations interleave exactly as concurrent Workers would
    const r = this.s.run(...(this.params as never[]));
    return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
}

/** D1-shaped adapter over node:sqlite: runs the REAL migration SQL (SQLite is D1's engine). */
export class TestDb implements Db {
  readonly raw: DatabaseSync;
  constructor() { this.raw = new DatabaseSync(":memory:"); this.raw.exec("pragma foreign_keys = on"); }
  prepare(sql: string): DbStatement { return new Stmt(this.raw.prepare(sql)); }
  async batch(statements: DbStatement[]): Promise<DbRunResult[]> {
    this.raw.exec("begin");
    try { const out: DbRunResult[] = []; for (const st of statements) out.push(await st.run()); this.raw.exec("commit"); return out; }
    catch (e) { this.raw.exec("rollback"); throw e; }
  }
  migrate(): this { this.raw.exec(readFileSync(MIGRATION, "utf8")); return this; }
  rollback(): this { this.raw.exec(readFileSync(ROLLBACK, "utf8")); return this; }
  tables(): string[] { return (this.raw.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name").all() as Array<{ name: string }>).map((r) => r.name); }
  rows<T = Record<string, unknown>>(sql: string, ...p: unknown[]): T[] { return this.raw.prepare(sql).all(...(p as never[])) as unknown as T[]; }
  count(table: string, where = "1=1"): number { return (this.raw.prepare(`select count(*) as n from ${table} where ${where}`).get() as { n: number }).n; }
}
export const newDb = () => new TestDb().migrate();
