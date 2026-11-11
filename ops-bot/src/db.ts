/** Minimal structural subset of Cloudflare D1 used by the bot. D1Database satisfies it (cast at the Worker boundary). */
export interface DbRunResult { success?: boolean; meta?: { changes?: number; last_row_id?: number } }
export interface DbStatement {
  bind(...values: unknown[]): DbStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<DbRunResult>;
}
export interface Db {
  prepare(sql: string): DbStatement;
  batch(statements: DbStatement[]): Promise<DbRunResult[]>;
}
export const changes = (r: DbRunResult): number => r.meta?.changes ?? 0;

export interface Clock { now(): number }
export const systemClock: Clock = { now: () => Date.now() };
